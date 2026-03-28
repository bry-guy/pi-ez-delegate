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
- tmux is unavailable for the current pi session
- You are already a delegated worker; delegated workers must not launch more delegates

## Rules
1. Delegate only self-contained work with clear ownership boundaries.
2. Prefer a small number of meaningful delegated workers over many tiny workers.
3. Default to `target: "pane"` unless the user explicitly asks for the shared delegates window behavior (`target: "window"`).
4. Prefer `createWorktree: true` for same-repo coding work.
5. Include the concrete goal, relevant files, constraints, and expected output in the delegated task prompt.
6. Keep integration work local until delegated contracts are stable.
7. **Compact before delegating.** When the conversation has significant context usage, run `/compact` before calling `delegate_task`. Delegated workers inherit the current conversation as their starting context — compacting first maximizes the useful context budget available to each worker. This is especially important for long sessions or when launching multiple delegates.
8. Use `--model <pattern>` to override the model for a specific delegate when appropriate (e.g. using a cheaper model for simple tasks, or a stronger model for complex ones).

## Suggested workflow
1. Read the user request and identify independent workstreams.
2. Keep one stream local if integration or coordination is still needed.
3. If the session has substantial context usage, compact first to give delegates maximum context budget.
4. Call `delegate_task` once per worker-worthy stream.
5. Give each delegated prompt a crisp scope, such as one subsystem or one repo.
6. If tmux is unavailable, continue locally and explain why delegation could not launch.

## Prompt shape for delegated workers
Each delegated task should include:
- the concrete objective
- the owned files or directories
- constraints and assumptions
- what to avoid stepping on
- the expected deliverable (code, plan, tests, notes)

## Command surface

The user-facing command family is `/ezdg <subcommand>`:

- `/ezdg [start] [--model pattern] [--target pane|window] <task>` — launch a new worker (start is implicit if omitted)
- `/ezdg list` — list workers for the current repo
- `/ezdg attach <name-or-id>` — switch to a live worker
- `/ezdg open <name-or-id> [--model pattern]` — attach if live, relaunch if dead
- `/ezdg clean [--yes]` — clean safe dead workers (preview without --yes)
- `/ezdg help [subcommand]` — show help

The LLM-facing tool is `delegate_task`.

## Notes
- `pi-ez-delegate` forks the current conversation, can create a same-repo worktree, and launches a worker in tmux.
- Workers are tracked in a persistent per-repo registry for cross-session discovery.
- Dead workers can be reopened from their saved session files.
- Do not suggest the old `/delegate` name.
- Use delegation for independence, not for tightly-coupled parallel edits.
- Context management is orthogonal to delegation. The extension does not enforce compaction — it is the model's responsibility to compact when appropriate before delegating. The skill guidance above covers when and why.
