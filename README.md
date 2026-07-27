# pi-ez-delegate

`pi-ez-delegate` is a shareable [pi](https://pi.dev) package for delegating work out of the **current pi session** into forked worker sessions.

The core flow is:

- keep working in the current pi session
- run `/delegate <task>` or let the agent call `delegate_task` / `delegate_task_worktree`
- fork the current conversation context into a worker session file
- use an isolated same-repo git worktree only when explicitly requested
- launch the worker as a detached, headless tmux session
- return a switch hint so you can jump to that worker later

## Status

Implemented:
- **Command:** `/delegate <subcommand> [options]`
- **Tools:** `delegate_task`, `delegate_task_worktree`, `delegate_status`, `delegate_result`
- **tmux adapter:** one detached headless session per worker
- **Session forking:** worker gets a forked session file with the current conversation branch
- **Same-repo worktrees:** explicit via `/delegate worktree` or `delegate_task_worktree`
- **Worker registry:** persistent per-repo registry for cross-session worker discovery
- **Worker lifecycle:** status, result, attach, open, and clean subcommands
- **Live/dead detection:** tmux target inspection for liveness checks
- **Safe cleanup:** conservative dead-worker cleanup with dry-run preview
- **Replay safety:** parentId chain preservation when forking sessions

Not implemented yet:
- `--pick-model` interactive selector
- zellij adapter
- completion signaling back from workers to parents

## Command

```text
/delegate <subcommand> [options]
```

### Subcommands

#### Start a worker (default)

```text
/delegate [start] [--name worker-name] [--cwd path] [--model pattern] [--effort none|low|medium|high|xhigh] <task>
```

The `start` keyword is optional — `/delegate <task>` works as an implicit start. Use `/delegate worktree <task>` for isolated code changes.

#### List workers

```text
/delegate status
```

Shows all workers for the current repo grouped by status: open, needs attention, safe to clean, stale.

#### Attach to a live worker

```text
/delegate attach <name-or-id>
```

Switches to the worker's tmux session when possible, or prints an attach command. Fails with a suggestion to use `open` if the worker is dead.

#### Open a worker

```text
/delegate open <name-or-id> [--model pattern] [--effort none|low|medium|high|xhigh]
```

If the worker is live, attaches to it. If dead, relaunches from its saved session file and worktree.

#### Read a worker result

```text
/delegate result <name-or-id>
```

Reads the structured JSON result written by a completed delegate. Results live under `~/.pi/agent/state/pi-ez-delegate/results/`.

#### Clean dead workers

```text
/delegate clean [--yes]
```

Without `--yes`, shows a preview of what would be cleaned. With `--yes`, deletes session files and removes leftover worktrees; branches are preserved for delegator review for workers that are safe to clean.

Workers with dirty worktrees, branches ahead of base, or in-progress rebases/merges are skipped with actionable recommendations.

#### Help

```text
/delegate help [subcommand]
```

### Examples

```text
/delegate investigate the GH Actions publish pipeline --model claude-opus-4-7 --effort high
/delegate worktree wire up castaway-web service auth middleware --model gpt-codex-5.5 --effort xhigh
/delegate --cwd ~/dev/infra bootstrap Argo CD and Tailscale access
/delegate status
/delegate open my-worker
/delegate attach my-worker
/delegate result my-worker
/delegate clean --yes
```

Defaults:
- workers run as detached headless tmux sessions
- `createWorktree = false` for normal delegation; use `/delegate worktree` / `delegate_task_worktree` for isolated code changes
- `cwd = current session cwd`
- `model = current pi default/model selection` unless overridden with `--model` for that delegate process only
- `effort = current/default effort` unless overridden with `--effort` for that delegate process only

## Tool

The extension also exposes an LLM-facing tool:

- `delegate_task` — non-worktree delegation
- `delegate_task_worktree` — isolated code-change delegation
- `delegate_status` — list/inspect delegates
- `delegate_result` — read a delegate result JSON

Use it for independent workstreams with clear ownership boundaries.

## tmux behavior

Delegates run as detached, headless tmux sessions. The parent pi session does not need to be inside tmux.

Each worker launch runs roughly:

```text
tmux new-session -d -s <worker-session> -c <cwd> <pi worker command>
```

Each launch returns:
- worker name
- worker session file path
- effective cwd
- worktree details when one was created
- tmux session name
- an attach hint such as `tmux attach-session -t <worker-session>`

There is intentionally no pane splitting, shared delegates window, origin pane tracking, or pane layout management. Liveness is just `tmux has-session -t <worker-session>`.

## Worker lifecycle

Workers are tracked in a persistent per-repo registry file at:

```text
~/.pi/agent/state/pi-ez-delegate/<repo-slug>-<hash>.json
```

Worker statuses:
- **Open** — tmux target still exists
- **Needs Attention** — dead, but has dirty/ahead/conflicted worktree
- **Safe to Clean** — dead, worktree clean or missing
- **Stale** — dead, no session file or workspace remains

## Worktree behavior

When using `/delegate worktree` or `delegate_task_worktree`, and the delegated cwd is inside the **same git repo** as the parent session, `pi-ez-delegate` creates a fresh worktree and branch before launch.

That keeps delegated workers from colliding in the same checkout.

Important nuance: today the delegated worker session is started with its session cwd rooted at the delegated worktree's effective cwd.

That means `pi-ez-delegate` currently chooses a **session-rooted worktree** model for delegated same-repo workers, rather than a pure "keep the original cwd and only route tools into the worktree" model.

Tradeoffs of the current behavior:

- the worker feels naturally rooted in the delegated files it is supposed to edit
- but cleanup can be more awkward if another integration assumes worktrees are only tool-routed
- long-lived workers rooted inside the worktree can make `git worktree remove` / branch cleanup feel surprising
- users may conflate the worker session cwd with ez-worktree's effective routed cwd contract

If the delegated cwd is in a different repo or not in git, worktree creation is skipped cleanly.

Normal `/delegate <task>` and `delegate_task` do not create worktrees by default. Worktree delegates should commit their changes, remove only their worktree, and leave the branch for the delegator to review/merge however they choose.

## Session behavior

The worker session is a **forked session file**, not a blank new run.

It inherits the current conversation branch, but intentionally drops non-context custom extension state so workers do not accidentally restore parent runtime state such as active `pi-ez-worktree` routing.

parentId chains are preserved across filtered entries so pi's session tree traversal remains valid in the forked session.

For extension authors composing on top of `pi-ez-delegate` or `pi-ez-worktree`:

- do not assume ez-worktree itself relocates pi's real session cwd
- be explicit about whether your worker model is **session-rooted in the worktree** or **session stays put and tools are routed into the worktree**
- document that choice for users, because the ergonomics and cleanup behavior differ

The worker session gets its own display name in the form:

```text
delegate:<worker-name>
```

## Configuration

Optional config file at `~/.pi/agent/pi-ez-delegate.json`:

```json
{
  "multiplexer": "tmux"
}
```

## Install

```bash
pi install git:github.com/bry-guy/pi-ez-delegate
```

Or try it without installing:

```bash
pi -e git:github.com/bry-guy/pi-ez-delegate
```

If pi is already running, install the package and then run `/reload` in that pi session.

## Local development

Syntax check:

```bash
mise run check
```

Unit tests:

```bash
mise run test
```

tmux smoke test:

```bash
mise run smoke
```

## Release process

This repository is set up for squash-merged PRs and automated semver bumps:

- GitHub Actions runs CI on pushes and pull requests.
- PR titles are checked for Conventional Commit style (`feat:`, `fix:`, `docs:`, etc.).
- `release-please` watches `main` and opens a release PR that updates `package.json` and `CHANGELOG.md`.
- Merge that release PR to create the next version tag and GitHub release.
