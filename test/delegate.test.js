import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  DELEGATE_COMMAND,
  DELEGATE_STATE_ENTRY_TYPE,
  buildDelegateState,
  buildDelegatedFinishCommand,
  buildDelegatedPrompt,
  createForkedSessionFile,
  deriveWorkerName,
  getActiveDelegateState,
  getForkBranchEntries,
  getParentEffectiveCwd,
  parseDelegateCommandInput,
  planDelegatedWorkspace,
  resolveDelegatedLaunchCwd,
  resolveParentSessionName,
  sanitizeEntriesForFork,
  validateDelegateRequest,
  verifyDelegatedWorkspace,
} from "../lib/delegate.js";
import { finishWorker } from "../lib/manager.js";
import { readWorkerRegistry } from "../lib/registry.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Subcommand parsing
// ---------------------------------------------------------------------------

test("parseDelegateCommandInput implicit start parses flags and task text", () => {
  const { subcommand, request, errors } = parseDelegateCommandInput(
    '--target window --name worker-one --cwd ~/dev/infra --no-worktree ship the deploy pipeline',
  );

  assert.equal(subcommand, "start");
  assert.deepEqual(errors, []);
  assert.equal(request.target, "window");
  assert.equal(request.name, "worker-one");
  assert.equal(request.cwd, "~/dev/infra");
  assert.equal(request.createWorktree, false);
  assert.equal(request.task, "ship the deploy pipeline");
});

test("parseDelegateCommandInput explicit start subcommand", () => {
  const { subcommand, request, errors } = parseDelegateCommandInput("start --target session do something");
  assert.equal(subcommand, "start");
  assert.deepEqual(errors, []);
  assert.equal(request.target, "session");
  assert.equal(request.task, "do something");
});

test("parseDelegateCommandInput list subcommand", () => {
  const { subcommand, errors } = parseDelegateCommandInput("list");
  assert.equal(subcommand, "list");
  assert.deepEqual(errors, []);
});

test("parseDelegateCommandInput attach subcommand", () => {
  const { subcommand, request, errors } = parseDelegateCommandInput("attach my-worker");
  assert.equal(subcommand, "attach");
  assert.equal(request.nameOrId, "my-worker");
  assert.deepEqual(errors, []);
});

test("parseDelegateCommandInput attach without name errors", () => {
  const { subcommand, errors } = parseDelegateCommandInput("attach");
  assert.equal(subcommand, "attach");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing/i);
});

test("parseDelegateCommandInput open subcommand with target", () => {
  const { subcommand, request, errors } = parseDelegateCommandInput("open my-worker --target window");
  assert.equal(subcommand, "open");
  assert.equal(request.nameOrId, "my-worker");
  assert.equal(request.target, "window");
  assert.deepEqual(errors, []);
});

test("parseDelegateCommandInput finish subcommand", () => {
  const { subcommand, request, errors } = parseDelegateCommandInput("finish my-worker");
  assert.equal(subcommand, "finish");
  assert.equal(request.nameOrId, "my-worker");
  assert.deepEqual(errors, []);
});

test("parseDelegateCommandInput finish without name errors", () => {
  const { subcommand, errors } = parseDelegateCommandInput("finish");
  assert.equal(subcommand, "finish");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing/i);
});

test("parseDelegateCommandInput clean subcommand", () => {
  const { subcommand, request, errors } = parseDelegateCommandInput("clean --yes");
  assert.equal(subcommand, "clean");
  assert.equal(request.yes, true);
  assert.deepEqual(errors, []);
});

test("parseDelegateCommandInput clean without --yes", () => {
  const { subcommand, request } = parseDelegateCommandInput("clean");
  assert.equal(subcommand, "clean");
  assert.equal(request.yes, false);
});

test("parseDelegateCommandInput help subcommand", () => {
  const { subcommand, request } = parseDelegateCommandInput("help start");
  assert.equal(subcommand, "help");
  assert.equal(request.topic, "start");
});

test("parseDelegateCommandInput empty input returns help", () => {
  const { subcommand } = parseDelegateCommandInput("");
  assert.equal(subcommand, "help");
});

test("parseDelegateCommandInput reports unknown flags", () => {
  const { errors } = parseDelegateCommandInput("--wat do the thing");
  assert.deepEqual(errors, ["Unknown flag: --wat"]);
});

// ---------------------------------------------------------------------------
// --split flag parsing
// ---------------------------------------------------------------------------

test("parseDelegateCommandInput parses --split flag", () => {
  const { subcommand, request, errors } = parseDelegateCommandInput("start --split vertical do the thing");
  assert.equal(subcommand, "start");
  assert.deepEqual(errors, []);
  assert.equal(request.split, "vertical");
  assert.equal(request.task, "do the thing");
});

