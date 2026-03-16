import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { getDefaultAgentDir } from "./config.js";

export const DELEGATE_REGISTRY_VERSION = 1;
export const DELEGATE_REGISTRY_STATE_DIR = "pi-ez-delegate";

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
}

function truncateWords(value, maxWords = 8) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function stableHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function normalizePath(value) {
  const normalized = normalizeOptionalString(value);
  return normalized ? resolve(normalized) : undefined;
}

function normalizeTimestamp(value, label) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  const timestamp = new Date(normalized);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
  return timestamp.toISOString();
}

function deriveWorkerId(input) {
  return (
    normalizeOptionalString(input.id) ||
    normalizeOptionalString(input.workerId) ||
    normalizeOptionalString(input.childSessionFile && basename(input.childSessionFile, ".jsonl")) ||
    randomUUID()
  );
}

function deriveWorkerSlug(input) {
  const explicitSlug = normalizeOptionalString(input.slug);
  if (explicitSlug) return explicitSlug;
  const slug = slugify(input.name || input.taskSummary || deriveWorkerId(input));
  return slug || deriveWorkerId(input).slice(0, 12);
}

function normalizeWorkerRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Worker record must be an object.");
  }

  const id = deriveWorkerId(input);
  const name = normalizeOptionalString(input.name) || id;
  const launchedAt = normalizeTimestamp(input.launchedAt, "launchedAt") || new Date().toISOString();
  const updatedAt = normalizeTimestamp(input.updatedAt, "updatedAt") || launchedAt;
  const cleanedAt = normalizeTimestamp(input.cleanedAt, "cleanedAt");

  return {
    id,
    name,
    slug: deriveWorkerSlug({ ...input, id, name }),
    taskSummary: normalizeOptionalString(input.taskSummary) || undefined,
    launchedAt,
    updatedAt,
    cleanedAt,
    parentSessionFile: normalizePath(input.parentSessionFile),
    childSessionFile: normalizePath(input.childSessionFile),
    requestedCwd: normalizePath(input.requestedCwd),
    effectiveCwd: normalizePath(input.effectiveCwd),
    worktreePath: normalizePath(input.worktreePath),
    taskBranch: normalizeOptionalString(input.taskBranch),
    baseBranch: normalizeOptionalString(input.baseBranch),
    multiplexer: normalizeOptionalString(input.multiplexer),
    targetMode: normalizeOptionalString(input.targetMode),
    targetId: normalizeOptionalString(input.targetId),
    windowId: normalizeOptionalString(input.windowId),
    paneId: normalizeOptionalString(input.paneId),
    sessionId: normalizeOptionalString(input.sessionId),
    originPaneId: normalizeOptionalString(input.originPaneId),
    originWindowId: normalizeOptionalString(input.originWindowId),
    model: normalizeOptionalString(input.model),
  };
}

function normalizeRegistryScope(input) {
  const scopeInput = input?.scope && typeof input.scope === "object" && !Array.isArray(input.scope) ? input.scope : input;
  const scopeKey = normalizePath(
    scopeInput?.key || scopeInput?.scopeKey || scopeInput?.gitCommonDir || scopeInput?.mainCheckoutPath || scopeInput?.repoRoot || scopeInput?.cwd,
  );
  if (!scopeKey) {
    throw new Error("Registry scope requires one of: scopeKey, gitCommonDir, mainCheckoutPath, repoRoot, or cwd.");
  }

  return {
    key: scopeKey,
    label: normalizeOptionalString(scopeInput?.label || input?.scopeLabel) || basename(scopeKey),
  };
}

export function getDelegateStateDir(agentDir = getDefaultAgentDir()) {
  return join(agentDir, "state", DELEGATE_REGISTRY_STATE_DIR);
}

