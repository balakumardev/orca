import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_RETRY_INITIAL_MS,
  DOWNLOAD_RETRY_MAX_MS,
  DownloadBackoff
} from './custom-update-backoff'

const MINUTE = 60_000

describe('the wait between downloads of a release that keeps failing', () => {
  it('starts at fifteen minutes, doubles each time, and stops at six hours', () => {
    const backoff = new DownloadBackoff()

    const waits = Array.from({ length: 8 }, () => backoff.failed('1.4.258+custom.7') / MINUTE)

    expect(waits).toEqual([15, 30, 60, 120, 240, 360, 360, 360])
    expect(DOWNLOAD_RETRY_INITIAL_MS).toBe(15 * MINUTE)
    expect(DOWNLOAD_RETRY_MAX_MS).toBe(360 * MINUTE)
  })

  it('starts again for a newer release', () => {
    const backoff = new DownloadBackoff()
    backoff.failed('1.4.258+custom.7')
    backoff.failed('1.4.258+custom.7')

    expect(backoff.failed('1.4.258+custom.8')).toBe(15 * MINUTE)
    expect(backoff.failed('1.4.258+custom.8')).toBe(30 * MINUTE)
  })

  it('starts again once the release was staged', () => {
    const backoff = new DownloadBackoff()
    backoff.failed('1.4.258+custom.7')
    backoff.failed('1.4.258+custom.7')

    backoff.reset()

    expect(backoff.failed('1.4.258+custom.7')).toBe(15 * MINUTE)
  })
})
