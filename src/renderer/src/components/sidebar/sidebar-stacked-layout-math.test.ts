import { describe, expect, it } from 'vitest'
import { activityPaneRatioFromPointer, clampActivityPaneRatio } from './sidebar-stacked-layout-math'

describe('clampActivityPaneRatio', () => {
  it('keeps 120px for the Activity pane and 160px for the workspace list in a 600px body', () => {
    expect(clampActivityPaneRatio(0.05, 600)).toBeCloseTo(0.2)
    expect(clampActivityPaneRatio(0.95, 600)).toBeCloseTo(1 - 160 / 600)
    expect(clampActivityPaneRatio(0.5, 600)).toBe(0.5)
  })

  it('falls back to the default split when the body is too short for both minimums', () => {
    expect(clampActivityPaneRatio(0.9, 250)).toBe(0.42)
  })
})

describe('activityPaneRatioFromPointer', () => {
  it('gives the Activity pane the space below the pointer', () => {
    expect(activityPaneRatioFromPointer(400, { bottom: 700, height: 600 })).toBe(0.5)
  })

  it('clamps a pointer dragged past the top of the body', () => {
    expect(activityPaneRatioFromPointer(0, { bottom: 700, height: 600 })).toBeCloseTo(1 - 160 / 600)
  })
})
