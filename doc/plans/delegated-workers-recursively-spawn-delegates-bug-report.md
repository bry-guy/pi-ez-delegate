# Bug: Delegated workers recursively spawn their own delegates

Status: `open`
Severity: **critical** — can create 150+ worktrees/branches in under a minute with no useful work done

## Summary

When a parent pi session uses `delegate_task` to launch workers, the forked worker sessions inherit the full conversation context including the `delegate-work` skill. The delegated workers then interpret their own task prompt as containing "independent workstreams" and call `delegate_task` themselves. Those sub-delegates do the same thing, creating an exponential cascade of worktree/branch creation with no actual code changes produced.

## Reproduction

1. Have a pi session with the `delegate-work` skill available (via `pi-ez-delegate`).
2. From the parent session, call `delegate_task` for 4 independent workstreams, each with `createWorktree: true`.
3. Each delegate inherits the conversation history and available skills.
4. Each delegate sees its task prompt, recognizes it contains sub-tasks or file ownership boundaries, and decides to further delegate using `delegate_task`.
5. Sub-delegates repeat step 4.
6. Result: **155 linked worktrees**, **154 `ezdg/*` branches**, **14 distinct naming patterns** with numeric suffixes up to `-31`.

## Observed behavior

- 155 git worktrees created under `.pi-worktrees/srvivor/`
- 154 local branches created (`ezdg/*` prefix)
- 0 actual commits produced beyond the base branch
- 1 worktree had a single dirty file (partial TypeSpec edit)
- tmux panes were exhausted and cleaned up by the time the user intervened
- The cascade was self-sustaining: delegates spawned delegates spawned delegates

## Naming patterns observed

The delegates chose varied names for their sub-delegates, showing the LLM was re-interpreting the task each time:

```
ezdg/api-contract[-N]        (16 copies)
ezdg/web-api-contract[-N]    (22 copies)
ezdg/web-contract[-N]        (5 copies)
ezdg/web-handlers            (1 copy)
ezdg/web-http[-N]            (13 copies)
ezdg/web-http-handlers[-N]   (4 copies)
ezdg/web-http-impl[-N]       (17 copies)
ezdg/web-httpapi[-N]         (9 copies)
ezdg/bot-client-format[-N]   (31 copies)
ezdg/bot-commands[-N]        (19 copies)
ezdg/bot-discord-commands    (1 copy)
ezdg/bot-discord-handlers[-N](12 copies)
ezdg/bot-handlers[-N]        (4 copies)
```

## Root cause

There is no mechanism to prevent a delegated worker from calling `delegate_task` itself. The `delegate-work` skill's "when to use" heuristics fire on the delegated task prompt because:

1. The task prompt describes work with clear file ownership boundaries (which the skill interprets as "independent workstreams").
2. The forked session retains access to `delegate_task` as a callable tool.
3. There is no depth limit, recursion guard, or "I am a delegate" flag in the forked context.

## Expected behavior

Delegated workers should **never** call `delegate_task`. A worker should only do the work described in its task prompt.

## Suggested fixes (any one would help, ideally combine)

1. **Strip `delegate_task` from forked worker tool sets.** Workers should not have access to the delegation tool at all.
2. **Add a recursion guard.** If the session was created by `delegate_task`, set a flag (e.g., env var or session metadata) that prevents further delegation.
3. **Add a depth limit.** `delegate_task` could track delegation depth and refuse to delegate beyond depth 1.
4. **Update the skill prompt.** The `delegate-work` SKILL.md should add an explicit "when not to use" rule: "You are a delegated worker — do not delegate further."
5. **Inject a system-level instruction into forked sessions.** When forking, prepend something like "You are a delegated worker. Do your own work directly. Do NOT use delegate_task or suggest further delegation."

## Impact

- 155 worktrees consuming disk space (each is a full checkout)
- 154 stale branches polluting the repo
- No useful work produced
- User had to manually intervene and spend significant time cleaning up
- Risk of git corruption or performance degradation with that many worktrees

## Environment

- pi-ez-delegate (current as of 2026-03-26)
- pi-ez-worktree (current as of 2026-03-26)
- Claude as the LLM backend
- macOS, tmux available
