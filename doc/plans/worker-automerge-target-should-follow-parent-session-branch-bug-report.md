# pi-ez-delegate bug report: worker automerge target should follow the delegating session's branch/worktree, not always the repo main checkout

Status: open bug report / investigation note.

## Summary

For same-repo delegated worktrees, `pi-ez-delegate` currently emits worker completion instructions that merge back into:

- `worktree.mainCheckoutPath`

That is only correct when the delegating session itself is working directly in the repository's main checkout and intends to merge back there.

It is **not** correct when the delegating session is itself operating from:

- a git worktree
- a non-`main` branch
- a `pi-ez-worktree`-routed session whose effective checkout is not the repo main checkout path

In those cases, the worker should:

1. get its own isolated delegated worktree
2. commit on its own `ezdg/<worker>` branch
3. merge back into the **delegating session's active branch/worktree target**, not hardcoded `mainCheckoutPath`

## Why this matters

Delegation is supposed to preserve the current session's branch isolation.

If the parent session is working in a feature branch or a routed worktree, then forcing delegated completion to merge into the repo main checkout can:

- merge work into the wrong branch
- bypass the parent session's intended isolation boundary
- create misleading completion instructions
- make delegated work unsafe in exactly the scenarios where worktree isolation matters most

This is a correctness bug even if worker branch isolation itself is otherwise functioning.

## Verified current behavior

## Evidence from implementation

In `lib/delegate.js`, `buildDelegatedPrompt()` currently emits completion instructions using:

- `worktree.mainCheckoutPath`
- `worktree.taskBranch`

Current code shape:

```js
if (automerge && worktree?.created && worktree.mainCheckoutPath && worktree.taskBranch) {
  const mcp = shellQuoteForPrompt(worktree.mainCheckoutPath);
  const tb = worktree.taskBranch;
  const wp = shellQuoteForPrompt(worktree.worktreePath);
  lines.push(
    "",
    "When your task is complete and all changes are committed, run this single command to merge and clean up:",
    "",
    `cd ${mcp} && git merge ${tb} && git worktree remove --force ${wp} && git branch -d ${tb}`,
  );
}
```

That means the merge target is always the repo's main checkout path, not the parent session's effective checkout.

## Evidence from tests

`test/delegate.test.js` explicitly encodes this current behavior.

The existing test asserts prompt output like:

```text
cd /tmp/repo && git merge ezdg/test-worker
```

with `mainCheckoutPath: "/tmp/repo"`.

So the current implementation and tests are aligned on behavior that is too narrow for routed/non-main parent sessions.

## Why the expected behavior should be different

The package README says delegated work is launched from the **current pi session** and creates an isolated same-repo worktree by default.

That implies delegated completion semantics should preserve the current session's active git context.

If the parent session is effectively working on:

- branch `pi/homelab`
- in worktree `/Users/brain/dev/.pi-worktrees/infra/homelab`

then the delegated worker should merge back into that branch/worktree context, not the repository's plain main checkout at `/Users/brain/dev/infra`.

Otherwise delegation leaks across the parent's own isolation boundary.

## Expected behavior

For same-repo delegated work with automerge enabled:

1. worker starts in its own delegated worktree
2. worker commits on `ezdg/<worker>`
3. completion instructions merge into the **delegating session's active branch target**
4. cleanup removes the delegated worker worktree and branch only after that merge succeeds

More concretely:

- if parent session is on plain repo `main`, merge back into that checkout
- if parent session is on plain repo branch `feature/x`, merge back into that checkout/branch
- if parent session is effectively rooted in a same-repo worktree, merge back into that worktree path / active branch, not the repo main checkout path

## Actual behavior

The emitted completion command always targets `worktree.mainCheckoutPath`, which is derived from the repository common dir / main checkout, not from the parent session's active routed/effective checkout.

That means the completion command can be wrong even when:

- the delegated worker worktree itself is correct
- the worker branch is correct
- the parent session is using an isolated feature worktree intentionally

## Reproduction shape

### Preconditions

- parent pi session is operating in a same-repo worktree or routed non-main branch
- `/ezdg` launches a same-repo worker with default worktree creation
- automerge instructions are enabled

### Steps

1. Start from a parent session whose effective working checkout is not the repo main checkout path.
2. Launch a worker with `/ezdg`.
3. Inspect the worker banner and final completion command.
4. Observe whether the emitted merge command cds into the repo main checkout instead of the parent session's actual active checkout.

### Failure signature

The bug is reproduced if the completion command looks like:

```bash
cd /path/to/repo-main-checkout && git merge ezdg/worker-name ...
```

when the parent session is actually operating from a different worktree/branch.

## Likely fix direction

The automerge target should be derived from the delegating session's active git context, not always from `worktree.mainCheckoutPath`.

Possible directions:

### Option A — persist parent merge target explicitly

At delegate launch time, record:

- parent effective cwd
- parent repo toplevel
- parent active branch
- parent merge target path

Then build completion instructions from that explicit merge target.

### Option B — derive merge target from active ez-worktree/delegate state

If the parent session has an active same-repo worktree/routed checkout, resolve the merge target to that path instead of the repo main checkout.

### Option C — split prompt fields more clearly

Store both:

- `repoMainCheckoutPath`
- `parentCheckoutPath`

and make tests enforce that automerge uses the **parent checkout path**.

## Acceptance criteria

- delegated workers still create their own isolated worktrees
- worker commits still land on `ezdg/<worker>`
- automerge instructions target the delegating session's active branch/worktree
- when the parent session is on repo `main`, behavior remains unchanged
- tests cover both:
  - plain repo-main parent session
  - parent session rooted in a different same-repo worktree/branch

## Suggested test additions

Add coverage in `test/delegate.test.js` for a parent session whose effective checkout differs from `mainCheckoutPath`.

Expected assertions:

- prompt merges into parent checkout path, not repo main checkout path
- task branch remains `ezdg/<worker>`
- cleanup still removes the delegated worktree/branch after merge

## Relationship to existing bug reports

This is related to, but distinct from:

- `doc/plans/worker-branch-and-worktree-isolation-bug-report.md`
- `doc/plans/worker-commit-on-main-merge-cleanup-bug-report.md`

Those reports cover workers launching or committing in the wrong checkout.

This report covers a separate correctness issue:

- even if worker isolation is correct, the **automerge target** can still be wrong when the parent session is not the repo main checkout.

## Compact summary

`pi-ez-delegate` currently hardcodes worker completion merge instructions to the repository main checkout path.

That is too narrow.

For delegated same-repo work, automerge should target the **delegating session's active branch/worktree context**, because the parent session may itself be isolated in a worktree or non-main branch.
