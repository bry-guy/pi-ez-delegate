# pi-ez-delegate bug report: delegated worker committed on `main`, making merge/cleanup a no-op

Status: open bug report / investigation note.

## Summary

A delegated `/ezdg` worker was launched with a banner claiming it had an isolated same-repo worktree on branch:

- `ezdg/discord-bot-prod-client-state`

But when the worker committed its completed work, Git reported the commit landing on:

- `main`

That broke the expected worker lifecycle:

1. worker commits on its own `ezdg/...` branch
2. worker merges that branch back into `main`
3. worker removes its worktree
4. worker deletes its branch

Instead, the worker commit already lived on `main`, so the requested merge step became a no-op and the cleanup step deleted a stale worker branch pointer that did not actually contain the work.

## Why this matters

This is a trust and safety issue for delegated work.

If a worker appears isolated but is actually checked out on `main`, then:

- delegation is no longer protecting the parent branch from direct edits
- merge/cleanup instructions become misleading
- users cannot trust worker completion semantics
- the worker branch may be deleted even though it never received the worker's actual commit

For `/ezdg`, this is especially important because the whole point is safe parallel same-repo work.

## Observed session context

The delegated worker banner stated:

- worker name: `discord-bot-prod-client-state`
- working directory: `/Users/brain/dev/.pi-worktrees/srvivor/discord-bot-prod-client-state`
- isolated git worktree: `/Users/brain/dev/.pi-worktrees/srvivor/discord-bot-prod-client-state (ezdg/discord-bot-prod-client-state based on main)`

The worker was instructed to:

- implement `apps/castaway-discord-bot/**` work only
- commit its work in the worker worktree
- then run this exact completion command:

```bash
cd /Users/brain/dev/srvivor && git merge ezdg/discord-bot-prod-client-state && git worktree remove --force /Users/brain/dev/.pi-worktrees/srvivor/discord-bot-prod-client-state && git branch -d ezdg/discord-bot-prod-client-state
```

## Observed symptoms

### Symptom 1: the worker commit landed on `main`

The worker made its implementation commit and Git printed:

```text
[main 81721ea] feat: support bot api auth and postgres state backend
```

Expected output should have looked more like:

```text
[ezdg/discord-bot-prod-client-state <sha>] feat: support bot api auth and postgres state backend
```

This is the clearest signal that the worker was not actually committing on the expected delegated branch.

### Symptom 2: merge step became a no-op

When the worker ran the instructed completion command, Git reported:

```text
Already up to date.
```

That only makes sense if `main` already contained the worker's commit.

Expected behavior:

- `git merge ezdg/discord-bot-prod-client-state` should have advanced `main`
- then cleanup should remove the worker worktree and delete the merged worker branch

Actual behavior:

- merge did nothing because the worker commit was already on `main`

### Symptom 3: deleted worker branch was stale

The cleanup command then printed:

```text
Deleted branch ezdg/discord-bot-prod-client-state (was bb932f1).
```

But the worker's actual implementation commit was:

- `81721ea`

That means the deleted worker branch tip was stale and did not contain the worker's completed work.

### Symptom 4: reflog confirms `main` moved directly

Immediately after the worker commit, the parent repo showed:

```text
81721ea (HEAD -> main) feat: support bot api auth and postgres state backend
```

And reflog included:

```text
81721ea HEAD@{0}: commit: feat: support bot api auth and postgres state backend
```

That indicates the delegated worker advanced `main` directly.

## Expected behavior

For a same-repo delegated worker with `createWorktree=true`, all of the following should hold:

1. the worker's checkout is on branch `ezdg/<worker-name>`
2. worker commits land on that branch, not `main`
3. the parent repo's `main` does not advance until the explicit merge step
4. the merge step actually merges worker changes back to `main`
5. the deleted worker branch is the one that contains the worker's commit history

## Actual behavior

The launch banner and the actual git branch state diverged:

- banner implied worker branch/worktree isolation
- worker commit landed on `main`
- merge step was already a no-op
- stale `ezdg/...` branch was deleted afterward

## Impact

Severity: high for delegated-work safety.

Consequences:

- worker isolation is not reliable
- users may think delegated work is isolated when it is not
- completion/cleanup instructions can be misleading
- branch deletion can clean up the wrong ref
- future users may stop trusting `/ezdg` for safe parallel work

