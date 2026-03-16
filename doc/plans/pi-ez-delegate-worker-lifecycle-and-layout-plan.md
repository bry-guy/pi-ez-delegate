# pi-ez-delegate worker lifecycle and layout plan

Status: follow-up design plan, not implemented yet.

This is a **second plan** that builds on `doc/plans/pi-ez-delegate-implementation-plan.md`.

The first plan delivered the MVP:
- `/ezdg <task>`
- `delegate_task`
- tmux launch targets
- same-repo worktree creation by default
- forked worker sessions

This follow-up plan covers what comes next:
- worker lifecycle management
- dead/live detection
- safe cleanup of dangling sessions/worktrees
- `/ezdg` subcommands
- configurable pane layout behavior
- multiplexer abstraction for future zellij support

## Goal

Evolve `pi-ez-delegate` from a launch-only MVP into a manageable worker system that can:

1. launch workers predictably
2. discover workers later
3. reopen dead workers safely
4. attach to live workers quickly
5. clean up dead workers when it is safe
6. avoid creating unusable tmux pane layouts

## Important framing

Keep these concepts separate:

- **delegation** = the workflow concept
- **worker** = the session/process/worktree created by delegation
- **model override** = an optional launch parameter

Do **not** introduce:
- subagents
- profiles
- worker queues
- batch orchestration

Those are complexity cliffs and should stay out of scope for this phase.

## Non-goals

Not part of this plan:
- automatic merging or finishing delegated worktrees
- arbitrary worker trees or background orchestration
- profile systems that are effectively subagents under another name
- delegate queues
- multiple workers launched in one command
- full multi-column delegate rail logic in tmux
- zellij implementation in this phase

## Command surface redesign

Move from the MVP command shape:

```text
/ezdg <task>
```

to a single command family:

```text
/ezdg <subcommand> [...args]
```

### Planned subcommands

#### Start a worker

```text
/ezdg start [--target pane|window|session] [--split auto|horizontal|vertical] [--name worker-name] [--cwd path] [--no-worktree] [--model pattern] [--pick-model] <task>
```

#### List workers

```text
/ezdg list
```

#### Attach to a live worker

```text
/ezdg attach <name-or-id>
```

#### Open a worker

```text
/ezdg open <name-or-id> [--target pane|window|session] [--split auto|horizontal|vertical] [--model pattern] [--pick-model]
```

Behavior:
- if the worker is live, attach to it
- if the worker is dead, relaunch it from its saved session/worktree

#### Clean safe dead workers

```text
/ezdg clean [--yes]
```

#### Help

```text
/ezdg help [subcommand]
```

## Why there is no detach

Unlike `pi-ez-worktree`, `pi-ez-delegate` does not maintain a session-level routing state that needs detaching.

- the origin session is not “attached” to a worker in a persistent runtime sense
- `attach` just switches focus to a live worker
- `open` makes a dead worker usable again

So `detach` is unnecessary in this design.

## Worker lifecycle model

A worker has three distinct assets:

1. **process**
   - the live `pi` process in tmux
2. **session**
   - the forked session file on disk
3. **workspace**
   - the delegated cwd, often a git worktree

Closing a pane/window/session kills the **process**, but usually leaves the **session file** and **worktree** behind.

That means a worker can be:

- **live**
  - its tmux target still exists
- **dead but resumable**
  - tmux target is gone, but session/worktree still exist
- **dead and safe to clean**
  - target is gone and the worktree has no meaningful remaining state
- **dead and needs attention**
  - target is gone but the worktree is dirty, ahead, conflicted, or otherwise unsafe to delete
- **stale**
  - the registry record exists but the target, session, and worktree are all gone or partially missing

## Registry design

The current MVP stores launch records only as custom session entries.

That is useful for history, but not enough for:
- cross-session discovery
- cleanup
- reopening workers later
- inspecting liveness after the parent session is gone

### Plan

Keep both:

1. **session custom entries**
   - for conversation-local history
   - for lightweight active delegate state that can be inherited by nested workers
