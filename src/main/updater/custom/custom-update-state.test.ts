import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CustomUpdateState,
  STRIKE_WINDOW_MS,
  UPDATE_STATE_FILE_NAME,
  UPDATE_STATE_TTL_MS
} from './custom-update-state'

const V7 = '1.4.258+custom.7'
const V6 = '1.4.258+custom.6'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const DAY = 24 * 60 * 60_000

describe('what the updater remembers about releases', () => {
  let root: string
  let file: string
  let clock: number

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca update state '))
    file = join(root, UPDATE_STATE_FILE_NAME)
    clock = 1_700_000_000_000
  })
  afterEach(async () => {
    // A write may still be on its way; let it land before the directory goes.
    await Promise.all(opened.splice(0).map((state) => state.flush()))
    await rm(root, { recursive: true, force: true })
  })

  const opened: CustomUpdateState[] = []
  const open = (path: string | null = file): CustomUpdateState => {
    const state = new CustomUpdateState(path, () => clock)
    opened.push(state)
    state.load()
    return state
  }

  describe('a verdict on the release itself', () => {
    it('is remembered across a restart, by version and by checksum', async () => {
      const first = open()
      first.reject(V7, SHA_A, 'verification')
      await first.flush()

      const second = open()

      expect(second.isRejected(V7, SHA_A)).toBe(true)
      // The same version with other bytes is another release: a fixed re-upload gets its chance.
      expect(second.isRejected(V7, SHA_B)).toBe(false)
      expect(second.isRejected(V6, SHA_A)).toBe(false)
    })

    it('is no longer honoured after thirty days', async () => {
      const state = open()
      state.reject(V7, SHA_A, 'verification')
      await state.flush()

      clock += UPDATE_STATE_TTL_MS - DAY
      expect(open().isRejected(V7, SHA_A)).toBe(true)
      clock += DAY
      expect(open().isRejected(V7, SHA_A)).toBe(false)
    })

    it('is the only thing written to the file: a failure that is not a verdict is set aside in memory', async () => {
      const state = open()
      state.reject(V7, SHA_A, 'check-error')
      state.reject(V6, SHA_B, 'staging')
      await state.flush()

      expect(state.isRejected(V7, SHA_A)).toBe(true)
      expect(existsSync(file)).toBe(false)
      expect(open().isRejected(V7, SHA_A)).toBe(false)
    })
  })

  describe('failures that prove nothing alone', () => {
    it('are counted per release and per stage, and only for a day', async () => {
      const state = open()

      expect(state.addStrike(V7, SHA_A, 'check')).toBe(1)
      expect(state.addStrike(V7, SHA_A, 'staging')).toBe(1)
      expect(state.addStrike(V7, SHA_B, 'check')).toBe(1)
      clock += STRIKE_WINDOW_MS - 1
      expect(state.addStrike(V7, SHA_A, 'check')).toBe(2)
      // The two oldest are now a day old; a failure weeks later does not add up with them.
      clock += 2
      expect(state.addStrike(V7, SHA_A, 'check')).toBe(2)
      clock += 20 * DAY
      expect(state.addStrike(V7, SHA_A, 'check')).toBe(1)
    })

    it('of one stage do not add up with those of the other: the limit is for failing the same way', () => {
      const state = open(null)

      expect([1, 2].map(() => state.addStrike(V7, SHA_A, 'check'))).toEqual([1, 2])
      expect([1, 2].map(() => state.addStrike(V7, SHA_A, 'staging'))).toEqual([1, 2])
      expect(state.addStrike(V7, SHA_A, 'check')).toBe(3)
    })

    it('are never written down, so a restart starts from none', async () => {
      const state = open()
      state.addStrike(V7, SHA_A, 'staging')
      state.addStrike(V7, SHA_A, 'check')
      await state.flush()

      expect(existsSync(file)).toBe(false)
      expect(open().addStrike(V7, SHA_A, 'check')).toBe(1)
    })

    it('end per stage: a clean pass of the checks does not forgive a staging failure', () => {
      const state = open(null)
      state.addStrike(V7, SHA_A, 'check')
      state.addStrike(V7, SHA_A, 'check')
      state.addStrike(V7, SHA_A, 'staging')

      state.resetStrikes(V7, SHA_A, 'check')

      expect(state.addStrike(V7, SHA_A, 'staging')).toBe(2)
      expect(state.addStrike(V7, SHA_A, 'check')).toBe(1)
    })

    it('do not count when they are dated ahead of the clock', () => {
      const state = open(null)
      clock += 10 * DAY
      state.addStrike(V7, SHA_A, 'check')
      clock -= 10 * DAY

      expect(state.addStrike(V7, SHA_A, 'check')).toBe(1)
    })
  })

  describe('a release set aside after repeated failures', () => {
    it('is skipped by background checks, but not by a person asking, and is forgotten by a restart', async () => {
      const state = open()
      state.setAsideForNow(V7, SHA_A)
      await state.flush()

      expect(state.isRejected(V7, SHA_A)).toBe(true)
      expect(state.isRejected(V7, SHA_A, false)).toBe(false)
      expect(state.isRejected(V7, SHA_B)).toBe(false)
      expect(existsSync(file)).toBe(false)
      expect(open().isRejected(V7, SHA_A)).toBe(false)
    })

    it('is tried again after the day its strikes counted for, not before', () => {
      const state = open(null)
      state.setAsideForNow(V7, SHA_A)

      clock += STRIKE_WINDOW_MS - 1
      expect(state.isRejected(V7, SHA_A)).toBe(true)
      clock += 1
      expect(state.isRejected(V7, SHA_A)).toBe(false)
    })

    it('is set aside again from the moment of the last time, not of the first', () => {
      const state = open(null)
      state.setAsideForNow(V7, SHA_A)
      clock += STRIKE_WINDOW_MS - 1
      state.setAsideForNow(V7, SHA_A)

      clock += STRIKE_WINDOW_MS - 1
      expect(state.isRejected(V7, SHA_A)).toBe(true)
    })

    it('is not held when it is dated ahead of the clock, which cannot age it', () => {
      const state = open(null)
      clock += 10 * DAY
      state.setAsideForNow(V7, SHA_A)
      clock -= 10 * DAY

      expect(state.isRejected(V7, SHA_A)).toBe(false)
    })

    it('does not make a persisted verdict optional for a person asking', async () => {
      const state = open()
      state.reject(V7, SHA_A, 'verification')

      expect(state.isRejected(V7, SHA_A, false)).toBe(true)
    })
  })

  it('forgets everything about a release once it was staged', async () => {
    const state = open()
    state.reject(V7, SHA_A, 'verification')
    state.addStrike(V7, SHA_A, 'check')
    state.setAsideForNow(V7, SHA_A)

    state.clear(V7, SHA_A)
    await state.flush()

    const reopened = open()
    expect(state.isRejected(V7, SHA_A)).toBe(false)
    expect(reopened.isRejected(V7, SHA_A)).toBe(false)
    expect(state.addStrike(V7, SHA_A, 'check')).toBe(1)
  })

  describe('the file on disk', () => {
    const good = (): Record<string, unknown> => ({
      version: V7,
      sha256: SHA_A,
      at: clock,
      kind: 'verification'
    })

    it('is written beside itself and renamed, so no temporary file is left', async () => {
      const state = open()
      state.reject(V7, SHA_A, 'verification')
      state.reject(V6, SHA_B, 'verification')
      await state.flush()

      expect(await readdir(root)).toEqual([UPDATE_STATE_FILE_NAME])
      expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600')
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 2 })
    })

    it.each([
      ['not JSON', '{nope'],
      ['JSON of another shape', '[1, 2, 3]'],
      [
        'an older format, whose rejects may have been transient failures',
        JSON.stringify({
          version: 1,
          records: [
            {
              version: V7,
              sha256: SHA_A,
              at: 1_700_000_000_000,
              rejected: true,
              strikes: 0,
              diskFreeBytes: null
            }
          ]
        })
      ],
      ['records that are not a list', JSON.stringify({ version: 2, records: 'x' })]
    ])('is ignored when it is %s, and the next write replaces it', async (_label, content) => {
      await writeFile(file, content)

      const state = open()
      expect(state.isRejected(V7, SHA_A)).toBe(false)
      state.reject(V7, SHA_A, 'verification')
      await state.flush()

      expect(open().isRejected(V7, SHA_A)).toBe(true)
    })

    it('is ignored when it is far larger than a state file can be, without reading all of it', async () => {
      await writeFile(
        file,
        JSON.stringify({ version: 2, records: [good()], padding: 'x'.repeat(200 * 1024) })
      )

      expect(open().isRejected(V7, SHA_A)).toBe(false)
    })

    it('keeps the well formed records and drops the others, including any kind that is not a verdict', async () => {
      const bad = [
        { ...good(), version: 'v7' },
        { ...good(), sha256: 'not a digest' },
        { ...good(), at: -1 },
        { ...good(), at: 'now' },
        { ...good(), kind: 'staging' },
        { ...good(), kind: 7 },
        null,
        'text',
        {}
      ]
      await writeFile(file, JSON.stringify({ version: 2, records: [...bad, good()] }))

      const state = open()

      expect(state.isRejected(V7, SHA_A)).toBe(true)
      // The next change rewrites the file from what was kept.
      state.reject(V6, SHA_B, 'verification')
      await state.flush()
      const stored: { version: string }[] = JSON.parse(await readFile(file, 'utf8')).records
      expect(stored.map((record) => record.version).sort()).toEqual([V6, V7])
    })

    it('keeps at most 64 records and drops the oldest first', async () => {
      const state = open()
      for (let index = 0; index < 70; index += 1) {
        clock += 1000
        state.reject(`1.4.258+custom.${index + 10}`, SHA_A, 'verification')
      }
      await state.flush()

      const reopened = open()

      expect(reopened.isRejected('1.4.258+custom.10', SHA_A)).toBe(false)
      expect(reopened.isRejected('1.4.258+custom.15', SHA_A)).toBe(false)
      expect(reopened.isRejected('1.4.258+custom.16', SHA_A)).toBe(true)
      expect(reopened.isRejected('1.4.258+custom.79', SHA_A)).toBe(true)
    })
  })

  describe('a state that cannot be written', () => {
    it('keeps working in memory, and says once per failed write', async () => {
      let failures = 0
      const state = new CustomUpdateState(
        join(root, 'missing-dir', 'state.json'),
        () => clock,
        () => {
          failures += 1
        }
      )

      state.reject(V7, SHA_A, 'verification')
      await state.flush()

      expect(state.isRejected(V7, SHA_A)).toBe(true)
      expect(failures).toBe(1)
    })

    it('is in memory only without a file', async () => {
      const state = open(null)

      state.reject(V7, SHA_A, 'verification')
      await state.flush()

      expect(state.isRejected(V7, SHA_A)).toBe(true)
      expect(await readdir(root)).toEqual([])
    })
  })
})
