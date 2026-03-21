import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { planTmuxPaneLaunch } from "./layout.js";
import { getTmuxPaneContext, getTmuxWindowPanes, launchInTmux } from "./tmux.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_SESSION_VERSION = 3;
const DEFAULT_PI_COMMAND = "pi";

// Serialize pane-target launches so concurrent delegate_task calls see each
// other's panes when planning the layout (prevents duplicate vsplits).
let _paneLaunchQueue = Promise.resolve();

async function withPaneLaunchQueue(fn) {
  const run = _paneLaunchQueue.then(fn, fn);
  _paneLaunchQueue = run.catch(() => undefined);
  return run;
}
const WORKTREE_BRANCH_PREFIX = "ezdg";
const EZ_WORKTREE_STATE_ENTRY_TYPE = "pi-ez-worktree-state";

export const DELEGATE_COMMAND = "ezdg";
export const DELEGATE_MESSAGE_TYPE = "pi-ez-delegate";
export const DELEGATE_REGISTRY_ENTRY_TYPE = "pi-ez-delegate-worker";
export const DELEGATE_STATE_ENTRY_TYPE = "pi-ez-delegate-state";
export const DELEGATE_TARGETS = ["pane", "window", "session"];
export const DELEGATE_SUBCOMMANDS = ["start", "list", "attach", "open", "finish", "clean", "help"];
export const DELEGATE_SPLIT_MODES = ["auto", "horizontal", "vertical"];

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

export function resolveParentSessionName(branchEntries, gitContext) {
  // Scan for the latest session_info entry with a name
  let latestName;
  for (const entry of branchEntries || []) {
    if (entry?.type === "session_info" && entry.name) {
      latestName = String(entry.name).trim();
    }
  }
  if (latestName) {
    return { name: latestName, generated: false };
  }

  // Auto-generate from git context
  if (gitContext?.mainCheckoutPath) {
    const repoBase = basename(gitContext.mainCheckoutPath);
    const slug = String(repoBase || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 12);
    if (slug) {
      return { name: slug, generated: true };
    }
  }

  // Fallback: random short name
  return { name: `pi-${randomUUID().slice(0, 4)}`, generated: true };
}

export function deriveWorkerName(task, explicitName, options) {
  const parentSessionName = options?.parentSessionName;
  const delegateIndex = options?.delegateIndex;

  if (parentSessionName && delegateIndex != null) {
    const baseName = String(explicitName || "").trim() || truncateWords(task, 4) || "worker";
    const slug = slugify(baseName);
    const sessionName = `${parentSessionName}-dg-${delegateIndex}-${slug}`;
    return {
      name: baseName,
      slug,
      sessionName,
      tmuxName: sessionName.slice(0, 48),
    };
  }

  // Backward compat: no parent context
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

  if (tokens.length === 0) {
    return { subcommand: "help", request: { help: true }, errors: [] };
  }

  const first = tokens[0].toLowerCase();

  if (first === "help" || first === "--help" || first === "-h") {
    return { subcommand: "help", request: { help: true, topic: tokens[1] }, errors: [] };
  }
  if (first === "list") return { subcommand: "list", request: {}, errors: [] };
  if (first === "attach") return parseAttachSubcommand(tokens.slice(1));
  if (first === "open") return parseOpenSubcommand(tokens.slice(1));
  if (first === "finish") return parseFinishSubcommand(tokens.slice(1));
  if (first === "clean") return parseCleanSubcommand(tokens.slice(1));
  if (first === "start") return parseStartSubcommand(tokens.slice(1));

  // Implicit start (backward compat)
  return parseStartSubcommand(tokens);
}

export function normalizeSplit(value, options = {}) {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (DELEGATE_SPLIT_MODES.includes(normalized)) return normalized;
  if (options.strict) throw new Error(`Unsupported split mode "${value}". Expected one of: ${DELEGATE_SPLIT_MODES.join(", ")}.`);
  return "auto";
}

