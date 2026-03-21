# pi-ez-delegate

`pi-ez-delegate` is a shareable [pi](https://pi.dev) package for delegating work out of the **current pi session** into forked worker sessions.

The core flow is:

- keep working in the current pi session
- run `/ezdg <task>` or let the agent call `delegate_task`
- fork the current conversation context into a worker session file
- default to an isolated same-repo git worktree when appropriate
- launch the worker in tmux
  - default: detached pane split
  - optional: detached window or detached session
- return a switch hint so you can jump to that worker later

## Status

Implemented:
- **Command:** `/ezdg <subcommand> [options]`
- **Tool:** `delegate_task`
- **tmux adapter:** pane, window, and session launch targets
- **Session forking:** worker gets a forked session file with the current conversation branch
- **Same-repo worktrees:** enabled by default unless `--no-worktree` is used
- **Worker registry:** persistent per-repo registry for cross-session worker discovery
- **Worker lifecycle:** list, attach, open, finish, and clean subcommands
- **Live/dead detection:** tmux target inspection for liveness checks
- **Safe cleanup:** conservative dead-worker cleanup with dry-run preview
- **Safe finish:** guarded merge-back, worktree removal, branch deletion, and session cleanup for completed workers
- **Replay safety:** parentId chain preservation when forking sessions
- **Single-rail pane layout:** configurable min columns/rows for auto layout decisions

Not implemented yet:
- `--model` / `--pick-model` flags
- zellij adapter
- completion signaling back from workers to parents

## Command

```text
/ezdg <subcommand> [options]
```

### Subcommands

#### Start a worker (default)

```text
/ezdg [start] [--target pane|window|session] [--name worker-name] [--cwd path] [--no-worktree] <task>
```

The `start` keyword is optional — `/ezdg <task>` works as an implicit start.

#### List workers

```text
/ezdg list
```

Shows all workers for the current repo grouped by status: live, needs attention, safe to clean, stale.

#### Attach to a live worker

```text
/ezdg attach <name-or-id>
```

Switches tmux focus to the worker's pane/window/session. Fails with a suggestion to use `open` if the worker is dead.

#### Open a worker

```text
/ezdg open <name-or-id> [--target pane|window|session]
```

If the worker is live, attaches to it. If dead, relaunches from its saved session file and worktree.

#### Finish a completed worker

```text
/ezdg finish <name-or-id>
```

For a completed dead worker, merges its delegated branch back into the delegator branch, removes the worker worktree, deletes the worker branch, deletes the saved worker session file, and marks the registry record cleaned.

Finish refuses to run while the worker is still live, or when the delegator branch is dirty or in the middle of a merge/rebase.

#### Clean dead workers

```text
/ezdg clean [--yes]
```

Without `--yes`, shows a preview of what would be cleaned. With `--yes`, deletes session files, removes worktrees, and deletes branches for workers that are safe to clean.

Workers with dirty worktrees, branches ahead of base, or in-progress rebases/merges are skipped with actionable recommendations.

#### Help

```text
/ezdg help [subcommand]
```

### Examples

```text
/ezdg implement the GH Actions publish pipeline
/ezdg start --target window wire up castaway-web service auth middleware
/ezdg --cwd ~/dev/infra bootstrap Argo CD and Tailscale access
/ezdg list
/ezdg open my-worker
/ezdg attach my-worker
/ezdg finish my-worker
/ezdg clean --yes
```

Defaults:
- `target = pane`
- `createWorktree = true` for same-repo delegation
- `cwd = current session cwd`

## Tool

The extension also exposes an LLM-facing tool:

- `delegate_task`

Use it for independent workstreams with clear ownership boundaries.

## tmux behavior

v1 requires running pi **inside tmux**.

Launch modes:
- `pane` → `tmux split-window -d ...`
- `window` → `tmux new-window -d ...`
- `session` → `tmux new-session -d ...`

Each launch returns:
- worker name
- worker session file path
- effective cwd
- worktree details when one was created
- tmux target identifier
- a switch hint such as `tmux select-pane -t %17`

## Worker lifecycle

Workers are tracked in a persistent per-repo registry file at:

```text
~/.pi/agent/state/pi-ez-delegate/<repo-slug>-<hash>.json
```

Worker statuses:
- **Live** — tmux target still exists
- **Needs Attention** — dead, but has dirty/ahead/conflicted worktree
- **Safe to Clean** — dead, worktree clean or missing
- **Stale** — dead, no session file or workspace remains

## Worktree behavior

When the delegated cwd is inside the **same git repo** as the parent session, `pi-ez-delegate` creates a fresh worktree by default.

That keeps delegated workers from colliding in the same checkout.

Important nuance: today the delegated worker session is started with its session cwd rooted at the delegated worktree's effective cwd.

That means `pi-ez-delegate` currently chooses a **session-rooted worktree** model for delegated same-repo workers, rather than a pure "keep the original cwd and only route tools into the worktree" model.

Tradeoffs of the current behavior:

- the worker feels naturally rooted in the delegated files it is supposed to edit
- but cleanup can be more awkward if another integration assumes worktrees are only tool-routed
- long-lived workers rooted inside the worktree can make `git worktree remove` / branch cleanup feel surprising
- users may conflate the worker session cwd with ez-worktree's effective routed cwd contract

If the delegated cwd is in a different repo or not in git, worktree creation is skipped cleanly.

If you want to avoid same-repo worktree rooting entirely for a worker, use `--no-worktree`.

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
ezdg:<worker-name>
```

## Configuration

Optional config file at `~/.pi/agent/pi-ez-delegate.json`:

```json
{
  "multiplexer": "tmux",
  "defaultTarget": "pane",
  "defaultPaneSplit": "auto",
  "minPaneColumns": 180,
  "minPaneRows": 28
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
