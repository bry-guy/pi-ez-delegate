# pi-ez-delegate

`pi-ez-delegate` is a shareable [pi](https://pi.dev) package for delegating work out of the **current pi session** into forked worker sessions.

The intended flow is:

- keep working in the current pi session
- run `/delegate <task>` or let the agent call `delegate_task`
- fork the current conversation context
- optionally create an isolated git worktree for the worker
- launch a new worker in a pluggable multiplexer target
  - default: tmux split
  - optional later: tmux window / tmux session / zellij adapters

## Status

This repository is currently a scaffold plus implementation plan.

Included today:
- **Extension stub:** registers `/delegate` and `delegate_task`
- **Skill stub:** teaches the agent when delegation is appropriate
- **Plan:** `doc/plans/pi-ez-delegate-implementation-plan.md`

Not implemented yet:
- actual session forking
- worktree creation/attachment
- tmux spawning
- worker registry / attach helpers
- zellij adapter

## Design goals

- Keep the extension as multiplexer-agnostic as possible
- Follow the same project structure and release flow as `pi-ez-worktree`
- Start with a single core UX:
  - `/delegate <task>`
- Default to a new tmux split, but allow window/session modes later
- Prefer isolated worktrees when delegating inside the same git repo
- Make it possible for an agent to delegate independent workstreams automatically

## Intended UX

```text
/delegate implement the GH Actions publish pipeline
/delegate --target window wire up castaway-web service auth middleware
```

And for agent use via tool:

- `delegate_task`

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

This repo includes a tiny `mise.toml` for a smoke check:

```bash
mise run check
```

## Release process

This repository is set up for squash-merged PRs and automated semver bumps:

- GitHub Actions runs CI on pushes and pull requests.
- PR titles are checked for Conventional Commit style (`feat:`, `fix:`, `docs:`, etc.).
- `release-please` watches `main` and opens a release PR that updates `package.json` and `CHANGELOG.md`.
- Merge that release PR to create the next version tag and GitHub release.