test("parseDelegateCommandInput parses --split=horizontal", () => {
  const { request, errors } = parseDelegateCommandInput("--split=horizontal do it");
  assert.deepEqual(errors, []);
  assert.equal(request.split, "horizontal");
});

test("parseDelegateCommandInput defaults split to auto", () => {
  const { request } = parseDelegateCommandInput("do the thing");
  assert.equal(request.split, "auto");
});

test("parseDelegateCommandInput reports invalid --split value", () => {
  const { errors } = parseDelegateCommandInput("--split diagonal do it");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /split mode/i);
});

test("parseDelegateCommandInput reports missing --split value", () => {
  const { errors } = parseDelegateCommandInput("--split --target pane do it");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing value for --split/i);
});

test("validateDelegateRequest rejects --split with non-pane target", () => {
  assert.throws(
    () => validateDelegateRequest({ task: "do it", target: "window", split: "vertical" }),
    /--split is only supported with --target pane/,
  );
});

test("validateDelegateRequest accepts --split with pane target", () => {
  const result = validateDelegateRequest({ task: "do it", target: "pane", split: "horizontal" });
  assert.equal(result.split, "horizontal");
});

// ---------------------------------------------------------------------------
// --no-automerge flag parsing
// ---------------------------------------------------------------------------

test("parseDelegateCommandInput parses --no-automerge", () => {
  const { request, errors } = parseDelegateCommandInput("start --no-automerge do the thing");
  assert.deepEqual(errors, []);
  assert.equal(request.automerge, false);
  assert.equal(request.task, "do the thing");
});

test("parseDelegateCommandInput defaults automerge to true", () => {
  const { request } = parseDelegateCommandInput("do the thing");
  assert.equal(request.automerge, true);
});

test("validateDelegateRequest preserves automerge field", () => {
  const result = validateDelegateRequest({ task: "do it", automerge: false });
  assert.equal(result.automerge, false);
});

// ---------------------------------------------------------------------------
// buildDelegatedPrompt automerge instructions
// ---------------------------------------------------------------------------

test("buildDelegatedPrompt includes merge instructions when automerge is true and worktree exists", () => {
  const prompt = buildDelegatedPrompt({
    task: "implement feature",
    workerName: "test-worker",
    parentCwd: "/tmp/repo",
    requestedCwd: "/tmp/repo",
    effectiveCwd: "/tmp/worktrees/test-worker",
    worktree: {
      created: true,
      mainCheckoutPath: "/tmp/repo",
      worktreePath: "/tmp/worktrees/test-worker",
      taskBranch: "ezdg/test-worker",
      baseBranch: "main",
    },
    automerge: true,
  });
  assert.match(prompt, /when your task is complete/i);
  assert.match(prompt, /cd \/tmp\/repo/);
  assert.match(prompt, /git diff --quiet/);
  assert.match(prompt, /git diff --cached --quiet/);
  assert.match(prompt, /git merge ezdg\/test-worker/);
  assert.match(prompt, /&& git worktree remove --force \/tmp\/worktrees\/test-worker/);
  assert.match(prompt, /&& git branch -d ezdg\/test-worker/);
});

test("buildDelegatedPrompt quotes paths with spaces in automerge command", () => {
  const prompt = buildDelegatedPrompt({
    task: "implement feature",
    workerName: "test-worker",
    parentCwd: "/tmp/my repo",
    requestedCwd: "/tmp/my repo",
    effectiveCwd: "/tmp/my worktrees/test-worker",
    worktree: {
      created: true,
      mainCheckoutPath: "/tmp/my repo",
      worktreePath: "/tmp/my worktrees/test-worker",
      taskBranch: "ezdg/test-worker",
      baseBranch: "main",
    },
    automerge: true,
  });
  assert.match(prompt, /cd '\/tmp\/my repo'/);
  assert.match(prompt, /worktree remove --force '\/tmp\/my worktrees\/test-worker'/);
});

test("buildDelegatedPrompt omits merge instructions when automerge is false", () => {
  const prompt = buildDelegatedPrompt({
    task: "implement feature",
    workerName: "test-worker",
    parentCwd: "/tmp/repo",
    requestedCwd: "/tmp/repo",
    effectiveCwd: "/tmp/worktrees/test-worker",
    worktree: {
      created: true,
      mainCheckoutPath: "/tmp/repo",
      worktreePath: "/tmp/worktrees/test-worker",
      taskBranch: "ezdg/test-worker",
      baseBranch: "main",
    },
    automerge: false,
  });
  assert.ok(!prompt.includes("when your task is complete"));
  assert.ok(!prompt.includes("worktree remove"));
});

