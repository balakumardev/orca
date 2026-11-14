import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_STRIKES, runUpdateCycle, type CycleResult } from './custom-update-cycle'
import { CustomUpdateError } from './custom-update-errors'
import { diskNeededFor } from './custom-update-extract'
import { CustomUpdateState, STRIKE_WINDOW_MS, UPDATE_STATE_FILE_NAME } from './custom-update-state'
import { V6, V7, candidate, setup } from './testing/custom-update-cycle-harness'
import { SAMPLE_SHA256, sampleManifest } from './testing/custom-update-sample-release'

const DAY = 24 * 60 * 60_000
const HOUR = 60 * 60_000

describe('what a release is held against, and what only this machine did', () => {
  let root: string
  let file: string
  let clock: number
  const opened: CustomUpdateState[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca cycle retry '))
    file = join(root, UPDATE_STATE_FILE_NAME)
    clock = 1_700_000_000_000
  })
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((state) => state.flush()))
    await rm(root, { recursive: true, force: true })
  })

  /** A state kept in a file, as in the app, so that "after a restart" is a new object that reads the file. */
  const fileState = (): CustomUpdateState => {
    const state = new CustomUpdateState(file, () => clock)
    opened.push(state)
    state.load()
    return state
  }

  const cycles = async (t: ReturnType<typeof setup>, count: number): Promise<CycleResult[]> => {
    const results: CycleResult[] = []
    for (let index = 0; index < count; index += 1) {
      results.push(await runUpdateCycle(t.request))
    }
    return results
  }

  describe('a failure that says nothing certain about the release', () => {
    // Each of these was a final verdict (kind verification) before: a good release was set aside for thirty days
    // because a tool could not start, a file system hiccuped, a proxy changed a byte, or a file changed on disk.
    const sources: [string, Omit<Parameters<typeof setup>[0], 'offers'>][] = [
      [
        'a check that could not run',
        {
          failingVersions: {
            [V7]: new CustomUpdateError('check-error', 'codesign could not start')
          }
        }
      ],
      [
        'an unexpected error of the verification step (EIO, EMFILE)',
        { failingVersions: { [V7]: Object.assign(new Error('EMFILE'), { code: 'EMFILE' }) } }
      ],
      [
        'a tool that ran past its time limit',
        { failingVersions: { [V7]: new CustomUpdateError('check-timeout', 'too slow') } }
      ],
      [
        'a download of the right size whose checksum did not match',
        { downloadFailures: { [V7]: new CustomUpdateError('check-error', 'checksum') } }
      ],
      [
        'a zip that changed on disk right before staging',
        { stagingFailures: { [V7]: new CustomUpdateError('staging', 'changed on disk') } }
      ]
    ]

    it.each(sources)('%s is retried, not written down', async (_label, options) => {
      const state = fileState()
      const t = setup({ offers: [candidate(V7)], state, now: () => clock, ...options })

      const [first] = await cycles(t, 1)
      await state.flush()

      expect(first).toMatchObject({ outcome: 'failed', failure: { retryable: true } })
      expect(t.rejected.size).toBe(0)
      expect(existsSync(file)).toBe(false)
    })

    it.each(sources)(
      '%s: a person asking right after is not told they are up to date',
      async (_label, options) => {
        const state = fileState()
        const t = setup({ offers: [candidate(V7)], state, now: () => clock, ...options })
        await cycles(t, 1)

        t.request.userInitiated = true
        const [again] = await cycles(t, 1)

        expect(again).toMatchObject({ outcome: 'failed' })
        expect(t.downloaded).toHaveLength(2)
      }
    )

    it.each(sources)('%s: after a restart the release is tried again', async (_label, options) => {
      const t = setup({ offers: [candidate(V7)], state: fileState(), now: () => clock, ...options })
      await cycles(t, 1)
      await t.state.flush()

      const restarted = setup({ offers: [candidate(V7)], state: fileState(), now: () => clock })
      const [result] = await cycles(restarted, 1)

      expect(result).toMatchObject({ outcome: 'staged' })
      expect(restarted.downloaded).toHaveLength(1)
    })
  })

  describe('a manifest that claims an untrusted build', () => {
    it('is looked at again every check, so a corrected manifest for the same release is picked up at once', async () => {
      const state = fileState()
      const wrong = setup({
        offers: [candidate(V7, { notarized: false })],
        state,
        now: () => clock
      })
      expect(await runUpdateCycle(wrong.request)).toMatchObject({ outcome: 'failed' })
      await state.flush()
      expect(existsSync(file)).toBe(false)

      // The same version, the same zip bytes (the sha256 the sample carries), a manifest that is now right.
      const corrected = setup({ offers: [candidate(V7)], state, now: () => clock })
      const result = await runUpdateCycle(corrected.request)

      expect(sampleManifest(V7).sha256).toBe(SAMPLE_SHA256)
      expect(result).toMatchObject({ outcome: 'staged' })
      expect(corrected.downloaded).toHaveLength(1)
    })
  })

  describe('failures that prove nothing alone, repeated', () => {
    const timeout = (): CustomUpdateError => new CustomUpdateError('check-timeout', 'too slow')
    const stagingFailure = (): CustomUpdateError =>
      new CustomUpdateError('staging', 'macOS said no')

    it(`set the release aside after ${MAX_STRIKES} in a day, in memory only, and the next older release is offered`, async () => {
      const state = fileState()
      const t = setup({
        offers: [candidate(V7), candidate(V6)],
        failingVersions: { [V7]: timeout() },
        state,
        now: () => clock
      })

      const results = await cycles(t, MAX_STRIKES)

      expect(results.slice(0, -1).every((r) => r.outcome === 'failed')).toBe(true)
      expect(results.at(-1)).toMatchObject({ outcome: 'staged' })
      expect(t.rejected.has(V7)).toBe(true)
      await state.flush()
      expect(existsSync(file)).toBe(false)
    })

    it('do not add up when they are weeks apart', async () => {
      const t = setup({
        offers: [candidate(V7)],
        failingVersions: { [V7]: timeout() },
        state: fileState(),
        now: () => clock
      })

      for (let index = 0; index < MAX_STRIKES + 2; index += 1) {
        await cycles(t, 1)
        clock += 8 * DAY
      }

      expect(t.rejected.size).toBe(0)
      expect(t.downloaded).toHaveLength(MAX_STRIKES + 2)
    })

    it('do not add up when they are just over a day apart, but do when each is just inside it', async () => {
      const t = setup({
        offers: [candidate(V7)],
        failingVersions: { [V7]: timeout() },
        state: fileState(),
        now: () => clock
      })

      await cycles(t, 1)
      clock += STRIKE_WINDOW_MS / 2
      await cycles(t, 1)
      clock += STRIKE_WINDOW_MS / 2 - 1
      await cycles(t, 1)

      expect(t.rejected.has(V7)).toBe(true)
    })

    it('are forgiven by a clean pass of the checks, even when macOS then refuses to stage it', async () => {
      const failing: Record<string, unknown> = { [V7]: timeout() }
      const t = setup({
        offers: [candidate(V7)],
        failingVersions: failing,
        stagingFailures: { [V7]: stagingFailure() },
        state: fileState(),
        now: () => clock
      })
      await cycles(t, MAX_STRIKES - 1)

      // The tool works now: verification passes, staging fails (one staging strike); then the tool fails again.
      delete failing[V7]
      await cycles(t, 1)
      failing[V7] = timeout()
      await cycles(t, 1)

      expect(t.rejected.size).toBe(0)
    })

    it('are counted per stage: forgiving the checks leaves the staging failures to stand on their own', async () => {
      const failing: Record<string, unknown> = { [V7]: timeout() }
      const t = setup({
        offers: [candidate(V7)],
        failingVersions: failing,
        stagingFailures: { [V7]: stagingFailure() },
        state: fileState(),
        now: () => clock
      })
      // The checks pass once, and macOS refuses to stage the release.
      const checksPassOnce = async (): Promise<void> => {
        delete failing[V7]
        await cycles(t, 1)
        failing[V7] = timeout()
      }

      await cycles(t, 2)
      await checksPassOnce()
      // Two more timeouts: two check strikes (the first two were forgiven) and one staging strike are not three.
      await cycles(t, 2)
      expect(t.rejected.size).toBe(0)
      expect(t.downloaded).toHaveLength(5)

      await checksPassOnce()
      expect(t.rejected.size).toBe(0)
      expect(t.downloaded).toHaveLength(6)

      // The third staging failure is the third time macOS refused it, whatever else happened in between.
      await checksPassOnce()
      expect(t.rejected.has(V7)).toBe(true)
      expect(t.downloaded).toHaveLength(7)
    })

    it('of staging are not forgiven by passing the checks again: macOS refusing every time still ends', async () => {
      const t = setup({
        offers: [candidate(V7)],
        stagingFailures: { [V7]: stagingFailure() },
        state: fileState(),
        now: () => clock
      })

      await cycles(t, MAX_STRIKES)

      expect(t.rejected.has(V7)).toBe(true)
      expect(t.downloaded).toHaveLength(MAX_STRIKES)
    })

    it('of staging are not written down: a restart (what moving the app out of a disk image means) tries again', async () => {
      const state = fileState()
      const t = setup({
        offers: [candidate(V7)],
        stagingFailures: { [V7]: stagingFailure() },
        state,
        now: () => clock
      })
      await cycles(t, MAX_STRIKES)
      await state.flush()

      expect(existsSync(file)).toBe(false)
      const restarted = setup({ offers: [candidate(V7)], state: fileState(), now: () => clock })
      expect(await runUpdateCycle(restarted.request)).toMatchObject({ outcome: 'staged' })
    })

    it('set the release aside for a day only: it is tried again, and needs three new failures to be set aside again', async () => {
      const t = setup({
        offers: [candidate(V7)],
        failingVersions: { [V7]: timeout() },
        state: fileState(),
        now: () => clock
      })
      await cycles(t, MAX_STRIKES)

      clock += HOUR
      expect(await runUpdateCycle(t.request)).toEqual({ outcome: 'none', heldBack: true })
      expect(t.downloaded).toHaveLength(MAX_STRIKES)

      clock += STRIKE_WINDOW_MS
      const again = await cycles(t, MAX_STRIKES)

      expect(again.every((result) => result.outcome === 'failed')).toBe(true)
      expect(t.downloaded).toHaveLength(2 * MAX_STRIKES)
      expect(await runUpdateCycle(t.request)).toEqual({ outcome: 'none', heldBack: true })
      expect(t.downloaded).toHaveLength(2 * MAX_STRIKES)
    })

    it('are set aside for background checks only: a person asking for an update gets another try', async () => {
      const t = setup({
        offers: [candidate(V7)],
        failingVersions: { [V7]: timeout() },
        state: fileState(),
        now: () => clock
      })
      await cycles(t, MAX_STRIKES)
      // Nothing is offered, but not because there is nothing new: the caller must not call that "up to date".
      expect(await runUpdateCycle(t.request)).toEqual({ outcome: 'none', heldBack: true })

      t.request.userInitiated = true
      const manual = await runUpdateCycle(t.request)

      expect(manual).toMatchObject({ outcome: 'failed', failure: { kind: 'check-timeout' } })
      expect(t.downloaded).toHaveLength(MAX_STRIKES + 1)
    })
  })

  describe('a release that needs more free space than there is', () => {
    const needed = diskNeededFor(sampleManifest(V7).size as number)

    it('is not downloaded, and the failure is not a download that was shown', async () => {
      const t = setup({ offers: [candidate(V7)], free: () => needed - 1 })

      const result = await runUpdateCycle(t.request)

      expect(result).toMatchObject({
        outcome: 'failed',
        downloadShown: false,
        failure: { kind: 'disk-space', retryable: true, freeBytes: needed - 1 }
      })
      expect(t.downloaded).toHaveLength(0)
    })

    it('is downloaded at exactly the figure the download itself asks for, with no growth needed beyond it', async () => {
      let free = needed - 1
      const t = setup({ offers: [candidate(V7)], free: () => free })
      await runUpdateCycle(t.request)

      free = needed
      const result = await runUpdateCycle(t.request)

      expect(result).toMatchObject({ outcome: 'staged' })
      expect(t.downloaded).toHaveLength(1)
    })

    it('is held against nothing when a shortage seen mid-way turns out not to be one: the disk has the room the next time', async () => {
      // A shortage that another program caused for a moment: the disk has plenty by the time the check is over.
      const t = setup({
        offers: [candidate(V7)],
        failingVersions: {
          [V7]: new CustomUpdateError('disk-space', 'no room', { freeBytes: 1_000 })
        },
        free: () => needed * 3
      })
      await cycles(t, 1)

      t.deps.verify = vi.fn(async () => ['archive-layout'])
      const [again] = await cycles(t, 1)

      expect(again).toMatchObject({ outcome: 'staged' })
      expect(t.downloaded).toHaveLength(2)
    })

    it('does not stop a check whose free space cannot be read', async () => {
      const t = setup({ offers: [candidate(V7)] })
      t.deps.getFreeBytes = async () => {
        throw new Error('statfs failed')
      }

      expect(await runUpdateCycle(t.request)).toMatchObject({ outcome: 'staged' })
    })
  })

  it('keeps retrying a download that failed for an unclassified reason', async () => {
    const t = setup({ offers: [candidate(V7)] })
    t.deps.download = vi.fn().mockRejectedValue(new Error('socket hang up'))

    const result = await runUpdateCycle(t.request)

    expect(result).toMatchObject({ outcome: 'failed', failure: { kind: 'download' } })
    expect(t.rejected.size).toBe(0)
  })
})
