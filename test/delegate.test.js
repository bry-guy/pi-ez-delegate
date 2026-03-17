import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import {
  DELEGATE_COMMAND,
  DELEGATE_STATE_ENTRY_TYPE,
  buildDelegateState,
  createForkedSessionFile,
  getActiveDelegateState,
  getForkBranchEntries,
  getParentEffectiveCwd,
  parseDelegateCommandInput,
  sanitizeEntriesForFork,
} from "../lib/delegate.js";

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
