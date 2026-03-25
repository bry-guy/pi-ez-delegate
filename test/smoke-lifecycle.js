/**
 * Lifecycle smoke test — validates the full delegate → isolate → merge-back flow.
 * This test does not require tmux. It exercises the mechanical pieces:
 * worktree creation, worker commits, and merge-back via finishWorker/finishAllWorkers.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildDelegatedPrompt, planDelegatedWorkspace } from "../lib/delegate.js";
import { finishAllWorkers, finishWorker } from "../lib/manager.js";
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
  assert.equal(workerA.taskBranch, "ezdg/worker-a");
  assert.equal(workerB.taskBranch, "ezdg/worker-b");
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
  assert.match(prompt, /\/ezdg finish worker-a/i);
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
        targetMode: "pane",
        paneId: "%99",
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
        targetMode: "pane",
        paneId: "%98",
      },
    ],
    updatedAt: now,
  };
  await writeWorkerRegistry({ registry, registryPath });

  const finishA = await finishWorker({ scope: registry.scope, registry, registryPath }, { record: registry.workers[0], live: false });
  assert.match(finishA.actions.join(", "), /merged/);
  assert.equal(await readFile(join(repoDir, "feature-a.txt"), "utf8"), "work from worker A\n");
  assert.ok(!(await pathExists(workerA.worktreePath)));

  const reloaded = await readWorkerRegistry({ registryPath, scopeKey: repoDir });
  const finishB = await finishWorker({ scope: reloaded.registry.scope, registry: reloaded.registry, registryPath }, { record: reloaded.registry.workers.find((w) => w.id === "worker-b-id"), live: false });
  assert.match(finishB.actions.join(", "), /merged/);
  assert.equal(await readFile(join(repoDir, "feature-b.txt"), "utf8"), "work from worker B\n");
  assert.ok(!(await pathExists(workerB.worktreePath)));

  // finishAllWorkers should handle a fresh pair sequentially.
  const workerC = await planDelegatedWorkspace({ currentCwd: repoDir, requestedCwd: repoDir, createWorktree: true, workerSlug: "worker-c" });
  const workerD = await planDelegatedWorkspace({ currentCwd: repoDir, requestedCwd: repoDir, createWorktree: true, workerSlug: "worker-d" });
  await writeFile(join(workerC.effectiveCwd, "feature-c.txt"), "work from worker C\n", "utf8");
  await runGit(workerC.effectiveCwd, ["add", "feature-c.txt"]);
  await runGit(workerC.effectiveCwd, ["commit", "-m", "feat: worker C delivers"]);
  await writeFile(join(workerD.effectiveCwd, "feature-d.txt"), "work from worker D\n", "utf8");
  await runGit(workerD.effectiveCwd, ["add", "feature-d.txt"]);
  await runGit(workerD.effectiveCwd, ["commit", "-m", "feat: worker D delivers"]);

  const registry2Path = join(tempRoot, "registry2.json");
  const registry2 = {
    version: 1,
    scope: { key: repoDir, label: "repo" },
    workers: [
      { id: "worker-c-id", name: "worker-c", slug: "worker-c", launchedAt: now, updatedAt: now, worktreePath: workerC.worktreePath, taskBranch: workerC.taskBranch, baseBranch: workerC.baseBranch, effectiveCwd: workerC.effectiveCwd, targetMode: "pane", paneId: "%97" },
      { id: "worker-d-id", name: "worker-d", slug: "worker-d", launchedAt: now, updatedAt: now, worktreePath: workerD.worktreePath, taskBranch: workerD.taskBranch, baseBranch: workerD.baseBranch, effectiveCwd: workerD.effectiveCwd, targetMode: "pane", paneId: "%96" },
    ],
    updatedAt: now,
  };
  await writeWorkerRegistry({ registry: registry2, registryPath: registry2Path });

  const allResults = await finishAllWorkers(
    { scope: registry2.scope, registry: registry2, registryPath: registry2Path },
    [
      { record: registry2.workers[0], live: false, gitState: { exists: true, isGit: true, isDirty: false, aheadCount: 1, rebaseInProgress: false, mergeInProgress: false } },
      { record: registry2.workers[1], live: false, gitState: { exists: true, isGit: true, isDirty: false, aheadCount: 1, rebaseInProgress: false, mergeInProgress: false } },
    ],
  );
  assert.equal(allResults.length, 2);
  assert.equal(allResults.filter((r) => !r.error).length, 2);
  assert.equal(await readFile(join(repoDir, "feature-c.txt"), "utf8"), "work from worker C\n");
  assert.equal(await readFile(join(repoDir, "feature-d.txt"), "utf8"), "work from worker D\n");

  console.log("lifecycle smoke test passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
