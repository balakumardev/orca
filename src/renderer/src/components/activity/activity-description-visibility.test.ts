// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ActivityDescriptionVisibility from './activity-description-visibility'

async function loadFreshModule(): Promise<typeof ActivityDescriptionVisibility> {
  vi.resetModules()
  return import('./activity-description-visibility')
}

describe('Activity description visibility', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is hidden until the user opts in', async () => {
    const { getActivityDescriptionVisible } = await loadFreshModule()

    expect(getActivityDescriptionVisible()).toBe(false)
  })

  it('survives a reload once ticked and is hidden again once unticked', async () => {
    const first = await loadFreshModule()
    first.setActivityDescriptionVisible(true)
    expect(first.getActivityDescriptionVisible()).toBe(true)

    const afterReload = await loadFreshModule()
    expect(afterReload.getActivityDescriptionVisible()).toBe(true)

    afterReload.setActivityDescriptionVisible(false)
    const afterSecondReload = await loadFreshModule()
    expect(afterSecondReload.getActivityDescriptionVisible()).toBe(false)
  })

  it('keeps working for this window when storage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage denied')
      },
      setItem: () => {
        throw new Error('storage denied')
      }
    })
    const { getActivityDescriptionVisible, setActivityDescriptionVisible } = await loadFreshModule()

    expect(getActivityDescriptionVisible()).toBe(false)
    setActivityDescriptionVisible(true)
    expect(getActivityDescriptionVisible()).toBe(true)
  })
})
