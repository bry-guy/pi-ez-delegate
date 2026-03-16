---
name: delegate-work
description: Use when a user request contains independent workstreams that should be delegated into forked pi worker sessions instead of handled serially in the current session.
---

# Delegate Work

Use the `delegate_task` tool from `pi-ez-delegate` when the user asks for parallelizable implementation work and the work can be cleanly split.

## When to use this
- The user gives multiple independent workstreams
- A task can be partitioned by subsystem, repository, or file ownership
- The user explicitly asks to fan work out into delegated workers
- The current session should remain focused on integration, coordination, or higher-level decision making

## When **not** to use this
- Multiple tasks need to edit the same files immediately
- Workstreams are highly sequential and depend on unsettled interfaces
- The user wants all work to stay inside the current session
- The tool reports that delegation is not implemented yet

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
5. If delegation is unavailable or reports scaffold-only status, continue locally and tell the user the delegation package still needs implementation.

## Prompt shape for delegated workers
Each delegated task should include:
- the concrete objective
- the owned files or directories
- constraints and assumptions
- what to avoid stepping on
- the expected deliverable (code, plan, tests, notes)

## Notes
- The user-facing command is `/delegate ...`.
- The LLM-facing tool is `delegate_task`.
- `pi-ez-delegate` is intended to fork the current conversation, optionally create a worktree, and launch a new worker in a multiplexer target.
- In the current scaffold stage, the tool may only return placeholder output.
