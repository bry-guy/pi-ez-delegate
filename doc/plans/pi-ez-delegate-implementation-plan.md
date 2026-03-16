# pi-ez-delegate implementation plan

Status: command/tool MVP implemented with tmux launch and same-repo worktree support.

Follow-up design work for worker lifecycle, cleanup, and layout now lives in `doc/plans/pi-ez-delegate-worker-lifecycle-and-layout-plan.md`.

## Goal

Build a pi package that lets the current pi session delegate work into forked worker sessions.

Primary UX:

```text
/ezdg <task>
```

Expected behavior:
1. fork the current conversation context
2. optionally create an isolated git worktree for the worker
3. launch a new worker in a pluggable multiplexer target
4. default to a new tmux split
5. allow alternate target modes like tmux window or tmux session
6. make the delegated worker easy to switch to later

The package should be structured like `pi-ez-worktree`:
- thin extension wrapper
- reusable core logic in `lib/`
- shareable pi package metadata
- release-please + CI scaffold
- companion skill that teaches the agent when delegation is appropriate

## Non-goals (v1)

- full multi-worker dashboard UI
- background worker orchestration without an external multiplexer/runtime
- automatic merge or cross-worker coordination logic
- arbitrary subagent trees
- zellij support in v1 (but the design must leave room for it)

## Core UX

### User-facing command

```text
/ezdg [--target pane|window|session] [--name worker-name] [--cwd path] [--no-worktree] <task>
```

Defaults:
- `target = pane`
- `createWorktree = true` when delegating inside the current repo
- `cwd = current session cwd`

Initial examples:

```text
/ezdg implement the GH Actions publish pipeline
/ezdg --target window wire up bot-to-web auth middleware
/ezdg --cwd ~/dev/infra bootstrap Argo CD and Tailscale access
```

### LLM-facing tool

`delegate_task`

This is required so the agent can delegate on its own instead of relying on the user to type `/ezdg` manually.

## Design principles

### 1. Multiplexer-agnostic core

Keep tmux-specific commands out of the main delegation flow.

Create a narrow adapter interface, for example:

```ts
interface MultiplexerAdapter {
  name: string;
  detect(ctx): Promise<boolean>;
  launch(request): Promise<LaunchResult>;
  formatAttachHint(result): string;
}
```

Implement first:
- `tmux`

Design next:
- `zellij`

The extension should route all multiplexer decisions through the adapter so adding zellij later is just a new adapter, not a rewrite.

### 2. Keep session logic separate from process logic

There are really three layers:

1. **pi session layer**
   - create forked session file
   - optionally seed a worker name / label
   - optionally set delegated task as the first new prompt

2. **repo/worktree layer**
   - decide whether this worker should get an isolated checkout
   - create/attach a worker worktree when appropriate

3. **runtime layer**
   - spawn the worker pi process in tmux/zellij
   - return target identifiers so the user can switch later

Do not blur these concerns together.

### 3. Follow `pi-ez-worktree` structure

Keep code organized so the extension file is mostly surface area and orchestration:

- `extensions/delegate.js`
  - registers `/ezdg`
  - registers `delegate_task`
  - renders user-visible results
- `lib/delegate.js`
  - core parsing / request normalization now
  - later: launch planning, state helpers, adapter selection
- `doc/plans/...`
  - executable plan / design notes
- `skills/delegate-work/SKILL.md`
  - policy layer for the LLM

## Recommended implementation phases

### Phase 0: scaffold

Done in this repository:
- package metadata
- README
- release flow scaffold
- extension stub
- skill stub
- implementation plan

### Phase 1: `/ezdg` command MVP (manual user flow)

Implement `/ezdg` as an interactive command first.

Target behavior:
1. wait until current agent is idle
2. capture current session file and current leaf
3. create a branched session file for the worker
4. derive worker cwd
5. if same repo and worktree enabled, create a worktree for the worker
6. pick an adapter (tmux only for v1)
7. launch `pi --session <forked-session> <task>` in the chosen target
8. emit a visible result back into the current session

Suggested result payload:
- worker name
- session file path
- cwd/worktree path
- multiplexer type
- pane/window/session identifier
- attach/switch hint

### Phase 2: `delegate_task` tool MVP

Expose the same behavior to the LLM.

Suggested tool parameters:
- `task: string`
- `target?: "pane" | "window" | "session"`
- `name?: string`
- `cwd?: string`
- `createWorktree?: boolean`

Tool guidelines should instruct the model to:
- delegate only independent workstreams
- default to `target: pane`
- prefer worktrees for same-repo coding tasks
- keep integration work local when contracts are still moving

### Phase 3: worker registry

Persist enough information to make delegated workers discoverable later.

Likely storage:
- append extension custom entries to the current session for launches
- optionally mirror a simple JSON registry file under the package state dir if cross-session lookup is needed

Registry record should contain:
- worker id
- worker name
- parent session file
- child session file
- cwd / worktree path
- adapter name
- target mode
- target id
- task summary
- launch timestamp

### Phase 4: attach/list helpers

After `/ezdg` exists, add:
- `/ezdg-list`
- `/ezdg-attach <name-or-id>`
- maybe `/ezdg-open`

