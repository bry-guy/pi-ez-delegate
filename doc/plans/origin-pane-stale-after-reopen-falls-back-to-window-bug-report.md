# Origin pane becomes stale after reopening pi, causing `/ezdg start` pane launches to fail and fall back to windows

status: done

## Summary
When a parent pi session is closed/reopened, `/ezdg start` can attempt to launch delegates using a previously stored tmux pane id (`originPaneId`) that no longer exists. Delegate startup with `target: pane` fails with:

- `Stored origin pane no longer exists: %27. Retry with --target window or --target session.`

If retried with `target: window`, delegates launch into new tmux windows instead of panes in the current window.

## Impact
- Confusing UX: user expects pane split, sees extra windows/tabs.
- Looks like "blank delegate windows" depending on current tmux focus/worker state.
- Breaks expectation that `/ezdg start` should target the current pane/window context at invocation time.

## Environment
- Repo: `~/dev/srvivor` (delegation caller)
- Extension under test: `~/dev/pi-ez-delegate`
- tmux session had been previously used for delegation.
- Parent pi was closed and reopened (same tmux window reused by user).

## Reproduction
1. In a tmux pane, run pi in a repo and launch at least one delegate via `/ezdg start ...`.
2. Close pi in that pane/session (or otherwise invalidate prior pane id), then reopen pi.
3. From reopened parent pi, run another delegate launch expecting pane target:
   - tool-level: `delegate_task(... target: "pane" ...)`
   - slash-level equivalent: `/ezdg start ...`
4. Observe error:
   - `Stored origin pane no longer exists: %<id>. Retry with --target window or --target session.`
5. Retry with window target; delegate launches into new tmux windows.

## Expected
- `/ezdg start` should refresh and use the current live origin pane/window at invocation time.
- If stale origin metadata exists, extension should auto-heal by re-binding origin to current pane (or a resolvable current pane) before launching.
- Default pane target should work without manual fallback.

## Actual
- Extension appears to trust stale stored origin pane id.
- Pane-target launch fails until user manually switches target mode to window/session.

## Hypothesis
- Worker/session registry stores `originPaneId` once and reuses it across parent restarts.
- Reopen flow does not revalidate/rebind `originPaneId` against current tmux state.

## Suggested fixes
1. On every `/ezdg start`, recompute origin pane/window from current tmux context.
2. If stored `originPaneId` is missing, auto-fallback to current pane instead of hard error.
3. Add stale-origin detection and one-time self-heal writeback to worker/session metadata.
4. Improve user-facing error text to mention likely "parent reopened" cause and automatic recovery path.

## Acceptance criteria
- After parent close/reopen, `/ezdg start` with pane target succeeds without manual target override.
- No extra windows are created when pane target is requested and current pane exists.
- Regression test covers stale `originPaneId` recovery behavior.
