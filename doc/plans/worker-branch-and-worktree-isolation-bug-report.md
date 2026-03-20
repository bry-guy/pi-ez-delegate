# pi-ez-delegate bug report: delegated worker not isolated to expected branch/worktree state

Status: open bug report / investigation note.

## Summary

A delegated `/ezdg` worker that was announced as an isolated worktree on branch `ezdg/castaway-web-prod-contract` appeared to be running on `main` instead, and its checkout contained unrelated uncommitted changes outside the worker's assigned file ownership.

That breaks one of the core expectations of `pi-ez-delegate`:

- a delegated same-repo worker should get an isolated worktree
- that worktree should be attached to the worker branch created for that delegation
- the worker should not appear to inherit unrelated dirty state from other workstreams

## Why this matters

This failure mode makes the worker cleanup instructions unsafe.

In the observed session, the worker was instructed to run:

```bash
cd /Users/brain/dev/srvivor && git merge ezdg/castaway-web-prod-contract && git worktree remove --force /Users/brain/dev/.pi-worktrees/srvivor/castaway-web-prod-contract && git branch -d ezdg/castaway-web-prod-contract
```

That would only be safe if the delegated worker were actually:

- on branch `ezdg/castaway-web-prod-contract`
- isolated from unrelated edits
- operating in a clean same-repo worktree created for that branch

Instead, the worker observed:

- `git branch --show-current` reported `main`
- `git status --short` showed unrelated modifications under:
  - `apps/castaway-discord-bot/**`
  - `deploy/**`

So the worker had to stop and refuse the cleanup/merge step.

## Observed context

The delegated worker banner said:

- worker name: `castaway-web-prod-contract`
- worktree path: `/Users/brain/dev/.pi-worktrees/srvivor/castaway-web-prod-contract`
- isolated git worktree: `/Users/brain/dev/.pi-worktrees/srvivor/castaway-web-prod-contract (ezdg/castaway-web-prod-contract based on main)`

The worker task itself was intentionally scoped to:

- `apps/castaway-web/**` only
- explicitly do **not** edit `deploy/**`
- explicitly do **not** edit `.github/workflows/**`

## Observed symptoms

### Symptom 1: branch mismatch

Inside the delegated worker checkout, the worker ran:

```bash
git branch --show-current
git rev-parse --abbrev-ref HEAD
git log --oneline -1
```

Observed output:

```text
main
main
8433ab2 feat(castaway-web): add service auth and migration entrypoint
```

Expected output:

```text
ezdg/castaway-web-prod-contract
ezdg/castaway-web-prod-contract
<worker commit>
```

### Symptom 2: unrelated dirty state in the delegated worktree

Inside the delegated worker checkout, the worker ran:

```bash
git status --short
```

Observed output included unrelated paths outside the worker's ownership:

```text
 M apps/castaway-discord-bot/cmd/bot/main.go
 M apps/castaway-discord-bot/go.mod
 M apps/castaway-discord-bot/go.sum
 M apps/castaway-discord-bot/internal/castaway/client.go
 M apps/castaway-discord-bot/internal/config/config.go
 M apps/castaway-discord-bot/internal/discord/bot.go
 M apps/castaway-discord-bot/internal/state/store.go
?? apps/castaway-discord-bot/internal/state/bolt_store.go
?? apps/castaway-discord-bot/internal/state/import.go
?? apps/castaway-discord-bot/internal/state/open.go
?? apps/castaway-discord-bot/internal/state/postgres_store.go
?? deploy/
```

The worker had only modified `apps/castaway-web/**`, and the task explicitly forbade editing `deploy/**`.

Expected state:

- only the worker's own `apps/castaway-web/**` edits should be present
- no unrelated dirty files from other workstreams should appear

### Symptom 3: unsafe cleanup path

Because of the mismatch above, the worker could not safely run the merge/remove/branch-delete command it had been instructed to run on completion.

## Expected behavior

For same-repo delegated work with `createWorktree=true`, the worker should observe all of the following:

1. its cwd is inside the created worktree
2. `git branch --show-current` reports the worker branch
3. `git rev-parse --show-toplevel` points at the delegated worktree root
4. the worktree starts clean unless the tool intentionally pre-populates it
5. unrelated in-progress changes from other workers do not appear in that worktree
6. worker cleanup instructions remain valid for the branch/worktree that was actually created

## Actual behavior

The worker banner and the actual git state diverged:

- banner implied worker branch/worktree isolation
- actual `git` state looked like the worker was on `main`
- actual `git status` looked contaminated by unrelated workstreams

## Impact

Severity: high for trust/safety, even if the underlying bug is intermittent.

