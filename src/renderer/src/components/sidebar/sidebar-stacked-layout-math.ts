export const DEFAULT_ACTIVITY_PANE_RATIO = 0.42
export const MIN_ACTIVITY_PANE_PX = 120
export const MIN_WORKSPACE_PANE_PX = 160

/** Share of the stacked sidebar body the Activity pane may take while both panes stay usable. */
export function clampActivityPaneRatio(ratio: number, containerHeight: number): number {
  const min = MIN_ACTIVITY_PANE_PX / containerHeight
  const max = 1 - MIN_WORKSPACE_PANE_PX / containerHeight
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return DEFAULT_ACTIVITY_PANE_RATIO
  }
  return Math.min(max, Math.max(min, ratio))
}

/** The splitter sits above the Activity pane, so a pointer higher in the body gives it more room. */
export function activityPaneRatioFromPointer(
  pointerY: number,
  container: { bottom: number; height: number }
): number {
  return clampActivityPaneRatio((container.bottom - pointerY) / container.height, container.height)
}
