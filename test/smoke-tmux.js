import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { DELEGATE_STATE_ENTRY_TYPE, delegateTask } from "../lib/delegate.js";

const execFileAsync = promisify(execFile);

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { cwd: options.cwd, env: options.env });
}

async function runGit(cwd, args) {
  await run("git", args, { cwd });
}

async function waitFor(condition, timeoutMs = 5000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await condition();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function parseTabbedFields(stdout, expectedFieldCount) {
  const fields = stdout.trim().split("\t");
  if (fields.length < expectedFieldCount || fields.slice(0, expectedFieldCount).some((field) => !field)) {
    throw new Error("Unexpected tmux output.");
  }
  return fields;
}

async function tmuxHas(targetType, targetId) {
  const args =
    targetType === "pane"
      ? ["list-panes", "-a", "-F", "#{pane_id}"]
      : targetType === "window"
        ? ["list-windows", "-a", "-F", "#{window_id}"]
        : ["list-sessions", "-F", "#{session_id}"];
  const { stdout } = await run("tmux", args, { env: process.env });
  return stdout.split(/\r?\n/).includes(targetId);
}

async function cleanupTmuxTarget(mode, targetId, sessionName) {
  try {
    if (mode === "pane") {
      if (await tmuxHas("pane", targetId)) await run("tmux", ["kill-pane", "-t", targetId], { env: process.env });
      return;
    }
    if (mode === "window") {
      if (await tmuxHas("window", targetId)) await run("tmux", ["kill-window", "-t", targetId], { env: process.env });
      return;
    }
    if (sessionName) {
      await run("tmux", ["kill-session", "-t", sessionName], { env: process.env }).catch(() => undefined);
      return;
    }
    if (await tmuxHas("session", targetId)) await run("tmux", ["kill-session", "-t", targetId], { env: process.env });
  } catch {
    // best-effort cleanup only
  }
}

async function getTmuxPaneContext(paneId) {
  const { stdout } = await run(
    "tmux",
    ["display-message", "-p", "-t", paneId, "#{pane_id}\t#{window_id}\t#{session_id}"],
    { env: process.env },
  );
  const [resolvedPaneId, windowId, sessionId] = parseTabbedFields(stdout, 3);
  return {
    paneId: resolvedPaneId,
    windowId,
    sessionId,
  };
}

async function createAnchorWindow() {
  const { stdout } = await run(
    "tmux",
    ["new-window", "-d", "-P", "-F", "#{pane_id}\t#{window_id}\t#{session_id}", "-n", "ezdg-anchor", "sleep 60"],
    { env: process.env },
  );
  const [paneId, windowId, sessionId] = parseTabbedFields(stdout, 3);
  return {
    paneId,
    windowId,
    sessionId,
  };
}

async function readSessionEntries(sessionFile) {
  const raw = await readFile(sessionFile, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

if (!process.env.TMUX) {
  console.log("Skipping tmux smoke test: not running inside tmux.");
  process.exit(0);
}

const tempRoot = await mkdtemp(join(os.tmpdir(), "pi-ez-delegate-smoke-"));
const repoDir = join(tempRoot, "repo");
const agentDir = join(tempRoot, "agent");
const logPath = join(tempRoot, "worker-log.jsonl");
const fakePiPath = join(tempRoot, "fake-pi.mjs");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

try {
  await writeFile(
    fakePiPath,
    `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }) + '\\n');\nsetTimeout(() => process.exit(0), 750);\n`,
    "utf8",
  );
  await chmod(fakePiPath, 0o755);

  process.env.PI_CODING_AGENT_DIR = agentDir;

  await mkdir(repoDir, { recursive: true });
  await runGit(repoDir, ["init", "-b", "main"]);
  await runGit(repoDir, ["config", "user.name", "Pi Smoke Test"]);
  await runGit(repoDir, ["config", "user.email", "pi-smoke@example.com"]);
  await writeFile(join(repoDir, "README.md"), "# smoke\n", "utf8");
  await runGit(repoDir, ["add", "README.md"]);
  await runGit(repoDir, ["commit", "-m", "chore: seed repo"]);

  const branchEntries = [
    {
      type: "message",
      id: "11111111",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "Please delegate this work." }],
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "22222222",
      parentId: "11111111",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Okay, delegating." }],
        provider: "test",
        model: "test-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  ];

  let previousLogCount = 0;

  const anchor = await createAnchorWindow();
  try {
    const paneResult = await delegateTask(
      {
        task: "smoke test pane",
        target: "pane",
        name: "smoke-pane",
        createWorktree: true,
      },
      {
        parentCwd: repoDir,
        parentSessionFile: join(tempRoot, "parent.jsonl"),
        headerVersion: 3,
        branchEntries: [
          ...branchEntries,
          {
            type: "custom",
            id: "33333333",
            parentId: "22222222",
            timestamp: new Date().toISOString(),
            customType: DELEGATE_STATE_ENTRY_TYPE,
            data: {
              active: true,
              workerId: "anchor-worker",
              targetMode: "pane",
              originPaneId: anchor.paneId,
              originWindowId: anchor.windowId,
            },
          },
        ],
        getLabel: () => undefined,
        env: process.env,
        piCommand: fakePiPath,
      },
    );

    assert.equal(paneResult.worktree.created, true);
    assert.equal(paneResult.launch.mode, "pane");
    assert.equal(paneResult.launch.originPaneId, anchor.paneId);
    assert.equal(paneResult.launch.originWindowId, anchor.windowId);
    assert.equal(paneResult.launch.windowId, anchor.windowId);
    assert.ok(paneResult.cwd.effective.includes(".pi-worktrees"));

    const paneSessionEntries = await readSessionEntries(paneResult.session.sessionFile);
    const paneStateEntry = paneSessionEntries.find((entry) => entry.customType === DELEGATE_STATE_ENTRY_TYPE);
    assert.ok(paneStateEntry);
    assert.equal(paneStateEntry.data.originPaneId, anchor.paneId);
    assert.equal(paneStateEntry.data.originWindowId, anchor.windowId);

    const paneLogLines = await waitFor(async () => {
      try {
        const raw = await readFile(logPath, "utf8");
        const entries = raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        return entries.length > previousLogCount ? entries : undefined;
      } catch {
        return undefined;
      }
    });

    previousLogCount = paneLogLines.length;
    const latestPaneLog = paneLogLines.at(-1);
    assert.equal(latestPaneLog.cwd, paneResult.cwd.effective);
    assert.equal(latestPaneLog.argv[0], "--session");
    assert.equal(latestPaneLog.argv[1], paneResult.session.sessionFile);
    assert.match(latestPaneLog.argv[2], /You are a delegated worker launched via \/ezdg\./);
    assert.match(latestPaneLog.argv[2], /smoke test pane/);

    await cleanupTmuxTarget(paneResult.launch.mode, paneResult.launch.targetId, paneResult.launch.sessionName);
  } finally {
    await cleanupTmuxTarget("window", anchor.windowId);
  }

  for (const mode of ["window", "session"]) {
    const result = await delegateTask(
      {
        task: `smoke test ${mode}`,
        target: mode,
        name: `smoke-${mode}`,
        createWorktree: true,
      },
      {
        parentCwd: repoDir,
        parentSessionFile: join(tempRoot, "parent.jsonl"),
        headerVersion: 3,
        branchEntries,
        getLabel: () => undefined,
        env: process.env,
        piCommand: fakePiPath,
      },
    );

    assert.equal(result.worktree.created, true);
    assert.match(result.worktree.taskBranch, /^ezdg\//);
    assert.ok(result.cwd.effective.includes(".pi-worktrees"));

    const logLines = await waitFor(async () => {
      try {
        const raw = await readFile(logPath, "utf8");
        const entries = raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        return entries.length > previousLogCount ? entries : undefined;
      } catch {
        return undefined;
      }
    });

    previousLogCount = logLines.length;
    const latest = logLines.at(-1);
    assert.equal(latest.cwd, result.cwd.effective);
    assert.equal(latest.argv[0], "--session");
    assert.equal(latest.argv[1], result.session.sessionFile);
    assert.match(latest.argv[2], /You are a delegated worker launched via \/ezdg\./);
    assert.match(latest.argv[2], new RegExp(`smoke test ${mode}`));

    await cleanupTmuxTarget(result.launch.mode, result.launch.targetId, result.launch.sessionName);
  }

  console.log("tmux smoke test passed");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(tempRoot, { recursive: true, force: true });
}
