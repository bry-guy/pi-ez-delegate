# pi-ez-delegate bug triage and fix plan

Status: investigation complete, fixes not implemented yet.

This document summarizes the currently filed bug reports and the most likely root causes found by inspecting the implementation.

Bug reports reviewed:
- `doc/plans/pane-worker-liveness-fallback-prevents-cleanup-bug-report.md`
- `doc/plans/worker-branch-and-worktree-isolation-bug-report.md`
- `doc/plans/worker-commit-on-main-merge-cleanup-bug-report.md`

## Executive summary

There appear to be **two primary bugs** and **one adjacent hardening issue**.

### Primary bug 1: delegated workers can launch in the wrong checkout

Most likely root cause:
- `lib/delegate.js` creates an isolated worktree and computes `worktree.effectiveCwd`
- but the tmux worker is launched with `cwd: parentCwd` instead of `cwd: worktree.effectiveCwd`

This directly explains the two high-severity isolation reports:
- worker appears to be on `main`
- worker sees unrelated dirty files from the parent checkout
- worker commits land on `main`
- merge/cleanup instructions become misleading or unsafe

### Primary bug 2: pane workers can be misclassified as live after exit

Most likely root cause:
- `lib/manager.js` checks pane liveness first, then falls back to window liveness, then session liveness
- for pane workers, the recorded window/session are often just the still-live parent tmux containers
- a dead pane therefore remains classified as live

This directly explains the cleanup/listing bug:
- dead pane worker remains under **Live**
- `/ezdg clean` never reaches it
- stale registry entries accumulate

### Adjacent hardening issue: attach/open uses non-authoritative tmux ids

While investigating, I also found a likely follow-on bug:
- `extensions/delegate.js` uses `paneId || windowId || sessionId` when attaching/opening live workers
- this ignores `targetMode`
- session workers also pass `worker.record.slug` as the session name, but the actual tmux session name is created from `worker.tmuxName` and is not persisted in the registry

This is not the main cause of the filed reports, but it is worth fixing in the same hardening pass because it can make `attach`/`open` unreliable.

## Evidence from the current code

### 1. Wrong cwd is passed at launch time

In `lib/delegate.js`, the worker launch currently uses the parent cwd:

- `launchInTmux({ ... cwd: parentCwd, ... })`

But the same function also computes and records:
- `worktree.effectiveCwd`
- `cwd.effective`
- prompt text that tells the worker it is running in the delegated worktree

So the launch banner and registry can claim one workspace while tmux starts the worker process in another.

### 2. Liveness fallback is too broad for pane workers

In `lib/manager.js`, `inspectWorker()` currently does this shape:

- check `paneId`
- if not live, check `windowId`
- if not live, check `sessionId`

That logic is valid only if those ids are interchangeable representations of the same worker identity.

For `targetMode: "pane"`, they are not interchangeable:
- pane id = worker identity
- window/session ids = enclosing containers, often belonging to the parent session

### 3. Attach/open target selection is not mode-aware

In `extensions/delegate.js`, both `handleAttach()` and the live path in `handleOpen()` do:

- `const targetId = worker.record.paneId || worker.record.windowId || worker.record.sessionId;`

That should instead select the id that matches `targetMode`.

## Proposed fix plan

## Phase 1 — fix worker isolation and launch correctness

Priority: highest.

### Changes

#### A. Launch tmux in the effective delegated cwd

File:
- `lib/delegate.js`

Change:
- replace `cwd: parentCwd` with `cwd: worktree.effectiveCwd`

Expected effect:
- worker process starts inside the delegated worktree
- `git branch --show-current` reflects the delegated branch
- unrelated parent-checkout dirty state is no longer visible in the worker

#### B. Add explicit git verification after creating a worktree

Files:
- `lib/delegate.js`
- possibly a small helper inside the same file

Add verification immediately after `git worktree add`:
- `git -C <worktreePath> rev-parse --show-toplevel`
- `git -C <worktreePath> branch --show-current`
- `git -C <worktreePath> status --porcelain`

Verify at least:
- toplevel resolves to `worktreePath`
- current branch equals `taskBranch`
- fresh worker launch is clean

If verification fails:
- abort launch
- clean up the newly created worktree/branch
- surface a clear error instead of launching an unsafe worker

