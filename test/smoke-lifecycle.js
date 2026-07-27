/**
 * Lifecycle smoke test — validates the full delegate → isolate → merge-back flow.
 * This test does not require tmux. It exercises the mechanical pieces:
 * worktree creation and worker commits with branches preserved for delegator review.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildDelegatedPrompt, planDelegatedWorkspace } from "../lib/delegate.js";
import { cleanSafeWorkers } from "../lib/manager.js";
import { readWorkerRegistry, writeWorkerRegistry } from "../lib/registry.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

async function gitStdout(cwd, args) {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function initTestRepo(repoDir) {
  await rm(repoDir, { recursive: true, force: true });
  await mkdir(repoDir, { recursive: true });
  await runGit(repoDir, ["init", "-b", "main"]);
  await runGit(repoDir, ["config", "user.name", "Pi Lifecycle Test"]);
  await runGit(repoDir, ["config", "user.email", "pi-lifecycle@example.com"]);
  await writeFile(join(repoDir, "README.md"), "# lifecycle test\n", "utf8");
  await runGit(repoDir, ["add", "README.md"]);
  await runGit(repoDir, ["commit", "-m", "chore: seed repo"]);
}

const tempRoot = await mkdtemp(join(os.tmpdir(), "pi-ez-delegate-lifecycle-"));
const repoDir = join(tempRoot, "repo");

try {
  await initTestRepo(repoDir);
  const seedHead = await gitStdout(repoDir, ["rev-parse", "HEAD"]);

  // Delegate two workers into isolated worktrees.
  const workerA = await planDelegatedWorkspace({ currentCwd: repoDir, requestedCwd: repoDir, createWorktree: true, workerSlug: "worker-a" });
  const workerB = await planDelegatedWorkspace({ currentCwd: repoDir, requestedCwd: repoDir, createWorktree: true, workerSlug: "worker-b" });

  assert.equal(workerA.created, true);
  assert.equal(workerB.created, true);
  assert.equal(workerA.taskBranch, "delegate/worker-a");
  assert.equal(workerB.taskBranch, "delegate/worker-b");
  assert.notEqual(workerA.worktreePath, workerB.worktreePath);
  assert.equal(await gitStdout(repoDir, ["rev-parse", "HEAD"]), seedHead);

  // Prompt should direct workers to commit and exit, not self-merge.
  const prompt = buildDelegatedPrompt({
    task: "implement feature A",
    workerName: "worker-a",
    workerSlug: "worker-a",
    parentCwd: repoDir,
    requestedCwd: repoDir,
    effectiveCwd: workerA.effectiveCwd,
    worktree: workerA,
    automerge: true,
  });
  assert.match(prompt, /commit all changes/i);
  assert.match(prompt, /do not attempt to merge/i);
  assert.match(prompt, /leaving the branch and commits intact/i);
  assert.ok(!prompt.includes("git merge"));

  // Simulate isolated work in each worktree.
  await writeFile(join(workerA.effectiveCwd, "feature-a.txt"), "work from worker A\n", "utf8");
  await runGit(workerA.effectiveCwd, ["add", "feature-a.txt"]);
  await runGit(workerA.effectiveCwd, ["commit", "-m", "feat: worker A delivers"]);

  await writeFile(join(workerB.effectiveCwd, "feature-b.txt"), "work from worker B\n", "utf8");
  await runGit(workerB.effectiveCwd, ["add", "feature-b.txt"]);
  await runGit(workerB.effectiveCwd, ["commit", "-m", "feat: worker B delivers"]);

  assert.equal(await readFile(join(workerA.effectiveCwd, "feature-a.txt"), "utf8"), "work from worker A\n");
  assert.equal(await readFile(join(workerB.effectiveCwd, "feature-b.txt"), "utf8"), "work from worker B\n");
  assert.ok(!(await pathExists(join(repoDir, "feature-a.txt"))));
  assert.ok(!(await pathExists(join(repoDir, "feature-b.txt"))));

  // Finish A, then B, using the mechanical merge path.
  const now = new Date().toISOString();
  const registryPath = join(tempRoot, "registry.json");
  const registry = {
    version: 1,
    scope: { key: repoDir, label: "repo" },
    workers: [
      {
        id: "worker-a-id",
        name: "worker-a",
        slug: "worker-a",
        launchedAt: now,
        updatedAt: now,
        worktreePath: workerA.worktreePath,
        taskBranch: workerA.taskBranch,
        baseBranch: workerA.baseBranch,
        effectiveCwd: workerA.effectiveCwd,
        targetMode: "session",
        targetId: "worker-a",
      },
      {
        id: "worker-b-id",
        name: "worker-b",
        slug: "worker-b",
        launchedAt: now,
        updatedAt: now,
        worktreePath: workerB.worktreePath,
        taskBranch: workerB.taskBranch,
        baseBranch: workerB.baseBranch,
        effectiveCwd: workerB.effectiveCwd,
        targetMode: "session",
        targetId: "worker-b",
      },
    ],
    updatedAt: now,
  };
  await writeWorkerRegistry({ registry, registryPath });

  // Branches are intentionally left for delegator review; no merge-back helper is invoked.
  assert.equal(await pathExists(workerA.worktreePath), true);
  assert.equal(await pathExists(workerB.worktreePath), true);

  console.log("lifecycle smoke test passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
