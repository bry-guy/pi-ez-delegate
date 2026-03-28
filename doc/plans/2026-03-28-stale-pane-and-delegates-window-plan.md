# pi-ez-delegate stale-pane and delegates-window implementation plan

Status: in progress
Date: 2026-03-28

## Goals

1. Fix stale origin pane handling so `/ezdg start` recovers after parent reopen.
2. Remove tmux `session` target support entirely.
3. Redefine `window` target to mean a shared tmux `delegates` window whose delegates are panes.
4. Fix liveness classification so pane workers are not kept alive by parent window/session metadata.
5. Improve `/ezdg list` status wording so open/clean workers are not conflated with truly active or stale workers.

## Problem breakdown

### A. Stale origin pane
Stored `originPaneId` is treated as durable truth. After the parent pi session is closed/reopened, that pane id may no longer exist. A later pane-target launch fails instead of rebinding to the current live tmux pane.

### B. Worker liveness too broad
Pane workers currently probe pane, then window, then session. For pane workers, the recorded window/session usually belong to the parent tmux container, so a dead pane can still look live.

### C. `window` behavior is wrong for the desired UX
Current `window` launches one new tmux window per delegate. Desired behavior is one shared `delegates` window, with delegates as panes inside it.

### D. Status labeling is too coarse
`Live` currently mixes together active workers, idle-but-open workers, and some stale metadata cases.

## Implementation phases

### Phase 1 — correctness and API cleanup
- Remove `session` from target enums, parsing, help text, config validation, tool schema, and tests.
- Fix stale origin recovery:
  - if stored `originPaneId` is dead, try current `TMUX_PANE`
  - if current pane is live, rebind to it
  - only fail when no live pane context exists
- Make pane/window liveness authoritative by launch mode.
- Add regression tests for stale-origin recovery and pane-worker liveness.

### Phase 2 — delegates window
- Add tmux helpers to locate/create a shared `delegates` window in the current tmux session.
- Redefine `target: window` launch behavior:
  - keep the current window untouched
  - place delegates in the shared `delegates` window
  - within that window, delegates are panes
- Reuse existing pane layout logic inside the delegates window.
- Update reopen/attach behavior to work with the new model.

### Phase 3 — status UX
- Refine worker statuses to distinguish open clean workers from stale/dead workers.
- Minimum user-facing improvement:
  - `Open` for live targets
  - `Needs Attention`
  - `Safe to Clean`
  - `Stale`
- Include git summary context in list output.

## File ownership split

### Worker 1: tmux/delegates-window
Own:
- `lib/tmux.js`
- related tests if added for tmux target behavior

Constraints:
- do not edit `lib/manager.js`
- do not edit `extensions/delegate.js`
- do not edit `lib/config.js`
- do not edit docs

### Worker 2: manager/liveness
Own:
- `lib/manager.js`
- `test/manager.test.js`

Constraints:
- do not edit `lib/tmux.js`
- do not edit `extensions/delegate.js`
- do not edit docs

### Coordinator (current session)
Own:
- `lib/delegate.js`
- `extensions/delegate.js`
- `lib/config.js`
- `skills/delegate-work/SKILL.md`
- shared integration tests/docs/help text

## Acceptance criteria

- `/ezdg start` with pane target succeeds after parent reopen if current tmux pane exists.
- No `session` target remains in code, config, docs, or help text.
- `target: window` uses one shared `delegates` window; delegates there are panes, not one window each.
- A dead pane worker is not shown as live merely because its parent window/session still exists.
- `/ezdg list` better distinguishes open workers from dead/stale ones.
