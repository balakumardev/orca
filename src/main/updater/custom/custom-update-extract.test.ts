import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult, CommandRunner } from './custom-update-commands'
import { FREE_SPACE_MARGIN_BYTES } from './custom-update-disk'
import { diskNeededFor, extractArchive, findExtractedBundle } from './custom-update-extract'
import type { TreeLimit, TreeMeasure } from './custom-update-tree'

describe('the extracted bundle', () => {
  let root: string
  let extractDir: string
  let outside: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-extract-'))
    extractDir = join(root, 'extracted')
    outside = join(root, 'outside')
    await mkdir(extractDir)
    await mkdir(join(outside, 'Evil.app', 'Contents'), { recursive: true })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('accepts a real Orca.app directory', async () => {
    await mkdir(join(extractDir, 'Orca.app', 'Contents'), { recursive: true })

    expect(await findExtractedBundle(extractDir)).toBe(join(extractDir, 'Orca.app'))
  })

  it.each([
    ['another name', 'Other.app'],
    ['a name with extra lines', 'Orca\nTeamIdentifier=KHD36T7C97\n.app'],
    ['a different case', 'orca.app']
  ])('rejects %s', async (_label, name) => {
    await mkdir(join(extractDir, name), { recursive: true })

    await expect(findExtractedBundle(extractDir)).rejects.toMatchObject({ kind: 'verification' })
  })

  it('rejects Orca.app when it is a symlink to a bundle outside the extraction directory', async () => {
    await symlink(join(outside, 'Evil.app'), join(extractDir, 'Orca.app'))

    await expect(findExtractedBundle(extractDir)).rejects.toMatchObject({
      kind: 'verification',
      message: expect.stringContaining('"archive-layout"')
    })
  })

  it('rejects Orca.app when it is a symlink to a directory inside the extraction directory', async () => {
    await mkdir(join(extractDir, 'elsewhere'))
    await symlink(join(extractDir, 'elsewhere'), join(extractDir, 'Orca.app'))

    await expect(findExtractedBundle(extractDir)).rejects.toMatchObject({ kind: 'verification' })
  })

  it('rejects Orca.app when it is a plain file', async () => {
    await writeFile(join(extractDir, 'Orca.app'), 'not a bundle')

    await expect(findExtractedBundle(extractDir)).rejects.toMatchObject({ kind: 'verification' })
  })

  it('rejects an archive with more than the bundle in it', async () => {
    await mkdir(join(extractDir, 'Orca.app'))
    await writeFile(join(extractDir, '.DS_Store'), '')

    await expect(findExtractedBundle(extractDir)).rejects.toMatchObject({ kind: 'verification' })
  })
})