Consequences:

- workers cannot trust their own checkout identity
- cleanup instructions may delete or merge the wrong branch/worktree
- unrelated workstreams may appear to collide even when delegation was chosen to avoid exactly that
- users may stop trusting `/ezdg` for parallel same-repo implementation work

## What was safely completed despite the bug

The worker completed its assigned `apps/castaway-web/**` work and created a commit:

```text
8433ab2 feat(castaway-web): add service auth and migration entrypoint
```

But it explicitly refused to perform final merge/cleanup because the observed branch/worktree state was unsafe.

## Suspected failure classes

This report does not claim a root cause, but the likely failure classes seem to be:

### 1. Worker process launched in the intended cwd, but git HEAD/worktree attachment was wrong

Possibilities:

- worktree directory reused unexpectedly
- branch checkout failed silently
- launch metadata recorded one branch while process actually started on another

### 2. Session/worktree identity drift after launch

Possibilities:

- later command reopened or reattached the worker into the wrong checkout
- a pre-existing worktree path was reused with stale branch state
- registry/session restore logic pointed at a mismatched branch/worktree combination

### 3. Concurrent contamination from another session/process

Possibilities:

- multiple workers writing to the same physical checkout
- a reopened worker and a fresh worker sharing one path
- `main` checkout unexpectedly receiving delegated changes instead of the isolated worktree

## Reproduction status

I do not yet have a minimal deterministic repro.

This report is based on a real observed delegated worker session. At minimum, it is a credible evidence report even if the trigger is intermittent.

## Proposed repro attempt

The next step should be a focused repro with extra instrumentation.

### Preconditions

- run `pi` inside tmux
- use a repo with multiple clearly separable workstreams
- ensure parent repo is clean before delegation
- delegate two same-repo workers with `createWorktree=true`

### Suggested repro script

From a clean parent repo session:

1. Launch worker A with `/ezdg` on one app-local scope.
2. Launch worker B with `/ezdg` on a different app-local scope.
3. In each worker, immediately record:
   - `pwd`
   - `git rev-parse --show-toplevel`
   - `git branch --show-current`
   - `git rev-parse --abbrev-ref HEAD`
   - `git status --short`
   - `git worktree list`
4. Make a small uncommitted change in worker A only.
5. Verify worker B does not see it.
6. Commit in worker A only.
7. Verify worker B still does not see it.
8. Repeat after closing/reopening one worker via `/ezdg open`.

### Suggested invariant checks for automation

The delegated worker launch path should be validated with assertions like:

- registry branch == actual `git branch --show-current`
- registry worktree path == actual `git rev-parse --show-toplevel` or cwd-rooted path expectation
- `git status --short` is empty at launch in a fresh worker
- worker A and worker B have different `git rev-parse --show-toplevel` results when both use same-repo worktrees

## Recommended instrumentation to add

To make the next repro actionable, consider logging these values at worker creation and reopen time:

- requested branch name
- actual branch after checkout
- requested worktree path
- actual `git rev-parse --show-toplevel`
- requested cwd
- effective cwd passed to worker process
- whether the target worktree path already existed before creation
- whether branch creation/checkout returned success
- whether reopen reused an existing worker path

## Candidate areas to inspect in `pi-ez-delegate`

Based on the package structure and README behavior, likely inspection areas include:

- worker launch path in `lib/delegate.js`
- worker registry/state restore path in `lib/manager.js`
- any worktree creation/reuse logic
- reopen/attach logic for dead workers
- any path translation between:
  - requested cwd
  - worktree root
  - effective worker cwd
- any assumptions around session-rooted worktree behavior vs tool-routed worktree behavior

## User-facing symptom wording

If this bug is confirmed, the user-facing symptom is roughly:

> `/ezdg` said it created an isolated same-repo worktree on branch `ezdg/<name>`, but the delegated worker reported `main` and showed unrelated dirty files from another workstream.`

## Recommended fix acceptance criteria

A fix should be considered successful only if all of the following hold in test/manual repro:

- a newly launched same-repo worker reports the expected worker branch
- a newly launched same-repo worker starts clean
- two workers do not see each other's uncommitted changes
- reopen preserves correct worker branch/worktree identity
- cleanup instructions are safe because branch/worktree identity matches the launch banner and registry

## Appendix: exact observed worker safety note

The worker concluded with this summary:

> I did not run the requested merge/cleanup command because this worktree currently contains unrelated uncommitted changes outside my ownership (`apps/castaway-discord-bot/**` and `deploy/**`), and the worktree is currently reporting branch `main` rather than `ezdg/castaway-web-prod-contract`. Running the cleanup command as written would not be safe.