## Minimal evidence log

Observed outputs:

```text
[main 81721ea] feat: support bot api auth and postgres state backend
```

```text
Already up to date.
Deleted branch ezdg/discord-bot-prod-client-state (was bb932f1).
```

```text
81721ea (HEAD -> main) feat: support bot api auth and postgres state backend
```

```text
81721ea HEAD@{0}: commit: feat: support bot api auth and postgres state backend
```

## Reproduction status

I do not yet have a fully deterministic repro, but I do have a concrete repro shape that should be easy to instrument.

## Proposed repro

### Preconditions

- run `pi` inside tmux
- use a same-repo `/ezdg` worker with default worktree creation
- start from a clean parent repo on `main`

### Steps

1. From the parent session, launch a same-repo worker:

```text
/ezdg start --name repro-worker make a tiny docs-only change in this repo
```

2. In the worker, before editing anything, run:

```bash
git branch --show-current
git status --short --branch
git rev-parse --show-toplevel
git worktree list
```

3. Make a tiny change and commit it.

4. Observe the commit output carefully.

### Failure signature

The bug is reproduced if commit output says:

```text
[main <sha>] ...
```

instead of:

```text
[ezdg/repro-worker <sha>] ...
```

5. Then run the standard worker completion command from the parent repo and observe whether:

- merge says `Already up to date`
- the worker branch being deleted does not point at the worker commit

## Stronger repro variant

To make this easier to debug, use two checks:

### Check A: before editing

Worker should report:

```bash
git branch --show-current
```

Expected:

```text
ezdg/repro-worker
```

If it already says `main`, the launch is broken before any work happens.

### Check B: after commit

Compare:

```bash
git log --oneline --decorate -1
```

in both:

- the worker worktree
- the parent repo

Expected before merge:

- worker repo shows commit on `ezdg/repro-worker`
- parent repo `main` does not yet include that commit

Buggy behavior:

- parent repo `main` already includes the worker commit before merge

## Likely failure classes

This report does not claim a specific root cause, but the likely classes are:

### 1. worktree created, but worker process launched with `main` checked out

Possibilities:

- branch checkout failed silently during worktree creation
- worktree path existed, but branch attachment did not match the banner metadata
- launch flow recorded intended branch without verifying actual checkout state

### 2. worker session rooted in the worktree path, but branch identity drifted

Possibilities:

- worker session or reopen logic attached to the correct path but wrong branch
- branch switching failed during session startup or reopen
- registry metadata was stale while the actual checkout followed a different branch

### 3. parent branch advanced directly because worker was effectively not isolated

Possibilities:

- delegated worker inherited `main` HEAD in the worktree
- worker branch was created as a ref but never actually checked out
- cleanup instructions assumed invariants that the launch path did not enforce

## Recommended instrumentation

To debug this properly, `pi-ez-delegate` should log or assert these values at worker creation and reopen time:

- intended worker branch name
- actual branch after checkout (`git branch --show-current`)
- intended worktree path
- actual repo toplevel (`git rev-parse --show-toplevel`)
- whether the path already existed before worktree creation
- whether branch checkout returned success
- whether the actual post-launch branch matches the banner/registry branch

## Recommended acceptance criteria for a fix

A fix should not be considered complete unless all of the following hold:

- a delegated same-repo worker always reports the expected `ezdg/...` branch at launch
- worker commits land on `ezdg/...`, never on `main`
- before explicit merge, parent `main` does not contain the worker commit
- merge/cleanup instructions work exactly as emitted
- deleted worker branch actually contains the worker's commit history

## Suggested user-facing safeguard

Even before a deeper fix, the launch path should probably fail fast if post-launch verification says the worker is on `main`.

For example:

> Worker launch failed: expected delegated branch `ezdg/<name>`, but actual checkout is `main`. Refusing to start an unsafe worker.

That would be much safer than launching a worker that only appears isolated.

## Relationship to other isolation bugs

This may be related to broader worktree/branch isolation issues already observed in delegated workers, especially cases where:

- launch banners imply one branch/worktree identity
- actual `git` state reports something else
- unrelated work leaks across workers

Even if the underlying cause is shared, this specific failure mode deserves its own bug report because it directly breaks the worker completion contract.