function parseStartSubcommand(tokens) {
  const request = {
    task: "",
    target: "pane",
    name: undefined,
    cwd: undefined,
    createWorktree: true,
    split: "auto",
    automerge: true,
    printMode: true,
    help: false,
  };
  const errors = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") {
      return { subcommand: "help", request: { help: true }, errors: [] };
    }
    if (token === "--no-worktree") {
      request.createWorktree = false;
      continue;
    }
    if (token === "--worktree") {
      request.createWorktree = true;
      continue;
    }
    if (token === "--no-automerge") {
      request.automerge = false;
      continue;
    }
    if (token === "--no-print") {
      request.printMode = false;
      continue;
    }
    if (token === "--print") {
      request.printMode = true;
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
    if (token === "--split") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) {
        errors.push("Missing value for --split.");
        continue;
      }
      try {
        request.split = normalizeSplit(value, { strict: true });
      } catch (error) {
        errors.push(error.message);
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--split=")) {
      try {
        request.split = normalizeSplit(token.slice("--split=".length), { strict: true });
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

  return { subcommand: "start", request, errors };
}

function parseAttachSubcommand(tokens) {
  const nameOrId = tokens.filter((t) => !t.startsWith("--")).join(" ").trim();
  if (!nameOrId) return { subcommand: "attach", request: {}, errors: ["Missing worker name or id."] };
  return { subcommand: "attach", request: { nameOrId }, errors: [] };
}

function parseOpenSubcommand(tokens) {
  const request = { nameOrId: "", target: undefined };
  const errors = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") {
      return { subcommand: "help", request: { help: true, topic: "open" }, errors: [] };
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
    if (token.startsWith("--")) {
      errors.push(`Unknown flag: ${token}`);
      continue;
    }
    request.nameOrId += request.nameOrId ? ` ${token}` : token;
  }

  if (!request.nameOrId) errors.push("Missing worker name or id.");
  return { subcommand: "open", request, errors };
}

function parseFinishSubcommand(tokens) {
  const nameOrId = tokens.filter((t) => !t.startsWith("--")).join(" ").trim();
  if (!nameOrId) return { subcommand: "finish", request: {}, errors: ["Missing worker name or id."] };
  return { subcommand: "finish", request: { nameOrId }, errors: [] };
}

function parseCleanSubcommand(tokens) {
  const yes = tokens.includes("--yes") || tokens.includes("-y");
  return { subcommand: "clean", request: { yes }, errors: [] };
}

export function validateDelegateRequest(input) {
  const normalized = {
    task: String(input?.task || "").trim(),
    target: normalizeTarget(input?.target, { strict: true }),
    name: input?.name ? String(input.name).trim() : undefined,
    cwd: input?.cwd ? String(input.cwd).trim() : undefined,
    createWorktree: input?.createWorktree ?? true,
    split: normalizeSplit(input?.split),
    automerge: input?.automerge ?? true,
    printMode: input?.printMode ?? true,
  };
  if (!normalized.task) {
    throw new Error(`Usage: /${DELEGATE_COMMAND} [--target pane|window|session] [--name worker-name] [--cwd path] [--no-worktree] [--no-print] <task>`);
  }
  if (normalized.name && !normalized.name.trim()) {
    throw new Error("Worker name cannot be empty.");
  }
  if (normalized.split !== "auto" && normalized.target !== "pane") {
    throw new Error(`--split is only supported with --target pane. Got --target ${normalized.target}.`);
  }
  return normalized;
}

export function formatDelegateHelp(topic) {
  if (topic === "start") {
    return [
      `Usage: /${DELEGATE_COMMAND} start [--target pane|window|session] [--name worker-name] [--cwd path] [--no-worktree] [--no-print] <task>`,
      "",
      "Fork the current session into a new worker.",
    ].join("\n");
  }
  if (topic === "list") return `Usage: /${DELEGATE_COMMAND} list\n\nList workers for the current repository.`;
  if (topic === "attach") return `Usage: /${DELEGATE_COMMAND} attach <name-or-id>\n\nSwitch to a live worker's tmux target.`;
  if (topic === "open") {
    return [
      `Usage: /${DELEGATE_COMMAND} open <name-or-id> [--target pane|window|session]`,
      "",
      "Attach to a live worker, or relaunch a dead one from its saved session.",
    ].join("\n");
  }
  if (topic === "finish") {
    return [
      `Usage: /${DELEGATE_COMMAND} finish <name-or-id>`,
      "",
      "Merge a completed dead worker back into the delegator branch, remove its worktree, and delete its worker branch.",
    ].join("\n");
  }
  if (topic === "clean") return `Usage: /${DELEGATE_COMMAND} clean [--yes]\n\nClean up dead workers that are safe to remove.`;

  return [
    `Usage: /${DELEGATE_COMMAND} <subcommand> [options]`,
    "",
    "Subcommands:",
    `  start [flags] <task>       Launch a new worker (default when no subcommand given)`,
    `  list                       List workers for the current repo`,
    `  attach <name-or-id>        Switch to a live worker`,
    `  open <name-or-id> [flags]  Attach if live, relaunch if dead`,
    `  finish <name-or-id>        Merge and clean up a completed dead worker`,
    `  clean [--yes]              Clean safe dead workers (preview without --yes)`,
    `  help [subcommand]          Show help`,
    "",
    "Start flags:",
    "  --target pane|window|session",
    "  --name <worker-name>",
    "  --cwd <path>",
    "  --no-worktree",
    "  --print                Exit when the delegated task completes (default)",
    "  --no-print             Keep worker interactive after task completes",
    "",
    "Examples:",
    `  /${DELEGATE_COMMAND} implement the GH Actions publish pipeline`,
    `  /${DELEGATE_COMMAND} start --target window wire up auth middleware`,
    `  /${DELEGATE_COMMAND} list`,
    `  /${DELEGATE_COMMAND} open my-worker`,
    `  /${DELEGATE_COMMAND} clean --yes`,
  ].join("\n");
}

