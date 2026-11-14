import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CustomUpdateState, UPDATE_STATE_FILE_NAME } from './custom-update-state'

const V7 = '1.4.258+custom.7'
const V6 = '1.4.258+custom.6'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const DAY = 24 * 60 * 60_000
const posix = process.platform === 'win32' ? describe.skip : describe

posix('a state file that is not a plain file, and a clock that is wrong', () => {
  let root: string
  let file: string
  let clock: number
  const opened: CustomUpdateState[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca update state robustness '))
    file = join(root, UPDATE_STATE_FILE_NAME)
    clock = 1_700_000_000_000
  })
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((state) => state.flush()))
    await rm(root, { recursive: true, force: true })
  })

  const open = (now: () => number = () => clock): CustomUpdateState => {
    const state = new CustomUpdateState(file, now)
    opened.push(state)
    state.load()
    return state
  }

  /** Writes one verdict as a state file of the current format, as it would be written when the clock read `at`. */
  async function writeVerdictDatedAt(at: number): Promise<string> {
    const writer = open(() => at)
    writer.reject(V7, SHA_A, 'verification')
    await writer.flush()
    return readFile(file, 'utf8')
  }

  describe('the path holds something else', () => {
    it('does not wait for a writer when it is a FIFO, which would hold the start of the app', async () => {
      expect(spawnSync('/usr/bin/mkfifo', [file]).status).toBe(0)
      // Opening a FIFO to read blocks until someone opens it to write: this helper does, after three seconds, and
      // then lets go. The old code waited for it; load() runs synchronously from start(), so that was three seconds
      // (or for ever) in which the app could not start.
      const helper = spawn('/bin/sh', ['-c', 'sleep 3; : > "$0"', file], { stdio: 'ignore' })

      const started = Date.now()
      const state = open()
      const elapsed = Date.now() - started
      helper.kill('SIGKILL')

      expect(elapsed).toBeLessThan(1000)
      expect(state.isRejected(V7, SHA_A)).toBe(false)
    }, 20_000)

    it('does not read through a link, whatever it points at', async () => {
      const elsewhere = join(root, 'elsewhere.json')
      await writeFile(elsewhere, await writeVerdictDatedAt(clock))
      await rm(file)
      await symlink(elsewhere, file)

      expect(open().isRejected(V7, SHA_A)).toBe(false)
    })

    it('treats a link to a device as an empty state', async () => {
      await symlink('/dev/zero', file)

      expect(open().isRejected(V7, SHA_A)).toBe(false)
    })

    it('replaces a link with its own file when it writes, and writes nothing through it', async () => {
      const elsewhere = join(root, 'elsewhere.json')
      await writeFile(elsewhere, 'untouched')
      await symlink(elsewhere, file)

      const state = open()
      state.reject(V7, SHA_A, 'verification')
      await state.flush()

      expect(open().isRejected(V7, SHA_A)).toBe(true)
      expect(await readFile(elsewhere, 'utf8')).toBe('untouched')
    })
  })

  describe('the clock', () => {
    it('does not honour a record dated more than a day in the future, which would outlive its thirty days', async () => {
      await writeVerdictDatedAt(clock + 29 * DAY)

      expect(open().isRejected(V7, SHA_A)).toBe(false)
    })

    it('honours a record dated a few hours ahead, as two clocks that disagree slightly will make one', async () => {
      await writeVerdictDatedAt(clock + 3 * 60 * 60_000)

      expect(open().isRejected(V7, SHA_A)).toBe(true)
    })

    it.each([
      ['400 days ahead', 400 * DAY],
      ['400 days behind', -400 * DAY]
    ])(
      'does not lose what it remembers when the clock jumps %s and one write happens',
      async (_label, offset) => {
        const first = open()
        first.reject(V7, SHA_A, 'verification')
        await first.flush()

        // The clock is wrong for a while: another release is judged in that time.
        let now = clock
        const running = open(() => now)
        now = clock + offset
        running.reject(V6, SHA_B, 'verification')
        await running.flush()

        // Once the clock is right again, the first verdict is still there.
        now = clock
        expect(open().isRejected(V7, SHA_A)).toBe(true)
      }
    )

    it('does not delete what a start with a clock 400 days ahead could not use, so the next start can', async () => {
      const first = open()
      first.reject(V7, SHA_A, 'verification')
      await first.flush()

      const wrong = open(() => clock + 400 * DAY)
      expect(wrong.isRejected(V7, SHA_A)).toBe(false)
      wrong.reject(V6, SHA_B, 'verification')
      await wrong.flush()

      expect(open().isRejected(V7, SHA_A)).toBe(true)
    })
  })
})
