import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { basename } from "node:path";
import {
  DELEGATE_COMMAND,
  DELEGATE_EFFORTS,
  DELEGATE_MESSAGE_TYPE,
  DELEGATE_REGISTRY_ENTRY_TYPE,
  DELEGATE_STATE_ENTRY_TYPE,
  DELEGATE_SUBCOMMANDS,
  DELEGATE_TARGETS,
  delegateTask,
  formatDelegateHelp,
  formatDelegateLaunchResult,
  getActiveDelegateState,
  getForkBranchEntries,
  getGitContext,
  getParentEffectiveCwd,
  isDelegatedWorkerSession,
  parseDelegateCommandInput,
  resolveParentSessionName,
} from "../lib/delegate.js";
import { loadDelegateConfig } from "../lib/config.js";
import {
  listWorkersForScope,
  findWorkerByNameOrId,
  reopenWorker,
  cleanSafeWorkers,
  persistLaunchToRegistry,
  persistReopenToRegistry,
  formatWorkerList,
  formatCleanPreview,
  formatCleanResult,
  getWorkerTmuxTarget,
  readDelegateResultFile,
} from "../lib/manager.js";
import { attachToTmuxTarget } from "../lib/tmux.js";

// ---------------------------------------------------------------------------
// Config cache
// ---------------------------------------------------------------------------

let configCache = null;

async function getConfig() {
  if (!configCache) {
    const loaded = await loadDelegateConfig();
    configCache = loaded.config;
  }
  return configCache;
}

function applyConfigDefaults(request, _config) {
  return { ...request, target: "session" };
}

const delegateSchema = Type.Object({
  task: Type.String({ description: "Task prompt for the delegated worker" }),
  target: Type.Optional(StringEnum(DELEGATE_TARGETS)),
  name: Type.Optional(Type.String({ description: "Optional human-friendly worker name" })),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for the delegated worker" })),
  model: Type.Optional(Type.String({ description: "Optional pi model pattern/id to launch the delegated worker with." })),
  effort: Type.Optional(StringEnum(DELEGATE_EFFORTS)),
  createWorktree: Type.Optional(
    Type.Boolean({ description: "Create an isolated worktree for same-repo delegation. Defaults to false; prefer delegate_task_worktree for code changes." }),
  ),
});

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

function filterCompletionItems(prefix, items) {
  const normalized = String(prefix || "").toLowerCase();
  const filtered = items.filter((item) => item.label.toLowerCase().startsWith(normalized));
  return filtered.length > 0 ? filtered : null;
}