2. **persistent registry file**
   - for durable worker management

### Delegate session state

Add a small active delegate state entry, for example `pi-ez-delegate-state`, that carries the pane/window anchor information needed by child sessions.

At minimum it should include:
- worker id
- target mode
- origin pane id for pane launches
- origin window id for pane launches
- current live target id when relevant

Why this matters:
- registry data is durable, but it is not automatically inherited by a forked child session
- nested delegation should remember which pane initiated the current worker
- pane relaunch/open behavior should not depend on whatever pane happens to be focused later

### Suggested storage

```text
~/.pi/agent/state/pi-ez-delegate/<repo-id>.json
```

A record should include:
- worker id
- worker name
- task summary
- parent session file
- child session file
- requested cwd
- effective cwd
- worktree path
- task branch
- base branch
- launch timestamp
- multiplexer
- target mode
- target id
- pane/window/session ids as applicable
- window id for pane launches
- origin pane id for pane launches
- origin window id for pane launches
- layout metadata
- model override, if any

Important:
- **live/dead must be computed from the multiplexer**, not blindly trusted from stored state

## Multiplexer abstraction

The extension should now formalize a narrow adapter boundary.

Example shape:

```ts
interface MultiplexerAdapter {
  name: string;
  detect(ctx): Promise<boolean>;
  launch(request): Promise<LaunchResult>;
  attach(record): Promise<AttachResult>;
  isLive(record): Promise<boolean>;
  inspectWindow(record): Promise<WindowLayout | undefined>;
}
```

### Config

Use a package config file with at least:

```json
{
  "multiplexer": "tmux",
  "defaultTarget": "pane",
  "defaultPaneSplit": "auto",
  "minPaneColumns": 180,
  "minPaneRows": 28
}
```

Defaults:
- `multiplexer = "tmux"`
- `defaultTarget = "pane"`
- `defaultPaneSplit = "auto"`
- `minPaneColumns = 180`
- `minPaneRows = 28`

### v1 adapter behavior

- only `tmux` is implemented
- if config requests `zellij`, fail clearly
- keep all layout heuristics behind the tmux adapter

## Live/dead detection

For tmux, a worker is **live** if its recorded target still exists:
- pane target exists
- or window target exists
- or session target exists

If the target no longer exists, the worker is **dead**, but it may still be resumable.

## `/ezdg list`

`/ezdg list` should group workers into:
- live
- dead but resumable
- dead and safe to clean
- dead and needs attention
- stale

Each row should show:
- worker name or id
- status
- task summary
- session path
- worktree path
- git summary
- target info

### Git summary examples

- clean
- dirty
- ahead of base by N
- rebase in progress
- merge in progress
- worktree missing
- session missing

## `/ezdg attach`

`/ezdg attach <name-or-id>` should:
- switch to the live tmux target if the worker is live
- otherwise fail with a clear message and suggest `/ezdg open <name-or-id>`

It should not relaunch a dead worker.

## `/ezdg open`

`/ezdg open <name-or-id>` should:
- attach if the worker is already live
- relaunch if the worker is dead
- reuse the stored session file
- reuse the stored worktree/cwd if still present
- reuse the stored origin pane id for pane relaunches
- if the stored origin pane no longer exists and the requested target is `pane`, fail clearly and recommend `--target window` or `--target session`
- update the registry with the new target info

This makes `open` the idempotent “make this worker usable” command.

## `/ezdg clean`

`/ezdg clean` should only operate on **dead** workers.

Split results into two buckets.

### A. Safe to clean

Safe means all of the following are true:
- target is dead
- worktree is missing or clean
- no rebase in progress
- no merge in progress
- branch is not ahead of base
- no uncommitted changes

For safe workers:
- delete session file if it exists
- remove worktree if it exists
- delete branch if safe
- archive or mark the registry record as cleaned

### B. Needs attention

Examples:
- dirty worktree
- branch ahead of base
- merge/rebase in progress
- partially missing state that might hide useful work

For these workers:
- do **not** delete automatically
- describe the state clearly
- recommend a course of action

