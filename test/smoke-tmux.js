#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { launchInTmux, isTmuxTargetLive, attachToTmuxTarget } from "../lib/tmux.js";

const execFileAsync = promisify(execFile);

async function hasTmux() {
  try { await execFileAsync("tmux", ["-V"]); return true; } catch { return false; }
}

async function main() {
  if (!(await hasTmux())) {
    console.log("Skipping tmux smoke test: tmux is not installed.");
    return;
  }

  const dir = await mkdtemp(join(os.tmpdir(), "ezdg-headless-smoke-"));
  let launch;
  try {
    launch = await launchInTmux({
      cwd: dir,
      workerName: `ezdg-smoke-${Date.now()}`,
      command: "sleep 5",
      env: process.env,
    });

    assert.equal(launch.mode, "session");
    assert.equal(await isTmuxTargetLive("session", launch.targetId, { env: process.env }), true);
    const attached = await attachToTmuxTarget("session", launch.targetId, { env: {} });
    assert.equal(attached.attached, false);
    assert.match(attached.hint, /tmux attach-session/);
  } finally {
    if (launch?.targetId) await execFileAsync("tmux", ["kill-session", "-t", launch.targetId]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
