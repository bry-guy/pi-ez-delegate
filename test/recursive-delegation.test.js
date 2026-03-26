import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import {
  DELEGATE_COMMAND,
  DELEGATE_STATE_ENTRY_TYPE,
  buildDelegateState,
  buildDelegatedPrompt,
  createForkedSessionFile,
  delegateTask,
  sanitizeEntriesForFork,
} from "../lib/delegate.js";

// ---------------------------------------------------------------------------
// Guard 1: delegateTask runtime check (isDelegatedWorker flag)
// ---------------------------------------------------------------------------

test("delegateTask throws when isDelegatedWorker is true", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-recursive-`));
  try {
    await assert.rejects(
      () =>
        delegateTask(
          { task: "do something", target: "pane" },
          {
            branchEntries: [],
            parentCwd: tempRoot,
            parentSessionFile: join(tempRoot, "session.jsonl"),
            headerVersion: 3,
            getLabel: () => undefined,
            env: process.env,
            isDelegatedWorker: true,
          },
        ),
      (err) => {
        assert.match(err.message, /delegated workers may not/i);
        return true;
      },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("delegateTask does NOT throw when isDelegatedWorker is false", async () => {
  // We can't do a full launch without tmux, but we can verify it gets past
  // the guard. It will fail later (no tmux), which is fine — the point is
  // the guard didn't fire.
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-recursive-ok-`));
  try {
    await assert.rejects(
      () =>
        delegateTask(
          { task: "do something", target: "pane" },
          {
            branchEntries: [],
            parentCwd: tempRoot,
            parentSessionFile: join(tempRoot, "session.jsonl"),
            headerVersion: 3,
            getLabel: () => undefined,
            env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
            isDelegatedWorker: false,
          },
        ),
      (err) => {
        // Should fail for a reason OTHER than the recursion guard
        assert.doesNotMatch(err.message, /delegated workers may not/i);
        return true;
      },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Guard 2: buildDelegatedPrompt includes anti-delegation instructions
// ---------------------------------------------------------------------------

test("buildDelegatedPrompt tells workers they must never call delegate_task", () => {
  const prompt = buildDelegatedPrompt({
    task: "implement auth",
    workerName: "auth-worker",
    parentCwd: "/tmp/repo",
    requestedCwd: "/tmp/repo",
    effectiveCwd: "/tmp/repo",
    worktree: { created: false, reason: "disabled", effectiveCwd: "/tmp/repo" },
  });

  assert.match(prompt, /must never call delegate_task/i);
  assert.match(prompt, /only the parent session may launch workers/i);
});

test("buildDelegatedPrompt anti-delegation instruction is present with worktree", () => {
  const prompt = buildDelegatedPrompt({
    task: "do stuff",
    workerName: "wt-worker",
    parentCwd: "/tmp/repo",
    requestedCwd: "/tmp/repo",
    effectiveCwd: "/tmp/worktrees/wt-worker",
    worktree: {
      created: true,
      mainCheckoutPath: "/tmp/repo",
      worktreePath: "/tmp/worktrees/wt-worker",
      taskBranch: "ezdg/wt-worker",
      baseBranch: "main",
    },
  });

  assert.match(prompt, /must never call delegate_task/i);
});

// ---------------------------------------------------------------------------
// Guard 3: sanitizeEntriesForFork strips delegate_task tool calls
// ---------------------------------------------------------------------------

test("sanitizeEntriesForFork removes delegate_task calls so forked workers don't see them", () => {
  const branchEntries = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      message: { role: "user", content: "split this into 3 workers" },
    },
    {
      type: "message",
      id: "asst-delegate-1",
      parentId: "user-1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll delegate this into 3 workers." },
          { type: "toolCall", id: "tc-1", name: "delegate_task", arguments: { task: "worker 1" } },
          { type: "toolCall", id: "tc-2", name: "delegate_task", arguments: { task: "worker 2" } },
          { type: "toolCall", id: "tc-3", name: "delegate_task", arguments: { task: "worker 3" } },
        ],
      },
    },
    {
      type: "message",
      id: "result-1",
      parentId: "asst-delegate-1",
      message: { role: "toolResult", toolCallId: "tc-1", content: [{ type: "text", text: "launched" }] },
    },
    {
      type: "message",
      id: "result-2",
      parentId: "result-1",
      message: { role: "toolResult", toolCallId: "tc-2", content: [{ type: "text", text: "launched" }] },
    },
    {
      type: "message",
      id: "result-3",
      parentId: "result-2",
      message: { role: "toolResult", toolCallId: "tc-3", content: [{ type: "text", text: "launched" }] },
    },
    {
      type: "message",
      id: "user-2",
      parentId: "result-3",
      message: { role: "user", content: "ok thanks" },
    },
  ];

  const sanitized = sanitizeEntriesForFork(branchEntries);

  // The delegate_task assistant message and all 3 tool results should be stripped
  const ids = sanitized.map((e) => e.id);
  assert.ok(!ids.includes("asst-delegate-1"), "delegate_task assistant message should be stripped");
  assert.ok(!ids.includes("result-1"), "delegate_task result 1 should be stripped");
  assert.ok(!ids.includes("result-2"), "delegate_task result 2 should be stripped");
  assert.ok(!ids.includes("result-3"), "delegate_task result 3 should be stripped");

  // user-1 and user-2 should survive
  assert.ok(ids.includes("user-1"));
  assert.ok(ids.includes("user-2"));

  // user-2 should be reparented to user-1
  const user2 = sanitized.find((e) => e.id === "user-2");
  assert.equal(user2.parentId, "user-1");
});

