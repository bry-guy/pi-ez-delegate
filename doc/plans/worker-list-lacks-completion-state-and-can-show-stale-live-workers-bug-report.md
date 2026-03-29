# pi-ez-delegate bug report: `/ezdg list` conflates tmux liveness with task completion and can still show stale workers as Live

Status: partially done

## Summary

`/ezdg list` currently answers a narrow question: does the recorded tmux target still look alive?

Update: this has been improved, but not fully solved. Pane-worker liveness fallback bugs were fixed, and the user-facing `Live` label was changed to `Open` with git-summary context such as `Open (clean)`. However, the system still does not distinguish truly active work from merely open/idle workers, nor does it detect integrated/done state.

That is not the same as the user question they usually mean to ask:

- is this worker still doing useful work?
- is this worker finished?
- is this worker safe to close or clean?

In practice this creates two confusing failure modes:

1. **completed but idle workers still appear under Live** because the pi process/tmux target still exists
2. **stale workers can also appear under Live** when registry state drifts from reality or pane-target liveness is misclassified

## Concrete observed case

In `srvivor`, the UI showed these as Live:

- `docs-followthrough` — `[window] ... (clean)`
- `docs-followthrough` — `[pane] ... (clean)`
- `automation-ci` — `[pane] ...`

Observed repo/worktree state at inspection time:

- the delegated work had already been integrated into `main`
- `automation-ci` worktree path no longer existed
- `docs-followthrough` worktree still existed and was clean
- tmux inspection showed only one delegate-style node window still present, not three distinct active workers

So the list mixed together:

- workers that were effectively **done but still open**
- workers that were plausibly **stale**

## Why this is confusing

The current Live label reads to users like:

- work is still in progress
- do not touch this worker yet

But the actual implementation appears much closer to:

- some tmux target tied to this record still exists, or is believed to exist

That mismatch makes it hard to answer basic lifecycle questions.

A clean, idle worker with no pending work is not meaningfully "live" in the same way as an actively running worker.

## Expected behavior

`/ezdg list` should distinguish at least these states:

### 1. Running / Active

- tmux target exists
- worker process is present
- worker likely still doing work or waiting for interaction

### 2. Idle but open

- tmux target exists
- worktree is clean
- worker is not obviously doing work
- safe to close manually if desired

### 3. Done / integrated

- work has already been merged or otherwise superseded
- worker can be closed or archived
- should not keep looking like active in-progress work

### 4. Stale / inconsistent

- registry says Live or open-ish
- but worktree/session/tmux evidence disagrees
- user should be told this is drift, not ongoing work

## Actual behavior

Everything tends to collapse into a coarse Live bucket when tmux evidence exists or is believed to exist.

That leaves users unable to tell:

- which workers are actually still running
- which are merely idle and forgotten
- which are stale and should be cleaned up

## Relationship to existing pane-liveness bug

This bug is related to, but distinct from:

- `doc/plans/pane-worker-liveness-fallback-prevents-cleanup-bug-report.md`

That report covers a correctness bug where pane workers can be misclassified as live because liveness falls back to parent window/session.

This report covers the broader UX/state-model problem:

- even when raw tmux liveness is technically correct, the label **Live** is too coarse and misleading for completed clean workers
- and when liveness is wrong, the same label makes stale workers look active

## Evidence from the observed case

### `automation-ci`

- was still shown in the UI as Live
- but its worktree path had already been removed
- that strongly suggests stale registry/liveness classification

### `docs-followthrough`

- appeared twice as Live (`window` and `pane` variants)
- worktree state was clean
- only one obvious delegate-style tmux node window remained visible during inspection
- at least one of the two records was likely stale, and the remaining one was at best idle/open rather than actively working

## Impact

Severity: medium.

Consequences:

- users keep wondering whether finished workers are still doing work
- cleanup decisions are delayed because Live sounds unsafe to touch
- stale worker records blend into real workers
- worker list trust degrades over time

## Likely root cause

The worker model currently emphasizes tmux-target liveness but does not track or surface enough lifecycle state to answer user intent.

Likely missing concepts:

- completion / integrated status
- idle-open vs actively-running distinction
- stronger stale-state detection when worktree/session/tmux evidence disagree

## Proposed fix direction

Keep raw tmux liveness, but present a richer derived status.

Possible derived status inputs:

- tmux target exists
- session file exists
- worktree exists
- worktree clean/dirty/ahead/behind
- branch merged/integrated vs still unique
- optional recent worker heartbeat/activity timestamp if available

Possible user-facing statuses:

- `Active`
- `Idle (open)`
- `Done (open)`
- `Safe to clean`
- `Needs attention`
- `Stale`

## Minimum acceptable improvement

Status: mostly achieved.

Even without full lifecycle tracking, `/ezdg list` should stop using only the word Live when the record is also:

- clean
- merged/integrated
- or internally inconsistent

Examples:

- `Live (idle, clean)`
- `Live (stale metadata?)`
- `Done but still open`

## Reproduction sketch

1. Start a delegated worker
2. Let it finish its assigned task
3. Integrate or merge the resulting work
4. Leave the tmux target open, or partially clean up the worker
5. Run `/ezdg list`
6. Observe that the worker still appears as Live without enough context to tell whether it is active, idle, done, or stale

## User-visible symptom summary

"`/ezdg list` says my workers are live, but I can't tell whether they are still working, merely open, or actually stale. A finished clean worker should not look the same as an active worker."