export function shellQuote(value) {
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

export async function getGitContext(cwd) {
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

async function verifyCleanDelegatorCheckout(cwd) {
  const gitContext = await getGitContext(cwd);
  if (!gitContext) return { ok: true, skipped: true, reason: "not-git" };

  const statusOutput = await gitStdout(cwd, ["status", "--porcelain"]);
  if (statusOutput) {
    throw new Error(
      `Delegated launch requires a clean parent checkout on branch ${gitContext.currentBranch || "<detached>"}. Commit, stash, or discard local changes before launching a same-repo worker.`,
    );
  }

  const gitDir = await gitStdout(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]).catch(() => undefined);
  if (gitDir) {
    const rebaseInProgress = (await pathExists(join(gitDir, "rebase-merge"))) || (await pathExists(join(gitDir, "rebase-apply")));
    if (rebaseInProgress) {
      throw new Error(
        `Delegated launch requires a clean parent checkout, but branch ${gitContext.currentBranch || "<detached>"} is currently rebasing. Finish or abort the rebase before launching a same-repo worker.`,
      );
    }

    const mergeInProgress = await pathExists(join(gitDir, "MERGE_HEAD"));
    if (mergeInProgress) {
      throw new Error(
        `Delegated launch requires a clean parent checkout, but branch ${gitContext.currentBranch || "<detached>"} has a merge in progress. Finish or abort the merge before launching a same-repo worker.`,
      );
    }
  }

  return { ok: true, branch: gitContext.currentBranch, repoRoot: gitContext.repoRoot };
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

function shouldExcludeFromFork(entry) {
  return entry?.type === "label" || entry?.type === "custom";
}

export function sanitizeEntriesForFork(branchEntries) {
  const entries = [...(branchEntries || [])];
  const remappedParents = new Map();
  const kept = [];

  for (const entry of entries) {
    if (shouldExcludeFromFork(entry)) {
      if (entry.id) {
        remappedParents.set(entry.id, entry.parentId ?? null);
      }
      continue;
    }

    let resolvedParentId = entry.parentId ?? null;
    while (resolvedParentId && remappedParents.has(resolvedParentId)) {
      resolvedParentId = remappedParents.get(resolvedParentId);
    }

    if (resolvedParentId !== (entry.parentId ?? null)) {
      kept.push({ ...entry, parentId: resolvedParentId });
    } else {
      kept.push(entry);
    }
  }

  return kept;
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

  const copiedEntries = sanitizeEntriesForFork(branchEntries);
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

export function resolveDelegatedLaunchCwd(parentCwd, effectiveCwd) {
  return effectiveCwd || parentCwd;
}

export async function verifyDelegatedWorkspace(worktree, effectiveCwd) {
  if (!worktree?.created) {
    return {
      verified: false,
      skipped: true,
      reason: "no-worktree",
    };
  }

  const checkPath = effectiveCwd || worktree.worktreePath;
  const topLevel = await gitStdout(checkPath, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) {
    throw new Error(`Delegated worktree verification failed: ${checkPath} is not inside a git checkout.`);
  }

  const resolvedTopLevel = resolve(topLevel);
  const resolvedWorktreePath = resolve(worktree.worktreePath);
  if (resolvedTopLevel !== resolvedWorktreePath) {
    throw new Error(
      `Delegated worktree verification failed: expected toplevel ${resolvedWorktreePath}, got ${resolvedTopLevel}.`,
    );
  }

  const branch = await gitStdout(checkPath, ["branch", "--show-current"]);
  if (branch !== worktree.taskBranch) {
    throw new Error(
      `Delegated worktree verification failed: expected branch ${worktree.taskBranch}, got ${branch || "<detached>"}.`,
    );
  }

  const statusOutput = await gitStdout(checkPath, ["status", "--porcelain"]);
  if (statusOutput) {
    throw new Error(`Delegated worktree verification failed: expected a clean checkout, found pending changes.`);
  }

  return {
    verified: true,
    topLevel: resolvedTopLevel,
    branch,
    clean: true,
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

  await verifyCleanDelegatorCheckout(currentCwd);

  const worktree = await createDelegatedWorktree({ cwd: currentCwd, workerSlug });
  const requestedCwdResolved = await realpath(requestedCwd).catch(() => resolve(requestedCwd));
  const sessionSubdir = relative(requestedGit.repoRoot, requestedCwdResolved) || "";
  const effectiveCwd = sessionSubdir ? join(worktree.worktreePath, sessionSubdir) : worktree.worktreePath;
  await mkdir(effectiveCwd, { recursive: true });
  const verification = await verifyDelegatedWorkspace(worktree, effectiveCwd);

  return {
    requested: true,
    created: true,
    reason: undefined,
    effectiveCwd,
    verification,
    ...worktree,
  };
}

function buildTmuxCommand({ piCommand, sessionFile, prompt, printMode }) {
  const parts = [shellQuote(piCommand)];
  if (printMode) parts.push("-p");
  parts.push("--session", shellQuote(sessionFile));
  if (prompt) parts.push(shellQuote(prompt));
  return parts.join(" ");
}

export function buildDelegatedFinishCommand(worktree) {
  if (!worktree?.created || !worktree.mainCheckoutPath || !worktree.taskBranch || !worktree.worktreePath) {
    return undefined;
  }

  const mcp = shellQuoteForPrompt(worktree.mainCheckoutPath);
  const tb = worktree.taskBranch;
  const wp = shellQuoteForPrompt(worktree.worktreePath);

  return [
    `cd ${mcp}`,
    'gdir="$(git rev-parse --path-format=absolute --git-dir)"',
    "git diff --quiet",
    "git diff --cached --quiet",
    'test ! -e "$gdir/MERGE_HEAD"',
    'test ! -d "$gdir/rebase-merge"',
    'test ! -d "$gdir/rebase-apply"',
    `git merge ${tb}`,
    `git worktree remove --force ${wp}`,
    `git branch -d ${tb}`,
  ].join(" && ");
}

export function buildDelegatedPrompt({ task, workerName, parentCwd, requestedCwd, effectiveCwd, worktree, automerge, workerSlug }) {
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

  if (worktree?.created) {
    lines.push(
      "",
      "When your task is complete, commit all changes to your branch and exit.",
      "Do NOT attempt to merge, remove the worktree, or delete the branch yourself.",
      `The delegator will handle merging via ${buildFinishHint(workerSlug)}.`,
    );
  }

  return lines.join("\n");
}

function buildFinishHint(workerSlug) {
  return workerSlug ? `/ezdg finish ${workerSlug}` : "/ezdg finish <worker-name>";
}

function shellQuoteForPrompt(value) {
  if (/\s/.test(value)) return `'${value}'`;
  return value;
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
    ...deriveWorkerName(normalized.task, normalized.name, {
      parentSessionName: runtime.parentSessionName,
      delegateIndex: runtime.delegateIndex,
    }),
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
      automerge: normalized.automerge,
    });

    // Plan pane layout and launch the tmux target.
    // Pane launches are serialized so concurrent delegate_task calls see each
    // other's panes when planning the rail layout (prevents duplicate vsplits).
    const launchCwd = resolveDelegatedLaunchCwd(parentCwd, worktree.effectiveCwd);
    const tmuxCommand = buildTmuxCommand({
      sessionFile: session.sessionFile,
      prompt,
      piCommand: runtime.piCommand || DEFAULT_PI_COMMAND,
      printMode: normalized.printMode,
    });

    const doLaunch = async () => {
      let effectiveOriginPaneId = origin?.originPaneId;
      let splitDirection;
      if (normalized.target === "pane" && origin?.originWindowId) {
        const panes = await getTmuxWindowPanes(origin.originWindowId, { env });
        if (panes.length > 0) {
          const railPaneIds = panes.map((p) => p.paneId).filter((id) => id !== origin.originPaneId);
          const layoutPlan = planTmuxPaneLaunch({
            panes,
            originPaneId: origin.originPaneId,
            splitPreference: normalized.split,
            minPaneColumns: runtime.minPaneColumns ?? 180,
            minPaneRows: runtime.minPaneRows ?? 28,
            windowWidth: panes[0]?.windowWidth,
            railPaneIds,
          });
          effectiveOriginPaneId = layoutPlan.targetPaneId;
          splitDirection = layoutPlan.splitMode;
        }
      }

      return launchInTmux({
        target: normalized.target,
        cwd: launchCwd,
        workerName: worker.tmuxName,
        command: tmuxCommand,
        env,
        originPaneId: effectiveOriginPaneId,
        splitDirection,
      });
    };

    const launch = normalized.target === "pane" ? await withPaneLaunchQueue(doLaunch) : await doLaunch();

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
