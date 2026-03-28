import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKER_STATUS,
  classifyWorker,
  findWorkerByNameOrId,
  formatWorkerList,
  formatCleanPreview,
  formatCleanResult,
  getWorkerLivenessProbePlan,
  getWorkerTmuxTarget,
} from "../lib/manager.js";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("classifyWorker returns live when tmux target is alive", () => {
  assert.equal(classifyWorker(true, true, true, { isDirty: false, aheadCount: 0 }), WORKER_STATUS.LIVE);
});

test("classifyWorker returns stale when nothing remains", () => {
  assert.equal(classifyWorker(false, false, false, undefined), WORKER_STATUS.STALE);
});

test("classifyWorker returns dead-needs-attention when worktree is dirty", () => {
  assert.equal(classifyWorker(false, true, true, { isDirty: true, aheadCount: 0 }), WORKER_STATUS.DEAD_NEEDS_ATTENTION);
});

test("classifyWorker returns dead-needs-attention when branch is ahead", () => {
  assert.equal(classifyWorker(false, true, true, { isDirty: false, aheadCount: 3 }), WORKER_STATUS.DEAD_NEEDS_ATTENTION);
});

test("classifyWorker returns dead-needs-attention when rebase in progress", () => {
  assert.equal(
    classifyWorker(false, true, true, { isDirty: false, aheadCount: 0, rebaseInProgress: true }),
    WORKER_STATUS.DEAD_NEEDS_ATTENTION,
  );
});

test("classifyWorker returns dead-safe-to-clean when worktree is clean", () => {
  assert.equal(
    classifyWorker(false, true, true, { isDirty: false, aheadCount: 0 }),
    WORKER_STATUS.DEAD_SAFE_TO_CLEAN,
  );
});

test("classifyWorker returns dead-safe-to-clean for session-only workers", () => {
  assert.equal(classifyWorker(false, true, false, undefined), WORKER_STATUS.DEAD_SAFE_TO_CLEAN);
});

test("getWorkerLivenessProbePlan uses pane only for pane workers", () => {
  assert.deepEqual(getWorkerLivenessProbePlan({ targetMode: "pane", paneId: "%9", windowId: "@2", sessionId: "$1" }), [
    { mode: "pane", targetId: "%9" },
  ]);
});

test("getWorkerLivenessProbePlan uses pane/window fallback for legacy workers", () => {
  assert.deepEqual(getWorkerLivenessProbePlan({ paneId: "%9", windowId: "@2", sessionId: "$1" }), [
    { mode: "pane", targetId: "%9" },
    { mode: "window", targetId: "@2" },
  ]);
});

test("getWorkerTmuxTarget returns authoritative window target", () => {
  assert.deepEqual(
    getWorkerTmuxTarget({ targetMode: "window", paneId: "%9", windowId: "@2", slug: "my-worker" }),
    { targetMode: "window", targetId: "@2", sessionName: "my-worker" },
  );
});

test("getWorkerTmuxTarget falls back to pane metadata for unsupported legacy target modes", () => {
  assert.deepEqual(
    getWorkerTmuxTarget({ targetMode: "session", paneId: "%3", sessionId: "$3", slug: "short-name", tmuxSessionName: "actual-session-name" }),
    { targetMode: "pane", targetId: "%3", sessionName: "actual-session-name" },
  );
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function makeWorkers(...specs) {
  return specs.map(([id, slug, name]) => ({
    record: { id, slug, name },
    live: true,
    status: WORKER_STATUS.LIVE,
  }));
}

test("findWorkerByNameOrId matches by exact id", () => {
  const workers = makeWorkers(["abc-123", "my-worker", "My Worker"]);
  const found = findWorkerByNameOrId(workers, "abc-123");
  assert.equal(found.record.id, "abc-123");
});

test("findWorkerByNameOrId matches by slug", () => {
  const workers = makeWorkers(["abc-123", "my-worker", "My Worker"]);
  const found = findWorkerByNameOrId(workers, "my-worker");
  assert.equal(found.record.slug, "my-worker");
});

test("findWorkerByNameOrId matches by name case-insensitively", () => {
  const workers = makeWorkers(["abc-123", "my-worker", "My Worker"]);
  const found = findWorkerByNameOrId(workers, "my worker");
  assert.equal(found.record.name, "My Worker");
});

test("findWorkerByNameOrId returns undefined for no match", () => {
  const workers = makeWorkers(["abc-123", "my-worker", "My Worker"]);
  assert.equal(findWorkerByNameOrId(workers, "nope"), undefined);
});

test("findWorkerByNameOrId matches partial slug prefix", () => {
  const workers = makeWorkers(["abc-123", "my-worker", "My Worker"], ["def-456", "other-worker", "Other"]);
  const found = findWorkerByNameOrId(workers, "my-");
  assert.equal(found.record.slug, "my-worker");
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test("formatWorkerList returns empty message for no workers", () => {
  assert.match(formatWorkerList([]), /no workers/i);
});

test("formatWorkerList groups by status", () => {
  const workers = [
    { record: { name: "live-one", targetMode: "pane" }, status: WORKER_STATUS.LIVE, gitSummary: "clean" },
    { record: { name: "dead-one", slug: "dead-one", targetMode: "pane", taskBranch: "ezdg/dead-one" }, status: WORKER_STATUS.DEAD_NEEDS_ATTENTION, gitSummary: "dirty" },
  ];
  const output = formatWorkerList(workers);
  assert.match(output, /Open/);
  assert.match(output, /Needs Attention/);
  assert.match(output, /dead-one/);
  assert.match(output, /\/ezdg open dead-one/);
});

test("formatCleanPreview shows safe and attention workers", () => {
  const workers = [
    { record: { name: "safe-one", id: "s1", taskBranch: "ezdg/safe" }, status: WORKER_STATUS.DEAD_SAFE_TO_CLEAN, sessionExists: true, workspaceExists: true, gitSummary: "clean" },
    { record: { name: "attn-one", id: "a1" }, status: WORKER_STATUS.DEAD_NEEDS_ATTENTION, gitSummary: "dirty" },
  ];
  const output = formatCleanPreview(workers);
  assert.match(output, /will clean 1/i);
  assert.match(output, /skipping 1/i);
  assert.match(output, /--yes/);
});

test("formatCleanResult reports cleaned and skipped", () => {
  const result = {
    cleaned: [{ record: { name: "w1" }, actions: ["deleted session", "removed worktree"] }],
    skipped: [],
    needsAttention: [],
  };
  const output = formatCleanResult(result);
  assert.match(output, /cleaned 1/i);
  assert.match(output, /deleted session/);
});
