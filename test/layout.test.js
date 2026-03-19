import test from "node:test";
import assert from "node:assert/strict";

import { planTmuxPaneLaunch } from "../lib/layout.js";

const WIDE_WINDOW = 400;
const NARROW_WINDOW = 160;

function makePanes(specs) {
  return specs.map(([paneId, width, height]) => ({
    paneId,
    width,
    height,
    windowWidth: WIDE_WINDOW,
    windowHeight: 60,
  }));
}

test("auto: vertical split when window is wide enough and no rail exists", () => {
  const result = planTmuxPaneLaunch({
    panes: makePanes([["%1", WIDE_WINDOW, 60]]),
    originPaneId: "%1",
    windowWidth: WIDE_WINDOW,
    railPaneIds: [],
  });
  assert.equal(result.splitMode, "vertical");
  assert.equal(result.targetPaneId, "%1");
  assert.equal(result.createdRail, true);
});

test("auto: horizontal split when window is too narrow but pane is tall enough", () => {
  const result = planTmuxPaneLaunch({
    panes: makePanes([["%1", NARROW_WINDOW, 80]]),
    originPaneId: "%1",
    windowWidth: NARROW_WINDOW,
    railPaneIds: [],
  });
  assert.equal(result.splitMode, "horizontal");
  assert.equal(result.targetPaneId, "%1");
  assert.equal(result.createdRail, true);
});

test("auto: errors when no space available", () => {
  assert.throws(
    () =>
      planTmuxPaneLaunch({
        panes: makePanes([["%1", NARROW_WINDOW, 20]]),
        originPaneId: "%1",
        windowWidth: NARROW_WINDOW,
        railPaneIds: [],
        minPaneRows: 28,
      }),
    /not enough space/i,
  );
});

test("auto: stacks horizontally in tallest rail pane when rail exists", () => {
  const panes = makePanes([
    ["%1", 200, 60],
    ["%2", 200, 40],
    ["%3", 200, 60],
  ]);
  const result = planTmuxPaneLaunch({
    panes,
    originPaneId: "%1",
    windowWidth: WIDE_WINDOW,
    railPaneIds: ["%2", "%3"],
  });
  assert.equal(result.splitMode, "horizontal");
  assert.equal(result.targetPaneId, "%3"); // tallest rail pane
  assert.equal(result.createdRail, false);
});

test("auto: errors when rail is full (all panes too short)", () => {
  const panes = makePanes([
    ["%1", 200, 60],
    ["%2", 200, 20],
  ]);
  assert.throws(
    () =>
      planTmuxPaneLaunch({
        panes,
        originPaneId: "%1",
        windowWidth: WIDE_WINDOW,
        railPaneIds: ["%2"],
        minPaneRows: 28,
      }),
    /too short/i,
  );
});

test("auto: minPaneRows=0 disables rail height checks", () => {
  const panes = makePanes([
    ["%1", 200, 60],
    ["%2", 200, 8],
  ]);
  const result = planTmuxPaneLaunch({
    panes,
    originPaneId: "%1",
    windowWidth: WIDE_WINDOW,
    railPaneIds: ["%2"],
    minPaneRows: 0,
  });
  assert.equal(result.splitMode, "horizontal");
  assert.equal(result.targetPaneId, "%2");
  assert.equal(result.createdRail, false);
});

test("explicit vertical: errors when rail already exists", () => {
  const panes = makePanes([
    ["%1", 200, 60],
    ["%2", 200, 60],
  ]);
  assert.throws(
    () =>
      planTmuxPaneLaunch({
        panes,
        originPaneId: "%1",
        windowWidth: WIDE_WINDOW,
        railPaneIds: ["%2"],
        splitPreference: "vertical",
      }),
    /rail already exists/i,
  );
});

test("explicit horizontal: targets tallest rail pane or origin", () => {
  const panes = makePanes([["%1", 200, 80]]);
  const result = planTmuxPaneLaunch({
    panes,
    originPaneId: "%1",
    windowWidth: WIDE_WINDOW,
    railPaneIds: [],
    splitPreference: "horizontal",
  });
  assert.equal(result.splitMode, "horizontal");
  assert.equal(result.targetPaneId, "%1");
});

test("errors when origin pane not found", () => {
  assert.throws(
    () =>
      planTmuxPaneLaunch({
        panes: makePanes([["%1", 200, 60]]),
        originPaneId: "%99",
      }),
    /origin pane/i,
  );
});
