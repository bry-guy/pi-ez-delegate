# pi-ez-delegate bug report: pane workers can be misclassified as live after exit because liveness falls back to parent window/session

Status: open bug report / investigation note.

## Summary

A delegated worker launched with `target=pane` can remain listed as **Live** even after the worker pane has exited and the worker worktree/session are already gone or safe to clean.

The observed reason is that worker inspection currently does this:

1. check whether the recorded pane id is still live
2. if not, check whether the recorded window id is still live
3. if not, check whether the recorded session id is still live

For pane-targeted workers, the recorded window/session often belong to the **parent tmux window/session**, which usually stay alive long after the worker pane exits.

That means a dead pane worker can be reported as live simply because its parent window or session still exists.

## Why this matters

This breaks several core `/ezdg` lifecycle behaviors:

- `/ezdg list` shows dead pane workers under **Live**
- `/ezdg clean` cannot clean them, because they never become dead-safe-to-clean
- `/ezdg open` / `/ezdg attach` can behave misleadingly because the worker is not actually there
- stale registry entries accumulate even when the worker worktree or branch has already been removed

This is especially confusing because the UI can simultaneously show:

- a worker as "live"
- while its worktree is missing
- and its dedicated pane no longer exists

## Concrete observed case

Registry file:

- `~/.pi/agent/state/pi-ez-delegate/srvivor-7fff68e24580.json`

Recorded workers that still showed as live in the UI:

- `discord-bot-prod-client-state`
- `infra-selfhost-k3s-castaway`

Recorded tmux metadata for those workers:

- `discord-bot-prod-client-state`
  - `paneId=%93`
  - `windowId=@10`
  - `sessionId=$0`
- `infra-selfhost-k3s-castaway`
  - `paneId=%91`
  - `windowId=@10`
  - `sessionId=$0`

Observed live tmux panes at the time of inspection did **not** include `%91` or `%93`.

But tmux session `$0` and window `@10` still existed, because they were the parent session/window.

So the workers were still shown as live even though their panes were gone.

## Evidence

### Registry state showed dead-looking workers

For both workers:

- `childSessionFile` still existed
- `worktreePath` was missing for the discord worker
- no dedicated worker pane still existed

### tmux pane lookup for the recorded pane ids failed

Running:

```bash
for p in %91 %93; do
  tmux display-message -p -t "$p" '#{session_id} #{window_id} #{pane_id}'
done
```

returned empty / failed to resolve those pane ids.

### tmux still had the parent window/session alive

Running:

```bash
tmux list-panes -a -F '#{session_id} #{window_id} #{pane_id} #{pane_current_path}'
```

showed the parent session/window still alive, including:

- session `$0`
- window `@10`

### Current implementation explains the bug directly

`lib/manager.js` currently does:

```js
let live = false;
if (record.paneId) live = await isTmuxTargetLive("pane", record.paneId, { env });
if (!live && record.windowId) live = await isTmuxTargetLive("window", record.windowId, { env });
if (!live && record.sessionId) live = await isTmuxTargetLive("session", record.sessionId, { env });
```

For pane workers, this fallback is too broad.

## Expected behavior

For a worker launched with `targetMode: "pane"`:

- the worker should be considered live only if its **pane** is still live
- if the pane is gone, the worker should be treated as dead
- parent window/session liveness should not keep that worker classified as live

For a worker launched with `targetMode: "window"`:

- window liveness should be the primary source of truth

For a worker launched with `targetMode: "session"`:

- session liveness should be the primary source of truth

## Actual behavior

Pane workers fall back to recorded window/session liveness, so they can be incorrectly kept in the **Live** state forever as long as the surrounding tmux container still exists.

## Impact

Severity: medium-high for worker lifecycle correctness.

Consequences:

- dead workers look live
- safe cleanup is blocked
- registry state drifts from reality
- users can end up manually editing registry files or cleaning worktrees by hand
- the command model feels unreliable

## Likely root cause

The inspection logic seems to treat tmux targets as interchangeable fallbacks, but for pane workers they are not interchangeable.

A pane worker's recorded `windowId` and `sessionId` are typically just the enclosing parent containers, not alternate worker identities.

So for pane workers:

- pane liveness is the worker liveness
- window/session liveness is only context metadata, not a fallback signal

## Proposed fix

Use `record.targetMode` to choose the authoritative liveness probe.

Suggested logic:

- if `targetMode === "pane"`, check only `paneId`
- if `targetMode === "window"`, check only `windowId`
- if `targetMode === "session"`, check only `sessionId`
- only use alternate ids if the original launch mode truly supports identity equivalence

Pseudo-shape:

```js
let live = false;
if (record.targetMode === "pane") {
  live = record.paneId ? await isTmuxTargetLive("pane", record.paneId, { env }) : false;
} else if (record.targetMode === "window") {
  live = record.windowId ? await isTmuxTargetLive("window", record.windowId, { env }) : false;
} else if (record.targetMode === "session") {
  live = record.sessionId ? await isTmuxTargetLive("session", record.sessionId, { env }) : false;
} else {
  // conservative fallback for old records
  if (record.paneId) live = await isTmuxTargetLive("pane", record.paneId, { env });
  if (!live && record.windowId) live = await isTmuxTargetLive("window", record.windowId, { env });
  if (!live && record.sessionId) live = await isTmuxTargetLive("session", record.sessionId, { env });
}
```

## Recommended regression coverage

Add tests covering at least:

1. a pane worker whose pane is gone but parent window/session still exist -> should be dead
2. a window worker whose window still exists -> should be live
3. a session worker whose session still exists -> should be live
4. old records without `targetMode` -> may still use the conservative fallback path

## Reproduction sketch

1. Launch a worker with `/ezdg start --target pane ...`
2. Let the worker process exit so the pane disappears
3. Keep the parent tmux window/session open
4. Run `/ezdg list`
5. Observe the worker is still shown as **Live**

If the bug is fixed, step 5 should show the worker as:

- **Safe to Clean** if its worktree/session file are clean
- **Needs Attention** if it still has ahead/dirty/rebase state
- **Stale** if nothing remains

## User-visible symptom summary

"My pane worker is gone, but `/ezdg list` still says it's live because the parent tmux window/session still exists. That prevents cleanup and leaves stale workers behind."
