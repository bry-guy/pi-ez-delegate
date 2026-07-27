import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { basename, join } from "node:path";

import {
  createEmptyWorkerRegistry,
  createWorkerRegistryRecord,
  getDelegateStateDir,
  getRegistryFilePath,
  readWorkerRegistry,
  upsertWorkerRecord,
  writeWorkerRegistry,
} from "../lib/registry.js";

test("getRegistryFilePath is stable for the same scope", () => {
  const first = getRegistryFilePath({ scopeKey: "/tmp/project/.git" });
  const second = getRegistryFilePath({ scopeKey: "/tmp/project/.git" });
  const third = getRegistryFilePath({ scopeKey: "/tmp/other/.git" });

  assert.equal(first, second);
  assert.notEqual(first, third);
  assert.match(basename(first), /^git-[a-f0-9]{12}\.json$/);
});

test("createWorkerRegistryRecord normalizes a delegate launch result", () => {
  const record = createWorkerRegistryRecord({
    launchedAt: "2026-03-16T12:00:00.000Z",
    request: {
      task: "Implement worker registry tracking and cleanup safety",
      model: "anthropic/claude-sonnet-4-5",
    },
    parent: {
      sessionFile: "/tmp/parent.jsonl",
    },
    worker: {
      name: "registry worker",
      slug: "registry-worker",
    },
    session: {
      sessionFile: "/tmp/2026-03-16_session.jsonl",
    },
    cwd: {
      requested: "/tmp/project",
      effective: "/tmp/project",
    },
    worktree: {
      worktreePath: "/tmp/worktree",
      taskBranch: "delegate/registry-worker",
      baseBranch: "main",
    },
    launch: {
      adapter: "tmux",
      mode: "session",
      targetId: "registry-worker-session",
      sessionName: "registry-worker-session",
    },
  });

  assert.equal(record.id, "2026-03-16_session");
  assert.equal(record.name, "registry worker");
  assert.equal(record.slug, "registry-worker");
  assert.equal(record.taskSummary, "Implement worker registry tracking and cleanup safety");
  assert.equal(record.multiplexer, "tmux");
  assert.equal(record.targetMode, "session");
  assert.equal(record.targetId, "registry-worker-session");
  assert.equal(record.sessionId, "registry-worker-session");
  assert.equal(record.tmuxSessionName, "registry-worker-session");
  assert.equal(record.taskBranch, "delegate/registry-worker");
  assert.equal(record.baseBranch, "main");
  assert.equal(record.model, "anthropic/claude-sonnet-4-5");
});

test("writeWorkerRegistry and readWorkerRegistry round-trip records", async () => {
  const tempAgentDir = await mkdtemp(join(os.tmpdir(), "ezdg-registry-"));

  try {
    const registry = createEmptyWorkerRegistry({
      scopeKey: "/tmp/project/.git",
      scopeLabel: "pi-ez-delegate",
    });
    const record = createWorkerRegistryRecord({
      launchedAt: "2026-03-16T12:00:00.000Z",
      request: { task: "Inspect dead workers and clean safe ones" },
      worker: { name: "cleanup-worker", slug: "cleanup-worker" },
      session: { sessionFile: "/tmp/cleanup-worker.jsonl" },
      cwd: { requested: "/tmp/project", effective: "/tmp/project" },
      launch: { adapter: "tmux", mode: "session", targetId: "cleanup-worker-session", sessionName: "cleanup-worker-session" },
    });
    const nextRegistry = upsertWorkerRecord(registry, record);

    const stateDir = getDelegateStateDir(tempAgentDir);
    const registryPath = getRegistryFilePath({
      agentDir: tempAgentDir,
      scopeKey: "/tmp/project/.git",
      scopeLabel: "pi-ez-delegate",
    });

    assert.equal(registryPath.startsWith(stateDir), true);

    await writeWorkerRegistry({ registry: nextRegistry, registryPath });
    const loaded = await readWorkerRegistry({ registryPath, scopeKey: "/tmp/project/.git" });

    assert.equal(loaded.exists, true);
    assert.equal(loaded.registry.scope.label, "pi-ez-delegate");
    assert.equal(loaded.registry.workers.length, 1);
    assert.equal(loaded.registry.workers[0].name, "cleanup-worker");
    assert.equal(loaded.registry.workers[0].targetMode, "session");
    assert.equal(loaded.registry.workers[0].targetId, "cleanup-worker-session");
    assert.equal(loaded.registry.workers[0].tmuxSessionName, "cleanup-worker-session");
  } finally {
    await rm(tempAgentDir, { recursive: true, force: true });
  }
});