test("buildDelegatedPrompt omits merge instructions when no worktree", () => {
  const prompt = buildDelegatedPrompt({
    task: "implement feature",
    workerName: "test-worker",
    parentCwd: "/tmp/repo",
    requestedCwd: "/tmp/repo",
    effectiveCwd: "/tmp/repo",
    worktree: { created: false, reason: "disabled", effectiveCwd: "/tmp/repo" },
    automerge: true,
  });
  assert.ok(!prompt.includes("when your task is complete"));
});

// ---------------------------------------------------------------------------
// Parent cwd / delegate state
// ---------------------------------------------------------------------------

test("getParentEffectiveCwd honors active ez-worktree state", () => {
  const branchEntries = [
    {
      type: "custom",
      customType: "pi-ez-worktree-state",
      data: {
        active: true,
        worktreePath: "/tmp/worktree",
        sessionSubdir: "packages/api",
      },
    },
  ];

  assert.equal(getParentEffectiveCwd("/tmp/repo", branchEntries), "/tmp/worktree/packages/api");
});

test("getActiveDelegateState returns the latest active delegate state", () => {
  const branchEntries = [
    {
      type: "custom",
      customType: DELEGATE_STATE_ENTRY_TYPE,
      data: {
        active: true,
        workerId: "old-worker",
        originPaneId: "%1",
      },
    },
    {
      type: "custom",
      customType: DELEGATE_STATE_ENTRY_TYPE,
      data: {
        active: true,
        workerId: "new-worker",
        originPaneId: "%2",
        originWindowId: "@3",
      },
    },
  ];

  assert.deepEqual(getActiveDelegateState(branchEntries), {
    active: true,
    workerId: "new-worker",
    originPaneId: "%2",
    originWindowId: "@3",
  });
});

// ---------------------------------------------------------------------------
// Fork branch entries
// ---------------------------------------------------------------------------

test("getForkBranchEntries can strip the trailing delegate tool-call message", () => {
  const branchEntries = [
    { type: "message", id: "user1", message: { role: "user", content: "delegate something" } },
    {
      type: "message",
      id: "assistant1",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "delegate_task",
            arguments: { task: "implement it" },
          },
        ],
      },
    },
  ];

  const filtered = getForkBranchEntries(branchEntries, { excludeTrailingDelegateToolCall: true });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "user1");
});

// ---------------------------------------------------------------------------
// Replay safety: parentId reparenting
// ---------------------------------------------------------------------------

test("sanitizeEntriesForFork reparents parentId chain when custom entries are removed", () => {
  const branchEntries = [
    { type: "message", id: "msg1", parentId: null },
    { type: "custom", id: "custom1", parentId: "msg1", customType: "pi-ez-worktree-state", data: {} },
    { type: "message", id: "msg2", parentId: "custom1" },
    { type: "label", id: "label1", parentId: "msg2" },
    { type: "message", id: "msg3", parentId: "label1" },
  ];

  const sanitized = sanitizeEntriesForFork(branchEntries);

  assert.equal(sanitized.length, 3);
  assert.equal(sanitized[0].id, "msg1");
  assert.equal(sanitized[0].parentId, null);
  assert.equal(sanitized[1].id, "msg2");
  assert.equal(sanitized[1].parentId, "msg1"); // reparented from custom1
  assert.equal(sanitized[2].id, "msg3");
  assert.equal(sanitized[2].parentId, "msg2"); // reparented from label1
});

test("sanitizeEntriesForFork handles consecutive custom entries", () => {
  const branchEntries = [
    { type: "message", id: "msg1", parentId: null },
    { type: "custom", id: "c1", parentId: "msg1", customType: "a", data: {} },
    { type: "custom", id: "c2", parentId: "c1", customType: "b", data: {} },
    { type: "message", id: "msg2", parentId: "c2" },
  ];

  const sanitized = sanitizeEntriesForFork(branchEntries);

  assert.equal(sanitized.length, 2);
  assert.equal(sanitized[1].id, "msg2");
  assert.equal(sanitized[1].parentId, "msg1"); // skipped both c1 and c2
});

// ---------------------------------------------------------------------------
// Session forking
// ---------------------------------------------------------------------------