These are not required for v1, but they make the feature feel complete.

## Session strategy

The delegated worker should be a **forked session**, not just a blank `pi` run with a copied prompt.

Desired properties:
- worker inherits relevant conversation context
- parent session keeps its own leaf and continues locally
- worker can later be resumed independently
- worker remains understandable in pi session selectors

Open question to resolve while implementing:
- whether to use the command-side `ctx.fork(...)` flow directly,
- or the lower-level session manager branch extraction APIs for more control over naming and launch timing.

Because the parent session must remain where it is, prefer the approach that creates a new session file without forcibly switching the current session away from the user's current view.

## Worktree strategy

For same-repo coding work, default to isolated worktrees.

Why:
- multiple delegated workers should not edit the same checkout
- worktree paths can encode worker names cleanly
- this mirrors the discipline already established in `pi-ez-worktree`

Implementation options:

### Option A: reuse `pi-ez-worktree` CLI helpers

Pros:
- less duplicated worktree logic
- consistent naming and merge-back strategy later

Cons:
- introduces package coupling
- may make `pi-ez-delegate` less self-contained

### Option B: vendor or reimplement the minimum worktree creation flow

Pros:
- self-contained package
- cleaner dependency story

Cons:
- more duplicated git worktree logic

Recommendation:
- start with a small internal worktree helper or a very thin dependency boundary
- avoid hard-wiring to tmux or to the full `pi-ez-worktree` extension runtime

## Multiplexer adapter plan

### tmux adapter (v1)

Required capabilities:
- detect whether current process is inside tmux
- launch a worker in:
  - detached split of current window
  - detached window
  - detached session
- return identifiers and human-friendly attach hints

Likely tmux commands:
- split: `tmux split-window -d ...`
- window: `tmux new-window -d ...`
- session: `tmux new-session -d ...`

The adapter should return structured results, not raw command strings.

Example result shape:

```ts
{
  adapter: "tmux",
  mode: "pane",
  targetId: "%17",
  attachHint: "tmux select-pane -t %17",
}
```

### zellij adapter (future)

Keep the interface small enough that zellij only needs to implement launch + hint formatting.

Do not let tmux assumptions leak into core naming, registry, or worker launch planning.

## Worker naming

Support both explicit and derived names.

Priority:
1. `--name` from the user
2. `name` from tool params
3. generated slug from task text

The name should be used consistently for:
- worktree branch/path naming
- session display name when useful
- tmux target naming when supported
- registry lookup

## Suggested command/tool behavior on the example workset

Given a workset like:
- deploy manifests
- GitHub Actions pipeline
- web deploy contract
- bot Postgres state backend
- infra bootstrap in another repo

A skill-guided agent should be able to:
- keep integration work local
- delegate independent app streams
- delegate cross-repo infra work with explicit `cwd`
- avoid delegating tasks that still depend on unsettled interfaces

That means the package should make multiple sequential calls to `delegate_task` cheap and consistent.

## Open questions

1. **How should child worker sessions be named?**
   - session display name only?
   - first prompt text only?
   - both?

2. **How should delegated workers signal completion back?**
   - out of scope for v1, but leave room for it

3. **Should `/ezdg` fail outside tmux in v1?**
   - likely yes, with a clear message, until another adapter exists

4. **Should worktree creation be automatic for non-git cwd?**
   - no; just skip it cleanly

5. **Should cross-repo delegation fork from the current session or start a fresh child session with summarized context?**
   - likely fork current session, but the prompt must explicitly tell the worker it is now operating in another repo

## Concrete implementation checklist

### Package scaffold
- [x] package metadata
- [x] release-please files
- [x] CI workflow
- [x] extension stub
- [x] skill stub
- [x] implementation plan

### Extension MVP
- [x] implement robust `/ezdg` arg parsing and validation
- [x] wait for idle before mutating session / launching worker
- [x] create a forked worker session file without hijacking the current session
- [x] set a sensible worker session name
- [x] build delegated task prompt from user input
- [x] select adapter (tmux only initially)
- [x] launch worker process
- [x] emit structured result back into the parent session

### Worktree MVP
- [x] detect when current cwd is inside a git repo
- [x] create a worker worktree by default for same-repo delegation
- [x] allow `--no-worktree`
- [x] plumb worker cwd into the launched pi process

### Tool MVP
- [x] implement `delegate_task`
- [x] add good prompt guidelines for model usage
- [x] ensure tool result stores launch details for later reconstruction

### Registry / attach follow-up
- [x] persist worker launch records
- [ ] list known workers
- [ ] attach or switch to existing worker targets
- [ ] document the reattach flow

## First recommended slice

Implement this first and stop:

1. `/ezdg <task>`
2. tmux pane mode only
3. same-repo worktree creation by default
4. visible result message with session path + tmux target

That gets the core UX working without prematurely designing a full worker manager.

## Notes for later follow-through

- Keep the extension thin and test core logic in `lib/`.
- Prefer structured results over freeform strings so later UI and registry work can reuse them.
- If needed, add tiny helper CLIs later, but do not assume they are required for the first slice.
- The skill should remain policy-only; the extension should own mechanics.
