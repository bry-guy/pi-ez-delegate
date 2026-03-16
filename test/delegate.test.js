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
} from "../lib/delegate.js";

test("parseDelegateCommandInput parses flags and task text", () => {
  const { request, errors } = parseDelegateCommandInput(
    '--target window --name worker-one --cwd ~/dev/infra --no-worktree ship the deploy pipeline',
  );

  assert.deepEqual(errors, []);
  assert.equal(request.target, "window");
  assert.equal(request.name, "worker-one");
  assert.equal(request.cwd, "~/dev/infra");
  assert.equal(request.createWorktree, false);
  assert.equal(request.task, "ship the deploy pipeline");
});

test("parseDelegateCommandInput reports unknown flags", () => {
  const { errors } = parseDelegateCommandInput("--wat do the thing");
  assert.deepEqual(errors, ["Unknown flag: --wat"]);
});

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
