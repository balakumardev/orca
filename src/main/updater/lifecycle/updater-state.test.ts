import { describe, expect, it, vi } from 'vitest'

const { getVersionMock } = vi.hoisted(() => ({ getVersionMock: vi.fn(() => '1.4.258') }))

vi.mock('electron', () => ({ app: { getVersion: getVersionMock } }))

import { isAutoUpdateDisabledForBuild } from './updater-state'

describe('isAutoUpdateDisabledForBuild', () => {
  it.each([
    ['1.4.258+custom.3', true],
    ['1.4.258-rc.1+custom.2', true],
    ['1.4.258', false],
    ['1.4.258-rc.1', false],
    ['1.4.258-custom.1', false],
    ['1.4.258+sha.abc123', false]
  ])('classifies %s as disabled=%s', (version, expected) => {
    expect(isAutoUpdateDisabledForBuild(version)).toBe(expected)
  })

  it('reads the running app version when none is passed', () => {
    getVersionMock.mockReturnValueOnce('1.4.258+custom.7')
    expect(isAutoUpdateDisabledForBuild()).toBe(true)
    expect(isAutoUpdateDisabledForBuild()).toBe(false)
  })
})
