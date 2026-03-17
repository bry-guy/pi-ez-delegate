import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { getTmuxPaneContext, launchInTmux } from "./tmux.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_SESSION_VERSION = 3;
const DEFAULT_PI_COMMAND = "pi";
const WORKTREE_BRANCH_PREFIX = "ezdg";
const EZ_WORKTREE_STATE_ENTRY_TYPE = "pi-ez-worktree-state";

export const DELEGATE_COMMAND = "ezdg";
export const DELEGATE_MESSAGE_TYPE = "pi-ez-delegate";
export const DELEGATE_REGISTRY_ENTRY_TYPE = "pi-ez-delegate-worker";
export const DELEGATE_STATE_ENTRY_TYPE = "pi-ez-delegate-state";
export const DELEGATE_TARGETS = ["pane", "window", "session"];

function stripQuotes(token) {
  return token.replace(/^("|')(.*)\1$/, "$2");
}

function tokenize(input) {
  return String(input || "").match(/(?:"[^"]*"|'[^']*'|\S+)/g) || [];
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

export function stripAtPrefix(value) {
  return typeof value === "string" && value.startsWith("@") ? value.slice(1) : value;
}

function expandHomePath(value) {
  if (typeof value !== "string" || !value.startsWith("~")) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(os.homedir(), value.slice(2));
  }
  return value;
}

export function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
  if (!slug) throw new Error("Worker name must contain at least one letter or number.");
  return slug;
}

function truncateWords(value, maxWords = 8) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");
}

export function deriveWorkerName(task, explicitName) {
  const baseName = String(explicitName || "").trim() || truncateWords(task, 8) || "worker";
  const slug = slugify(baseName);
  return {
    name: baseName,
    slug,
    sessionName: `${DELEGATE_COMMAND}:${baseName}`,
    tmuxName: `${DELEGATE_COMMAND}-${slug}`.slice(0, 48),
  };
}

export function normalizeTarget(value, options = {}) {
  const normalized = String(value || "pane").trim().toLowerCase();
  if (DELEGATE_TARGETS.includes(normalized)) return normalized;
  if (options.strict) throw new Error(`Unsupported target \"${value}\". Expected one of: ${DELEGATE_TARGETS.join(", ")}.`);
  return "pane";
}

export function parseDelegateCommandInput(input) {
  const tokens = tokenize(input).map(stripQuotes);
  const request = {
    task: "",
    target: "pane",
    name: undefined,
    cwd: undefined,
    createWorktree: true,
    help: false,
  };
  const errors = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") {
      request.help = true;
      continue;
    }
    if (token === "--no-worktree") {
      request.createWorktree = false;
      continue;
    }
    if (token === "--worktree") {
      request.createWorktree = true;
      continue;
    }
    if (token === "--target") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) {
        errors.push("Missing value for --target.");
        continue;
      }
      try {
        request.target = normalizeTarget(value, { strict: true });
      } catch (error) {
        errors.push(error.message);
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--target=")) {
      try {
        request.target = normalizeTarget(token.slice("--target=".length), { strict: true });
      } catch (error) {
        errors.push(error.message);
      }
      continue;
    }
    if (token === "--name") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) {
        errors.push("Missing value for --name.");
        continue;
      }
      request.name = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--name=")) {
      request.name = token.slice("--name=".length);
      continue;
    }
    if (token === "--cwd") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) {
        errors.push("Missing value for --cwd.");
        continue;
      }
      request.cwd = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      request.cwd = token.slice("--cwd=".length);
      continue;
    }
    if (token.startsWith("--")) {
      errors.push(`Unknown flag: ${token}`);
      continue;
    }
    request.task += request.task ? ` ${token}` : token;
  }

  return { request, errors };
}

export function validateDelegateRequest(input) {
  const normalized = {
    task: String(input?.task || "").trim(),
    target: normalizeTarget(input?.target, { strict: true }),
    name: input?.name ? String(input.name).trim() : undefined,
    cwd: input?.cwd ? String(input.cwd).trim() : undefined,
    createWorktree: input?.createWorktree ?? true,
  };
  if (!normalized.task) {
    throw new Error(`Usage: /${DELEGATE_COMMAND} [--target pane|window|session] [--name worker-name] [--cwd path] [--no-worktree] <task>`);
  }
  if (normalized.name && !normalized.name.trim()) {
    throw new Error("Worker name cannot be empty.");
  }
  return normalized;
}

