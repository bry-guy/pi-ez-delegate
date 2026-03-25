import { execFile } from "node:child_process";
import { access, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  readWorkerRegistry,
  writeWorkerRegistry,
  upsertWorkerRecord,
  createWorkerRegistryRecord,
} from "./registry.js";
import { isTmuxTargetLive, attachToTmuxTarget, launchInTmux, formatTmuxAttachHint } from "./tmux.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

export const WORKER_STATUS = Object.freeze({
  LIVE: "live",
  DEAD_NEEDS_ATTENTION: "dead-needs-attention",
  DEAD_SAFE_TO_CLEAN: "dead-safe-to-clean",
  STALE: "stale",
});

const STATUS_ORDER = [WORKER_STATUS.LIVE, WORKER_STATUS.DEAD_NEEDS_ATTENTION, WORKER_STATUS.DEAD_SAFE_TO_CLEAN, WORKER_STATUS.STALE];

const STATUS_LABELS = {
  [WORKER_STATUS.LIVE]: "Live",
  [WORKER_STATUS.DEAD_NEEDS_ATTENTION]: "Needs Attention",
  [WORKER_STATUS.DEAD_SAFE_TO_CLEAN]: "Safe to Clean",
  [WORKER_STATUS.STALE]: "Stale",
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, { cwd: options.cwd, maxBuffer: MAX_BUFFER });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message ?? "", code: typeof error.code === "number" ? error.code : 1 };
  }
}

async function gitStdout(cwd, args) {
  const result = await runCommand("git", args, { cwd });
  return result.code === 0 ? result.stdout.trim() : "";
}

// ---------------------------------------------------------------------------
// Git state inspection
// ---------------------------------------------------------------------------

async function inspectGitState(worktreePath, baseBranch) {
  if (!worktreePath) return undefined;
  if (!(await pathExists(worktreePath))) return { exists: false };

  const topLevel = await gitStdout(worktreePath, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) return { exists: true, isGit: false };

  const statusOutput = await gitStdout(worktreePath, ["status", "--porcelain"]);
  const isDirty = statusOutput.length > 0;

  let aheadCount = 0;
  if (baseBranch) {
    const countStr = await gitStdout(worktreePath, ["rev-list", "--count", `${baseBranch}..HEAD`]);
    aheadCount = parseInt(countStr, 10) || 0;
  }

  const gitDir = await gitStdout(worktreePath, ["rev-parse", "--git-dir"]);
  let rebaseInProgress = false;
  let mergeInProgress = false;
  if (gitDir) {
    rebaseInProgress = (await pathExists(join(gitDir, "rebase-merge"))) || (await pathExists(join(gitDir, "rebase-apply")));
    mergeInProgress = await pathExists(join(gitDir, "MERGE_HEAD"));
  }

  return { exists: true, isGit: true, isDirty, aheadCount, rebaseInProgress, mergeInProgress };
}