export function getRegistryFilePath(options = {}) {
  const scope = normalizeRegistryScope(options);
  const labelSlug = slugify(scope.label || basename(scope.key) || "registry") || "registry";
  const fileName = `${labelSlug}-${stableHash(scope.key)}.json`;
  return join(options.stateDir || getDelegateStateDir(options.agentDir), fileName);
}

export function createEmptyWorkerRegistry(options = {}) {
  const scope = normalizeRegistryScope(options);
  return {
    version: DELEGATE_REGISTRY_VERSION,
    scope,
    workers: [],
    updatedAt: new Date().toISOString(),
  };
}

export function createWorkerRegistryRecord(result) {
  const taskSummary = truncateWords(result?.request?.task, 12);
  const windowId = result?.launch?.mode === "window" ? result.launch.targetId : result?.launch?.windowId;
  const paneId = result?.launch?.mode === "pane" ? result.launch.targetId : result?.launch?.paneId;
  const sessionId = result?.launch?.mode === "session" ? result.launch.targetId : result?.launch?.sessionId;

  return normalizeWorkerRecord({
    id: result?.worker?.id,
    name: result?.worker?.name,
    slug: result?.worker?.slug,
    taskSummary,
    launchedAt: result?.launchedAt,
    updatedAt: result?.launchedAt,
    parentSessionFile: result?.parent?.sessionFile,
    childSessionFile: result?.session?.sessionFile,
    requestedCwd: result?.cwd?.requested,
    effectiveCwd: result?.cwd?.effective,
    worktreePath: result?.worktree?.worktreePath,
    taskBranch: result?.worktree?.taskBranch,
    baseBranch: result?.worktree?.baseBranch,
    multiplexer: result?.launch?.adapter,
    targetMode: result?.launch?.mode,
    targetId: result?.launch?.targetId,
    windowId,
    paneId,
    sessionId,
    originPaneId: result?.launch?.originPaneId,
    originWindowId: result?.launch?.originWindowId,
    model: result?.request?.model,
  });
}

export function upsertWorkerRecord(registry, record) {
  const normalizedRegistry = normalizeWorkerRegistry(registry);
  const normalizedRecord = normalizeWorkerRecord(record);
  const nextWorkers = normalizedRegistry.workers.filter((worker) => worker.id !== normalizedRecord.id);
  nextWorkers.push({
    ...normalizedRecord,
    updatedAt: new Date().toISOString(),
  });
  nextWorkers.sort((left, right) => (left.launchedAt < right.launchedAt ? 1 : -1));

  return {
    ...normalizedRegistry,
    workers: nextWorkers,
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeWorkerRegistry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Worker registry must be an object.");
  }

  const version = Number(input.version ?? DELEGATE_REGISTRY_VERSION);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("Worker registry version must be a positive integer.");
  }

  const scope = normalizeRegistryScope(input.scope || input);
  const workers = Array.isArray(input.workers) ? input.workers.map(normalizeWorkerRecord) : [];

  return {
    version,
    scope,
    workers,
    updatedAt: normalizeTimestamp(input.updatedAt, "updatedAt") || new Date().toISOString(),
  };
}

export async function readWorkerRegistry(options = {}) {
  const registryPath = options.registryPath || getRegistryFilePath(options);
  const exists = await pathExists(registryPath);
  if (!exists) {
    return {
      registryPath,
      exists: false,
      registry: createEmptyWorkerRegistry(options),
    };
  }

  const raw = await readFile(registryPath, "utf8");
  let parsed;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : createEmptyWorkerRegistry(options);
  } catch (error) {
    throw new Error(`Could not parse worker registry at ${registryPath}: ${error.message}`);
  }

  return {
    registryPath,
    exists: true,
    registry: normalizeWorkerRegistry(parsed),
  };
}

export async function writeWorkerRegistry(options = {}) {
  const registry = normalizeWorkerRegistry(options.registry);
  const registryPath = options.registryPath || getRegistryFilePath(registry.scope);
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return {
    registryPath,
    registry,
  };
}