### Recommended user actions

If dirty or conflicted:
- recommend `/ezdg open <name-or-id>` to resume it
- optionally suggest using `pi-ez-worktree` directly if the user wants to work from that checkout/branch

If clean but ahead of base:
- recommend reopening and intentionally finishing or merging the work
- do not auto-delete, because there is committed unmerged work

## Critical critique of the original auto layout idea

The original auto algorithm idea was the most likely place for subtle bugs.

### Problem 1: it treated tmux columns as easier to manage than they are

The idea of:
- one origin column
- then one or more delegate columns
- with each delegate column containing horizontal stacks

sounds clean conceptually, but tmux does **not** make “split the whole right column into another equal right column” a simple primitive.

Splitting a pane splits **that pane**, not an abstract column group.

That means true multi-column delegate layouts quickly become a layout-manipulation problem, not just a launch problem.

### Problem 2: width math based only on window width is too naive

Rules like:

```text
windowWidth >= (delegateColumnCount + 2) * minPaneColumns
```

are a useful intuition, but not a reliable implementation rule.

They ignore:
- manual pane resizing
- uneven column widths
- status/border overhead
- the fact that future splits operate on a pane subtree, not on the full window

### Problem 3: “workers per column” is not a robust capacity metric

Counting workers and estimating capacity from:

```text
columnHeight >= (count + 1) * minPaneRows
```

assumes the column is evenly divided.

In tmux, it often will not be.

A more reliable metric is to inspect the **actual tallest pane** available for splitting.

### Problem 4: ambiguous fallback-to-horizontal can violate the row constraint

A blanket rule of “if ambiguous, do a horizontal split” can create unusably tiny panes.

Ambiguity fallback is fine, but it still has to respect `minPaneRows`.

### Problem 5: launching from a delegate pane changes the geometry assumptions

If a user is currently focused in a delegate pane instead of the origin pane, “current pane width” is the wrong basis for deciding whether to create a new right-side rail.

Layout decisions need to be made at the **window** level, not just from the currently focused pane.

## Revised auto layout plan

Keep this intentionally simpler.

### Core simplification

In this phase, support **at most one delegate rail per tmux window**.

That rail is:
- a right-side pane created by a vertical split when the window is wide enough
- then a horizontal stack of delegates inside that rail

Do **not** attempt multiple right-side delegate columns in this phase.

Reason:
- it crosses the line from launch heuristics into full tmux layout orchestration
- it is the highest-risk source of layout bugs
- it can be added later once the single-rail model is proven

### Settings

For pane launches:
- `split = auto|horizontal|vertical`
- `minPaneColumns = 180`
- `minPaneRows = 28`

### Explicit splits

- `horizontal` = top/bottom split
- `vertical` = left/right split
- `auto` = use the algorithm below

If target is `window` or `session`, reject `--split` clearly.

## Revised auto algorithm

### Step 1: identify the remembered origin pane and its window

All pane auto-layout decisions are scoped to the **window that contains the remembered origin pane for this delegation**, not whichever pane happens to be focused when the command runs.

Rules:
- if the current session already has active delegate state with an `originPaneId`, use that pane as the anchor
- otherwise use the current `TMUX_PANE` as the origin pane and persist it into the worker/session metadata
- if the origin pane no longer exists, refuse pane launch and recommend `--target window` or `--target session`

### Step 2: look for a live delegate rail in the origin window

Use registry data plus tmux inspection to determine whether the **origin window** already has a delegate rail created by `pi-ez-delegate`.

Do not infer rail state from the currently focused pane.

If the state is ambiguous:
- fall back to horizontal behavior **only if** it still satisfies `minPaneRows`
- otherwise refuse the pane launch and recommend `--target window` or cleaning existing delegates

### Step 3: if no delegate rail exists

If:

```text
windowWidth >= 2 * minPaneColumns
```

then:
- create the first delegate rail with a **vertical split**
- target the remembered `originPaneId` for that split

Else:
- if the origin pane height is at least `2 * minPaneRows`, use a **horizontal split**
- target the remembered `originPaneId` for that split
- otherwise refuse the pane launch and recommend `--target window` or `--target session`