#### C. Add a launch-time invariant helper

File:
- `lib/delegate.js`

Extract a small helper to make the launch contract testable, for example:
- choose launch cwd
- verify worktree identity
- return normalized launch metadata

Goal:
- make the launch contract unit-testable without requiring tmux smoke coverage

### Tests to add

Files:
- `test/delegate.test.js`
- optionally extend `test/smoke-tmux.js`

Add coverage for:
1. same-repo worker launch passes the delegated effective cwd into tmux launch
2. worktree verification rejects mismatched branch/toplevel state
3. launch metadata and actual verified git state agree
4. smoke test asserts the spawned process cwd equals `result.cwd.effective`

### Acceptance criteria

- new same-repo workers start in the delegated worktree path
- `git branch --show-current` in the worker shows `ezdg/<worker>`
- worker commits do not land on `main`
- parent `main` does not advance before explicit merge
- two delegated workers do not see each other’s uncommitted changes

## Phase 2 — fix pane worker liveness classification

Priority: high.

### Changes

#### A. Make liveness mode-authoritative

File:
- `lib/manager.js`

Change `inspectWorker()` to use `record.targetMode` as the source of truth:
- `pane` workers: check only `paneId`
- `window` workers: check only `windowId`
- `session` workers: check only `sessionId`
- only use the current fallback chain for older records with no `targetMode`

#### B. Keep conservative backward compatibility for old registry records

File:
- `lib/manager.js`

If `targetMode` is missing:
- continue the old fallback behavior
- optionally add a comment marking it as legacy compatibility logic

### Tests to add

File:
- `test/manager.test.js`

Add coverage for:
1. pane worker: pane dead, parent window/session alive -> worker is dead
2. window worker: window alive -> worker is live
3. session worker: session alive -> worker is live
4. legacy record without `targetMode` still uses fallback behavior

To make this easy to test, extract the liveness selection logic into a small pure helper, for example:
- `resolveWorkerLivenessTargets(record)`
- or `getAuthoritativeTarget(record)`

### Acceptance criteria

- dead pane workers no longer remain stuck under **Live**
- `/ezdg list` shows them as dead
- `/ezdg clean` can clean safe dead pane workers
- stale registry entries stop accumulating from this case

## Phase 3 — harden attach/open target selection

Priority: medium, but worth doing in the same release.

### Changes

#### A. Select tmux target ids by mode

File:
- `extensions/delegate.js`

Replace:
- `paneId || windowId || sessionId`

With mode-aware selection:
- pane -> `paneId`
- window -> `windowId`
- session -> `sessionId`

#### B. Persist actual tmux session name for session launches

Files:
- `lib/registry.js`
- `extensions/delegate.js`
- possibly `lib/tmux.js` / launch result handling

Reason:
- session attach currently passes `worker.record.slug` as `sessionName`
- actual tmux session name is the launch-time worker/tmux name
- those values can diverge because of truncation and hierarchical naming

Store the actual session name in the registry and use it when attaching.

### Tests to add

Files:
- `test/registry.test.js`
- `test/manager.test.js` or a new attach-specific test file

Add coverage for:
1. registry persists session launch name
2. attach/open selects the correct tmux target id for each mode
3. session workers attach using persisted session name, not inferred slug

## Recommended implementation order

1. **Phase 1 first** — fixes the safety-critical branch/worktree isolation issue
2. **Phase 2 second** — fixes worker lifecycle correctness and cleanup
3. **Phase 3 third** — hardens live attach/open semantics

## Release recommendation

Ship these as a single patch release if possible, because the bugs interact in user trust:
- isolation bug makes work unsafe
- liveness bug makes cleanup unreliable
- attach/open hardening improves recovery behavior after the first two fixes

## Suggested changelog wording

- fix delegated worker launch cwd so same-repo workers start inside their isolated worktrees
- add launch-time verification for delegated worktree branch/toplevel correctness
- fix pane worker liveness classification so dead pane workers are not kept alive by parent window/session fallback
- harden attach/open target selection to respect worker target mode

## Notes

The two filed high-severity reports about branch/worktree isolation look like different symptoms of the same underlying launch bug. I would treat them as one root-cause fix with two regression tests:
- worker starts on `main`
- worker commit lands on `main`

Both should disappear once launch cwd and verification are corrected.
