---
name: delegate-work
description: Use when a user request contains independent workstreams that should be delegated into forked pi worker sessions instead of handled serially in the current session.
---

# Delegate Work

Use the `delegate_task` tool from `pi-ez-delegate` when a request can be split into independent workstreams.

## When to use this
- The user gives multiple independent workstreams
- A task can be partitioned by subsystem, repository, or file ownership
- The user explicitly asks to fan work out into delegated workers
- The current session should remain focused on integration, coordination, or review

## When **not** to use this
- Multiple tasks need to edit the same files immediately
- Workstreams are highly sequential and depend on unsettled interfaces
- The user wants all work to stay inside the current session
- tmux is unavailable on the host running pi
- You are already a delegated worker; delegated workers must not launch more delegates

## Rules
1. Delegate only self-contained work with clear ownership boundaries.
2. Prefer a small number of meaningful delegated workers over many tiny workers.
3. Use `delegate_task` for investigation, read-only, fetch, planning, or other non-isolated work.
4. Use `delegate_task_worktree` for software changes that should be isolated in a branch/worktree. Do not ask the delegate to decide whether isolation is needed.
5. Include the concrete goal, relevant files, constraints, expected output, and result expectations in the delegated task prompt.
6. Keep integration/review/merge decisions local to the delegator. Delegates may commit to their branch but must not merge into the delegator branch.
7. **Compact before delegating.** When the conversation has significant context usage, run `/compact` before calling `delegate_task`. Delegated workers inherit the current conversation as their starting context — compacting first maximizes the useful context budget available to each worker. This is especially important for long sessions or when launching multiple delegates.
8. Use `model` / `--model <pattern>` and `effort` / `--effort none|low|medium|high|xhigh` to override the model and reasoning effort for a specific delegate when appropriate. These options apply only to the spawned delegate process.

## Suggested workflow
1. Read the user request and identify independent workstreams.
2. Keep one stream local if integration or coordination is still needed.
3. If the session has substantial context usage, compact first to give delegates maximum context budget.
4. Call `delegate_task` once per non-code/non-isolated worker-worthy stream, or `delegate_task_worktree` for isolated code changes.
5. Give each delegated prompt a crisp scope, such as one subsystem or one repo.
6. Use `delegate_status` and `delegate_result` to monitor and read completed delegate results.
7. If tmux is unavailable, continue locally and explain why delegation could not launch.

## Prompt shape for delegated workers
Each delegated task should include:
- the concrete objective
- the owned files or directories
- constraints and assumptions
- what to avoid stepping on
- the expected deliverable (code, plan, tests, notes)

## Command surface

The user-facing command family is `/delegate <subcommand>`:

- `/delegate [start] [--model pattern] [--effort none|low|medium|high|xhigh] <task>` — launch a non-worktree worker (start is implicit if omitted)
- `/delegate worktree [--model pattern] [--effort none|low|medium|high|xhigh] <task>` — launch an isolated code-change worker
- `/delegate status [worker]` — list workers or inspect one worker
- `/delegate result <name-or-id>` — read the structured result JSON from a worker
- `/delegate attach <name-or-id>` — switch to a live worker
- `/delegate open <name-or-id> [--model pattern] [--effort ...]` — attach if live, relaunch if dead
- `/delegate clean [--yes]` — clean safe dead workers/artifacts (preview without --yes; branches are preserved)
- `/delegate help [subcommand]` — show help

The LLM-facing tools are `delegate_task`, `delegate_task_worktree`, `delegate_status`, and `delegate_result`.

## Notes
- `pi-ez-delegate` forks the current conversation and launches a worker as a detached, headless tmux session.
- Worktree delegates create an isolated branch/worktree, should commit their changes, remove only the worktree if possible, and leave the branch for delegator review.
- Workers are tracked in a persistent registry for cross-session discovery, with structured result JSON files under pi agent state.
- Dead workers can be reopened from their saved session files.
- Do not suggest the old `/ezdg` command name; it has been removed.
- Use delegation for independence, not for tightly-coupled parallel edits.
- Context management is orthogonal to delegation. The extension does not enforce compaction — it is the model's responsibility to compact when appropriate before delegating. The skill guidance above covers when and why.