### Step 4: if a delegate rail already exists

Pick the **tallest live pane inside that rail**.

If its height is at least:

```text
2 * minPaneRows
```

then:
- split that pane **horizontally**

This keeps the delegate rail stacked and tends to preserve the largest usable panes over time.

Important:
- explicit pane splits should always use an explicit tmux target derived from stored metadata, never the implicit currently focused pane
- for the first split, that target is the remembered `originPaneId`
- for later rail growth, that target is the chosen live pane inside the rail that belongs to the same origin window/worker layout

### Step 5: if the rail is full

If no live pane in the delegate rail has enough height for another horizontal split:
- do **not** try to create a second delegate rail in this phase
- refuse the auto pane launch with a clear message
- recommend:
  - `--target window`
  - `--target session`
  - or cleaning/closing old delegates

### Why this is better

This version is less ambitious but much safer because it relies on real tmux primitives that map cleanly to the desired layout.

It also avoids hidden layout mutations that would be hard to reason about or recover from.

## Model selection

Allow only lightweight model override behavior.

Planned options:
- `--model <pattern>`
- `--pick-model`

Do **not** add profiles.

Default behavior remains:
- inherit the current session/model behavior unless explicitly overridden

## Configuration

A small config file is enough for this phase.

Suggested keys:

```json
{
  "multiplexer": "tmux",
  "defaultTarget": "pane",
  "defaultPaneSplit": "auto",
  "minPaneColumns": 180,
  "minPaneRows": 28
}
```

Do not add queue settings or batch-worker limits yet.

Those are premature because this phase still launches one worker at a time.

## Recommended implementation phases

### Phase 1: subcommand refactor + registry
- [ ] refactor `/ezdg` into subcommands
- [ ] add persistent worker registry file
- [ ] keep session custom entries for launch history
- [ ] migrate current launch flow into `/ezdg start`

### Phase 2: worker management
- [ ] implement `/ezdg list`
- [ ] implement `/ezdg attach`
- [ ] implement `/ezdg open`
- [ ] add tmux live/dead detection

### Phase 3: safe cleanup
- [ ] implement `/ezdg clean`
- [ ] classify safe-to-clean vs needs-attention workers
- [ ] delete only safe dead workers
- [ ] print actionable recommendations for unsafe ones

### Phase 4: layout + config
- [ ] add package config loading
- [ ] add `multiplexer` setting
- [ ] add `defaultPaneSplit`, `minPaneColumns`, `minPaneRows`
- [ ] add `--split auto|horizontal|vertical`
- [ ] implement single-rail auto layout heuristic

### Phase 5: model override
- [ ] add `--model <pattern>`
- [ ] add `--pick-model`
- [ ] persist model override in worker records

### Phase 6: future multiplexer work
- [ ] keep tmux logic behind an adapter boundary
- [ ] design zellij support against the same worker registry model

## Delegate execution sequencing

Because the current implementation still concentrates core behavior in `extensions/delegate.js` and `lib/delegate.js`, parallel workers must be split by **file ownership**, not just by feature area.

### Safe first wave

Before launching this wave:
- commit the latest plan and skill updates to `HEAD` so delegated worktrees inherit them
- keep the current coordinator session on the main checkout

Launch only workers that can stay mostly in new files:

1. **registry-and-config foundation worker**
   - owns new files such as:
     - `lib/registry.js`
     - `lib/config.js`
     - `test/registry.test.js`
     - `test/config.test.js`
   - should avoid editing `extensions/delegate.js`
   - should avoid large edits to `lib/delegate.js` except for tiny export glue if absolutely required

2. **tmux-adapter-and-layout foundation worker**
   - owns new files such as:
     - `lib/tmux.js`
     - `lib/layout.js`
     - `test/tmux-layout.test.js`
   - should avoid editing `extensions/delegate.js`
   - should avoid editing registry/config files owned by the first worker

These two workers can run in parallel.

Suggested prompts:

**registry-and-config foundation worker**
```text
Implement the registry/config foundation from doc/plans/pi-ez-delegate-worker-lifecycle-and-layout-plan.md.

Own these files:
- lib/registry.js
- lib/config.js
- test/registry.test.js
- test/config.test.js

Constraints:
- do not edit extensions/delegate.js
- avoid large edits to lib/delegate.js
- do not implement the full /ezdg subcommand surface yet
- keep the code testable and integration-ready

Deliverable:
- implementation + tests + integration notes in your worker session
```

**tmux-adapter-and-layout foundation worker**
```text
Implement the tmux/layout foundation from doc/plans/pi-ez-delegate-worker-lifecycle-and-layout-plan.md.

Own these files:
- lib/tmux.js and/or lib/layout.js
- test/tmux-layout.test.js

Constraints:
- do not edit extensions/delegate.js
- avoid large edits to lib/delegate.js
- implement the conservative single-rail layout approach only
- remember the tmux origin pane for pane launches and use explicit split targets instead of relying on the currently focused pane
- respect minPaneColumns=180 and minPaneRows semantics from the plan

Deliverable:
- implementation + tests + integration notes in your worker session
```

### Gate before the next wave

Do **not** launch the integration worker until the first-wave workers have either:
- finished and committed their isolated modules, or
- produced clear notes on the APIs they created

Reason:
- the integration worker will need to touch shared files and would otherwise create avoidable merge conflicts

### Second wave

3. **command-and-integration worker**
   - owns shared integration files:
     - `extensions/delegate.js`
     - `lib/delegate.js`
   - wires in:
     - `/ezdg start`
     - `/ezdg list`
     - `/ezdg open`
     - `/ezdg attach`
     - `/ezdg clean`
   - integrates the registry/config/tmux/layout modules created in wave one
   - updates command help, completions, and rendering

This worker should run **after** the first-wave workers, not concurrently with them.

Suggested prompt:

```text
Integrate the completed worker lifecycle foundations into the /ezdg command surface.

Primary files:
- extensions/delegate.js
- lib/delegate.js

Read and follow:
- doc/plans/pi-ez-delegate-worker-lifecycle-and-layout-plan.md
- doc/plans/pi-ez-delegate-implementation-plan.md

Goals:
- move to /ezdg <subcommand>
- keep delegate_task working
- add start, list, open, attach, clean, and help
- integrate registry/config/tmux/layout modules from wave one
- preserve and use stored originPaneId/originWindowId for pane relaunch and layout decisions

Constraints:
- do not redesign the plan
- do not add profiles, queues, or batch delegation
- keep cleanup conservative and safe

Deliverable:
- integrated implementation + tests + notes on any remaining blockers
```

### Optional final polish wave

4. **docs-and-polish worker**
   - only after command behavior stabilizes
   - updates README, plans, examples, and any remaining tests or edge-case docs

This can run after integration is mostly settled.

### Practical rule

If a worker needs to edit `extensions/delegate.js` or the main `lib/delegate.js`, treat it as a **serialized** worker, not a parallel one.

## First recommended slice

Implement this first and stop:

1. `/ezdg start`, `/ezdg list`, `/ezdg open`, `/ezdg attach`, `/ezdg clean`
2. persistent worker registry
3. tmux live/dead detection
4. safe dead-worker cleanup
5. single-rail pane layout config with:
   - `defaultPaneSplit`
   - `minPaneColumns = 180`
   - `minPaneRows = 28`
6. stored origin pane/window metadata for pane relaunch and explicit split targeting

That gets worker lifecycle under control without prematurely building a full tmux layout manager.

## Notes for later follow-through

- Keep the extension thin; put worker lifecycle and tmux logic in `lib/`.
- Use the registry as the source of truth for worker discovery, but recompute liveness dynamically.
- Do not auto-delete anything with signs of meaningful unfinished work.
- Resist the temptation to grow this into a queue manager or profile system.
- If true multi-column delegate layouts are ever needed, treat that as a dedicated tmux layout project, not a small follow-up tweak.