describe('watching an extraction', () => {
  const MARGIN = FREE_SPACE_MARGIN_BYTES
  const ZIPINFO = '3 files, 100 bytes uncompressed, 50 bytes compressed'
  const within = (bytes = 10): TreeMeasure => ({ bytes, entries: 1, exceeded: false })

  /** A runner whose `ditto` takes `ms` to finish and reports whether it was told to stop. */
  function runner(ms: number, stopped: { value: boolean } = { value: false }): CommandRunner {
    return async (file, _args, options) => {
      if (file === '/usr/bin/zipinfo') {
        return { code: 0, stdout: ZIPINFO, stderr: '' }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        options?.signal?.addEventListener(
          'abort',
          () => {
            stopped.value = true
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
      })
      return { code: stopped.value ? 1 : 0, stdout: '', stderr: '' }
    }
  }

  const base = {
    zipPath: '/x.zip',
    destination: '/y',
    zipBytes: 100,
    getFreeBytes: async () => 10 ** 12,
    monitorIntervalMs: 5
  }

  it('never runs two size walks at once, however slow the walk is', async () => {
    let running = 0
    let peak = 0
    let walks = 0

    await extractArchive({
      ...base,
      run: runner(120),
      measure: async () => {
        running += 1
        walks += 1
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 40))
        running -= 1
        return within()
      }
    })

    expect(peak).toBe(1)
    // Several walks happened, so the monitor was not simply starved.
    expect(walks).toBeGreaterThan(2)
  })

  it('treats a tree that cannot be measured as over the cap, and stops ditto', async () => {
    const stopped = { value: false }
    const measure = vi.fn(async (): Promise<TreeMeasure> => {
      throw Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' })
    })

    await expect(
      extractArchive({ ...base, run: runner(5_000, stopped), measure })
    ).rejects.toMatchObject({
      kind: 'verification',
      message: expect.stringContaining('extract-size')
    })
    expect(stopped.value).toBe(true)
  })

  it('fails closed when only the last look cannot measure the tree', async () => {
    let walks = 0
    const measure = async (): Promise<TreeMeasure> => {
      walks += 1
      if (walks > 1) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
      return within()
    }

    await expect(extractArchive({ ...base, run: runner(60), measure })).rejects.toMatchObject({
      kind: 'verification'
    })
  })

  it.each(['EMFILE', 'EIO', 'ENFILE'])(
    'does not call a tree a verdict on the archive when it could not be measured because of %s',
    async (code) => {
      const measure = async (): Promise<TreeMeasure> => {
        throw Object.assign(new Error(code), { code })
      }

      await expect(extractArchive({ ...base, run: runner(60), measure })).rejects.toMatchObject({
        kind: 'check-error',
        retryable: true
      })
    }
  )

  it('starts at exactly what the whole update needs, although the zip itself took whole blocks', async () => {
    // The download starts at `diskNeededFor`; by the time extraction starts the zip has taken its blocks (a whole
    // number of 4 KiB), so the extraction must not ask for more than that left, or the same download repeats.
    const zipBytes = 266_000_001
    const blocks = Math.ceil(zipBytes / 4096) * 4096

    await expect(
      extractArchive({
        ...base,
        zipBytes,
        marginBytes: undefined,
        run: runner(20),
        getFreeBytes: async () => diskNeededFor(zipBytes) - blocks
      })
    ).resolves.toBeUndefined()
  })

  it('keeps the size rule when the disk has plenty of room', async () => {
    const limits: TreeLimit[] = []

    await extractArchive({
      ...base,
      zipBytes: 1000,
      run: runner(30),
      measure: async (_directory, limit) => {
        limits.push(limit)
        return within()
      }
    })

    expect(limits.every((limit) => limit.maxBytes === 4000)).toBe(true)
  })

  it('needs the cap plus a margin of free space before it starts, and says how much there was', async () => {
    const run = vi.fn(runner(1))

    await expect(
      extractArchive({ ...base, run, getFreeBytes: async () => 400 + MARGIN - 1 })
    ).rejects.toMatchObject({ kind: 'disk-space', freeBytes: 400 + MARGIN - 1 })
    expect(run).not.toHaveBeenCalled()
  })

  it('starts when the free space is exactly the cap plus the margin', async () => {
    await expect(
      extractArchive({ ...base, run: runner(20), getFreeBytes: async () => 400 + MARGIN })
    ).resolves.toBeUndefined()
  })

  it('stops ditto as soon as a walk reports the cap passed', async () => {
    const stopped = { value: false }

    await expect(
      extractArchive({
        ...base,
        run: runner(5_000, stopped),
        measure: async () => ({ bytes: 10 ** 9, entries: 1, exceeded: true })
      })
    ).rejects.toMatchObject({ kind: 'verification' })
    expect(stopped.value).toBe(true)
  })

  it('stops the monitor when ditto finishes', async () => {
    let walks = 0
    await extractArchive({
      ...base,
      run: runner(20),
      measure: async () => {
        walks += 1
        return within()
      }
    })
    const after = walks

    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(walks).toBe(after)
  })
})

