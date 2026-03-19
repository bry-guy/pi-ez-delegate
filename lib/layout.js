export function planTmuxPaneLaunch(input = {}) {
  const panes = Array.isArray(input.panes) ? input.panes : [];
  const originPaneId = String(input.originPaneId || "").trim();
  const originPane = panes.find((p) => p?.paneId === originPaneId);

  if (!originPane) {
    throw new Error(`Origin pane ${originPaneId || "<unknown>"} not found in the current window.`);
  }

  const splitPreference = normalizeSplit(input.splitPreference);
  const minCols = normalizePositive(input.minPaneColumns, 180);
  const minRows = normalizeNonNegative(input.minPaneRows, 28);
  const windowWidth = normalizePositive(input.windowWidth, originPane.windowWidth || originPane.width || 0);
  const enforceRowLimit = minRows > 0;

  const railPaneIds = [...new Set((input.railPaneIds || []).filter((id) => id && id !== originPaneId && panes.some((p) => p.paneId === id)))];

  if (splitPreference === "vertical") {
    if (railPaneIds.length > 0) {
      throw new Error("A delegate pane rail already exists. Use --split horizontal, --target window, or clean existing delegates.");
    }
    if (windowWidth < 2 * minCols) {
      throw new Error(
        `Window too narrow for vertical split (need ${2 * minCols} columns). Use --target window or --target session.`,
      );
    }
    return { splitMode: "vertical", targetPaneId: originPaneId, createdRail: true };
  }

  if (splitPreference === "horizontal") {
    const target = getTallestPane(panes, railPaneIds) || originPane;
    if (enforceRowLimit && target.height < 2 * minRows) {
      throw new Error(
        `Pane too short for horizontal split (need ${2 * minRows} rows). Use --target window or --target session.`,
      );
    }
    return { splitMode: "horizontal", targetPaneId: target.paneId, createdRail: railPaneIds.length === 0 };
  }

  // Auto mode
  if (railPaneIds.length === 0) {
    if (windowWidth >= 2 * minCols) {
      return { splitMode: "vertical", targetPaneId: originPaneId, createdRail: true };
    }
    if (!enforceRowLimit || originPane.height >= 2 * minRows) {
      return { splitMode: "horizontal", targetPaneId: originPaneId, createdRail: true };
    }
    throw new Error(
      `Not enough space for a pane split (need ${2 * minCols} columns or ${2 * minRows} rows). Use --target window or --target session.`,
    );
  }

  // Rail exists — stack horizontally in tallest rail pane
  const tallest = getTallestPane(panes, railPaneIds);
  if (!tallest) {
    throw new Error("No live delegate panes found in the rail.");
  }
  if (enforceRowLimit && tallest.height < 2 * minRows) {
    throw new Error(
      `Rail panes too short for another split (need ${2 * minRows} rows). Use --target window, --target session, or clean old delegates.`,
    );
  }
  return { splitMode: "horizontal", targetPaneId: tallest.paneId, createdRail: false };
}

function normalizeSplit(value) {
  const v = String(value || "auto").toLowerCase();
  return v === "horizontal" || v === "vertical" ? v : "auto";
}

function normalizePositive(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function normalizeNonNegative(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function getTallestPane(panes, paneIds) {
  return paneIds
    .map((id) => panes.find((p) => p.paneId === id))
    .filter(Boolean)
    .sort((a, b) => b.height - a.height)[0];
}
