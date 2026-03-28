import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;
const DELEGATES_WINDOW_NAME = "delegates";

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
  return `tmux select-window -t ${result.targetId}`;
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

async function getTmuxWindowContext({ env, windowId }) {
  const targetWindowId = String(windowId || "").trim();
  if (!targetWindowId) return undefined;

  const result = await runTmuxCommand(
    ["display-message", "-p", "-t", targetWindowId, "#{window_id}\t#{session_id}\t#{window_name}"],
    { env, allowFailure: true },
  );
  if (result.code !== 0 || !result.stdout.trim()) return undefined;

  const [resolvedWindowId, sessionId, windowName] = parseTmuxFields(result.stdout, 3, "window context");
  return {
    windowId: resolvedWindowId,
    sessionId,
    windowName,
  };
}

async function getTmuxSessionForPane(env, paneId) {
  const pane = await getTmuxPaneContext({ env, paneId });
  return pane?.sessionId;
}

async function getOrCreateDelegatesWindow({ env, originPaneId }) {
  const sessionId = await getTmuxSessionForPane(env, originPaneId || env?.TMUX_PANE);
  if (!sessionId) {
    throw new Error("No tmux pane is available to locate the delegates window.");
  }

  const listResult = await runTmuxCommand(
    ["list-windows", "-t", sessionId, "-F", "#{window_id}\t#{session_id}\t#{window_name}\t#{pane_id}"],
    { env, allowFailure: true },
  );

  if (listResult.code === 0 && listResult.stdout.trim()) {
    const existing = listResult.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("\t"))
      .find((parts) => parts[2] === DELEGATES_WINDOW_NAME);

    if (existing) {
      return {
        windowId: existing[0],
        sessionId: existing[1],
        paneId: existing[3],
        created: false,
        windowName: DELEGATES_WINDOW_NAME,
      };
    }
  }

  const { stdout } = await runTmuxCommand(
    [
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{window_id}\t#{pane_id}\t#{session_id}",
      "-t",
      sessionId,
      "-n",
      DELEGATES_WINDOW_NAME,
      "-c",
      "/",
      "sleep 86400",
    ],
    { env },
  );
  const [windowId, paneId, createdSessionId] = parseTmuxFields(stdout, 3, "delegates window creation");

  return {
    windowId,
    sessionId: createdSessionId,
    paneId,
    created: true,
    windowName: DELEGATES_WINDOW_NAME,
  };
}

async function launchPaneIntoWindow({ env, windowId, cwd, command, splitDirection, fallbackPaneId }) {
  const panes = await getTmuxWindowPanes(windowId, { env });
  const targetPaneId = fallbackPaneId || panes[0]?.paneId;
  if (!targetPaneId) {
    throw new Error(`Could not find a pane in tmux window ${windowId}.`);
  }

  const splitArgs = ["split-window", "-d", "-P", "-F", "#{pane_id}\t#{window_id}\t#{session_id}"];
  if (splitDirection === "vertical") splitArgs.push("-h");
  splitArgs.push("-t", targetPaneId, "-c", cwd, command);
  const { stdout } = await runTmuxCommand(splitArgs, { env });
  const [paneId, resolvedWindowId, sessionId] = parseTmuxFields(stdout, 3, "window pane split");

  await runTmuxCommand(["set-option", "-p", "-t", paneId, "remain-on-exit", "off"], { env, allowFailure: true });

  return {
    paneId,
    windowId: resolvedWindowId,
    sessionId,
  };
}

async function replacePaneCommand({ env, paneId, cwd, command }) {
  await runTmuxCommand(["set-option", "-p", "-t", paneId, "remain-on-exit", "off"], { env, allowFailure: true });
  await runTmuxCommand(["respawn-pane", "-k", "-t", paneId, "-c", cwd, command], { env });
  const context = await getTmuxPaneContext({ env, paneId });
  if (!context) {
    throw new Error(`Could not verify delegates window pane ${paneId} after respawn.`);
  }
  return context;
}

export async function launchInTmux({ target, cwd, workerName, command, env, originPaneId, splitDirection }) {
  if (!env?.TMUX) {
    throw new Error("pi-ez-delegate currently requires running inside tmux.");
  }

  if (target === "pane") {
    const originPane = await getTmuxPaneContext({ env, paneId: originPaneId });
    if (!originPane) {
      const missingTarget = originPaneId || env?.TMUX_PANE || "<unknown>";
      throw new Error(`Stored origin pane no longer exists: ${missingTarget}. Retry with --target window.`);
    }

    const splitArgs = ["split-window", "-d", "-P", "-F", "#{pane_id}\t#{window_id}\t#{session_id}"];
    if (splitDirection === "vertical") splitArgs.push("-h");
    splitArgs.push("-t", originPane.paneId, "-c", cwd, command);
    const { stdout } = await runTmuxCommand(splitArgs, { env });
    const [paneId, windowId, sessionId] = parseTmuxFields(stdout, 3, "pane split");

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
    const delegatesWindow = await getOrCreateDelegatesWindow({ env, originPaneId });

    let paneLaunch;
    if (delegatesWindow.created) {
      const context = await replacePaneCommand({ env, paneId: delegatesWindow.paneId, cwd, command });
      paneLaunch = {
        paneId: context.paneId,
        windowId: context.windowId,
        sessionId: context.sessionId,
      };
    } else {
      paneLaunch = await launchPaneIntoWindow({
        env,
        windowId: delegatesWindow.windowId,
        cwd,
        command,
        splitDirection,
        fallbackPaneId: delegatesWindow.paneId,
      });
    }

    const result = {
      adapter: "tmux",
      mode: "window",
      targetId: delegatesWindow.windowId,
      windowId: delegatesWindow.windowId,
      paneId: paneLaunch.paneId,
      sessionId: paneLaunch.sessionId,
      sessionName: workerName,
      originPaneId,
      originWindowId: delegatesWindow.windowId,
    };
    return {
      ...result,
      attachHint: formatTmuxAttachHint(result),
    };
  }

  throw new Error(`Unsupported tmux target: ${target}`);
}

export async function isTmuxTargetLive(targetMode, targetId, options = {}) {
  if (!targetId) return false;
  const env = options.env;
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

  throw new Error(`Unsupported tmux target mode: ${targetMode}`);
}

export async function getDelegatesWindowContext(options = {}) {
  return getOrCreateDelegatesWindow(options);
}

export async function getTmuxWindowInfo({ env, windowId }) {
  return getTmuxWindowContext({ env, windowId });
}