describe('watching the free space during an extraction', () => {
  const MARGIN = 1000
  const ZIPINFO = '3 files, 100 bytes uncompressed, 50 bytes compressed'
  const within = (bytes = 10): TreeMeasure => ({ bytes, entries: 1, exceeded: false })

  /** A `ditto` that runs for `ms` or until it is told to stop, and ends with `result` when it was not. */
  function dittoRunning(ms: number, result: Partial<CommandResult> = {}): CommandRunner {
    return async (file, _args, options) => {
      if (file === '/usr/bin/zipinfo') {
        return { code: 0, stdout: ZIPINFO, stderr: '' }
      }
      let stopped = false
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        options?.signal?.addEventListener(
          'abort',
          () => {
            stopped = true
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
      })
      return stopped
        ? { code: 1, stdout: '', stderr: '' }
        : { code: 0, stdout: '', stderr: '', ...result }
    }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  const base = {
    zipPath: '/x.zip',
    destination: '/y',
    // The cap is 4 x 100 = 400 bytes; the start needs 400 + 1000.
    zipBytes: 100,
    marginBytes: MARGIN,
    monitorIntervalMs: 1_000,
    freePollIntervalMs: 2,
    measure: async () => within()
  }

  /** Free space that reads 10_000 once and then follows `afterwards`, one value per read. */
  function freeSpace(...afterwards: number[]): () => Promise<number> {
    let reads = 0
    return async () => {
      reads += 1
      return reads === 1 ? 10_000 : (afterwards[Math.min(reads - 2, afterwards.length - 1)] ?? 0)
    }
  }

  it('stops ditto once the free space falls below the margin, whoever wrote, and calls it a disk problem', async () => {
    const run = vi.fn(dittoRunning(5_000))

    await expect(
      extractArchive({ ...base, run, getFreeBytes: freeSpace(9_900, 5_000, 900) })
    ).rejects.toMatchObject({ kind: 'disk-space', freeBytes: 900 })
    // zipinfo, then a ditto that was told to stop.
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not stop ditto when another process used the space: it fell by more than the cap, but our tree is within it', async () => {
    const walks: number[] = []

    await expect(
      extractArchive({
        ...base,
        run: dittoRunning(60, {}),
        getFreeBytes: freeSpace(9_900, 9_000, 8_500),
        measure: async () => {
          walks.push(1)
          return within(300)
        }
      })
    ).resolves.toBeUndefined()
    // The drop was looked into: a walk of our own tree decided it, not the free space alone.
    expect(walks.length).toBeGreaterThan(0)
  })

  it('stops ditto when the drop is its own: free space fell by more than the cap and the tree on disk is past it', async () => {
    const run = vi.fn(dittoRunning(5_000))

    await expect(
      extractArchive({
        ...base,
        run,
        getFreeBytes: freeSpace(9_900, 9_000),
        measure: async () => ({ bytes: 9_000, entries: 1, exceeded: true })
      })
    ).rejects.toMatchObject({
      kind: 'verification',
      message: expect.stringContaining('extract-size')
    })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("calls it the archive's doing when the tree on disk is past the cap as well", async () => {
    await expect(
      extractArchive({
        ...base,
        run: dittoRunning(5_000),
        getFreeBytes: freeSpace(9_000, 900),
        measure: async () => ({ bytes: 9_000, entries: 1, exceeded: true })
      })
    ).rejects.toMatchObject({
      kind: 'verification',
      message: expect.stringContaining('extract-size')
    })
  })

  it('does not stop a free-space read that fails, the walk and the exit code still judge', async () => {
    let reads = 0
    await expect(
      extractArchive({
        ...base,
        run: dittoRunning(30),
        getFreeBytes: async () => {
          reads += 1
          if (reads === 1) {
            return 10_000
          }
          throw new Error('statfs failed')
        }
      })
    ).resolves.toBeUndefined()
    expect(reads).toBeGreaterThan(2)
  })

  it('reads the free space more often than it walks the tree, and never two reads at once', async () => {
    let running = 0
    let peak = 0
    let reads = 0
    let walks = 0

    await extractArchive({
      ...base,
      monitorIntervalMs: 40,
      run: dittoRunning(200),
      getFreeBytes: async () => {
        reads += 1
        running += 1
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 3))
        running -= 1
        return 10_000
      },
      measure: async () => {
        walks += 1
        return within()
      }
    })

    expect(peak).toBe(1)
    expect(reads).toBeGreaterThan(walks * 2)
  })

  it.each([
    ['says there is no space left', { code: 1, stderr: 'ditto: No space left on device' }],
    ['says the quota is used up', { code: 1, stderr: 'ditto: Disc quota exceeded' }],
    [
      'carries that text in a file name of the archive',
      { code: 1, stderr: 'ditto: ENAMETOOLONG No space left on device-xxxx' }
    ]
  ])(
    'a ditto that %s is not taken at its word: the free space decides, and it is fine',
    async (_label, result) => {
      await expect(
        extractArchive({ ...base, run: dittoRunning(10, result), getFreeBytes: freeSpace(10_000) })
      ).rejects.toMatchObject({ kind: 'check-error', retryable: true })
    }
  )

  it('a ditto that fails with the disk nearly full is a disk problem even without a message', async () => {
    vi.useFakeTimers()
    let failDitto = (): void => undefined
    const run: CommandRunner = async (file) => {
      if (file === '/usr/bin/zipinfo') {
        return { code: 0, stdout: ZIPINFO, stderr: '' }
      }
      await new Promise<void>((resolve) => {
        failDitto = resolve
      })
      return { code: 1, stdout: '', stderr: '' }
    }
    // Room for the start and for three polls; every read after that finds the disk nearly full.
    let reads = 0
    const getFreeBytes = async (): Promise<number> => (++reads <= 4 ? 10_000 : 500)

    const outcome = expect(extractArchive({ ...base, run, getFreeBytes })).rejects.toMatchObject({
      kind: 'disk-space',
      freeBytes: 500
    })
    for (let poll = 0; poll < 3; poll += 1) {
      await vi.advanceTimersByTimeAsync(base.freePollIntervalMs)
    }
    failDitto()

    await outcome
  })

  it('a ditto that fails with the disk fine is not a verdict on the archive: it is retried, and only repeated failures count', async () => {
    await expect(
      extractArchive({
        ...base,
        run: dittoRunning(10, { code: 1, stderr: 'ditto: Unknown compression type' }),
        getFreeBytes: async () => 10_000
      })
    ).rejects.toMatchObject({ kind: 'check-error', retryable: true })
  })
})
