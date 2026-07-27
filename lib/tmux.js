import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

async function runTmuxCommand(args, options = {}) {
  try {
    const result = await execFileAsync("tmux", args, {
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
    throw new Error([`tmux ${args.join(" ")}`.trim(), result.stderr || result.stdout].filter(Boolean).join("\n\n"));
  }
}

function sanitizeSessionName(value) {
  return String(value || "delegate-worker")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "delegate-worker";
}

export function formatTmuxAttachHint(result) {
  const target = result.sessionName || result.targetId;
  return `tmux attach-session -t ${target}`;
}

export async function launchInTmux({ cwd, workerName, command, env }) {
  const sessionName = sanitizeSessionName(workerName);
  const { stdout } = await runTmuxCommand(
    ["new-session", "-d", "-s", sessionName, "-c", cwd, "-P", "-F", "#{session_name}", command],
    { env },
  );
  const createdName = String(stdout || "").trim() || sessionName;
  const result = {
    adapter: "tmux",
    mode: "session",
    targetId: createdName,
    sessionId: createdName,
    sessionName: createdName,
  };
  return { ...result, attachHint: formatTmuxAttachHint(result) };
}

export async function isTmuxTargetLive(_targetMode, targetId, options = {}) {
  if (!targetId) return false;
  const result = await runTmuxCommand(["has-session", "-t", String(targetId)], { env: options.env, allowFailure: true });
  return result.code === 0;
}

export async function attachToTmuxTarget(_targetMode, targetId, options = {}) {
  if (!targetId) throw new Error("No tmux session target recorded for this worker.");
  const env = options.env;
  if (env?.TMUX) {
    await runTmuxCommand(["switch-client", "-t", String(targetId)], { env });
    return { attached: true, mode: "session", targetId, hint: `tmux switch-client -t ${targetId}` };
  }
  return { attached: false, mode: "session", targetId, hint: `tmux attach-session -t ${targetId}` };
}
