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

Implemented today:
- **Command:** `/ezdg ...`
- **Tool:** `delegate_task`
- **tmux adapter:** pane, window, and session launch targets
- **Session forking:** worker gets a forked session file with the current conversation branch
- **Same-repo worktrees:** enabled by default unless `--no-worktree` is used
- **Launch records:** persisted as custom session entries for later follow-up features

Not implemented yet:
- worker list / reattach slash commands
- zellij adapter
- completion signaling back from workers to parents

## Command

```text
/ezdg [--target pane|window|session] [--name worker-name] [--cwd path] [--no-worktree] <task>
```

Examples:

```text
/ezdg implement the GH Actions publish pipeline
/ezdg --target window wire up castaway-web service auth middleware
/ezdg --cwd ~/dev/infra bootstrap Argo CD and Tailscale access
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

## Worktree behavior

When the delegated cwd is inside the **same git repo** as the parent session, `pi-ez-delegate` creates a fresh worktree by default.

That keeps delegated workers from colliding in the same checkout.

If the delegated cwd is in a different repo or not in git, worktree creation is skipped cleanly.

## Session behavior

The worker session is a **forked session file**, not a blank new run.

It inherits the current conversation branch, but intentionally drops non-context custom extension state so workers do not accidentally restore parent runtime state such as active `pi-ez-worktree` routing.

The worker session gets its own display name in the form:

```text
ezdg:<worker-name>
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