export function formatDelegateHelp() {
  return [
    `Usage: /${DELEGATE_COMMAND} [--target pane|window|session] [--name worker-name] [--cwd path] [--no-worktree] <task>`,
    "",
    "Behavior:",
    "- forks the current conversation context into a worker session",
    "- launches the worker in tmux (pane by default)",
    "- creates a same-repo git worktree by default unless --no-worktree is used",
    "",
    "Examples:",
    `- /${DELEGATE_COMMAND} implement the GH Actions publish pipeline`,
    `- /${DELEGATE_COMMAND} --target window wire up bot-to-web auth`,
    `- /${DELEGATE_COMMAND} --cwd ~/dev/infra bootstrap Argo CD and Tailscale access`,
  ].join("\n");
}

function shellQuote(value) {
  const text = String(value ?? "");
  if (text.length === 0) return "''";
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function getDefaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(os.homedir(), ".pi", "agent");
}

export function getDefaultSessionDir(cwd) {
  const safePath = `--${String(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(getDefaultAgentDir(), "sessions", safePath);
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: options.maxBuffer ?? MAX_BUFFER,
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: 0 };
  } catch (error) {
    const result = {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? "",
      code: typeof error.code === "number" ? error.code : 1,
    };
    if (options.allowFailure) return result;
    throw new Error([`${command} ${args.join(" ")}`.trim(), result.stderr || result.stdout].filter(Boolean).join("\n\n"));
  }
}

async function runGit(cwd, args, options = {}) {
  return runCommand("git", args, { ...options, cwd });
}

async function gitStdout(cwd, args) {
  const { stdout } = await runGit(cwd, args);
  return stdout.trim();
}

async function branchExists(cwd, branch) {
  const result = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
  return result.code === 0;
}

function getNearestExistingPath(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function resolveInputPath(value, baseCwd) {
  const stripped = stripAtPrefix(value);
  if (!stripped) return baseCwd;
  const expanded = expandHomePath(stripped);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseCwd, expanded);
}

async function resolveExistingTargetCwd(value, baseCwd) {
  const resolved = resolveInputPath(value, baseCwd);
  if (!(await pathExists(resolved))) {
    throw new Error(`Working directory does not exist: ${resolved}`);
  }
  return realpath(resolved).catch(() => resolved);
}

async function getGitContext(cwd) {
  const existing = getNearestExistingPath(cwd);
  const topLevel = await gitStdout(existing, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
  if (!topLevel) return undefined;
  const commonDirRaw = await gitStdout(existing, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => undefined);
  const repoRootResolved = resolve(topLevel);
  const commonDirResolved = commonDirRaw ? resolve(commonDirRaw) : join(repoRootResolved, ".git");
  const repoRoot = await realpath(repoRootResolved).catch(() => repoRootResolved);
  const commonDir = await realpath(commonDirResolved).catch(() => commonDirResolved);
  const mainCheckoutResolved = dirname(commonDir);
  const mainCheckoutPath = await realpath(mainCheckoutResolved).catch(() => mainCheckoutResolved);
  const currentBranch = await gitStdout(existing, ["branch", "--show-current"]).catch(() => "");
  return {
    repoRoot,
    currentBranch,
    commonDir,
    mainCheckoutPath,
  };
}

export function getActiveEzWorktreeState(branchEntries) {
  let state;
  for (const entry of branchEntries || []) {
    if (entry?.type !== "custom" || entry.customType !== EZ_WORKTREE_STATE_ENTRY_TYPE) continue;
    if (!entry.data || entry.data.active === false) {
      state = undefined;
      continue;
    }
    state = entry.data;
  }
  return state;
}

export function getActiveDelegateState(branchEntries) {
  let state;
  for (const entry of branchEntries || []) {
    if (entry?.type !== "custom" || entry.customType !== DELEGATE_STATE_ENTRY_TYPE) continue;
    if (!entry.data || entry.data.active === false) {
      state = undefined;
      continue;
    }
    state = entry.data;
  }
  return state;
}

export function buildDelegateState(input = {}) {
  return {
    active: input.active ?? true,
    ...(normalizeOptionalString(input.workerId) ? { workerId: normalizeOptionalString(input.workerId) } : {}),
    ...(normalizeOptionalString(input.targetMode) ? { targetMode: normalizeOptionalString(input.targetMode) } : {}),
    ...(normalizeOptionalString(input.targetId) ? { targetId: normalizeOptionalString(input.targetId) } : {}),
    ...(normalizeOptionalString(input.paneId) ? { paneId: normalizeOptionalString(input.paneId) } : {}),
    ...(normalizeOptionalString(input.windowId) ? { windowId: normalizeOptionalString(input.windowId) } : {}),
    ...(normalizeOptionalString(input.sessionId) ? { sessionId: normalizeOptionalString(input.sessionId) } : {}),
    ...(normalizeOptionalString(input.originPaneId) ? { originPaneId: normalizeOptionalString(input.originPaneId) } : {}),
    ...(normalizeOptionalString(input.originWindowId) ? { originWindowId: normalizeOptionalString(input.originWindowId) } : {}),
  };
}

export function getParentEffectiveCwd(baseCwd, branchEntries) {
  const state = getActiveEzWorktreeState(branchEntries);
  if (!state?.active || !state.worktreePath) return baseCwd;
  const subdir = state.sessionSubdir && state.sessionSubdir !== "." ? state.sessionSubdir : "";
  return subdir ? join(state.worktreePath, subdir) : state.worktreePath;
}

export function getForkBranchEntries(branchEntries, options = {}) {
  const entries = [...(branchEntries || [])];
  if (!options.excludeTrailingDelegateToolCall || entries.length === 0) return entries;
  const last = entries.at(-1);
  if (
    last?.type === "message" &&
    last.message?.role === "assistant" &&
    Array.isArray(last.message?.content) &&
    last.message.content.some((part) => part?.type === "toolCall" && part.name === "delegate_task")
  ) {
    return entries.slice(0, -1);
  }
  return entries;
}

async function resolveDelegateOrigin(branchEntries, env, options = {}) {
  const activeState = getActiveDelegateState(branchEntries);
  const storedOriginPaneId = normalizeOptionalString(activeState?.originPaneId);

  if (storedOriginPaneId) {
    const storedOrigin = await getTmuxPaneContext({ env, paneId: storedOriginPaneId });
    if (storedOrigin) {
      return {
        originPaneId: storedOrigin.paneId,
        originWindowId: storedOrigin.windowId,
        source: "state",
      };
    }
    if (!options.allowMissingStoredOrigin) {
      throw new Error(`Stored origin pane no longer exists: ${storedOriginPaneId}. Retry with --target window or --target session.`);
    }
    return {
      originPaneId: storedOriginPaneId,
      originWindowId: normalizeOptionalString(activeState?.originWindowId),
      source: "state",
      missing: true,
    };
  }

  const currentOrigin = await getTmuxPaneContext({ env, paneId: env?.TMUX_PANE });
  if (!currentOrigin) {
    if (options.optional) return undefined;
    throw new Error("No tmux pane is available to anchor delegated pane splits.");
  }

  return {
    originPaneId: currentOrigin.paneId,
    originWindowId: currentOrigin.windowId,
    source: "env",
  };
}

function createEntryId(usedIds) {
  for (let index = 0; index < 100; index += 1) {
    const id = randomUUID().slice(0, 8);
    if (!usedIds.has(id)) return id;
  }
  const fallback = randomUUID();
  usedIds.add(fallback);
  return fallback;
}

export async function createForkedSessionFile({
  parentSessionFile,
  headerVersion,
  branchEntries,
  getLabel,
  targetCwd,
  sessionName,
  delegateState,
}) {
  const version = headerVersion ?? DEFAULT_SESSION_VERSION;
  const timestamp = new Date().toISOString();
  const sessionId = randomUUID();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionDir = getDefaultSessionDir(targetCwd);
  const sessionFile = join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);

  await mkdir(sessionDir, { recursive: true });

  const copiedEntries = (branchEntries || []).filter((entry) => entry?.type !== "label" && entry?.type !== "custom");
  const header = {
    type: "session",
    version,
    id: sessionId,
    timestamp,
    cwd: targetCwd,
    ...(parentSessionFile ? { parentSession: parentSessionFile } : {}),
  };

  const usedIds = new Set(copiedEntries.map((entry) => entry.id).filter(Boolean));
  const labelTargets = copiedEntries.map((entry) => entry.id).filter(Boolean);
  const extraEntries = [];
  let parentId = copiedEntries.at(-1)?.id ?? null;

  for (const targetId of labelTargets) {
    const label = getLabel?.(targetId);
    if (!label) continue;
    const labelId = createEntryId(usedIds);
    usedIds.add(labelId);
    extraEntries.push({
      type: "label",
      id: labelId,
      parentId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    });
    parentId = labelId;
  }

  if (sessionName) {
    const sessionInfoId = createEntryId(usedIds);
    usedIds.add(sessionInfoId);
    extraEntries.push({
      type: "session_info",
      id: sessionInfoId,
      parentId,
      timestamp: new Date().toISOString(),
      name: sessionName,
    });
    parentId = sessionInfoId;
  }

  if (delegateState && Object.keys(delegateState).length > 0) {
    const delegateStateId = createEntryId(usedIds);
    usedIds.add(delegateStateId);
    extraEntries.push({
      type: "custom",
      id: delegateStateId,
      parentId,
      timestamp: new Date().toISOString(),
      customType: DELEGATE_STATE_ENTRY_TYPE,
      data: delegateState,
    });
  }

  const lines = [header, ...copiedEntries, ...extraEntries].map((entry) => JSON.stringify(entry));
  await writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");

  return {
    sessionId,
    sessionFile,
    sessionDir,
    sessionName,
  };
}

async function createDelegatedWorktree({ cwd, workerSlug }) {
  const gitContext = await getGitContext(cwd);
  if (!gitContext) throw new Error(`Not inside a git repository: ${cwd}`);
  if (!gitContext.currentBranch) {
    throw new Error("Current checkout is detached. Delegated worktrees require a named branch.");
  }

  const baseDir = join(dirname(gitContext.mainCheckoutPath), ".pi-worktrees", basename(gitContext.mainCheckoutPath));
  let taskBranch = `${WORKTREE_BRANCH_PREFIX}/${workerSlug}`;
  let worktreePath = join(baseDir, workerSlug);
  let suffix = 2;

  while ((await branchExists(gitContext.mainCheckoutPath, taskBranch)) || (await pathExists(worktreePath))) {
    taskBranch = `${WORKTREE_BRANCH_PREFIX}/${workerSlug}-${suffix}`;
    worktreePath = join(baseDir, `${workerSlug}-${suffix}`);
    suffix += 1;
  }

  await mkdir(baseDir, { recursive: true });
  await runGit(gitContext.repoRoot, ["worktree", "add", "-b", taskBranch, worktreePath, gitContext.currentBranch]);

  return {
    created: true,
    repoRoot: gitContext.repoRoot,
    mainCheckoutPath: gitContext.mainCheckoutPath,
    worktreePath,
    taskBranch,
    baseBranch: gitContext.currentBranch,
  };
}

async function cleanupDelegatedWorktree(worktreeInfo) {
  if (!worktreeInfo?.created || !worktreeInfo.worktreePath || !worktreeInfo.taskBranch) return;
  const gitBase = worktreeInfo.mainCheckoutPath || worktreeInfo.repoRoot;
  if (!gitBase) return;
  await runGit(gitBase, ["worktree", "remove", "--force", worktreeInfo.worktreePath], { allowFailure: true }).catch(() => undefined);
  await runGit(gitBase, ["branch", "-D", worktreeInfo.taskBranch], { allowFailure: true }).catch(() => undefined);
}

export async function planDelegatedWorkspace({ currentCwd, requestedCwd, createWorktree, workerSlug }) {
  if (!createWorktree) {
    return {
      requested: false,
      created: false,
      reason: "disabled",
      effectiveCwd: requestedCwd,
    };
  }

  const currentGit = await getGitContext(currentCwd);
  const requestedGit = await getGitContext(requestedCwd);
  if (!currentGit || !requestedGit) {
    return {
      requested: true,
      created: false,
      reason: "not-git",
      effectiveCwd: requestedCwd,
    };
  }

  if (resolve(currentGit.mainCheckoutPath) !== resolve(requestedGit.mainCheckoutPath)) {
    return {
      requested: true,
      created: false,
      reason: "different-repo",
      effectiveCwd: requestedCwd,
    };
  }

  const worktree = await createDelegatedWorktree({ cwd: currentCwd, workerSlug });
  const sessionSubdir = relative(requestedGit.repoRoot, requestedCwd) || "";
  const effectiveCwd = sessionSubdir ? join(worktree.worktreePath, sessionSubdir) : worktree.worktreePath;
  await mkdir(effectiveCwd, { recursive: true });

  return {
    requested: true,
    created: true,
    reason: undefined,
    effectiveCwd,
    ...worktree,
  };
}

function buildTmuxCommand({ piCommand, sessionFile, prompt }) {
  return `${shellQuote(piCommand)} --session ${shellQuote(sessionFile)} ${shellQuote(prompt)}`;
}

export function buildDelegatedPrompt({ task, workerName, parentCwd, requestedCwd, effectiveCwd, worktree }) {
  const lines = [
    `You are a delegated worker launched via /${DELEGATE_COMMAND}.`,
    `Worker name: ${workerName}`,
    `Working directory: ${effectiveCwd}`,
  ];

  if (worktree?.created) {
    lines.push(`Isolated git worktree: ${worktree.worktreePath} (${worktree.taskBranch} based on ${worktree.baseBranch})`);
  }

  if (requestedCwd !== effectiveCwd) {
    lines.push(`Requested cwd before worktree translation: ${requestedCwd}`);
  }

  if (parentCwd !== effectiveCwd) {
    lines.push(`Parent session cwd: ${parentCwd}`);
    lines.push("The worker cwd differs from the parent. Inspect the actual files in this cwd before editing.");
  }

  lines.push("", "Task:", task.trim());
  return lines.join("\n");
}

function describeWorktree(worktree) {
  if (!worktree.requested) return "disabled";
  if (worktree.created) {
    return `${worktree.worktreePath} (${worktree.taskBranch} based on ${worktree.baseBranch})`;
  }
  if (worktree.reason === "different-repo") return "skipped (target cwd is a different repository)";
  if (worktree.reason === "not-git") return "skipped (cwd is not inside a git repository)";
  return "skipped";
}

export function formatDelegateLaunchResult(result) {
  const lines = [
    `Launched delegated worker ${result.worker.name}.`,
    `Session: ${result.session.sessionFile}`,
    `Cwd: ${result.cwd.effective}`,
    `Target: ${result.launch.adapter} ${result.launch.mode} ${result.launch.targetId}`,
    `Worktree: ${describeWorktree(result.worktree)}`,
    `Switch: ${result.launch.attachHint}`,
  ];
  if (result.launch.mode === "pane" && result.launch.originPaneId) {
    lines.splice(4, 0, `Origin: ${result.launch.originPaneId}${result.launch.originWindowId ? ` in ${result.launch.originWindowId}` : ""}`);
  }
  return lines.join("\n");
}

export async function delegateTask(request, runtime) {
  const normalized = validateDelegateRequest(request);
  const worker = {
    id: randomUUID(),
    ...deriveWorkerName(normalized.task, normalized.name),
  };
  const parentCwd = runtime.parentCwd;
  const requestedCwd = await resolveExistingTargetCwd(normalized.cwd, parentCwd);
  const worktree = await planDelegatedWorkspace({
    currentCwd: parentCwd,
    requestedCwd,
    createWorktree: normalized.createWorktree,
    workerSlug: worker.slug,
  });

  const env = runtime.env || process.env;
  const origin = await resolveDelegateOrigin(runtime.branchEntries, env, {
    allowMissingStoredOrigin: normalized.target !== "pane",
    optional: normalized.target !== "pane",
  });
  const sessionDelegateState = buildDelegateState({
    workerId: worker.id,
    targetMode: normalized.target,
    originPaneId: origin?.originPaneId,
    originWindowId: origin?.originWindowId,
  });

  let session;
  try {
    session = await createForkedSessionFile({
      parentSessionFile: runtime.parentSessionFile,
      headerVersion: runtime.headerVersion,
      branchEntries: runtime.branchEntries,
      getLabel: runtime.getLabel,
      targetCwd: worktree.effectiveCwd,
      sessionName: worker.sessionName,
      delegateState: sessionDelegateState,
    });

    const prompt = buildDelegatedPrompt({
      task: normalized.task,
      workerName: worker.name,
      parentCwd,
      requestedCwd,
      effectiveCwd: worktree.effectiveCwd,
      worktree,
    });

    const launch = await launchInTmux({
      target: normalized.target,
      cwd: worktree.effectiveCwd,
      workerName: worker.tmuxName,
      command: buildTmuxCommand({
        sessionFile: session.sessionFile,
        prompt,
        piCommand: runtime.piCommand || DEFAULT_PI_COMMAND,
      }),
      env,
      originPaneId: origin?.originPaneId,
    });

    const delegateState = buildDelegateState({
      ...sessionDelegateState,
      targetMode: launch.mode,
      targetId: launch.targetId,
      paneId: launch.paneId,
      windowId: launch.windowId,
      sessionId: launch.sessionId,
      originPaneId: launch.originPaneId ?? origin?.originPaneId,
      originWindowId: launch.originWindowId ?? origin?.originWindowId,
    });

    return {
      status: "success",
      request: normalized,
      launchedAt: new Date().toISOString(),
      parent: {
        cwd: parentCwd,
        sessionFile: runtime.parentSessionFile,
      },
      worker,
      session,
      cwd: {
        parent: parentCwd,
        requested: requestedCwd,
        effective: worktree.effectiveCwd,
      },
      worktree,
      launch,
      delegateState,
    };
  } catch (error) {
    if (session?.sessionFile) {
      await unlink(session.sessionFile).catch(() => undefined);
    }
    if (worktree?.created) {
      await cleanupDelegatedWorktree(worktree).catch(() => undefined);
    }
    throw error;
  }
}
