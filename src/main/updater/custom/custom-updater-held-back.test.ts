import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CustomUpdateError } from './custom-update-errors'
import { CUSTOM_UPDATE_CHECK_INTERVAL_MS } from './custom-updater'
import {
  FIRST_CHECK_MS,
  NEXT,
  candidateFor,
  createHarness,
  offer,
  type Harness
} from './testing/custom-updater-harness'

describe('a click that lands while a background check is still waiting on the feed', () => {
  let userDataDir: string

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'orca-custom-updater-held-back-'))
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(userDataDir, { recursive: true, force: true })
  })

  const logged = (t: Harness, event: string): number =>
    vi.mocked(t.deps.log).mock.calls.filter(([name]) => name === event).length

  /** Three background checks whose verification times out: the release is then set aside for background checks. */
  async function setAsideAfterThreeFailures(): Promise<Harness> {
    const t = createHarness(userDataDir, {
      verify: vi.fn(async () => {
        throw new CustomUpdateError('check-timeout', 'spctl took too long')
      })
    })
    offer(t, candidateFor(NEXT))
    t.updater.start(t.host)
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
    for (const count of [1, 2, 3]) {
      await vi.waitFor(() => expect(logged(t, 'custom_update_failed')).toBe(count))
      if (count < 3) {
        await vi.advanceTimersByTimeAsync(CUSTOM_UPDATE_CHECK_INTERVAL_MS * 1.1)
      }
    }
    await t.settle()
    return t
  }

  /** The feed answers only when `release` is called, so a click can land while a check waits for it. */
  function slowFeed(t: Harness, answer: () => ReturnType<typeof candidateFor> | null): () => void {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    t.feed.check.mockImplementation(async (options) => {
      await gate
      const candidate = answer()
      return candidate && !options?.exclude?.has(candidate.manifest.version) ? candidate : null
    })
    return release
  }

  it('is not answered "up to date" for a release that only the background check was held back from', async () => {
    const t = await setAsideAfterThreeFailures()
    const release = slowFeed(t, () => candidateFor(NEXT))
    const verified = vi.mocked(t.deps.verify).mock.calls.length
    t.statuses.length = 0

    // The fourth background check starts and waits on the feed; then the person clicks "Check for updates".
    await vi.advanceTimersByTimeAsync(CUSTOM_UPDATE_CHECK_INTERVAL_MS * 1.1)
    expect(t.updater.checkFromMenu()).toBe(true)
    expect(t.statuses).toEqual([{ state: 'checking', userInitiated: true }])
    release()
    // They are not held to what the background check was: the release is tried for them, and it fails here again.
    await vi.waitFor(() => expect(t.current().state).toBe('error'))
    await t.settle()

    expect(vi.mocked(t.deps.verify).mock.calls.length).toBe(verified + 1)
    expect(t.statuses.some((status) => status.state === 'not-available')).toBe(false)
    expect(t.current()).toMatchObject({ state: 'error', version: NEXT })
  })

  it('is still answered "up to date" when the check finds nothing, and asks the feed once', async () => {
    const t = createHarness(userDataDir)
    t.updater.start(t.host)
    const release = slowFeed(t, () => null)
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
    expect(t.feed.check).toHaveBeenCalledTimes(1)

    expect(t.updater.checkFromMenu()).toBe(true)
    release()
    await vi.waitFor(() => expect(t.current().state).toBe('not-available'))

    expect(t.current()).toEqual({ state: 'not-available', userInitiated: true })
    expect(t.feed.check).toHaveBeenCalledTimes(1)
  })
})
