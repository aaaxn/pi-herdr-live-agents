import type { PaneLayout, PaneRect } from "./types.js";

export type SplitPlan = {
  sourcePaneId: string;
  direction: "right" | "down";
};

export function planSiblingSplit(
  layout: PaneLayout,
  sourcePaneId: string,
  minimum: { width: number; height: number },
): SplitPlan | undefined {
  const pane = layout.panes.find((candidate) => candidate.pane_id === sourcePaneId);
  if (!pane) return undefined;
  const direction = chooseDirection(pane.rect, minimum);
  return direction ? { sourcePaneId, direction } : undefined;
}

export function planLargestSplit(
  layout: PaneLayout,
  paneIds: ReadonlySet<string>,
  minimum: { width: number; height: number },
): SplitPlan | undefined {
  return layout.panes
    .filter((pane) => paneIds.has(pane.pane_id))
    .map((pane) => ({ pane, direction: chooseDirection(pane.rect, minimum) }))
    .filter((candidate): candidate is { pane: (typeof layout.panes)[number]; direction: "right" | "down" } => Boolean(candidate.direction))
    .sort((left, right) => area(right.pane.rect) - area(left.pane.rect))
    .map(({ pane, direction }) => ({ sourcePaneId: pane.pane_id, direction }))[0];
}

export function chooseDirection(
  rect: PaneRect,
  minimum: { width: number; height: number },
): "right" | "down" | undefined {
  const canSplitRight = rect.height >= minimum.height && Math.floor((rect.width - 1) / 2) >= minimum.width;
  const canSplitDown = rect.width >= minimum.width && Math.floor((rect.height - 1) / 2) >= minimum.height;
  if (!canSplitRight && !canSplitDown) return undefined;
  if (canSplitRight && !canSplitDown) return "right";
  if (canSplitDown && !canSplitRight) return "down";
  return rect.width / minimum.width >= rect.height / minimum.height ? "right" : "down";
}

function area(rect: PaneRect): number {
  return rect.width * rect.height;
}
