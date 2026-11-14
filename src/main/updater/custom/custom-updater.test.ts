import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CustomUpdateError } from './custom-update-errors'
import type { CustomUpdateCandidate } from './custom-update-feed'
import { CUSTOM_UPDATE_CHECK_INTERVAL_MS } from './custom-updater'
import type { CustomUpdaterDeps } from './custom-updater-types'
import {
  FIRST_CHECK_MS,
  NEXT,
  RUNNING,
  candidateFor,
  createHarness as createUpdaterHarness,
  offer,
  untilStatus,
  type Harness
} from './testing/custom-updater-harness'

describe('custom updater', () => {
  let userDataDir: string

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'orca-custom-updater-'))
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(userDataDir, { recursive: true, force: true })
  })

  /** The shared harness, with this test's user data folder. */
  const createHarness = (overrides: Partial<CustomUpdaterDeps> = {}, version = RUNNING): Harness =>
    createUpdaterHarness(userDataDir, overrides, version)

  describe('when it runs', () => {
    it.each([
      ['an official build', { version: '1.4.258' }],
      ['a prerelease build', { version: '1.4.258-rc.1' }],
      ['another platform', { platform: 'linux' }],
      ['an Intel Mac', { arch: 'x64' }],
      ['an unpackaged build with no test feed', { isPackaged: false }]
    ])('stays off on %s', async (_name, runtime) => {
      const t = createHarness({
        runtime: () => ({
          platform: 'darwin',
          arch: 'arm64',
          isPackaged: true,
          version: RUNNING,
          userDataDir,
          ...runtime
        })
      })

      expect(t.updater.start(t.host)).toBe(false)
      expect(t.deps.mac.registerEvents).not.toHaveBeenCalled()
      expect(t.deps.createFeed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(CUSTOM_UPDATE_CHECK_INTERVAL_MS)
      expect(t.feed.check).not.toHaveBeenCalled()
      expect(t.updater.checkFromMenu()).toBe(false)
      expect(t.updater.download()).toBe(false)
      expect(t.updater.quitAndInstall()).toBe(false)
      expect(t.updater.invokeNativeInstall()).toBe(false)
    })

    it('runs on an unpackaged build that points at a loopback test feed', () => {
      const t = createHarness({
        env: { ORCA_CUSTOM_UPDATER_FEED_URL: 'http://127.0.0.1:4000' },
        runtime: () => ({
          platform: 'darwin',
          arch: 'arm64',
          isPackaged: false,
          version: RUNNING,
          userDataDir
        })
      })

      expect(t.updater.start(t.host)).toBe(true)
      expect(t.deps.createFeed).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: expect.objectContaining({ apiBase: 'http://127.0.0.1:4000', overridden: true })
        })
      )
    })

    it('stays off, and does not throw, when the platform wiring fails during setup', () => {
      const t = createHarness({
        runtime: () => {
          throw new TypeError('app.getPath is not a function')
        }
      })

      expect(t.updater.start(t.host)).toBe(false)
      // A foreign error's message can hold paths or host names; only its type goes to the breadcrumb.
      expect(t.deps.log).toHaveBeenCalledWith('custom_update_start_failed', {
        errorType: 'TypeError'
      })
      expect(t.updater.checkFromMenu()).toBe(false)
    })

    it('stays off when registering with the native updater fails part-way', async () => {
      const t = createHarness({
        mac: {
          beginDownload: vi.fn(),
          setPreflightInProgress: vi.fn(),
          registerEvents: vi.fn(() => {
            throw new Error('register failed')
          }),
          installDelayMs: 100
        }
      })

      expect(t.updater.start(t.host)).toBe(false)
      await vi.advanceTimersByTimeAsync(CUSTOM_UPDATE_CHECK_INTERVAL_MS)
      expect(t.feed.check).not.toHaveBeenCalled()
      expect(t.updater.checkInBackground()).toBe(false)
    })

    it('registers upstream mac install events once, even when setup runs again', () => {
      const t = createHarness()

      expect(t.updater.start(t.host)).toBe(true)
      expect(t.updater.start(t.host)).toBe(true)

      expect(t.deps.mac.registerEvents).toHaveBeenCalledOnce()
      expect(t.deps.createFeed).toHaveBeenCalledOnce()
    })
  })

  describe('scheduling', () => {
    it('checks 90 seconds after start, then every four hours', async () => {
      const t = createHarness()
      t.updater.start(t.host)

      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1)
      expect(t.feed.check).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(t.feed.check).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(4 * 60 * 60_000 - 1)
      expect(t.feed.check).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(t.feed.check).toHaveBeenCalledTimes(2)
    })

    it.each([
      ['early', 0, 3.6],
      ['late', 1, 4.4]
    ])('jitters the interval by at most ten percent (%s)', async (_name, random, hours) => {
      const t = createHarness({ random: () => random })
      t.updater.start(t.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)

      await vi.advanceTimersByTimeAsync(hours * 60 * 60_000 - 1)
      expect(t.feed.check).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(t.feed.check).toHaveBeenCalledTimes(2)
    })

    it('waits out the feed backoff when it is longer than the interval', async () => {
      const t = createHarness()
      t.feed.check.mockImplementationOnce(async () => {
        t.feed.retryDelayMs = 6 * 60 * 60_000
        throw new CustomUpdateError('rate-limited', 'paused')
      })
      t.updater.start(t.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)

      await vi.advanceTimersByTimeAsync(5 * 60 * 60_000)
      expect(t.feed.check).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(t.feed.check).toHaveBeenCalledTimes(2)
    })

    it('looks again after fifteen minutes when the check failed for lack of a network', async () => {
      const t = createHarness()
      t.feed.check.mockRejectedValueOnce(new CustomUpdateError('network', 'offline'))
      t.updater.start(t.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)

      await vi.advanceTimersByTimeAsync(15 * 60_000 * 1.1)
      expect(t.feed.check).toHaveBeenCalledTimes(2)
    })

    it('asks for a person-initiated check without honoring a pause', async () => {
      const t = createHarness()
      t.updater.start(t.host)

      t.updater.checkFromMenu()
      await untilStatus(t, 'not-available')

      expect(t.feed.check).toHaveBeenCalledWith({ exclude: new Set(), force: true })
    })

    it('runs one check at a time and lets a manual check join the one in flight', async () => {
      const t = createHarness()
      let finish: (value: CustomUpdateCandidate | null) => void = () => undefined
      t.feed.check.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
      t.updater.start(t.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      expect(t.statuses).toEqual([])

      t.updater.checkFromMenu()
      t.updater.checkFromMenu()
      t.updater.checkInBackground()
      expect(t.feed.check).toHaveBeenCalledTimes(1)
      expect(t.statuses).toEqual([{ state: 'checking', userInitiated: true }])

      finish(null)
      await untilStatus(t, 'not-available')
      expect(t.current()).toEqual({ state: 'not-available', userInitiated: true })
    })
  })

  describe('check outcomes', () => {
    it('stays silent when a background check finds nothing or fails', async () => {
      const t = createHarness()
      t.feed.check
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new CustomUpdateError('network', 'offline'))
      t.updater.start(t.host)

      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await vi.advanceTimersByTimeAsync(CUSTOM_UPDATE_CHECK_INTERVAL_MS)

      expect(t.feed.check).toHaveBeenCalledTimes(2)
      expect(t.statuses).toEqual([])
      expect(t.deps.log).toHaveBeenCalledWith(
        'custom_update_failed',
        expect.objectContaining({ kind: 'network' })
      )
    })

    it('clears an old error card when a later background check finds nothing', async () => {
      const t = createHarness()
      t.updater.start(t.host)
      t.host.sendStatus({ state: 'error', message: 'old failure' })
      t.statuses.length = 0

      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)

      expect(t.statuses).toEqual([{ state: 'not-available' }])
    })

    it('answers a manual check with checking and then up to date', async () => {
      const t = createHarness()
      t.updater.start(t.host)

      expect(t.updater.checkFromMenu()).toBe(true)
      await untilStatus(t, 'not-available')

      expect(t.statuses).toEqual([
        { state: 'checking', userInitiated: true },
        { state: 'not-available', userInitiated: true }
      ])
    })

    it('shows a failed manual check as an error the user can read', async () => {
      const t = createHarness()
      t.feed.check.mockRejectedValue(new CustomUpdateError('rate-limited', 'paused'))
      t.updater.start(t.host)

      t.updater.checkFromMenu()
      await untilStatus(t, 'error')

      expect(t.current()).toEqual({
        state: 'error',
        message: 'GitHub is limiting update checks right now. Try again later.',
        retryable: true,
        userInitiated: true
      })
    })

    it('leaves local-build and pinned-tag requests to upstream', () => {
      const t = createHarness()
      t.updater.start(t.host)

      expect(t.updater.checkFromMenu({ localBuild: true })).toBe(false)
      expect(t.updater.checkFromMenu({ channel: 'rc', targetTag: 'v1.0.0' })).toBe(false)
      expect(t.feed.check).not.toHaveBeenCalled()
    })
  })

  describe('downloading an update', () => {
    it('reports available, downloading with progress, and ready to restart', async () => {
      const t = createHarness()
      t.feed.check.mockResolvedValue(candidateFor(NEXT))
      t.updater.start(t.host)

      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await untilStatus(t, 'downloaded')

      expect(t.statuses).toEqual([
        {
          state: 'available',
          version: NEXT,
          changelog: {
            release: {
              title: `Orca ${NEXT}`,
              description: `Build ${NEXT} from this fork's releases.`,
              releaseNotesUrl: `https://github.com/balakumardev/orca/releases/tag/v${NEXT}`
            },
            releasesBehind: null
          }
        },
        { state: 'downloading', percent: 0, version: NEXT },
        { state: 'downloading', percent: 40, version: NEXT },
        { state: 'downloading', percent: 100, version: NEXT },
        {
          state: 'downloaded',
          version: NEXT,
          releaseUrl: `https://github.com/balakumardev/orca/releases/tag/v${NEXT}`
        }
      ])
    })

    it('downloads, verifies, then stages, resetting upstream mac state first, and removes the work directory', async () => {
      const t = createHarness()
      t.feed.check.mockResolvedValue(candidateFor(NEXT))
      t.updater.start(t.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await untilStatus(t, 'downloaded')

      expect(t.steps).toEqual(['download', 'verify', 'stage'])
      expect(t.deps.mac.beginDownload).toHaveBeenCalledOnce()
      const download = vi.mocked(t.deps.download).mock.calls[0][0]
      expect(download.expectedSha256).toBe('a'.repeat(64))
      expect(download.url).toContain(`Orca-${NEXT}-arm64-mac.zip`)
      expect(existsSync(dirname(download.destination))).toBe(false)
    })

    it('never installs or quits by itself once the update is ready', async () => {
      const t = createHarness()
      t.feed.check.mockResolvedValue(candidateFor(NEXT))
      t.updater.start(t.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await untilStatus(t, 'downloaded')

      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)

      expect(t.host.performQuitAndInstall).not.toHaveBeenCalled()
      expect(t.nativeUpdater.quitAndInstall).not.toHaveBeenCalled()
      expect(t.feed.check).toHaveBeenCalledTimes(1)
    })

    it('reports a failure of a visible download even for a background check', async () => {
      const t = createHarness({
        download: vi.fn(async () => {
          throw new CustomUpdateError('disk-space', 'full')
        })
      })
      t.feed.check.mockResolvedValue(candidateFor(NEXT))
      t.updater.start(t.host)

      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await untilStatus(t, 'error')

      expect(t.current()).toEqual({
        state: 'error',
        message: 'There is not enough free disk space to download the update.',
        retryable: true,
        version: NEXT
      })
    })

    it('does not call a slow macOS staging a plain failure: the card says it may still finish', async () => {
      const t = createHarness({
        stage: vi.fn(async () => {
          throw new CustomUpdateError(
            'staging-timeout',
            'macOS did not finish preparing the update'
          )
        })
      })
      t.feed.check.mockResolvedValue(candidateFor(NEXT))
      t.updater.start(t.host)

      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await untilStatus(t, 'error')

      expect(t.current()).toEqual({
        state: 'error',
        message:
          'macOS is taking long to prepare the update. If it finishes, the update installs the next time Orca quits.',
        retryable: true,
        version: NEXT
      })
      // A later check is allowed to try again.
      t.updater.checkFromMenu()
      await vi.waitFor(() => expect(t.deps.stage).toHaveBeenCalledTimes(2))
    })

    it('discards a bundle that fails verification, tells the user, and does not retry it in the background', async () => {
      const t = createHarness({
        verify: vi.fn(async () => {
          throw new CustomUpdateError('verification', 'team mismatch')
        })
      })
      offer(t, candidateFor(NEXT))
      t.updater.start(t.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await untilStatus(t, 'error')

      expect(t.current()).toEqual({
        state: 'error',
        message: 'The downloaded update failed verification and was discarded.',
        retryable: false,
        version: NEXT
      })
      expect(t.deps.stage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(CUSTOM_UPDATE_CHECK_INTERVAL_MS)
      expect(t.deps.download).toHaveBeenCalledTimes(1)
      expect(t.feed.check).toHaveBeenLastCalledWith({
        exclude: new Set([NEXT]),
        force: false
      })

      t.updater.download()
      await vi.waitFor(() =>
        expect(t.feed.check).toHaveBeenCalledWith({ exclude: new Set(), force: true })
      )
      await vi.advanceTimersByTimeAsync(0)
      // A person's check does not fetch it again either: the same bytes fail the same way.
      expect(t.deps.download).toHaveBeenCalledTimes(1)
    })

    it('keeps a rejected release out after a restart, because the verdict is kept in the user data folder', async () => {
      const failing = vi.fn(async () => {
        throw new CustomUpdateError('verification', 'team mismatch')
      })
      const first = createHarness({ verify: failing })
      offer(first, candidateFor(NEXT))
      first.updater.start(first.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await untilStatus(first, 'error')
      await vi.waitFor(() =>
        expect(readFileSync(join(userDataDir, 'custom-update-state.json'), 'utf8')).toContain(NEXT)
      )

      const second = createHarness()
      offer(second, candidateFor(NEXT))
      second.updater.start(second.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await second.settle()

      expect(second.deps.download).not.toHaveBeenCalled()
      expect(second.feed.check).toHaveBeenCalled()
    })

    it('starts from nothing when the state file is corrupt', async () => {
      await writeFile(join(userDataDir, 'custom-update-state.json'), '{ not json')
      const t = createHarness()
      offer(t, candidateFor(NEXT))
      t.updater.start(t.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await untilStatus(t, 'downloaded')

      expect(t.deps.download).toHaveBeenCalledTimes(1)
    })

    it('offers an older good release when the newest one fails verification', async () => {
      const t = createHarness({
        verify: vi.fn(async ({ manifest }) => {
          if (manifest.version === '1.4.258+custom.6') {
            throw new CustomUpdateError('verification', 'team mismatch')
          }
          return ['archive-layout']
        })
      })
      offer(t, candidateFor('1.4.258+custom.6'), candidateFor(NEXT))
      t.updater.start(t.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await untilStatus(t, 'downloaded')

      expect(t.current()).toMatchObject({ state: 'downloaded', version: NEXT })
      expect(t.deps.log).toHaveBeenCalledWith(
        'custom_update_candidate_rejected',
        expect.objectContaining({ version: '1.4.258+custom.6' })
      )
    })

    it.each([
      ['an unsigned build', { signed: false, team_id: null, notarized: false }],
      ['a build from another team', { team_id: '6CX3WHS9HZ' }],
      ['a build that is not notarized', { notarized: false }]
    ])('does not even download %s', async (_name, overrides) => {
      const t = createHarness()
      t.feed.check.mockResolvedValue(candidateFor(NEXT, overrides))
      t.updater.start(t.host)

      t.updater.checkFromMenu()
      await untilStatus(t, 'error')

      expect(t.deps.download).not.toHaveBeenCalled()
      expect(t.current()).toMatchObject({ state: 'error', retryable: false, version: NEXT })
    })
  })

  describe('installing a staged update', () => {
    async function stagedHarness(): Promise<Harness> {
      const t = createHarness()
      t.feed.check.mockResolvedValue(candidateFor(NEXT))
      t.updater.start(t.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await untilStatus(t, 'downloaded')
      return t
    }

    it('does nothing for a restart request while no update is staged', () => {
      const t = createHarness()
      t.updater.start(t.host)

      expect(t.updater.quitAndInstall()).toBe(true)
      expect(t.deps.mac.setPreflightInProgress).not.toHaveBeenCalled()
      expect(t.updater.invokeNativeInstall()).toBe(false)
    })

    it('hands a restart request to upstream install execution after the renderer-flush delay', async () => {
      const t = await stagedHarness()

      t.updater.quitAndInstall()
      t.updater.quitAndInstall()
      expect(t.deps.mac.setPreflightInProgress).toHaveBeenCalledWith(true)
      expect(t.host.performQuitAndInstall).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(100)
      expect(t.host.performQuitAndInstall).toHaveBeenCalledOnce()
    })

    it('ignores a restart request while an install is already running', async () => {
      const t = await stagedHarness()
      vi.mocked(t.host.isInstalling).mockReturnValue(true)

      t.updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(1000)

      expect(t.host.performQuitAndInstall).not.toHaveBeenCalled()
    })

    it('swaps through the native updater, once', async () => {
      const t = await stagedHarness()

      expect(t.updater.invokeNativeInstall()).toBe(true)
      expect(t.updater.invokeNativeInstall()).toBe(false)
      expect(t.nativeUpdater.quitAndInstall).toHaveBeenCalledOnce()
    })

    it('returns to staged when the native call throws, so the restart can be retried', async () => {
      const t = await stagedHarness()
      t.nativeUpdater.quitAndInstall.mockImplementationOnce(() => {
        throw new Error('ShipIt missing')
      })

      expect(() => t.updater.invokeNativeInstall()).toThrow('ShipIt missing')
      expect(t.updater.invokeNativeInstall()).toBe(true)
    })

    it('forwards a native error after the swap started to upstream recovery and allows a retry', async () => {
      const t = await stagedHarness()
      t.updater.invokeNativeInstall()
      const failure = new Error('swap refused')

      t.nativeUpdater.emit('error', failure)

      expect(t.host.handleQuitAndInstallFailure).toHaveBeenCalledWith(failure)
      expect(t.updater.invokeNativeInstall()).toBe(true)
    })

    it('does not treat a native error before the swap as an install failure', async () => {
      const t = await stagedHarness()

      t.nativeUpdater.emit('error', new Error('late staging noise'))

      expect(t.host.handleQuitAndInstallFailure).not.toHaveBeenCalled()
    })

    it('shows the ready state again on a manual check instead of checking again', async () => {
      const t = await stagedHarness()
      t.statuses.length = 0

      t.updater.checkFromMenu()
      await vi.advanceTimersByTimeAsync(0)

      expect(t.statuses).toEqual([expect.objectContaining({ state: 'downloaded', version: NEXT })])
      expect(t.feed.check).toHaveBeenCalledTimes(1)
    })
  })

  describe('a download that keeps failing', () => {
    const MINUTE = 60_000
    const stall = (): Error => new CustomUpdateError('network', 'The download stalled')

    const wait = async (minutes: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(minutes * MINUTE)
    }
    const downloads = (t: Harness): number => vi.mocked(t.deps.download).mock.calls.length
    /**
     * Waits (in real time) until `count` cycles have failed and been rescheduled: the work directory is removed with
     * real I/O after each one, which the fake clock cannot wait for, so the next wait must not start before it is done.
     */
    async function failedCycles(t: Harness, count: number): Promise<void> {
      await vi.waitFor(() =>
        expect(
          vi.mocked(t.deps.log).mock.calls.filter(([event]) => event === 'custom_update_failed')
        ).toHaveLength(count)
      )
      await vi.advanceTimersByTimeAsync(0)
    }
    function stalling(...candidates: CustomUpdateCandidate[]): Harness {
      const t = createHarness({ download: vi.fn().mockRejectedValue(stall()) })
      offer(t, ...candidates)
      t.updater.start(t.host)
      return t
    }

    it('waits 15 minutes, then 30, then an hour: a stalling link is not paid for in full every quarter of an hour', async () => {
      const t = stalling(candidateFor(NEXT))
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await failedCycles(t, 1)

      await wait(14)
      expect(downloads(t)).toBe(1)
      await wait(1.5)
      await failedCycles(t, 2)
      expect(downloads(t)).toBe(2)

      await wait(29)
      expect(downloads(t)).toBe(2)
      await wait(1.5)
      await failedCycles(t, 3)
      expect(downloads(t)).toBe(3)

      await wait(59)
      expect(downloads(t)).toBe(3)
      await wait(1.5)
      await failedCycles(t, 4)
      expect(downloads(t)).toBe(4)
    })

    it('never waits more than six hours', async () => {
      const t = stalling(candidateFor(NEXT))
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await failedCycles(t, 1)

      const waits = [15, 30, 60, 120, 240, 360, 360]
      for (const [index, minutes] of waits.entries()) {
        await wait(minutes - 1)
        expect(downloads(t)).toBe(index + 1)
        await wait(2)
        await failedCycles(t, index + 2)
      }

      expect(downloads(t)).toBe(waits.length + 1)
    })

    it('lets a person check at once, and counts that try too', async () => {
      const t = stalling(candidateFor(NEXT))
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await failedCycles(t, 1)

      t.updater.checkFromMenu()
      await failedCycles(t, 2)
      expect(downloads(t)).toBe(2)

      await wait(29)
      expect(downloads(t)).toBe(2)
      await wait(1.5)
      await failedCycles(t, 3)
      expect(downloads(t)).toBe(3)
    })

    it('starts from fifteen minutes again for a newer release', async () => {
      const t = stalling(candidateFor(NEXT))
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      await failedCycles(t, 1)
      await wait(15.5)
      await failedCycles(t, 2)
      offer(t, candidateFor('1.4.258+custom.6'), candidateFor(NEXT))

      await wait(30.5)
      await failedCycles(t, 3)
      expect(vi.mocked(t.deps.download).mock.calls.at(-1)?.[0].url).toContain('custom.6')

      await wait(14)
      expect(downloads(t)).toBe(3)
      await wait(1.5)
      await failedCycles(t, 4)
      expect(downloads(t)).toBe(4)
    })

    it('still looks again after 15 minutes when GitHub could not be reached at all, which costs nothing', async () => {
      const t = createHarness()
      t.feed.check.mockRejectedValue(new CustomUpdateError('network', 'offline'))
      t.updater.start(t.host)
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)

      await wait(16)
      expect(t.feed.check).toHaveBeenCalledTimes(2)
      await wait(16)
      expect(t.feed.check).toHaveBeenCalledTimes(3)
    })
  })

  describe('a release that was set aside for now after repeated failures', () => {
    it('does not turn the error card into "up to date" when a background check skips it', async () => {
      const t = createHarness({
        verify: vi.fn(async () => {
          throw new CustomUpdateError('check-timeout', 'spctl took too long')
        })
      })
      offer(t, candidateFor(NEXT))
      t.updater.start(t.host)
      const logged = (event: string): number =>
        vi.mocked(t.deps.log).mock.calls.filter(([name]) => name === event).length
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
      for (const count of [1, 2, 3]) {
        await vi.waitFor(() => expect(logged('custom_update_failed')).toBe(count))
        await vi.advanceTimersByTimeAsync(CUSTOM_UPDATE_CHECK_INTERVAL_MS * 1.1)
      }

      // The fourth check skips the release that three failures set aside, and finds nothing else.
      await vi.waitFor(() => expect(logged('custom_update_candidate_skipped')).toBe(1))
      await vi.advanceTimersByTimeAsync(0)

      expect(t.current()).toMatchObject({ state: 'error', version: NEXT })
      expect(t.statuses.some((status) => status.state === 'not-available')).toBe(false)
    })
  })

  describe('a disk that is too small for the update', () => {
    it('says how much free space is needed', async () => {
      const t = createHarness({ getFreeBytes: async () => 1_000_000_000 })
      offer(t, candidateFor(NEXT))
      t.updater.start(t.host)

      t.updater.checkFromMenu()
      await untilStatus(t, 'error')

      // 300 MB of zip: its own size, the extracted copy at the most the size rule allows, a gigabyte kept free.
      expect(t.current()).toMatchObject({
        state: 'error',
        message:
          'There is not enough free disk space to download the update. About 2.6 GB of free space is needed.',
        retryable: true
      })
      expect(t.deps.download).not.toHaveBeenCalled()
    })
  })

  describe('what an earlier run left in the updates folder', () => {
    it('is removed at the next launch even when an archive made it undeletable', async () => {
      // A directory nobody may enter, holding a file that carries a deny-delete ACL (macOS only), under a read-only one.
      const leftover = join(userDataDir, 'custom-updates', `${NEXT}-1`, 'extracted', 'Orca.app')
      const closed = join(leftover, 'Contents', 'closed')
      await mkdir(closed, { recursive: true })
      await writeFile(join(closed, 'file'), 'x')
      if (process.platform === 'darwin') {
        execFileSync('/bin/chmod', ['+a', 'everyone deny delete', join(closed, 'file')])
      }
      await chmod(closed, 0o000)
      await chmod(join(leftover, 'Contents'), 0o555)
      const t = createHarness()

      t.updater.start(t.host)

      await vi.waitFor(() => expect(existsSync(join(userDataDir, 'custom-updates'))).toBe(false))
      expect(t.deps.log).not.toHaveBeenCalledWith('custom_update_cleanup_failed', expect.anything())
    })
  })
})
