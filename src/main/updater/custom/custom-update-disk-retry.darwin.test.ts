import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runUpdateCycle, type CycleRequest } from './custom-update-cycle'
import { downloadUpdateZip } from './custom-update-download'
import { diskNeededFor } from './custom-update-extract'
import type { CustomUpdateCandidate } from './custom-update-feed'
import { parseCustomUpdateManifest } from './custom-update-manifest'
import { CustomUpdateState } from './custom-update-state'
import { parseCustomBuildVersion } from './custom-update-version'
import type { CustomUpdaterDeps } from './custom-updater-types'
import { sampleManifest } from './testing/custom-update-sample-release'

const run = promisify(execFile)
const MIB = 1024 * 1024
const VERSION = '1.4.258+custom.7'
const PAYLOAD = Buffer.from('orca update payload '.repeat(50))

// Real hdiutil, a real mounted volume and real statfs. They exist only on macOS.
const suite = process.platform === 'darwin' ? describe : describe.skip

const freeOf = async (directory: string): Promise<number> => {
  const stats = await statfs(directory)
  return stats.bavail * stats.bsize
}

function release(): CustomUpdateCandidate {
  const parsed = parseCustomUpdateManifest(
    sampleManifest(VERSION, {
      size: PAYLOAD.length,
      sha256: createHash('sha256').update(PAYLOAD).digest('hex')
    }),
    `v${VERSION}`
  )
  const build = parseCustomBuildVersion(VERSION)
  if (!parsed.ok || !build) {
    throw new Error('bad release fixture')
  }
  return {
    manifest: parsed.manifest,
    build,
    zipUrl: `https://github.com/balakumardev/orca/releases/download/v${VERSION}/${parsed.manifest.asset}`,
    releaseUrl: `https://github.com/balakumardev/orca/releases/tag/v${VERSION}`
  }
}

suite('a release that does not fit on a real volume (skipped when not on macOS)', () => {
  let root: string
  let volume: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca disk retry '))
    volume = join(root, 'volume')
    await mkdir(volume)
    // A volume of its own, so the free space moves only when this test writes or deletes: 2 GiB, grown on demand.
    await run('/usr/bin/hdiutil', [
      'create',
      '-size',
      '2048m',
      '-type',
      'SPARSE',
      '-fs',
      'HFS+',
      '-volname',
      'orcaretry',
      '-ov',
      join(root, 'volume.sparseimage')
    ])
    await run('/usr/bin/hdiutil', [
      'attach',
      '-nobrowse',
      '-mountpoint',
      volume,
      join(root, 'volume.sparseimage')
    ])
  }, 120_000)
  afterAll(async () => {
    await run('/usr/bin/hdiutil', ['detach', '-force', volume]).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })

  async function fill(name: string, mebibytes: number): Promise<void> {
    await run('/bin/dd', [
      'if=/dev/zero',
      `of=${join(volume, name)}`,
      'bs=1048576',
      `count=${mebibytes}`
    ])
  }

  it('is held while the real free space is below what the update needs, and goes ahead the moment it is not', async () => {
    const fetchBody = vi.fn(async () => new Response(PAYLOAD, { status: 200 }))
    const state = new CustomUpdateState(join(root, 'custom-update-state.json'), Date.now)
    state.load()
    const deps = {
      now: Date.now,
      log: vi.fn(),
      mac: { beginDownload: vi.fn() },
      // The real download, so its own look at the free space (freeBytesOf, no stub) is what refuses.
      download: downloadUpdateZip,
      fetch: fetchBody,
      verify: vi.fn(async () => ['archive-layout']),
      stage: vi.fn(async () => undefined),
      nativeUpdater: () => ({}),
      prepareStaging: () => null
    } as unknown as CustomUpdaterDeps
    const request: CycleRequest = {
      feed: { check: vi.fn(async () => release()), retryDelayMs: 0 },
      host: { sendStatus: vi.fn() },
      deps,
      state,
      userInitiated: false,
      updatesRoot: join(volume, 'custom-updates'),
      onDownloadStart: vi.fn(async () => undefined)
    }
    const { manifest } = release()
    const needed = diskNeededFor(manifest.size)

    await fill('a.bin', 500)
    await fill('b.bin', 800)
    const freeWhenFull = await freeOf(volume)
    const first = await runUpdateCycle(request)

    // 1. It does not fit: the cycle refuses before it fetches anything, and says how much there is and how much it needs.
    expect(freeWhenFull).toBeLessThan(needed)
    expect(first).toMatchObject({
      outcome: 'failed',
      downloadShown: false,
      failure: { kind: 'disk-space', neededBytes: needed }
    })
    expect(fetchBody).not.toHaveBeenCalled()
    const recorded = first.outcome === 'failed' ? (first.failure.freeBytes ?? 0) : 0
    expect(Math.abs(recorded - freeWhenFull)).toBeLessThan(64 * MIB)

    // 2. Nothing changed: the second check asks the disk again and is refused the same way.
    expect(await runUpdateCycle(request)).toMatchObject({ failure: { kind: 'disk-space' } })
    expect(fetchBody).not.toHaveBeenCalled()

    // 3. 500 MiB come free and the disk now holds what the update needs: no growth beyond that is waited for.
    await rm(join(volume, 'a.bin'))
    const freeAfterSome = await freeOf(volume)
    expect(freeAfterSome).toBeGreaterThanOrEqual(needed)
    expect(await runUpdateCycle(request)).toMatchObject({ outcome: 'staged' })
    expect(fetchBody).toHaveBeenCalledTimes(1)
    expect(state.isRejected(VERSION, manifest.sha256)).toBe(false)

    await writeFile(join(root, 'done'), 'x')
  }, 180_000)
})
