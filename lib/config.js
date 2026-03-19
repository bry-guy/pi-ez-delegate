import os from "node:os";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const DELEGATE_MULTIPLEXERS = ["tmux", "zellij"];
export const DELEGATE_PANE_SPLITS = ["auto", "horizontal", "vertical"];
export const DELEGATE_DEFAULT_CONFIG = Object.freeze({
  multiplexer: "tmux",
  defaultTarget: "pane",
  defaultPaneSplit: "auto",
  minPaneColumns: 120,
  minPaneRows: 28,
});

export function getDefaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(os.homedir(), ".pi", "agent");
}

export function getDefaultConfigPath(agentDir = getDefaultAgentDir()) {
  return join(agentDir, "pi-ez-delegate.json");
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function normalizeEnum(value, allowedValues, label, defaultValue) {
  if (value === undefined) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (!allowedValues.includes(normalized)) {
    throw new Error(`${label} must be one of: ${allowedValues.join(", ")}.`);
  }
  return normalized;
}

function normalizePositiveInteger(value, label, defaultValue) {
  if (value === undefined) return defaultValue;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return normalized;
}

function normalizeNonNegativeInteger(value, label, defaultValue) {
  if (value === undefined) return defaultValue;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return normalized;
}

export function normalizeDelegateConfig(input = {}) {
  assertPlainObject(input, "Delegate config");

  return {
    multiplexer: normalizeEnum(input.multiplexer, DELEGATE_MULTIPLEXERS, "multiplexer", DELEGATE_DEFAULT_CONFIG.multiplexer),
    defaultTarget: normalizeEnum(
      input.defaultTarget,
      ["pane", "window", "session"],
      "defaultTarget",
      DELEGATE_DEFAULT_CONFIG.defaultTarget,
    ),
    defaultPaneSplit: normalizeEnum(
      input.defaultPaneSplit,
      DELEGATE_PANE_SPLITS,
      "defaultPaneSplit",
      DELEGATE_DEFAULT_CONFIG.defaultPaneSplit,
    ),
    minPaneColumns: normalizePositiveInteger(
      input.minPaneColumns,
      "minPaneColumns",
      DELEGATE_DEFAULT_CONFIG.minPaneColumns,
    ),
    minPaneRows: normalizeNonNegativeInteger(input.minPaneRows, "minPaneRows", DELEGATE_DEFAULT_CONFIG.minPaneRows),
  };
}

export async function readDelegateConfigFile(configPath) {
  const raw = await readFile(configPath, "utf8");
  if (!raw.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse delegate config at ${configPath}: ${error.message}`);
  }

  assertPlainObject(parsed, `Delegate config at ${configPath}`);
  return parsed;
}

export async function loadDelegateConfig(options = {}) {
  const configPath = resolveConfigPath(options);
  const exists = await pathExists(configPath);
  const fileConfig = exists ? await readDelegateConfigFile(configPath) : {};
  const merged = {
    ...fileConfig,
    ...(options.overrides || {}),
  };

  return {
    configPath,
    exists,
    fileConfig,
    config: normalizeDelegateConfig(merged),
  };
}

export function resolveConfigPath(options = {}) {
  const fromOptions = options.configPath;
  const fromEnv = options.env?.PI_EZ_DELEGATE_CONFIG || process.env.PI_EZ_DELEGATE_CONFIG;
  const candidate = fromOptions || fromEnv || getDefaultConfigPath(options.agentDir);
  return isAbsolute(candidate) ? resolve(candidate) : resolve(candidate);
}