function getDelegateArgumentCompletions(prefix) {
  const tokens = String(prefix || "").match(/(?:"[^"]*"|'[^']*'|\S+)/g) || [];
  const current = /\s$/.test(prefix) ? "" : (tokens.at(-1) ?? "");

  // First token: offer subcommands + flags
  if (tokens.length <= 1) {
    const subcommandItems = [
      { value: "start ", label: "start", description: "Launch a new worker" },
      { value: "status", label: "status", description: "List workers" },
      { value: "worktree ", label: "worktree", description: "Launch an isolated code-change worker" },
      { value: "result ", label: "result", description: "Read a worker result" },
      { value: "attach ", label: "attach", description: "Attach to a live worker" },
      { value: "open ", label: "open", description: "Open a worker" },
      { value: "clean ", label: "clean", description: "Clean dead workers" },
      { value: "help", label: "help", description: "Show help" },
    ];
    const flagItems = [
      { value: "--name ", label: "--name", description: "Set a worker name" },
      { value: "--cwd ", label: "--cwd", description: "Use a different working directory" },
      { value: "--model ", label: "--model", description: "Launch worker with a specific model" },
      { value: "--effort ", label: "--effort", description: "Set reasoning effort for this worker only" },
      { value: "--no-worktree", label: "--no-worktree", description: "Skip worktree creation" },
    ];
    return filterCompletionItems(current, [...subcommandItems, ...flagItems]);
  }

  // After first token: flag completions for start/implicit start
  if (!current || current.startsWith("--")) {
    return filterCompletionItems(current, [
      { value: "--name ", label: "--name", description: "Set a worker name" },
      { value: "--cwd ", label: "--cwd", description: "Use a different working directory" },
      { value: "--model ", label: "--model", description: "Launch worker with a specific model" },
      { value: "--effort ", label: "--effort", description: "Set reasoning effort for this worker only" },
      { value: "--no-worktree", label: "--no-worktree", description: "Skip worktree creation" },
      { value: "--worktree", label: "--worktree", description: "Explicitly request a worktree" },
      { value: "--help", label: "--help", description: "Show usage" },
      { value: "--yes", label: "--yes", description: "Skip confirmation (clean)" },
    ]);
  }

  if (tokens.at(-2) === "--target" || current.startsWith("--target=")) {
    const targetPrefix = current.startsWith("--target=") ? current.slice("--target=".length) : current;
    return filterCompletionItems(
      targetPrefix,
      DELEGATE_TARGETS.map((target) => ({
        value: current.startsWith("--target=") ? `--target=${target}` : target,
        label: target,
        description: `Launch worker in a ${target}`,
      })),
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildRuntimeContext(ctx, rawBranchEntries, options = {}) {
  const parentCwd = getParentEffectiveCwd(ctx.cwd, rawBranchEntries);
  return {
    parentCwd,
    parentSessionFile: ctx.sessionManager.getSessionFile(),
    headerVersion: ctx.sessionManager.getHeader()?.version,
    branchEntries: getForkBranchEntries(rawBranchEntries, {
      excludeTrailingDelegateToolCall: options.excludeTrailingDelegateToolCall,
    }),
    getLabel: (entryId) => ctx.sessionManager.getLabel(entryId),
    env: process.env,
    piCommand: process.env.PI_EZ_DELEGATE_PI_COMMAND || "pi",
    isDelegatedWorker: Boolean(ctx.sessionManager.getHeader()?.parentSession),
    // Naming fields — populated by enrichRuntimeWithNaming()
    parentSessionName: undefined,
    delegateIndex: undefined,
  };
}

function assertNotNestedDelegate(isDelegatedWorker, action = "launch delegates") {
  if (isDelegatedWorker) {
    throw new Error(`Delegated workers may not ${action}. Use the parent session to spawn new workers.`);
  }
}

/**
 * Compact the parent session before forking so delegates start with a
 * summarised history and maximum available context budget.
 *
 * Wraps the callback-based ctx.compact() in a promise.  Resolves on success
 * or when compaction is not needed; rejects only on genuine errors.
 */
function compactBeforeFork(ctx) {
  const COMPACT_TIMEOUT_MS = 30_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false); // timeout — proceed without compaction
      }
    }, COMPACT_TIMEOUT_MS);

    try {
      ctx.compact({
        customInstructions: "Summarize the full conversation so far. A delegated worker will be forked from this session and needs maximum context budget.",
        onComplete: () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(true);
          }
        },
        onError: (error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        },
      });
    } catch (error) {
      // ctx.compact() itself may throw synchronously (e.g. nothing to compact)
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

/**
 * Best-effort compaction before delegation.  Never blocks the launch if
 * compaction fails — the delegate would just start with a larger (uncompacted)
 * history, which is still functional.
 */
async function tryCompactBeforeFork(ctx, notify) {
  try {
    const compacted = await compactBeforeFork(ctx);
    if (compacted && notify) notify("Compacted parent session before delegation", "info");
    return compacted;
  } catch {
    // Compaction is best-effort — swallow errors and proceed.
    return false;
  }
}

/**
 * Resolve parent session name and delegate index, enriching the runtime context.
 * When the parent has no name, auto-generates one and persists it via pi.appendEntry.
 */
async function enrichRuntimeWithNaming(pi, ctx, runtime, rawBranchEntries) {
  const parentCwd = runtime.parentCwd;
  const gitContext = await getGitContext(parentCwd);
  const parentNameResult = resolveParentSessionName(rawBranchEntries, gitContext);

  runtime.parentSessionName = parentNameResult.name;

  // If name was auto-generated, persist it to the parent session
  if (parentNameResult.generated) {
    try {
      pi.appendEntry("session_info", { name: parentNameResult.name });
    } catch {
      // best-effort — if session_info isn't supported as a direct type, skip
    }
  }

  // Get delegate index from registry
  let delegateIndex = 1;
  try {
    const scope = await getRegistryScope(ctx);
    if (scope) {
      const result = await listWorkersForScope(scope, { env: process.env });
      delegateIndex = result.workers.filter((w) => !w.record.cleanedAt).length + 1;
    }
  } catch {
    // best-effort — fall back to 1
  }
  runtime.delegateIndex = delegateIndex;
}

function sendDelegateMessage(pi, content, details) {
  pi.sendMessage({
    customType: DELEGATE_MESSAGE_TYPE,
    content,
    display: true,
    details,
  });
}

function appendDelegateEntries(pi, result) {
  if (result?.delegateState) {
    pi.appendEntry(DELEGATE_STATE_ENTRY_TYPE, result.delegateState);
  }
  pi.appendEntry(DELEGATE_REGISTRY_ENTRY_TYPE, result);
}

async function getRegistryScope(ctx) {
  const rawBranchEntries = ctx.sessionManager.getBranch();
  const parentCwd = getParentEffectiveCwd(ctx.cwd, rawBranchEntries);
  const gitContext = await getGitContext(parentCwd);
  if (gitContext) return { key: gitContext.mainCheckoutPath, label: basename(gitContext.mainCheckoutPath) };
  return { key: parentCwd, label: basename(parentCwd) || "delegate" };
}

function stripLeadingMention(text) {
  let rest = String(text ?? "").trimStart();
  while (true) {
    const next = rest.replace(/^(?:<@!?\d+>|<@&\d+>|@[\w.-]+)\s*/u, "");
    if (next === rest) return rest;
    rest = next.trimStart();
  }
}

function matchSlashCommand(text, aliases) {
  const stripped = stripLeadingMention(text);
  for (const alias of aliases) {
    const command = `/${alias}`;
    if (stripped === command) return { name: alias, args: "" };
    if (stripped.startsWith(`${command} `) || stripped.startsWith(`${command}\n`) || stripped.startsWith(`${command}\t`)) {
      return { name: alias, args: stripped.slice(command.length).trim() };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function delegateExtension(pi) {
  // --- Prevent recursive delegation ---
  // When this session is a delegated worker (has parentSession in header),
  // remove the delegate_task tool from the active tool set so the LLM
  // cannot see or attempt to call it.  The runtime assertNotNestedDelegate
  // guard remains as a defense-in-depth backstop.
  pi.on("session_start", async (_event, ctx) => {
    const header = ctx.sessionManager.getHeader();
    if (header?.parentSession) {
      // Use getAllTools() — getActiveTools() may return an empty list at
      // session_start time because tools haven't been activated yet.
      const allToolNames = pi.getAllTools().map((t) => t.name).filter((n) => n !== "delegate_task" && n !== "delegate_task_worktree");
      pi.setActiveTools(allToolNames);
    }
  });

  async function handleDelegateCommand(args, ctx) {
    const parsed = parseDelegateCommandInput(args);

    if (parsed.errors.length > 0) {
      const content = [`/${DELEGATE_COMMAND} could not parse the request.`, "", ...parsed.errors, "", formatDelegateHelp()].join("\n");
      if (ctx.hasUI) ctx.ui.notify(parsed.errors[0], "error");
      sendDelegateMessage(pi, content, { status: "error", errors: parsed.errors });
      return;
    }

    switch (parsed.subcommand) {
      case "help":
        sendDelegateMessage(pi, formatDelegateHelp(parsed.request.topic), { status: "help" });
        return;
      case "start":
      case "worktree":
        return handleStart(pi, ctx, parsed);
      case "list":
      case "status":
        return handleStatus(pi, ctx, parsed);
      case "result":
        return handleResult(pi, ctx, parsed);
      case "attach":
        return handleAttach(pi, ctx, parsed);
      case "open":
        return handleOpen(pi, ctx, parsed);
      case "clean":
        return handleClean(pi, ctx, parsed);
    }
  }

  // --- Command ---
  const commandSpec = {
    description: "Delegate work to forked worker sessions (worktree, status, result, attach, open, clean, help)",
    getArgumentCompletions: getDelegateArgumentCompletions,
    handler: handleDelegateCommand,
  };
  pi.registerCommand(DELEGATE_COMMAND, commandSpec);

  pi.on("input", async (event, ctx) => {
    const match = matchSlashCommand(event.text, [DELEGATE_COMMAND]);
    if (!match) return { action: "continue" };
    const messages = [];
    const originalSendMessage = pi.sendMessage;
    pi.sendMessage = (message) => messages.push(typeof message === "string" ? message : message?.content ?? JSON.stringify(message));
    try {
      await handleDelegateCommand(match.args, ctx);
      const text = messages.join("\n\n") || `/${DELEGATE_COMMAND} completed.`;
      return { action: "transform", text: `The remote /${DELEGATE_COMMAND} command completed. Reply to the user with this result exactly:\n\n${text}` };
    } catch (error) {
      return { action: "transform", text: `The remote /${DELEGATE_COMMAND} command failed. Reply to the user with this error:\n\n${error instanceof Error ? error.message : String(error)}` };
    } finally {
      pi.sendMessage = originalSendMessage;
    }
  });

  // --- Tool ---
  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: "Fork the current session and launch an ephemeral headless delegate for non-code or non-isolated work.",
    promptSnippet: "Delegate an independent task into a forked tmux worker session.",
    promptGuidelines: [
      "Use this tool only for independent workstreams with clear ownership boundaries.",
      "Delegated workers must never spawn more delegates; only the parent session may launch workers.",
      "Delegates run as detached headless tmux sessions; do not ask for pane/window targets.",
      "For software changes that need isolation, prefer delegate_task_worktree instead of guessing.",
      `The user-facing slash command is /${DELEGATE_COMMAND}.`,
    ],
    parameters: delegateSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // NOTE: ctx.compact() cannot run inside a tool execute() handler — the
      // agent loop is blocked waiting for this tool to return, so the LLM call
      // compact needs will never dispatch and the Promise hangs forever.
      // Compaction is only attempted from the /delegate command handler path which
      // calls ctx.waitForIdle() first.
      const rawBranchEntries = ctx.sessionManager.getBranch();
      const config = await getConfig();
      const runtime = buildRuntimeContext(ctx, rawBranchEntries, {
        excludeTrailingDelegateToolCall: true,
      });
      assertNotNestedDelegate(runtime.isDelegatedWorker, "launch new delegates");
      await enrichRuntimeWithNaming(pi, ctx, runtime, rawBranchEntries);
      const request = applyConfigDefaults(
        {
          task: params.task,
          target: "session",
          name: params.name,
          cwd: params.cwd,
          model: params.model,
          effort: params.effort,
          createWorktree: params.createWorktree ?? false,
        },
        config,
      );
      const result = await delegateTask(request, runtime);

      appendDelegateEntries(pi, result);

      // Persist to registry (best-effort)
      const scope = await getRegistryScope(ctx);
      if (scope) await persistLaunchToRegistry(result, scope);

      return {
        content: [{ type: "text", text: formatDelegateLaunchResult(result) }],
        details: result,
      };
    },
  });


  pi.registerTool({
    name: "delegate_task_worktree",
    label: "Delegate Task in Worktree",
    description: "Fork the current session, create an isolated same-repo worktree/branch, and launch an ephemeral headless delegate for code changes.",
    promptSnippet: "Delegate an isolated code-change task into a forked headless worker session.",
    promptGuidelines: [
      "Use for software changes where work should be isolated in its own branch/worktree.",
      "The delegate should commit changes, remove only its worktree when done, write its result JSON, and exit.",
      "The delegator decides whether/how to review or merge the branch.",
    ],
    parameters: delegateSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rawBranchEntries = ctx.sessionManager.getBranch();
      const config = await getConfig();
      const runtime = buildRuntimeContext(ctx, rawBranchEntries, { excludeTrailingDelegateToolCall: true });
      assertNotNestedDelegate(runtime.isDelegatedWorker, "launch new delegates");
      await enrichRuntimeWithNaming(pi, ctx, runtime, rawBranchEntries);
      const request = applyConfigDefaults({
        task: params.task,
        target: "session",
        name: params.name,
        cwd: params.cwd,
        model: params.model,
        effort: params.effort,
        createWorktree: true,
      }, config);
      const result = await delegateTask(request, runtime);
      appendDelegateEntries(pi, result);
      const scope = await getRegistryScope(ctx);
      if (scope) await persistLaunchToRegistry(result, scope);
      return { content: [{ type: "text", text: formatDelegateLaunchResult(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "delegate_status",
    label: "Delegate Status",
    description: "List delegates for the current scope or inspect one delegate by name/id.",
    parameters: Type.Object({ worker: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = await getRegistryScope(ctx);
      const result = await listWorkersForScope(scope, { env: process.env });
      const workers = params.worker ? result.workers.filter((w) => findWorkerByNameOrId(result.workers, params.worker)?.record.id === w.record.id) : result.workers;
      return { content: [{ type: "text", text: formatWorkerList(workers) }], details: { registryPath: result.registryPath, workers } };
    },
  });

  pi.registerTool({
    name: "delegate_result",
    label: "Delegate Result",
    description: "Read the structured JSON result written by a delegate.",
    parameters: Type.Object({ worker: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = await getRegistryScope(ctx);
      const result = await listWorkersForScope(scope, { env: process.env });
      const worker = findWorkerByNameOrId(result.workers, params.worker);
      if (!worker) throw new Error(`No worker found matching "${params.worker}".`);
      if (!worker.record.resultFile) throw new Error(`Worker "${worker.record.name}" has no result file recorded.`);
      const parsed = await readDelegateResultFile(worker.record.resultFile);
      if (!parsed) throw new Error(`No result written yet: ${worker.record.resultFile}`);
      return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }], details: { resultFile: worker.record.resultFile, result: parsed, worker } };
    },
  });

  // --- Message renderer ---
  pi.registerMessageRenderer(DELEGATE_MESSAGE_TYPE, (message, options, theme) => {
    const status = message.details?.status;
    const color = status === "error" ? "error" : status === "success" ? "success" : "accent";
    let text = theme.fg(color, `[${DELEGATE_COMMAND}] `) + String(message.content);
    if (options.expanded && message.details && typeof message.details === "object" && !Array.isArray(message.details)) {
      const safeDetails = { ...message.details };
      delete safeDetails.workers; // avoid dumping large lists
      text += "\n\n" + theme.fg("dim", JSON.stringify(safeDetails, null, 2));
    }
    return new Text(text, 0, 0);
  });
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function handleStart(pi, ctx, parsed) {
  await ctx.waitForIdle();

  try {
    assertNotNestedDelegate(Boolean(ctx.sessionManager.getHeader()?.parentSession), "launch new delegates");
    const config = await getConfig();
    const rawBranchEntries = ctx.sessionManager.getBranch();
    const request = applyConfigDefaults(parsed.request, config);
    const runtime = buildRuntimeContext(ctx, rawBranchEntries, {
    });
    await enrichRuntimeWithNaming(pi, ctx, runtime, rawBranchEntries);
    const result = await delegateTask(request, runtime);
    appendDelegateEntries(pi, result);

    // Persist to registry (best-effort)
    const scope = await getRegistryScope(ctx);
    if (scope) await persistLaunchToRegistry(result, scope);

    if (ctx.hasUI) ctx.ui.notify(`Launched ${result.worker.name} as headless tmux session`, "success");
    sendDelegateMessage(pi, formatDelegateLaunchResult(result), result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    sendDelegateMessage(pi, message, { status: "error" });
  }
}

async function handleStatus(pi, ctx, parsed = { request: {} }) {
  try {
    const scope = await getRegistryScope(ctx);
    const result = await listWorkersForScope(scope, { env: process.env });
    const worker = parsed.request?.nameOrId ? findWorkerByNameOrId(result.workers, parsed.request.nameOrId) : undefined;
    if (parsed.request?.nameOrId && !worker) {
      sendDelegateMessage(pi, `No worker found matching "${parsed.request.nameOrId}".`, { status: "error" });
      return;
    }
    const workers = worker ? [worker] : result.workers;
    sendDelegateMessage(pi, formatWorkerList(workers), { status: "success", workerCount: workers.length, registryPath: result.registryPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendDelegateMessage(pi, message, { status: "error" });
  }
}

async function handleResult(pi, ctx, parsed) {
  try {
    const scope = await getRegistryScope(ctx);
    const result = await listWorkersForScope(scope, { env: process.env });
    const worker = findWorkerByNameOrId(result.workers, parsed.request.nameOrId);
    if (!worker) {
      sendDelegateMessage(pi, `No worker found matching "${parsed.request.nameOrId}".`, { status: "error" });
      return;
    }
    if (!worker.record.resultFile) {
      sendDelegateMessage(pi, `Worker "${worker.record.name}" has no result file recorded.`, { status: "error" });
      return;
    }
    const parsedResult = await readDelegateResultFile(worker.record.resultFile);
    if (!parsedResult) {
      sendDelegateMessage(pi, `No result written yet: ${worker.record.resultFile}`, { status: "pending" });
      return;
    }
    sendDelegateMessage(pi, JSON.stringify(parsedResult, null, 2), { status: "success", resultFile: worker.record.resultFile, result: parsedResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendDelegateMessage(pi, message, { status: "error" });
  }
}

async function handleAttach(pi, ctx, parsed) {
  try {
    const scope = await getRegistryScope(ctx);
    if (!scope) {
      sendDelegateMessage(pi, "Not inside a git repository.", { status: "error" });
      return;
    }

    const result = await listWorkersForScope(scope, { env: process.env });
    const worker = findWorkerByNameOrId(result.workers, parsed.request.nameOrId);

    if (!worker) {
      sendDelegateMessage(pi, `No worker found matching "${parsed.request.nameOrId}".`, { status: "error" });
      return;
    }

    if (!worker.live) {
      const slug = worker.record.slug || worker.record.id;
      sendDelegateMessage(
        pi,
        `Worker "${worker.record.name}" is not live. Use /delegate open ${slug} to relaunch.`,
        { status: "error" },
      );
      return;
    }

    const { targetMode, targetId, sessionName } = getWorkerTmuxTarget(worker.record);
    await attachToTmuxTarget(targetMode, targetId, { env: process.env, sessionName });

    if (ctx.hasUI) ctx.ui.notify(`Attached to ${worker.record.name}`, "success");
    sendDelegateMessage(pi, `Attached to ${worker.record.name} (${targetMode} ${targetId}).`, { status: "success" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    sendDelegateMessage(pi, message, { status: "error" });
  }
}

async function handleOpen(pi, ctx, parsed) {
  try {
    const scope = await getRegistryScope(ctx);
    if (!scope) {
      sendDelegateMessage(pi, "Not inside a git repository.", { status: "error" });
      return;
    }

    const result = await listWorkersForScope(scope, { env: process.env });
    const worker = findWorkerByNameOrId(result.workers, parsed.request.nameOrId);

    if (!worker) {
      sendDelegateMessage(pi, `No worker found matching "${parsed.request.nameOrId}".`, { status: "error" });
      return;
    }

    if (worker.live) {
      const { targetMode, targetId, sessionName } = getWorkerTmuxTarget(worker.record);
      await attachToTmuxTarget(targetMode, targetId, { env: process.env, sessionName });
      if (ctx.hasUI) ctx.ui.notify(`Worker "${worker.record.name}" is live — attached`, "success");
      sendDelegateMessage(pi, `Worker "${worker.record.name}" is live. Attached to ${targetMode} ${targetId}.`, { status: "success" });
      return;
    }

    // Dead — relaunch
    const rawBranchEntries = ctx.sessionManager.getBranch();
    assertNotNestedDelegate(Boolean(ctx.sessionManager.getHeader()?.parentSession), "relaunch workers");
    const relaunch = await reopenWorker(worker.record, {
      env: process.env,
      piCommand: process.env.PI_EZ_DELEGATE_PI_COMMAND || "pi",
      model: parsed.request.model,
    });

    // Update registry
    const updatedRecord = {
      ...worker.record,
      targetMode: relaunch.launch.mode,
      targetId: relaunch.launch.targetId,
      sessionId: relaunch.launch.sessionId,
      tmuxSessionName: relaunch.launch.sessionName,
      model: parsed.request.model || worker.record.model,
    };
    await persistReopenToRegistry(updatedRecord, scope);

    if (ctx.hasUI) ctx.ui.notify(`Reopened ${worker.record.name} as headless tmux session`, "success");
    sendDelegateMessage(
      pi,
      `Reopened "${worker.record.name}" in headless tmux session ${relaunch.launch.targetId}.\nSwitch: ${relaunch.launch.attachHint}`,
      { status: "success" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    sendDelegateMessage(pi, message, { status: "error" });
  }
}

async function handleClean(pi, ctx, parsed) {
  try {
    const scope = await getRegistryScope(ctx);
    if (!scope) {
      sendDelegateMessage(pi, "Not inside a git repository.", { status: "error" });
      return;
    }

    const result = await listWorkersForScope(scope, { env: process.env });

    if (!parsed.request.yes) {
      sendDelegateMessage(pi, formatCleanPreview(result.workers), { status: "preview" });
      return;
    }

    const cleanResult = await cleanSafeWorkers(
      { scope, registry: result.registry, registryPath: result.registryPath },
      result.workers,
    );

    if (ctx.hasUI && cleanResult.cleaned.length > 0) {
      ctx.ui.notify(`Cleaned ${cleanResult.cleaned.length} worker(s).`, "success");
    }
    sendDelegateMessage(pi, formatCleanResult(cleanResult), { status: "success" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendDelegateMessage(pi, message, { status: "error" });
  }
}