test("sanitizeEntriesForFork keeps non-delegate tool calls intact", () => {
  const branchEntries = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      message: { role: "user", content: "edit a file" },
    },
    {
      type: "message",
      id: "asst-edit",
      parentId: "user-1",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc-edit", name: "Edit", arguments: { path: "foo.txt" } },
        ],
      },
    },
    {
      type: "message",
      id: "result-edit",
      parentId: "asst-edit",
      message: { role: "toolResult", toolCallId: "tc-edit", content: [{ type: "text", text: "done" }] },
    },
  ];

  const sanitized = sanitizeEntriesForFork(branchEntries);
  assert.equal(sanitized.length, 3);
});

test("sanitizeEntriesForFork handles mixed delegate and non-delegate tool calls in one message", () => {
  // If an assistant message contains both delegate_task and other tool calls,
  // the entire message is stripped (because it contains a delegate_task call).
  // This is the conservative approach.
  const branchEntries = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      message: { role: "user", content: "do things" },
    },
    {
      type: "message",
      id: "asst-mixed",
      parentId: "user-1",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc-read", name: "Read", arguments: { path: "foo.txt" } },
          { type: "toolCall", id: "tc-delegate", name: "delegate_task", arguments: { task: "do it" } },
        ],
      },
    },
    {
      type: "message",
      id: "result-delegate",
      parentId: "asst-mixed",
      message: { role: "toolResult", toolCallId: "tc-delegate", content: [{ type: "text", text: "launched" }] },
    },
    {
      type: "message",
      id: "result-read",
      parentId: "result-delegate",
      message: { role: "toolResult", toolCallId: "tc-read", content: [{ type: "text", text: "file contents" }] },
    },
    {
      type: "message",
      id: "user-2",
      parentId: "result-read",
      message: { role: "user", content: "ok" },
    },
  ];

  const sanitized = sanitizeEntriesForFork(branchEntries);
  const ids = sanitized.map((e) => e.id);

  // The assistant message with delegate_task should be stripped
  assert.ok(!ids.includes("asst-mixed"));
  // The delegate_task result should be stripped
  assert.ok(!ids.includes("result-delegate"));
  // The non-delegate result is NOT stripped (tc-read is not a delegate call)
  assert.ok(ids.includes("result-read"));
});

// ---------------------------------------------------------------------------
// Guard 4: forked session file includes parentSession header
// ---------------------------------------------------------------------------

