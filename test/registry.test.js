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
      taskBranch: "ezdg/registry-worker",
      baseBranch: "main",
    },
    launch: {
      adapter: "tmux",
      mode: "pane",
      targetId: "%42",
      windowId: "@2",
      sessionName: "registry-worker-session",
      originPaneId: "%1",
      originWindowId: "@2",
    },
  });

  assert.equal(record.id, "2026-03-16_session");
  assert.equal(record.name, "registry worker");
  assert.equal(record.slug, "registry-worker");
  assert.equal(record.taskSummary, "Implement worker registry tracking and cleanup safety");
  assert.equal(record.multiplexer, "tmux");
  assert.equal(record.targetMode, "pane");
  assert.equal(record.targetId, "%42");
  assert.equal(record.windowId, "@2");
  assert.equal(record.paneId, "%42");
  assert.equal(record.tmuxSessionName, "registry-worker-session");
  assert.equal(record.originPaneId, "%1");
  assert.equal(record.originWindowId, "@2");
  assert.equal(record.taskBranch, "ezdg/registry-worker");
  assert.equal(record.baseBranch, "main");
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
      launch: { adapter: "tmux", mode: "window", targetId: "@3", sessionName: "cleanup-worker-window" },
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
    assert.equal(loaded.registry.workers[0].targetMode, "window");
    assert.equal(loaded.registry.workers[0].targetId, "@3");
    assert.equal(loaded.registry.workers[0].tmuxSessionName, "cleanup-worker-window");
  } finally {
    await rm(tempAgentDir, { recursive: true, force: true });
  }
});
