import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { basename } from "node:path";
import {
  DELEGATE_COMMAND,
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
  finishWorker,
  persistLaunchToRegistry,
  persistReopenToRegistry,
  formatWorkerList,
  formatCleanPreview,
  formatCleanResult,
  formatFinishResult,
  getWorkerTmuxTarget,
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

/**
 * Apply config-driven defaults to a start request.
 *
 * The parser in lib/delegate.js hardcodes target="pane" when the user does not
 * pass --target.  We detect this by checking whether the parsed target equals
 * the parser default ("pane") — if it does and the config specifies a different
 * defaultTarget, we override it.  When the user explicitly passes --target the
 * parsed value will already be what they asked for and either matches the
 * config default (no-op) or differs from "pane" (not overridden).
 *
 * The same strategy applies to split when the other worker wires --split into
 * the parser.
 */
function applyConfigDefaults(request, config) {
  const patched = { ...request };

  // Override target only when it is still the parser hardcoded default
  if (patched.target === "pane" && config.defaultTarget !== "pane") {
    patched.target = config.defaultTarget;
  }

  // Respect configured default pane split when request did not specify one.
  if ((patched.split === undefined || patched.split === "auto") && config.defaultPaneSplit && config.defaultPaneSplit !== "auto") {
    patched.split = config.defaultPaneSplit;
  }

  return patched;
}

function applyRuntimeConfig(runtime, config) {
  return {
    ...runtime,
    minPaneColumns: config.minPaneColumns,
    minPaneRows: config.minPaneRows,
  };
}

const delegateSchema = Type.Object({
  task: Type.String({ description: "Task prompt for the delegated worker" }),
  target: Type.Optional(StringEnum(DELEGATE_TARGETS)),
  name: Type.Optional(Type.String({ description: "Optional human-friendly worker name" })),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for the delegated worker" })),
  createWorktree: Type.Optional(
    Type.Boolean({ description: "Create an isolated worktree for same-repo delegation. Defaults to true." }),
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
      { value: "list", label: "list", description: "List workers" },
      { value: "attach ", label: "attach", description: "Attach to a live worker" },
      { value: "open ", label: "open", description: "Open a worker" },
      { value: "finish ", label: "finish", description: "Merge and clean up a completed dead worker" },
      { value: "clean ", label: "clean", description: "Clean dead workers" },
      { value: "help", label: "help", description: "Show help" },
    ];
    const flagItems = [
      { value: "--target ", label: "--target", description: "Launch worker in a pane, window, or session" },
      { value: "--name ", label: "--name", description: "Set a worker name" },
      { value: "--cwd ", label: "--cwd", description: "Use a different working directory" },
      { value: "--no-worktree", label: "--no-worktree", description: "Skip worktree creation" },
    ];
    return filterCompletionItems(current, [...subcommandItems, ...flagItems]);
  }

  // After first token: flag completions for start/implicit start
  if (!current || current.startsWith("--")) {
    return filterCompletionItems(current, [
      { value: "--target ", label: "--target", description: "Launch worker in a pane, window, or session" },
      { value: "--name ", label: "--name", description: "Set a worker name" },
      { value: "--cwd ", label: "--cwd", description: "Use a different working directory" },
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
    minPaneColumns: options.minPaneColumns,
    minPaneRows: options.minPaneRows,
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
  return new Promise((resolve, reject) => {
    try {
      ctx.compact({
        customInstructions: "Summarize the full conversation so far. A delegated worker will be forked from this session and needs maximum context budget.",
        onComplete: () => resolve(true),
        onError: (error) => reject(error),
      });
    } catch (error) {
      // ctx.compact() itself may throw synchronously (e.g. nothing to compact)
      resolve(false);
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
  } catch {
    // Compaction is best-effort — swallow errors and proceed.
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
  if (!gitContext) return undefined;
  return { key: gitContext.mainCheckoutPath, label: basename(gitContext.mainCheckoutPath) };
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
      const activeTools = pi.getActiveTools().map((t) => t.name).filter((n) => n !== "delegate_task");
      pi.setActiveTools(activeTools);
    }
  });

  // --- Command ---
  pi.registerCommand(DELEGATE_COMMAND, {
    description: "Delegate work to forked worker sessions (start, list, attach, open, clean, help)",
    getArgumentCompletions: getDelegateArgumentCompletions,
    handler: async (args, ctx) => {
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
          return handleStart(pi, ctx, parsed);
        case "list":
          return handleList(pi, ctx);
        case "attach":
          return handleAttach(pi, ctx, parsed);
        case "open":
          return handleOpen(pi, ctx, parsed);
        case "finish":
          return handleFinish(pi, ctx, parsed);
        case "clean":
          return handleClean(pi, ctx, parsed);
      }
    },
  });

  // --- Tool ---
  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: "Fork the current session, optionally create a same-repo worktree, and launch a delegated worker in tmux.",
    promptSnippet: "Delegate an independent task into a forked tmux worker session.",
    promptGuidelines: [
      "Use this tool only for independent workstreams with clear ownership boundaries.",
      "Delegated workers must never spawn more delegates; only the parent session may launch workers.",
      "Default to target pane unless the user explicitly asks for a different tmux target.",
      "Prefer createWorktree=true for same-repo coding work so delegated workers do not collide in the same checkout.",
      `The user-facing slash command is /${DELEGATE_COMMAND}.`,
    ],
    parameters: delegateSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await tryCompactBeforeFork(ctx);
      const rawBranchEntries = ctx.sessionManager.getBranch();
      const config = await getConfig();
      const runtime = buildRuntimeContext(ctx, rawBranchEntries, {
        excludeTrailingDelegateToolCall: true,
        minPaneColumns: config.minPaneColumns,
        minPaneRows: config.minPaneRows,
      });
      assertNotNestedDelegate(runtime.isDelegatedWorker, "launch new delegates");
      await enrichRuntimeWithNaming(pi, ctx, runtime, rawBranchEntries);
      const request = applyConfigDefaults(
        {
          task: params.task,
          target: params.target || "pane",
          name: params.name,
          cwd: params.cwd,
          createWorktree: params.createWorktree ?? true,
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
  await tryCompactBeforeFork(ctx, ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : undefined);
  const rawBranchEntries = ctx.sessionManager.getBranch();

  try {
    assertNotNestedDelegate(Boolean(ctx.sessionManager.getHeader()?.parentSession), "launch new delegates");
    const config = await getConfig();
    const request = applyConfigDefaults(parsed.request, config);
    const runtime = buildRuntimeContext(ctx, rawBranchEntries, {
      minPaneColumns: config.minPaneColumns,
      minPaneRows: config.minPaneRows,
    });
    await enrichRuntimeWithNaming(pi, ctx, runtime, rawBranchEntries);
    const result = await delegateTask(request, runtime);
    appendDelegateEntries(pi, result);

    // Persist to registry (best-effort)
    const scope = await getRegistryScope(ctx);
    if (scope) await persistLaunchToRegistry(result, scope);

    if (ctx.hasUI) ctx.ui.notify(`Launched ${result.worker.name} in tmux ${result.launch.mode}`, "success");
    sendDelegateMessage(pi, formatDelegateLaunchResult(result), result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    sendDelegateMessage(pi, message, { status: "error" });
  }
}

async function handleList(pi, ctx) {
  try {
    const scope = await getRegistryScope(ctx);
    if (!scope) {
      sendDelegateMessage(pi, "Not inside a git repository. Worker list requires a repo context.", { status: "error" });
      return;
    }

    const result = await listWorkersForScope(scope, { env: process.env });
    sendDelegateMessage(pi, formatWorkerList(result.workers), { status: "success", workerCount: result.workers.length });
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
        `Worker "${worker.record.name}" is not live. Use /ezdg open ${slug} to relaunch.`,
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
    const delegateState = getActiveDelegateState(rawBranchEntries);
    const originPaneId = delegateState?.originPaneId || process.env.TMUX_PANE;

    const relaunch = await reopenWorker(worker.record, {
      env: process.env,
      piCommand: process.env.PI_EZ_DELEGATE_PI_COMMAND || "pi",
      target: parsed.request.target,
      originPaneId,
    });

    // Update registry
    const updatedRecord = {
      ...worker.record,
      targetMode: relaunch.launch.mode,
      targetId: relaunch.launch.targetId,
      paneId: relaunch.launch.paneId,
      windowId: relaunch.launch.windowId,
      sessionId: relaunch.launch.sessionId,
      tmuxSessionName: relaunch.launch.sessionName,
      originPaneId: relaunch.launch.originPaneId,
      originWindowId: relaunch.launch.originWindowId,
    };
    await persistReopenToRegistry(updatedRecord, scope);

    if (ctx.hasUI) ctx.ui.notify(`Reopened ${worker.record.name} in ${relaunch.launch.mode}`, "success");
    sendDelegateMessage(
      pi,
      `Reopened "${worker.record.name}" in ${relaunch.launch.mode} ${relaunch.launch.targetId}.\nSwitch: ${relaunch.launch.attachHint}`,
      { status: "success" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    sendDelegateMessage(pi, message, { status: "error" });
  }
}

async function handleFinish(pi, ctx, parsed) {
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

    const finishResult = await finishWorker(
      { scope, registry: result.registry, registryPath: result.registryPath },
      worker,
    );

    if (ctx.hasUI) ctx.ui.notify(`Finished ${worker.record.name}`, "success");
    sendDelegateMessage(pi, formatFinishResult(finishResult), { status: "success" });
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