function summarizeGitState(gitState) {
  if (!gitState || !gitState.exists) return "missing";
  if (!gitState.isGit) return "not git";
  const parts = [];
  if (gitState.isDirty) parts.push("dirty");
  if (gitState.aheadCount > 0) parts.push(`ahead by ${gitState.aheadCount}`);
  if (gitState.rebaseInProgress) parts.push("rebase in progress");
  if (gitState.mergeInProgress) parts.push("merge in progress");
  return parts.length > 0 ? parts.join(", ") : "clean";
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classifyWorker(live, sessionExists, workspaceExists, gitState) {
  if (live) return WORKER_STATUS.LIVE;
  if (!sessionExists && !workspaceExists) return WORKER_STATUS.STALE;

  const hasUnsafeState =
    gitState?.isDirty || (gitState?.aheadCount ?? 0) > 0 || gitState?.rebaseInProgress || gitState?.mergeInProgress;
  if (hasUnsafeState) return WORKER_STATUS.DEAD_NEEDS_ATTENTION;
  return WORKER_STATUS.DEAD_SAFE_TO_CLEAN;
}

export function getWorkerLivenessProbePlan(record) {
  if (record?.targetMode === "pane") {
    return record?.paneId ? [{ mode: "pane", targetId: record.paneId }] : [];
  }
  if (record?.targetMode === "window") {
    return record?.windowId ? [{ mode: "window", targetId: record.windowId }] : [];
  }
  if (record?.targetMode === "session") {
    return record?.sessionId ? [{ mode: "session", targetId: record.sessionId }] : [];
  }

  const probes = [];
  if (record?.paneId) probes.push({ mode: "pane", targetId: record.paneId });
  if (record?.windowId) probes.push({ mode: "window", targetId: record.windowId });
  if (record?.sessionId) probes.push({ mode: "session", targetId: record.sessionId });
  return probes;
}

export function getWorkerTmuxTarget(record, options = {}) {
  const defaultMode = options.defaultMode || "pane";
  const targetMode = record?.targetMode || defaultMode;

  let targetId;
  if (targetMode === "pane") targetId = record?.paneId;
  else if (targetMode === "window") targetId = record?.windowId;
  else if (targetMode === "session") targetId = record?.sessionId;

  if (!targetId && options.allowFallback !== false) {
    targetId = record?.paneId || record?.windowId || record?.sessionId;
  }

  return {
    targetMode,
    targetId,
    sessionName: record?.tmuxSessionName || record?.slug || targetId,
  };
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export async function inspectWorker(record, options = {}) {
  const env = options.env || process.env;

  let live = false;
  for (const probe of getWorkerLivenessProbePlan(record)) {
    live = await isTmuxTargetLive(probe.mode, probe.targetId, { env });
    if (live) break;
  }

  const sessionExists = record.childSessionFile ? await pathExists(record.childSessionFile) : false;
  const effectiveCwd = record.effectiveCwd || record.worktreePath;
  const workspaceExists = effectiveCwd ? await pathExists(effectiveCwd) : false;
  const gitState = await inspectGitState(record.worktreePath, record.baseBranch);
  const status = classifyWorker(live, sessionExists, workspaceExists, gitState);

  return {
    record,
    live,
    sessionExists,
    workspaceExists,
    gitState,
    gitSummary: summarizeGitState(gitState),
    status,
    statusLabel: STATUS_LABELS[status] || status,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export async function listWorkersForScope(scope, options = {}) {
  const loaded = await readWorkerRegistry({ scopeKey: scope.key, scopeLabel: scope.label, agentDir: options.agentDir });
  if (!loaded.exists || loaded.registry.workers.length === 0) {
    return { registryPath: loaded.registryPath, workers: [], scope, registry: loaded.registry };
  }

  const activeWorkers = loaded.registry.workers.filter((w) => !w.cleanedAt);
  const inspected = await Promise.all(activeWorkers.map((w) => inspectWorker(w, options)));

  inspected.sort((a, b) => {
    const statusDiff = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (statusDiff !== 0) return statusDiff;
    return (b.record.launchedAt || "").localeCompare(a.record.launchedAt || "");
  });

  return { registryPath: loaded.registryPath, workers: inspected, scope, registry: loaded.registry };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export function findWorkerByNameOrId(inspectedWorkers, nameOrId) {
  const query = String(nameOrId || "").trim().toLowerCase();
  if (!query) return undefined;

  const byId = inspectedWorkers.find((w) => w.record.id === nameOrId);
  if (byId) return byId;

  const bySlug = inspectedWorkers.find((w) => w.record.slug?.toLowerCase() === query);
  if (bySlug) return bySlug;

  const byName = inspectedWorkers.find((w) => w.record.name?.toLowerCase() === query);
  if (byName) return byName;

  const byIdPrefix = inspectedWorkers.filter((w) => w.record.id?.toLowerCase().startsWith(query));
  if (byIdPrefix.length === 1) return byIdPrefix[0];

  const bySlugPrefix = inspectedWorkers.filter((w) => w.record.slug?.toLowerCase().startsWith(query));
  if (bySlugPrefix.length === 1) return bySlugPrefix[0];

  const byNameContains = inspectedWorkers.filter((w) => w.record.name?.toLowerCase().includes(query));
  if (byNameContains.length === 1) return byNameContains[0];

  return undefined;
}

// ---------------------------------------------------------------------------
// Reopen
// ---------------------------------------------------------------------------

export async function reopenWorker(record, options = {}) {
  const env = options.env || process.env;
  const piCommand = options.piCommand || "pi";
  const targetMode = options.target || record.targetMode || "window";
  const workerTmuxName = record.tmuxSessionName || record.slug || record.name || "worker";

  if (!record.childSessionFile || !(await pathExists(record.childSessionFile))) {
    throw new Error(`Session file missing: ${record.childSessionFile || "<none>"}. Cannot reopen.`);
  }

  const effectiveCwd = record.effectiveCwd || record.worktreePath || record.requestedCwd;
  if (!effectiveCwd || !(await pathExists(effectiveCwd))) {
    throw new Error(`Working directory missing: ${effectiveCwd || "<none>"}. Cannot reopen.`);
  }

  const command = `${shellQuote(piCommand)} --session ${shellQuote(record.childSessionFile)}`;
  const originPaneId = options.originPaneId || record.originPaneId;

  const launch = await launchInTmux({
    target: targetMode,
    cwd: effectiveCwd,
    workerName: workerTmuxName,
    command,
    env,
    originPaneId,
  });

  return { record, launch, effectiveCwd, sessionFile: record.childSessionFile };
}

// ---------------------------------------------------------------------------
// Registry persistence (after launch)
// ---------------------------------------------------------------------------

export async function persistLaunchToRegistry(result, scope) {
  try {
    const record = createWorkerRegistryRecord(result);
    const loaded = await readWorkerRegistry({ scopeKey: scope.key, scopeLabel: scope.label });
    const updated = upsertWorkerRecord(loaded.registry, record);
    await writeWorkerRegistry({ registry: updated, registryPath: loaded.registryPath });
  } catch {
    // best-effort
  }
}

export async function persistReopenToRegistry(updatedRecord, scope) {
  try {
    const loaded = await readWorkerRegistry({ scopeKey: scope.key, scopeLabel: scope.label });
    const updated = upsertWorkerRecord(loaded.registry, updatedRecord);
    await writeWorkerRegistry({ registry: updated, registryPath: loaded.registryPath });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Finish
// ---------------------------------------------------------------------------

async function verifyFinishableBaseCheckout(baseCwd) {
  const dirty = await runCommand("git", ["-C", baseCwd, "diff", "--quiet"]);
  if (dirty.code !== 0) {
    throw new Error("Cannot finish worker: the delegator branch has unstaged changes. Commit, stash, or discard them first.");
  }

  const staged = await runCommand("git", ["-C", baseCwd, "diff", "--cached", "--quiet"]);
  if (staged.code !== 0) {
    throw new Error("Cannot finish worker: the delegator branch has staged changes. Commit, stash, or discard them first.");
  }

  const gitDir = await gitStdout(baseCwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  if (gitDir) {
    if (await pathExists(join(gitDir, "MERGE_HEAD"))) {
      throw new Error("Cannot finish worker: the delegator branch has a merge in progress.");
    }
    if ((await pathExists(join(gitDir, "rebase-merge"))) || (await pathExists(join(gitDir, "rebase-apply")))) {
      throw new Error("Cannot finish worker: the delegator branch is rebasing.");
    }
  }
}

export async function finishWorker(registryResult, worker) {
  const inspected = worker?.record ? worker : { record: worker };
  const r = inspected.record;
  const baseCwd = registryResult.scope?.key || r.requestedCwd || r.effectiveCwd;

  if (!r) throw new Error("Worker record is required.");
  if (inspected.live) {
    throw new Error(`Cannot finish worker "${r.name || r.id}" while it is still live. Close the worker first, then run /ezdg finish.`);
  }
  if (!baseCwd) throw new Error("Cannot determine the delegator checkout for this worker.");
  if (!r.taskBranch) throw new Error(`Worker "${r.name || r.id}" has no delegated branch to merge.`);

  await verifyFinishableBaseCheckout(baseCwd);

  const actions = [];
  const merge = await runCommand("git", ["-C", baseCwd, "merge", r.taskBranch]);
  if (merge.code !== 0) {
    throw new Error(merge.stderr || merge.stdout || `Could not merge ${r.taskBranch} into the delegator branch.`);
  }
  actions.push(`merged ${r.taskBranch}`);

  if (r.worktreePath && (await pathExists(r.worktreePath))) {
    const removeWorktree = await runCommand("git", ["-C", baseCwd, "worktree", "remove", "--force", r.worktreePath]);
    if (removeWorktree.code !== 0) {
      throw new Error(removeWorktree.stderr || removeWorktree.stdout || `Could not remove worktree ${r.worktreePath}.`);
    }
    actions.push("removed worktree");
  }

  const deleteBranch = await runCommand("git", ["-C", baseCwd, "branch", "-d", r.taskBranch]);
  if (deleteBranch.code !== 0) {
    throw new Error(deleteBranch.stderr || deleteBranch.stdout || `Could not delete branch ${r.taskBranch}.`);
  }
  actions.push(`deleted branch ${r.taskBranch}`);

  if (r.childSessionFile && (await pathExists(r.childSessionFile))) {
    await unlink(r.childSessionFile).catch(() => undefined);
    actions.push("deleted session");
  }

  if (registryResult.registry) {
    const now = new Date().toISOString();
    const updatedWorkers = registryResult.registry.workers.map((w) =>
      w.id === r.id ? { ...w, cleanedAt: now, updatedAt: now } : w,
    );
    const updatedRegistry = { ...registryResult.registry, workers: updatedWorkers, updatedAt: now };
    await writeWorkerRegistry({ registry: updatedRegistry, registryPath: registryResult.registryPath });
  }

  return { record: r, actions };
}

export function formatFinishResult(result) {
  if (Array.isArray(result)) {
    if (result.length === 0) return "No workers were ready to finish.";
    return result.map((entry) => (entry.error ? `Failed ${entry.record.name || entry.record.id}: ${entry.error}` : formatFinishResult(entry))).join("\n");
  }
  return `Finished ${result.record.name || result.record.id}: ${result.actions.join(", ")}`;
}

/**
 * Sequentially finish every dead worker that is ready to merge back.
 */
export async function finishAllWorkers(registryResult, inspectedWorkers) {
  const finishable = inspectedWorkers.filter(
    (w) =>
      !w.live &&
      w.record?.taskBranch &&
      w.gitState?.exists &&
      w.gitState?.isGit &&
      !w.gitState?.isDirty &&
      !w.gitState?.rebaseInProgress &&
      !w.gitState?.mergeInProgress &&
      (w.gitState?.aheadCount ?? 0) > 0,
  );

  const results = [];
  let currentRegistry = registryResult.registry;
  for (const worker of finishable) {
    try {
      const result = await finishWorker({ ...registryResult, registry: currentRegistry }, worker);
      results.push(result);
      const reloaded = await readWorkerRegistry({
        registryPath: registryResult.registryPath,
        scopeKey: registryResult.scope?.key,
        scopeLabel: registryResult.scope?.label,
      });
      currentRegistry = reloaded.registry;
    } catch (error) {
      results.push({
        record: worker.record,
        actions: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Clean
// ---------------------------------------------------------------------------

export async function cleanSafeWorkers(registryResult, inspectedWorkers) {
  const scopeKey = registryResult.scope?.key;
  const cleaned = [];
  const skipped = [];
  const needsAttention = inspectedWorkers.filter((w) => w.status === WORKER_STATUS.DEAD_NEEDS_ATTENTION);
  const safeWorkers = inspectedWorkers.filter((w) => w.status === WORKER_STATUS.DEAD_SAFE_TO_CLEAN);

  for (const worker of safeWorkers) {
    const actions = [];
    const r = worker.record;

    try {
      if (worker.sessionExists && r.childSessionFile) {
        await unlink(r.childSessionFile).catch(() => undefined);
        actions.push("deleted session");
      }
      if (worker.workspaceExists && r.worktreePath) {
        const gitBase = scopeKey || r.requestedCwd || r.effectiveCwd;
        if (gitBase) {
          await runCommand("git", ["-C", gitBase, "worktree", "remove", "--force", r.worktreePath]);
          actions.push("removed worktree");
        }
      }
      if (r.taskBranch) {
        const gitBase = scopeKey || r.requestedCwd || r.effectiveCwd;
        if (gitBase) {
          await runCommand("git", ["-C", gitBase, "branch", "-D", r.taskBranch]);
          actions.push("deleted branch");
        }
      }
      cleaned.push({ record: r, actions });
    } catch (error) {
      skipped.push({ record: r, reason: error.message || String(error) });
    }
  }

  if (cleaned.length > 0 && registryResult.registry) {
    const cleanedIds = new Set(cleaned.map((c) => c.record.id));
    const now = new Date().toISOString();
    const updatedWorkers = registryResult.registry.workers.map((w) =>
      cleanedIds.has(w.id) ? { ...w, cleanedAt: now, updatedAt: now } : w,
    );
    const updatedRegistry = { ...registryResult.registry, workers: updatedWorkers, updatedAt: now };
    await writeWorkerRegistry({ registry: updatedRegistry, registryPath: registryResult.registryPath });
  }

  return { cleaned, skipped, needsAttention };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatWorkerList(inspectedWorkers) {
  if (inspectedWorkers.length === 0) return "No workers found in the registry.";

  const grouped = {};
  for (const status of STATUS_ORDER) {
    const workers = inspectedWorkers.filter((w) => w.status === status);
    if (workers.length > 0) grouped[status] = workers;
  }

  const lines = [];
  for (const [status, workers] of Object.entries(grouped)) {
    lines.push(`\n${STATUS_LABELS[status]} (${workers.length}):`);
    for (const w of workers) {
      const r = w.record;
      const name = r.name || r.slug || r.id;
      const task = r.taskSummary ? ` — ${r.taskSummary}` : "";
      const target = r.targetMode ? ` [${r.targetMode}]` : "";
      const git = w.gitSummary && w.gitSummary !== "missing" ? ` (${w.gitSummary})` : "";
      const branch = r.taskBranch ? ` ${r.taskBranch}` : "";
      lines.push(`  ${name}${task}${target}${branch}${git}`);
      if (status === WORKER_STATUS.DEAD_NEEDS_ATTENTION) {
        lines.push(`    → /ezdg open ${r.slug || r.id} to resume`);
      }
    }
  }

  return lines.join("\n");
}

export function formatCleanPreview(inspectedWorkers) {
  const safe = inspectedWorkers.filter((w) => w.status === WORKER_STATUS.DEAD_SAFE_TO_CLEAN);
  const attention = inspectedWorkers.filter((w) => w.status === WORKER_STATUS.DEAD_NEEDS_ATTENTION);
  if (safe.length === 0 && attention.length === 0) return "No dead workers to clean.";

  const lines = [];
  if (safe.length > 0) {
    lines.push(`Will clean ${safe.length} worker(s):`);
    for (const w of safe) {
      const r = w.record;
      const parts = [];
      if (w.sessionExists) parts.push("session");
      if (w.workspaceExists) parts.push("worktree");
      if (r.taskBranch) parts.push(`branch ${r.taskBranch}`);
      lines.push(`  ${r.name || r.id}: ${parts.join(", ") || "registry entry"}`);
    }
  }
  if (attention.length > 0) {
    lines.push(`\nSkipping ${attention.length} worker(s) that need attention:`);
    for (const w of attention) {
      lines.push(`  ${w.record.name || w.record.id} — ${w.gitSummary}`);
    }
  }
  if (safe.length > 0) {
    lines.push("\nRun /ezdg clean --yes to proceed.");
  }
  return lines.join("\n");
}

export function formatCleanResult(result) {
  const lines = [];
  if (result.cleaned.length > 0) {
    lines.push(`Cleaned ${result.cleaned.length} worker(s):`);
    for (const c of result.cleaned) {
      lines.push(`  ${c.record.name || c.record.id}: ${c.actions.join(", ")}`);
    }
  }
  if (result.skipped.length > 0) {
    lines.push(`\nSkipped ${result.skipped.length} worker(s):`);
    for (const s of result.skipped) {
      lines.push(`  ${s.record.name || s.record.id}: ${s.reason}`);
    }
  }
  if (result.needsAttention.length > 0) {
    lines.push(`\n${result.needsAttention.length} worker(s) need attention:`);
    for (const w of result.needsAttention) {
      lines.push(`  ${w.record.name || w.record.id} — ${w.gitSummary}`);
      lines.push(`    → /ezdg open ${w.record.slug || w.record.id} to resume`);
    }
  }
  if (lines.length === 0) lines.push("No workers to clean.");
  return lines.join("\n");
}
