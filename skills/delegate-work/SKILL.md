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

## Rules
1. Delegate only self-contained work with clear ownership boundaries.
2. Prefer a small number of meaningful delegated workers over many tiny workers.
3. Default to `target: "pane"` unless the user explicitly asks for window or session behavior.
4. Prefer `createWorktree: true` for same-repo coding work.
5. Include the concrete goal, relevant files, constraints, and expected output in the delegated task prompt.
6. Keep integration work local until delegated contracts are stable.

## Suggested workflow
1. Read the user request and identify independent workstreams.
2. Keep one stream local if integration or coordination is still needed.
3. Call `delegate_task` once per worker-worthy stream.
4. Give each delegated prompt a crisp scope, such as one subsystem or one repo.
5. If tmux is unavailable, continue locally and explain why delegation could not launch.

## Prompt shape for delegated workers
Each delegated task should include:
- the concrete objective
- the owned files or directories
- constraints and assumptions
- what to avoid stepping on
- the expected deliverable (code, plan, tests, notes)

## Notes
- The user-facing command family is `/ezdg ...`.
- The current launch form is `/ezdg <task>`.
- Future management commands should stay under the same `/ezdg ...` namespace.
- The LLM-facing tool is `delegate_task`.
- `pi-ez-delegate` forks the current conversation, can create a same-repo worktree, and launches a worker in tmux.
- Do not suggest the old `/delegate` name.
- Use delegation for independence, not for tightly-coupled parallel edits.
