import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSystemCommand } from './custom-update-commands'
import { freeBytesOf } from './custom-update-disk'
import { CustomUpdateError } from './custom-update-errors'
import { extractArchive } from './custom-update-extract'
import { measureTree, removeTree } from './custom-update-tree'
import { parseCustomUpdateManifest } from './custom-update-manifest'
import { verifyUpdateBundle } from './custom-update-verifier'
import { sampleManifest } from './testing/custom-update-sample-release'
import { buildZip } from './testing/custom-update-zip-builder'

const run = promisify(execFile)
const MIB = 1024 * 1024
const NO_LIMIT = { maxBytes: Number.MAX_SAFE_INTEGER, maxEntries: Number.MAX_SAFE_INTEGER }

// These tests drive the real ditto, chmod, hdiutil and statfs. They exist only on macOS. (The disk-space rule on a real volume is in custom-update-disk-retry.darwin.test.ts.)
const suite = process.platform === 'darwin' ? describe : describe.skip

async function aclOf(path: string): Promise<string> {
  return (await run('/bin/ls', ['-lde', path])).stdout
}

suite('hostile archives on a real disk (skipped when not on macOS)', () => {
  let root: string
  let counter = 0

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca hostile disk '))
  })
  afterAll(async () => {
    // A failing test may leave an ACL-protected tree behind; removeTree strips it so the scratch directory can go.
    await removeTree(root)
  })

  async function freshDirectory(name: string): Promise<string> {
    counter += 1
    const directory = join(root, `${name}-${counter}`)
    await mkdir(directory)
    return directory
  }

  /** A zip of Orca.app/Contents/rand.bin whose file carries a deny-delete ACL, packed the way package-release.sh does. */
  async function aclZip(): Promise<string> {
    const source = await freshDirectory('acl-source')
    const contents = join(source, 'Orca.app', 'Contents')
    await mkdir(contents, { recursive: true })
    // Random bytes do not compress, so the zip is about as big as what it holds and the size rule has no reason to object.
    await writeFile(join(contents, 'rand.bin'), randomBytes(MIB))
    await run('/bin/chmod', ['+a', 'everyone deny delete', join(contents, 'rand.bin')])
    const zipPath = join(source, 'acl.zip')
    await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(source, 'Orca.app'), zipPath])
    return zipPath
  }

  describe('an ACL that forbids deleting, carried in the zip (the reviewer reproduced it)', () => {
    it('survives ditto, so the premise holds', async () => {
      const destination = await freshDirectory('acl-extract')
      await run('/usr/bin/ditto', ['-x', '-k', await aclZip(), destination])

      expect(await aclOf(join(destination, 'Orca.app', 'Contents', 'rand.bin'))).toContain(
        'deny delete'
      )
      await removeTree(destination)
    })

    it('is still removed by removeTree', async () => {
      const destination = await freshDirectory('acl-remove')
      await run('/usr/bin/ditto', ['-x', '-k', await aclZip(), destination])

      const removed = await removeTree(destination)

      expect(removed).toBe(true)
      expect(existsSync(destination)).toBe(false)
    })

    it('leaves nothing behind when verification rejects the archive', async () => {
      const zipPath = await aclZip()
      const workDir = await freshDirectory('acl-work')
      const parsed = parseCustomUpdateManifest(
        sampleManifest('1.4.258+custom.5', { size: (await stat(zipPath)).size }),
        'v1.4.258+custom.5'
      )
      if (!parsed.ok) {
        throw new Error(parsed.reason)
      }

      await expect(
        verifyUpdateBundle({ zipPath, workDir, manifest: parsed.manifest })
      ).rejects.toMatchObject({ kind: 'verification' })

      expect(existsSync(join(workDir, 'extracted'))).toBe(false)
    })

    it('does not touch the target of a link inside the tree, or its ACL', async () => {
      const destination = await freshDirectory('acl-link')
      const outside = await freshDirectory('acl-outside')
      await mkdir(join(outside, 'precious'))
      await writeFile(join(outside, 'precious', 'file'), 'x')
      await run('/bin/chmod', ['+a', 'everyone deny delete', join(outside, 'precious')])
      await run('/bin/chmod', ['555', join(outside, 'precious')])
      await run('/usr/bin/ditto', ['-x', '-k', await aclZip(), destination])
      await symlink(join(outside, 'precious'), join(destination, 'link'))

      expect(await removeTree(destination)).toBe(true)

      expect(((await stat(join(outside, 'precious'))).mode & 0o777).toString(8)).toBe('555')
      expect(await aclOf(join(outside, 'precious'))).toContain('deny delete')
      await run('/bin/chmod', ['-N', join(outside, 'precious')])
      await run('/bin/chmod', ['755', join(outside, 'precious')])
    })
  })

  describe('a zip whose entry name imitates the disk-full message of ditto (the reviewer reproduced it)', () => {
    it('is not taken for a full disk: it is retried and counted, so older releases are not blocked for ever', async () => {
      // 300 bytes of name are too long for the file system (ENAMETOOLONG), and ditto prints the name in its error.
      const name = `Orca.app/No space left on device-${'x'.repeat(300)}`
      const zip = buildZip([
        { name: 'Orca.app/', mode: 0o755 },
        { name, mode: 0o644, data: Buffer.from('x') }
      ])
      const zipPath = join(await freshDirectory('hostile-name'), 'hostile.zip')
      await writeFile(zipPath, zip)
      const parsed = parseCustomUpdateManifest(
        sampleManifest('1.4.258+custom.5', { size: zip.length }),
        'v1.4.258+custom.5'
      )
      if (!parsed.ok) {
        throw new Error(parsed.reason)
      }

      const error = await verifyUpdateBundle({
        zipPath,
        workDir: await freshDirectory('hostile-name-work'),
        manifest: parsed.manifest
      }).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(CustomUpdateError)
      expect((error as CustomUpdateError).kind).toBe('check-error')
    })
  })

  describe('a zip that lies about its size (central directory says 1000 bytes, the data is far more)', () => {
    async function lyingZip(payloadMiB: number): Promise<{ path: string; bytes: number }> {
      const zip = buildZip([
        { name: 'Orca.app/', mode: 0o755 },
        {
          name: 'Orca.app/pad.bin',
          mode: 0o644,
          data: Buffer.alloc(payloadMiB * MIB),
          claimedSize: 1000
        }
      ])
      const path = join(await freshDirectory('lying'), 'lying.zip')
      await writeFile(path, zip)
      return { path, bytes: zip.length }
    }

    // How far ditto got before it was stopped depends on how soon the watcher's timer runs, and a test machine that is busy
    // (the whole suite runs in parallel) runs it late: measured 11 to 170 MiB across runs of the full suite, 14 to 27 MiB on an
    // idle machine, against a cap of 2.5 MiB. The old watcher, which only walked the tree every 100 ms, let ditto write 221 MiB.
    // So the test takes the best of three runs: a watcher that polls the free space stops one of them early whenever the
    // machine is not stalled for all three, and one that only walks the tree never does.
    async function stoppedAfter(payloadMiB: number): Promise<{ onDisk: number; error: unknown }> {
      const zip = await lyingZip(payloadMiB)
      const destination = await freshDirectory('lying-extract')
      let error: unknown
      try {
        await extractArchive({
          zipPath: zip.path,
          destination,
          zipBytes: zip.bytes,
          run: runSystemCommand
        })
      } catch (caught) {
        error = caught
      }
      const onDisk = (await measureTree(destination, NO_LIMIT)).bytes
      await removeTree(destination)
      return { onDisk, error }
    }

    it('is stopped long before it has written its payload', async () => {
      const payloadMiB = 640
      const runs: { onDisk: number; error: unknown }[] = []
      for (let attempt = 0; attempt < 3; attempt += 1) {
        runs.push(await stoppedAfter(payloadMiB))
        if (runs.at(-1)!.onDisk < 100 * MIB) {
          break
        }
      }

      for (const { error } of runs) {
        expect(error).toBeInstanceOf(CustomUpdateError)
        expect((error as CustomUpdateError).kind).toBe('verification')
      }
      expect(Math.min(...runs.map((run) => run.onDisk))).toBeLessThan(100 * MIB)
    }, 180_000)
  })

  describe('ditto running out of disk by itself', () => {
    it('is a disk-space problem, not a verdict on the archive', async () => {
      const image = join(await freshDirectory('image'), 'small.dmg')
      const mountpoint = await freshDirectory('mount')
      await run('/usr/bin/hdiutil', [
        'create',
        '-size',
        '16m',
        '-fs',
        'HFS+',
        '-volname',
        'orcasmall',
        '-ov',
        image
      ])
      await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', mountpoint, image])
      try {
        const zip = buildZip([
          { name: 'Orca.app/', mode: 0o755 },
          { name: 'Orca.app/pad.bin', mode: 0o644, data: Buffer.alloc(64 * MIB) }
        ])
        const zipPath = join(await freshDirectory('enospc'), 'pad.zip')
        await writeFile(zipPath, zip)
        const destination = join(mountpoint, 'extracted')
        await mkdir(destination)

        let error: unknown
        let dittoDone = false
        try {
          await extractArchive({
            zipPath,
            destination,
            // A manifest that promised a big zip, and looks at the disk that saw plenty of room: the disk then fills
            // up while ditto runs, which is what another program writing at the same time does. Once ditto has
            // failed the real free space is read, because that reading, not ditto's text, decides what it was.
            zipBytes: 200 * MIB,
            run: async (file, args, options) => {
              const result = await runSystemCommand(file, args, options)
              dittoDone ||= file === '/usr/bin/ditto'
              return result
            },
            getFreeBytes: async (directory) =>
              dittoDone ? freeBytesOf(directory) : 100 * 1024 * MIB
          })
        } catch (caught) {
          error = caught
        }

        expect(error).toBeInstanceOf(CustomUpdateError)
        expect((error as CustomUpdateError).kind).toBe('disk-space')
      } finally {
        await run('/usr/bin/hdiutil', ['detach', '-force', mountpoint]).catch(() => undefined)
      }
    }, 120_000)
  })
})
