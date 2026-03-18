import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

function parseTmuxFields(stdout, expectedFieldCount, label) {
  const fields = String(stdout || "").trim().split("\t");
  if (fields.length < expectedFieldCount || fields.slice(0, expectedFieldCount).some((field) => !field)) {
    throw new Error(`Unexpected tmux output for ${label}.`);
  }
  return fields;
}

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

export function formatTmuxAttachHint(result) {
  if (result.mode === "pane") return `tmux select-pane -t ${result.targetId}`;
  if (result.mode === "window") return `tmux select-window -t ${result.targetId}`;
  return result.sessionName ? `tmux switch-client -t ${result.sessionName}` : `tmux switch-client -t ${result.targetId}`;
}

export async function getTmuxPaneContext({ env, paneId }) {
  const targetPaneId = String(paneId || env?.TMUX_PANE || "").trim();
  if (!targetPaneId) return undefined;

  const result = await runTmuxCommand(
    ["display-message", "-p", "-t", targetPaneId, "#{pane_id}\t#{window_id}\t#{session_id}"],
    { env, allowFailure: true },
  );
  if (result.code !== 0 || !result.stdout.trim()) return undefined;

  const [resolvedPaneId, windowId, sessionId] = parseTmuxFields(result.stdout, 3, "pane context");
  return {
    paneId: resolvedPaneId,
    windowId,
    sessionId,
  };
}

export async function launchInTmux({ target, cwd, workerName, command, env, originPaneId, splitDirection }) {
  if (!env?.TMUX) {
    throw new Error("pi-ez-delegate currently requires running inside tmux.");
  }

  if (target === "pane") {
    const originPane = await getTmuxPaneContext({ env, paneId: originPaneId });
    if (!originPane) {
      const missingTarget = originPaneId || env?.TMUX_PANE || "<unknown>";
      throw new Error(`Stored origin pane no longer exists: ${missingTarget}. Retry with --target window or --target session.`);
    }

    const splitArgs = ["split-window", "-d", "-P", "-F", "#{pane_id}\t#{window_id}\t#{session_id}"];
    if (splitDirection === "vertical") splitArgs.push("-h");
    splitArgs.push("-t", originPane.paneId, "-c", cwd, command);
    const { stdout } = await runTmuxCommand(splitArgs, { env });
    const [paneId, windowId, sessionId] = parseTmuxFields(stdout, 3, "pane split");

    // Ensure pane closes when the worker process exits, even if the user has
    // remain-on-exit enabled globally in their tmux config.
    await runTmuxCommand(["set-option", "-p", "-t", paneId, "remain-on-exit", "off"], { env, allowFailure: true });

    const result = {
      adapter: "tmux",
      mode: "pane",
      targetId: paneId,
      paneId,
      windowId,
      sessionId,
      originPaneId: originPane.paneId,
      originWindowId: originPane.windowId,
    };
    return {
      ...result,
      attachHint: formatTmuxAttachHint(result),
    };
  }

  if (target === "window") {
    const { stdout } = await runTmuxCommand(
      ["new-window", "-d", "-P", "-F", "#{window_id}\t#{pane_id}\t#{session_id}", "-n", workerName, "-c", cwd, command],
      { env },
    );
    const [windowId, paneId, sessionId] = parseTmuxFields(stdout, 3, "window launch");
    const result = {
      adapter: "tmux",
      mode: "window",
      targetId: windowId,
      windowId,
      paneId,
      sessionId,
    };
    return {
      ...result,
      attachHint: formatTmuxAttachHint(result),
    };
  }

  const { stdout } = await runTmuxCommand(
    ["new-session", "-d", "-P", "-F", "#{session_id}\t#{window_id}\t#{pane_id}", "-s", workerName, "-c", cwd, command],
    { env },
  );
  const [sessionId, windowId, paneId] = parseTmuxFields(stdout, 3, "session launch");
  const result = {
    adapter: "tmux",
    mode: "session",
    targetId: sessionId,
    sessionId,
    windowId,
    paneId,
    sessionName: workerName,
  };
  return {
    ...result,
    attachHint: formatTmuxAttachHint(result),
  };
}

export async function isTmuxTargetLive(targetMode, targetId, options = {}) {
  if (!targetId) return false;
  const env = options.env;

  if (targetMode === "session") {
    const result = await runTmuxCommand(["has-session", "-t", targetId], { env, allowFailure: true });
    return result.code === 0;
  }

  const format = targetMode === "pane" ? "#{pane_id}" : "#{window_id}";
  const result = await runTmuxCommand(["display-message", "-p", "-t", targetId, format], { env, allowFailure: true });
  return result.code === 0 && result.stdout.trim().length > 0;
}

export async function getTmuxWindowPanes(windowId, options = {}) {
  const env = options.env;
  const format = "#{pane_id}\t#{pane_width}\t#{pane_height}\t#{window_width}\t#{window_height}";
  const result = await runTmuxCommand(["list-panes", "-t", windowId, "-F", format], { env, allowFailure: true });
  if (result.code !== 0 || !result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [paneId, width, height, windowWidth, windowHeight] = line.split("\t");
      return {
        paneId,
        width: parseInt(width, 10),
        height: parseInt(height, 10),
        windowWidth: parseInt(windowWidth, 10),
        windowHeight: parseInt(windowHeight, 10),
      };
    });
}

export async function attachToTmuxTarget(targetMode, targetId, options = {}) {
  const env = options.env;

  if (targetMode === "pane") {
    await runTmuxCommand(["select-window", "-t", targetId], { env, allowFailure: true });
    await runTmuxCommand(["select-pane", "-t", targetId], { env });
    return { attached: true, mode: targetMode, targetId, hint: `tmux select-pane -t ${targetId}` };
  }

  if (targetMode === "window") {
    await runTmuxCommand(["select-window", "-t", targetId], { env });
    return { attached: true, mode: targetMode, targetId, hint: `tmux select-window -t ${targetId}` };
  }

  const sessionName = options.sessionName || targetId;
  await runTmuxCommand(["switch-client", "-t", sessionName], { env });
  return { attached: true, mode: targetMode, targetId, hint: `tmux switch-client -t ${sessionName}` };
}