test("createForkedSessionFile writes delegate state for child-session inheritance", async () => {
  const tempAgentDir = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-agent-`));
  const targetCwd = join(tempAgentDir, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;

  try {
    const branchEntries = [
      {
        type: "message",
        id: "11111111",
        parentId: null,
        timestamp: "2026-03-16T00:00:00.000Z",
        message: {
          role: "user",
          content: "hello",
          timestamp: Date.now(),
        },
      },
      {
        type: "custom",
        id: "22222222",
        parentId: "11111111",
        timestamp: "2026-03-16T00:00:01.000Z",
        customType: "pi-ez-worktree-state",
        data: { active: true },
      },
    ];
    const delegateState = buildDelegateState({
      workerId: "worker-123",
      targetMode: "pane",
      originPaneId: "%1",
      originWindowId: "@2",
    });

    const result = await createForkedSessionFile({
      parentSessionFile: "/tmp/parent.jsonl",
      headerVersion: 3,
      branchEntries,
      getLabel: (entryId) => (entryId === "11111111" ? "keep-me" : undefined),
      targetCwd,
      sessionName: `${DELEGATE_COMMAND}:worker-one`,
      delegateState,
    });

    const raw = await readFile(result.sessionFile, "utf8");
    const entries = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(entries[0].type, "session");
    assert.equal(entries[0].cwd, targetCwd);
    assert.equal(entries[0].parentSession, "/tmp/parent.jsonl");
    assert.equal(entries.some((entry) => entry.customType === "pi-ez-worktree-state"), false);
    assert.equal(entries.some((entry) => entry.type === "label" && entry.label === "keep-me"), true);
    assert.equal(entries.at(-2).type, "session_info");
    assert.equal(entries.at(-2).name, `${DELEGATE_COMMAND}:worker-one`);
    assert.equal(entries.at(-1).type, "custom");
    assert.equal(entries.at(-1).customType, DELEGATE_STATE_ENTRY_TYPE);
    assert.deepEqual(entries.at(-1).data, delegateState);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(tempAgentDir, { recursive: true, force: true });
  }
});

test("createForkedSessionFile preserves parentId chain across filtered entries", async () => {
  const tempAgentDir = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-agent-`));
  const targetCwd = join(tempAgentDir, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;

  try {
    const branchEntries = [
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-03-16T00:00:00.000Z",
        message: { role: "user", content: "hello", timestamp: Date.now() },
      },
      {
        type: "custom",
        id: "custom1",
        parentId: "msg1",
        timestamp: "2026-03-16T00:00:01.000Z",
        customType: "pi-ez-delegate-state",
        data: { active: true },
      },
      {
        type: "message",
        id: "msg2",
        parentId: "custom1",
        timestamp: "2026-03-16T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "sure" }], provider: "test", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() },
      },
    ];

    const result = await createForkedSessionFile({
      parentSessionFile: "/tmp/parent.jsonl",
      headerVersion: 3,
      branchEntries,
      getLabel: () => undefined,
      targetCwd,
      sessionName: `${DELEGATE_COMMAND}:test`,
    });

    const raw = await readFile(result.sessionFile, "utf8");
    const entries = raw.trim().split("\n").map((line) => JSON.parse(line));

    // Custom entry should be filtered out
    const messages = entries.filter((e) => e.type === "message");
    assert.equal(messages.length, 2);

    // msg2 should be reparented to msg1 (not custom1)
    const msg2 = messages.find((e) => e.id === "msg2");
    assert.equal(msg2.parentId, "msg1");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(tempAgentDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Hierarchical session naming
// ---------------------------------------------------------------------------

test("deriveWorkerName with parentSessionName produces hierarchical names", () => {
  const result = deriveWorkerName("implement auth middleware", undefined, {
    parentSessionName: "ezdg-v2",
    delegateIndex: 1,
  });
  assert.equal(result.sessionName, "ezdg-v2-dg-1-implement-auth-middleware");
  assert.ok(result.tmuxName.startsWith("ezdg-v2-dg-1"));
});

test("deriveWorkerName with explicit name and parentSessionName", () => {
  const result = deriveWorkerName("implement auth middleware", "auth-work", {
    parentSessionName: "myproject",
    delegateIndex: 3,
  });
  assert.equal(result.sessionName, "myproject-dg-3-auth-work");
});

test("deriveWorkerName without options keeps backward compat", () => {
  const result = deriveWorkerName("implement auth middleware");
  assert.equal(result.sessionName, "ezdg:implement auth middleware");
});

test("deriveWorkerName with parentSessionName uses shorter task summary", () => {
  const result = deriveWorkerName("implement the auth middleware for the api gateway service", undefined, {
    parentSessionName: "proj",
    delegateIndex: 2,
  });
  // Should truncate to 4 words for the name when parent context is present
  assert.equal(result.name, "implement the auth middleware");
  assert.equal(result.slug, "implement-the-auth-middleware");
});

test("deriveWorkerName with parentSessionName truncates tmuxName to 48 chars", () => {
  const result = deriveWorkerName("a very long task description that will need truncation", undefined, {
    parentSessionName: "a-really-long-parent-session-name",
    delegateIndex: 99,
  });
  assert.ok(result.tmuxName.length <= 48);
});

test("resolveParentSessionName finds name from session_info entries", () => {
  const entries = [
    { type: "session_info", name: "my-session" },
    { type: "message", id: "m1" },
  ];
  const result = resolveParentSessionName(entries, { mainCheckoutPath: "/tmp/repo" });
  assert.equal(result.name, "my-session");
  assert.equal(result.generated, false);
});

test("resolveParentSessionName uses latest session_info entry", () => {
  const entries = [
    { type: "session_info", name: "old-name" },
    { type: "message", id: "m1" },
    { type: "session_info", name: "new-name" },
  ];
  const result = resolveParentSessionName(entries, { mainCheckoutPath: "/tmp/repo" });
  assert.equal(result.name, "new-name");
  assert.equal(result.generated, false);
});

test("resolveParentSessionName auto-generates from git context", () => {
  const result = resolveParentSessionName([], { mainCheckoutPath: "/tmp/my-cool-project" });
  assert.equal(result.name, "my-cool-proj");
  assert.equal(result.generated, true);
});

test("resolveParentSessionName falls back to random prefix without git", () => {
  const result = resolveParentSessionName([], null);
  assert.match(result.name, /^pi-[a-f0-9]{4}$/);
  assert.equal(result.generated, true);
});

test("resolveParentSessionName skips session_info entries without name", () => {
  const entries = [
    { type: "session_info" },
    { type: "session_info", name: "" },
  ];
  const result = resolveParentSessionName(entries, { mainCheckoutPath: "/tmp/repo" });
  assert.equal(result.generated, true);
});

async function runGit(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

async function gitStdout(cwd, args) {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function initTestRepo(repoDir) {
  await rm(repoDir, { recursive: true, force: true });
  await mkdir(repoDir, { recursive: true });
  await runGit(repoDir, ["init", "-b", "main"]);
  await runGit(repoDir, ["config", "user.name", "Pi Delegate Test"]);
  await runGit(repoDir, ["config", "user.email", "pi-delegate@example.com"]);
  await writeFile(join(repoDir, "README.md"), "# test\n", "utf8");
  await runGit(repoDir, ["add", "README.md"]);
  await runGit(repoDir, ["commit", "-m", "chore: seed repo"]);
}

test("resolveDelegatedLaunchCwd prefers the effective delegated cwd", () => {
  assert.equal(resolveDelegatedLaunchCwd("/tmp/parent", "/tmp/worktree/subdir"), "/tmp/worktree/subdir");
  assert.equal(resolveDelegatedLaunchCwd("/tmp/parent", undefined), "/tmp/parent");
});

test("planDelegatedWorkspace creates and verifies a clean worker branch in its worktree", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-worktree-`));
  const repoDir = join(tempRoot, "repo");

  try {
    await writeFile(join(tempRoot, "seed.txt"), "seed\n", "utf8");
    await initTestRepo(repoDir);

    const srcDir = join(repoDir, "packages", "api");
    await execFileAsync("mkdir", ["-p", srcDir]);

    const worktree = await planDelegatedWorkspace({
      currentCwd: repoDir,
      requestedCwd: srcDir,
      createWorktree: true,
      workerSlug: "branch-check",
    });

    assert.equal(worktree.created, true);
    assert.equal(worktree.taskBranch, "ezdg/branch-check");
    assert.equal(worktree.verification?.verified, true);
    assert.match(worktree.effectiveCwd, /branch-check\/packages\/api$/);

    const verified = await verifyDelegatedWorkspace(worktree, worktree.effectiveCwd);
    assert.equal(verified.verified, true);
    assert.equal(verified.branch, "ezdg/branch-check");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("planDelegatedWorkspace bases the worker on the current delegator branch, not always main", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-branch-base-`));
  const repoDir = join(tempRoot, "repo");

  try {
    await initTestRepo(repoDir);
    await runGit(repoDir, ["checkout", "-b", "feature/delegator-base"]);
    await writeFile(join(repoDir, "feature.txt"), "feature base\n", "utf8");
    await runGit(repoDir, ["add", "feature.txt"]);
    await runGit(repoDir, ["commit", "-m", "feat: create delegator base branch"]);

    const srcDir = join(repoDir, "packages", "web");
    await execFileAsync("mkdir", ["-p", srcDir]);

    const worktree = await planDelegatedWorkspace({
      currentCwd: repoDir,
      requestedCwd: srcDir,
      createWorktree: true,
      workerSlug: "follow-parent-branch",
    });

    assert.equal(worktree.created, true);
    assert.equal(worktree.baseBranch, "feature/delegator-base");
    assert.equal(worktree.taskBranch, "ezdg/follow-parent-branch");

    const branchResult = await execFileAsync("git", ["branch", "--show-current"], { cwd: worktree.effectiveCwd });
    assert.equal(branchResult.stdout.trim(), "ezdg/follow-parent-branch");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("planDelegatedWorkspace rejects launching a same-repo delegate from a dirty parent checkout", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-dirty-parent-`));
  const repoDir = join(tempRoot, "repo");

  try {
    await initTestRepo(repoDir);
    await writeFile(join(repoDir, "README.md"), "# dirty parent\n", "utf8");

    const srcDir = join(repoDir, "packages", "api");
    await execFileAsync("mkdir", ["-p", srcDir]);

    await assert.rejects(
      () =>
        planDelegatedWorkspace({
          currentCwd: repoDir,
          requestedCwd: srcDir,
          createWorktree: true,
          workerSlug: "should-refuse-dirty-parent",
        }),
      /dirty|clean|uncommitted|pending changes/i,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("planDelegatedWorkspace rejects launching when the parent checkout has a merge in progress", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-merge-parent-`));
  const repoDir = join(tempRoot, "repo");

  try {
    await initTestRepo(repoDir);
    const gitDir = (await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: repoDir })).stdout.trim();
    await writeFile(join(gitDir, "MERGE_HEAD"), "deadbeef\n", "utf8");

    const srcDir = join(repoDir, "packages", "api");
    await execFileAsync("mkdir", ["-p", srcDir]);

    await assert.rejects(
      () =>
        planDelegatedWorkspace({
          currentCwd: repoDir,
          requestedCwd: srcDir,
          createWorktree: true,
          workerSlug: "should-refuse-merge-parent",
        }),
      /merge in progress|clean parent checkout/i,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("planDelegatedWorkspace rejects launching when the parent checkout has a rebase in progress", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-rebase-parent-`));
  const repoDir = join(tempRoot, "repo");

  try {
    await initTestRepo(repoDir);
    const gitDir = (await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: repoDir })).stdout.trim();
    await mkdir(join(gitDir, "rebase-merge"), { recursive: true });

    const srcDir = join(repoDir, "packages", "api");
    await execFileAsync("mkdir", ["-p", srcDir]);

    await assert.rejects(
      () =>
        planDelegatedWorkspace({
          currentCwd: repoDir,
          requestedCwd: srcDir,
          createWorktree: true,
          workerSlug: "should-refuse-rebase-parent",
        }),
      /rebasing|rebase|clean parent checkout/i,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("buildDelegatedPrompt completion command merges back into the delegator's current branch checkout", () => {
  const prompt = buildDelegatedPrompt({
    task: "implement feature",
    workerName: "test-worker",
    parentCwd: "/tmp/repo",
    requestedCwd: "/tmp/repo/packages/api",
    effectiveCwd: "/tmp/.pi-worktrees/repo/test-worker/packages/api",
    worktree: {
      created: true,
      mainCheckoutPath: "/tmp/repo",
      worktreePath: "/tmp/.pi-worktrees/repo/test-worker",
      taskBranch: "ezdg/test-worker",
      baseBranch: "feature/delegator-base",
    },
    automerge: true,
  });

  assert.match(prompt, /cd \/tmp\/repo/);
  assert.match(prompt, /git diff --quiet/);
  assert.match(prompt, /git diff --cached --quiet/);
  assert.match(prompt, /git merge ezdg\/test-worker/);
  assert.match(prompt, /git worktree remove --force \/tmp\/\.pi-worktrees\/repo\/test-worker/);
  assert.match(prompt, /git branch -d ezdg\/test-worker/);
});

test("worker commit lands on the worker branch and not the parent branch", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-worker-commit-`));
  const repoDir = join(tempRoot, "repo");

  try {
    await initTestRepo(repoDir);
    await runGit(repoDir, ["checkout", "-b", "feature/delegator-base"]);

    const srcDir = join(repoDir, "packages", "api");
    await execFileAsync("mkdir", ["-p", srcDir]);

    const parentHeadBefore = await gitStdout(repoDir, ["rev-parse", "HEAD"]);
    const worktree = await planDelegatedWorkspace({
      currentCwd: repoDir,
      requestedCwd: srcDir,
      createWorktree: true,
      workerSlug: "commit-isolated",
    });

    await writeFile(join(worktree.effectiveCwd, "delegate.txt"), "worker-only\n", "utf8");
    await runGit(worktree.effectiveCwd, ["add", "delegate.txt"]);
    await runGit(worktree.effectiveCwd, ["commit", "-m", "feat: worker isolated commit"]);

    const parentHeadAfter = await gitStdout(repoDir, ["rev-parse", "HEAD"]);
    const workerHead = await gitStdout(worktree.effectiveCwd, ["rev-parse", "HEAD"]);
    const parentBranch = await gitStdout(repoDir, ["branch", "--show-current"]);
    const workerBranch = await gitStdout(worktree.effectiveCwd, ["branch", "--show-current"]);

    assert.equal(parentBranch, "feature/delegator-base");
    assert.equal(workerBranch, "ezdg/commit-isolated");
    assert.equal(parentHeadAfter, parentHeadBefore);
    assert.notEqual(workerHead, parentHeadBefore);
    await assert.rejects(() => readFile(join(repoDir, "packages", "api", "delegate.txt"), "utf8"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("parent branch stays unchanged until the delegated finish command merges and cleans up", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-finish-merge-`));
  const repoDir = join(tempRoot, "repo");

  try {
    await initTestRepo(repoDir);
    await runGit(repoDir, ["checkout", "-b", "feature/delegator-base"]);

    const srcDir = join(repoDir, "packages", "api");
    await execFileAsync("mkdir", ["-p", srcDir]);

    const parentHeadBefore = await gitStdout(repoDir, ["rev-parse", "HEAD"]);
    const worktree = await planDelegatedWorkspace({
      currentCwd: repoDir,
      requestedCwd: srcDir,
      createWorktree: true,
      workerSlug: "finish-merge",
    });

    await writeFile(join(worktree.effectiveCwd, "delegate.txt"), "merge me\n", "utf8");
    await runGit(worktree.effectiveCwd, ["add", "delegate.txt"]);
    await runGit(worktree.effectiveCwd, ["commit", "-m", "feat: merge delegated work"]);

    const parentHeadStillBeforeMerge = await gitStdout(repoDir, ["rev-parse", "HEAD"]);
    assert.equal(parentHeadStillBeforeMerge, parentHeadBefore);

    const finishCommand = buildDelegatedFinishCommand(worktree);
    await execFileAsync("bash", ["-lc", finishCommand], { cwd: worktree.effectiveCwd });

    const parentHeadAfterMerge = await gitStdout(repoDir, ["rev-parse", "HEAD"]);
    assert.notEqual(parentHeadAfterMerge, parentHeadBefore);
    assert.equal(await gitStdout(repoDir, ["branch", "--show-current"]), "feature/delegator-base");
    assert.equal(await readFile(join(repoDir, "packages", "api", "delegate.txt"), "utf8"), "merge me\n");
    await assert.rejects(() => readFile(worktree.worktreePath, "utf8"));
    const branchExists = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${worktree.taskBranch}`], {
      cwd: repoDir,
    }).then(
      () => true,
      () => false,
    );
    assert.equal(branchExists, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("sibling delegated workers do not see each other's uncommitted changes", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-sibling-isolation-`));
  const repoDir = join(tempRoot, "repo");

  try {
    await initTestRepo(repoDir);
    await runGit(repoDir, ["checkout", "-b", "feature/delegator-base"]);

    const srcDir = join(repoDir, "packages", "api");
    await execFileAsync("mkdir", ["-p", srcDir]);

    const workerOne = await planDelegatedWorkspace({
      currentCwd: repoDir,
      requestedCwd: srcDir,
      createWorktree: true,
      workerSlug: "sibling-one",
    });
    const workerTwo = await planDelegatedWorkspace({
      currentCwd: repoDir,
      requestedCwd: srcDir,
      createWorktree: true,
      workerSlug: "sibling-two",
    });

    await writeFile(join(workerOne.effectiveCwd, "draft.txt"), "only worker one\n", "utf8");

    const parentStatus = await gitStdout(repoDir, ["status", "--porcelain"]);
    const workerTwoStatus = await gitStdout(workerTwo.effectiveCwd, ["status", "--porcelain"]);

    assert.equal(parentStatus, "");
    assert.equal(workerTwoStatus, "");
    await assert.rejects(() => readFile(join(repoDir, "packages", "api", "draft.txt"), "utf8"));
    await assert.rejects(() => readFile(join(workerTwo.effectiveCwd, "draft.txt"), "utf8"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("delegated finish command refuses to merge and clean up when the parent branch becomes dirty later", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-finish-dirty-parent-`));
  const repoDir = join(tempRoot, "repo");

  try {
    await initTestRepo(repoDir);
    await runGit(repoDir, ["checkout", "-b", "feature/delegator-base"]);

    const srcDir = join(repoDir, "packages", "api");
    await execFileAsync("mkdir", ["-p", srcDir]);

    const worktree = await planDelegatedWorkspace({
      currentCwd: repoDir,
      requestedCwd: srcDir,
      createWorktree: true,
      workerSlug: "finish-dirty-parent",
    });

    await writeFile(join(worktree.effectiveCwd, "delegate.txt"), "needs clean parent\n", "utf8");
    await runGit(worktree.effectiveCwd, ["add", "delegate.txt"]);
    await runGit(worktree.effectiveCwd, ["commit", "-m", "feat: staged for later merge"]);

    const parentHeadBefore = await gitStdout(repoDir, ["rev-parse", "HEAD"]);
    await writeFile(join(repoDir, "README.md"), "# now dirty\n", "utf8");

    const finishCommand = buildDelegatedFinishCommand(worktree);
    await assert.rejects(() => execFileAsync("bash", ["-lc", finishCommand], { cwd: worktree.effectiveCwd }));

    assert.equal(await gitStdout(repoDir, ["rev-parse", "HEAD"]), parentHeadBefore);
    assert.equal(await gitStdout(repoDir, ["status", "--porcelain"]), "M README.md");
    assert.equal(await readFile(join(worktree.worktreePath, "packages", "api", "delegate.txt"), "utf8"), "needs clean parent\n");
    const branchExists = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${worktree.taskBranch}`], {
      cwd: repoDir,
    }).then(
      () => true,
      () => false,
    );
    assert.equal(branchExists, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("finishWorker merges, cleans up, deletes the session file, and marks the registry record cleaned", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-finish-worker-`));
  const repoDir = join(tempRoot, "repo");

  try {
    await initTestRepo(repoDir);
    await runGit(repoDir, ["checkout", "-b", "feature/delegator-base"]);

    const srcDir = join(repoDir, "packages", "api");
    await execFileAsync("mkdir", ["-p", srcDir]);

    const worktree = await planDelegatedWorkspace({
      currentCwd: repoDir,
      requestedCwd: srcDir,
      createWorktree: true,
      workerSlug: "finish-worker-helper",
    });

    await writeFile(join(worktree.effectiveCwd, "delegate.txt"), "finish helper\n", "utf8");
    await runGit(worktree.effectiveCwd, ["add", "delegate.txt"]);
    await runGit(worktree.effectiveCwd, ["commit", "-m", "feat: finish via helper"]);

    const sessionFile = join(tempRoot, "worker-session.jsonl");
    await writeFile(sessionFile, "{}\n", "utf8");
    const registryPath = join(tempRoot, "registry.json");
    const registry = {
      version: 1,
      scope: { key: repoDir, label: "repo" },
      workers: [
        {
          id: "worker-1",
          name: "finish-worker-helper",
          slug: "finish-worker-helper",
          launchedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          childSessionFile: sessionFile,
          requestedCwd: srcDir,
          effectiveCwd: worktree.effectiveCwd,
          worktreePath: worktree.worktreePath,
          taskBranch: worktree.taskBranch,
          baseBranch: worktree.baseBranch,
          targetMode: "pane",
          targetId: "%1",
          paneId: "%1",
        },
      ],
      updatedAt: new Date().toISOString(),
    };

    const result = await finishWorker(
      { scope: registry.scope, registry, registryPath },
      { record: registry.workers[0], live: false },
    );

    assert.match(result.actions.join(", "), /merged/);
    assert.equal(await readFile(join(repoDir, "packages", "api", "delegate.txt"), "utf8"), "finish helper\n");
    await assert.rejects(() => readFile(sessionFile, "utf8"));
    const loaded = await readWorkerRegistry({ registryPath, scopeKey: repoDir });
    assert.ok(loaded.registry.workers[0].cleanedAt);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("finishWorker refuses to finish a still-live worker", async () => {
  await assert.rejects(
    () =>
      finishWorker(
        { scope: { key: "/tmp/repo", label: "repo" }, registry: { version: 1, scope: { key: "/tmp/repo", label: "repo" }, workers: [], updatedAt: new Date().toISOString() }, registryPath: "/tmp/registry.json" },
        { record: { id: "worker-1", name: "worker-one", taskBranch: "ezdg/worker-one" }, live: true },
      ),
    /still live/i,
  );
});