test("createForkedSessionFile sets parentSession in the session header", async () => {
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
    ];

    const result = await createForkedSessionFile({
      parentSessionFile: "/tmp/parent-session.jsonl",
      headerVersion: 3,
      branchEntries,
      getLabel: () => undefined,
      targetCwd,
      sessionName: "test-worker",
      delegateState: buildDelegateState({ workerId: "w-1", targetMode: "pane" }),
    });

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(result.sessionFile, "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));

    // Header must have parentSession so the extension's session_start handler
    // can detect this is a delegated worker and hide the delegate_task tool
    const header = lines[0];
    assert.equal(header.type, "session");
    assert.equal(header.parentSession, "/tmp/parent-session.jsonl");

    // Delegate state entry must be present
    const delegateStateEntry = lines.find(
      (e) => e.type === "custom" && e.customType === DELEGATE_STATE_ENTRY_TYPE,
    );
    assert.ok(delegateStateEntry, "delegate state entry should be in the forked session");
    assert.equal(delegateStateEntry.data.workerId, "w-1");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(tempAgentDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Guard 5: delegate_task tool promptGuidelines tell the LLM not to recurse
// ---------------------------------------------------------------------------

test("delegate_task tool definition includes anti-recursion guideline", async () => {
  // We can't easily instantiate the full extension, but we can verify
  // the source code contains the guideline.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../extensions/delegate.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /Delegated workers must never spawn more delegates/);
  assert.match(source, /only the parent session may launch workers/i);
});

// ---------------------------------------------------------------------------
// Guard 6: session_start handler hides delegate_task from delegated workers
// ---------------------------------------------------------------------------

test("extension source contains session_start handler that hides delegate_task for delegated workers", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../extensions/delegate.js", import.meta.url),
    "utf8",
  );

  // Verify the session_start event handler exists
  assert.match(source, /pi\.on\("session_start"/);
  // Verify it checks for parentSession
  assert.match(source, /header\?\.parentSession/);
  // Verify it uses getAllTools() (not getActiveTools() which is empty at session_start)
  assert.match(source, /pi\.getAllTools\(\)/);
  // Verify it filters out delegate_task
  assert.match(source, /filter\(\(?n\)?\s*=>\s*n\s*!==\s*"delegate_task"\)/);
  // Verify it calls setActiveTools
  assert.match(source, /pi\.setActiveTools/);
});

// ---------------------------------------------------------------------------
// Scenario: simulated recursive delegation cascade
// ---------------------------------------------------------------------------

test("all recursion guards fire for a simulated delegation cascade", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), `${DELEGATE_COMMAND}-cascade-`));

  try {
    // Scenario: a parent session launches worker-1, which tries to launch worker-2.
    // Every layer of defense should prevent this.

    // Layer 1: The prompt tells the worker not to delegate
    const prompt = buildDelegatedPrompt({
      task: "implement 3 features across 3 files",
      workerName: "worker-1",
      parentCwd: "/tmp/repo",
      requestedCwd: "/tmp/repo",
      effectiveCwd: "/tmp/repo",
      worktree: { created: false, reason: "disabled", effectiveCwd: "/tmp/repo" },
    });
    assert.match(prompt, /must never call delegate_task/i);

    // Layer 2: If the worker somehow still calls delegateTask, the runtime guard fires
    await assert.rejects(
      () =>
        delegateTask(
          { task: "sub-delegate this", target: "pane" },
          {
            branchEntries: [],
            parentCwd: tempRoot,
            parentSessionFile: join(tempRoot, "session.jsonl"),
            headerVersion: 3,
            getLabel: () => undefined,
            env: process.env,
            isDelegatedWorker: true,
          },
        ),
      /delegated workers may not/i,
    );

    // Layer 3: The forked session's history won't contain delegate_task calls
    const historyWithDelegation = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        message: { role: "user", content: "split into workers" },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "delegate_task", arguments: { task: "sub-work" } },
          ],
        },
      },
      {
        type: "message",
        id: "r1",
        parentId: "a1",
        message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "launched" }] },
      },
    ];

    const sanitized = sanitizeEntriesForFork(historyWithDelegation);
    const hasDelegateCall = sanitized.some(
      (e) =>
        e.type === "message" &&
        Array.isArray(e.message?.content) &&
        e.message.content.some((p) => p?.name === "delegate_task"),
    );
    assert.equal(hasDelegateCall, false, "forked history must not contain delegate_task calls");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
