import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { measureTree, removeTree } from './custom-update-tree'

const NO_LIMIT = { maxBytes: Number.MAX_SAFE_INTEGER, maxEntries: Number.MAX_SAFE_INTEGER }

// The directory modes below only mean something to a user who is not root.
const unprivileged = typeof process.getuid === 'function' && process.getuid() !== 0
const posix = process.platform === 'win32' ? describe.skip : describe
const hostile = unprivileged ? it : it.skip

posix('a tree an archive filled', () => {
  let root: string
  let tree: string
  let outside: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-tree-'))
    tree = join(root, 'tree')
    outside = join(root, 'outside')
    await mkdir(tree)
    await mkdir(outside)
  })
  afterEach(async () => {
    await removeTree(root)
  })

  describe('measuring it', () => {
    it('adds up what the file system allocated, without following links', async () => {
      await mkdir(join(tree, 'a', 'b'), { recursive: true })
      await writeFile(join(tree, 'a', 'one'), Buffer.alloc(100_000, 1))
      await writeFile(join(tree, 'a', 'b', 'two'), Buffer.alloc(50_000, 1))
      await symlink(outside, join(tree, 'link'))
      await writeFile(join(outside, 'huge'), Buffer.alloc(10_000_000, 1))

      const measured = await measureTree(tree, NO_LIMIT)

      expect(measured.bytes).toBeGreaterThanOrEqual(150_000)
      expect(measured.bytes).toBeLessThan(1_000_000)
      // The root, two directories, two files and the link itself.
      expect(measured.entries).toBe(6)
      expect(measured.exceeded).toBe(false)
    })

    it('counts a missing directory as empty', async () => {
      expect(await measureTree(join(root, 'nope'), NO_LIMIT)).toEqual({
        bytes: 0,
        entries: 0,
        exceeded: false
      })
    })

    it('stops counting once the byte limit is passed', async () => {
      for (let index = 0; index < 5; index += 1) {
        await writeFile(join(tree, `file-${index}`), Buffer.alloc(100_000, 1))
      }

      const measured = await measureTree(tree, { maxBytes: 150_000, maxEntries: 1000 })

      expect(measured.exceeded).toBe(true)
      expect(measured.entries).toBeLessThan(6)
    })

    it('stops counting once the entry limit is passed', async () => {
      for (let index = 0; index < 20; index += 1) {
        await writeFile(join(tree, `file-${index}`), '')
      }

      const measured = await measureTree(tree, { maxBytes: 10 ** 9, maxEntries: 5 })

      expect(measured.exceeded).toBe(true)
    })

    it('counts a sparse file by its apparent size, so a hole cannot hide data', async () => {
      const path = join(tree, 'sparse')
      await writeFile(path, '')
      await truncate(path, 50_000_000)

      const measured = await measureTree(tree, { maxBytes: 10_000_000, maxEntries: 100 })

      expect(measured.exceeded).toBe(true)
    })

    hostile.each([
      ['execute-only (0111)', 0o111],
      ['no access at all (0000)', 0o000]
    ])(
      'rejects a tree with a directory that is %s, instead of reporting it empty',
      async (_label, mode) => {
        await mkdir(join(tree, 'closed', 'deeper'), { recursive: true })
        await writeFile(join(tree, 'closed', 'deeper', 'payload'), Buffer.alloc(2_000_000, 1))
        await chmod(join(tree, 'closed', 'deeper'), mode)
        await chmod(join(tree, 'closed'), mode)

        // The old walk swallowed the failure and reported 0 bytes: a 2 MB payload passed a 1 MB cap.
        await expect(
          measureTree(tree, { maxBytes: 1_000_000, maxEntries: 100 })
        ).rejects.toMatchObject({
          code: 'EACCES'
        })
      }
    )

    hostile(
      'changes no mode while it measures, because the tree may still be being written',
      async () => {
        await mkdir(join(tree, 'closed'))
        await chmod(join(tree, 'closed'), 0o111)

        await expect(measureTree(tree, NO_LIMIT)).rejects.toBeInstanceOf(Error)

        expect((await stat(join(tree, 'closed'))).mode & 0o777).toBe(0o111)
      }
    )

    hostile('counts a directory that can be listed but not written (0555)', async () => {
      await mkdir(join(tree, 'read-only'))
      await writeFile(join(tree, 'read-only', 'payload'), Buffer.alloc(2_000_000, 1))
      await chmod(join(tree, 'read-only'), 0o555)

      const measured = await measureTree(tree, { maxBytes: 1_000_000, maxEntries: 100 })

      expect(measured.exceeded).toBe(true)
      expect(measured.bytes).toBeGreaterThanOrEqual(2_000_000)
    })

    hostile('never changes the mode of what a link points at', async () => {
      const target = join(outside, 'closed')
      await mkdir(target)
      await chmod(target, 0o555)
      await symlink(target, join(tree, 'link'))

      await measureTree(tree, NO_LIMIT)

      expect((await stat(target)).mode & 0o777).toBe(0o555)
    })
  })

  describe('removing it', () => {
    it('removes an ordinary tree', async () => {
      await mkdir(join(tree, 'a'), { recursive: true })
      await writeFile(join(tree, 'a', 'file'), 'x')

      expect(await removeTree(tree)).toBe(true)
      expect(existsSync(tree)).toBe(false)
    })

    it('is quiet about a tree that is not there', async () => {
      expect(await removeTree(join(root, 'nope'))).toBe(true)
    })

    hostile.each([
      ['execute-only (0111)', 0o111],
      ['read-and-execute-only (0555)', 0o555],
      ['no access at all (0000)', 0o000]
    ])('removes a tree whose directories are %s', async (_label, mode) => {
      await mkdir(join(tree, 'closed', 'deeper'), { recursive: true })
      await writeFile(join(tree, 'closed', 'deeper', 'payload'), Buffer.alloc(100_000, 1))
      await chmod(join(tree, 'closed', 'deeper'), mode)
      await chmod(join(tree, 'closed'), mode)
      await chmod(tree, mode)

      expect(await removeTree(tree)).toBe(true)
      expect(existsSync(tree)).toBe(false)
    })

    hostile('never changes the mode of what a link in the tree points at', async () => {
      const target = join(outside, 'closed')
      await mkdir(target)
      await chmod(target, 0o555)
      await mkdir(join(tree, 'closed'))
      await chmod(join(tree, 'closed'), 0o111)
      await symlink(target, join(tree, 'closed-link'))

      expect(await removeTree(tree)).toBe(true)

      expect(existsSync(tree)).toBe(false)
      expect((await stat(target)).mode & 0o777).toBe(0o555)
    })

    hostile('shows that a plain recursive remove would have failed on such a tree', async () => {
      await mkdir(join(tree, 'closed'), { recursive: true })
      await writeFile(join(tree, 'closed', 'payload'), 'x')
      await chmod(join(tree, 'closed'), 0o555)

      await expect(rm(tree, { recursive: true, force: true })).rejects.toMatchObject({
        code: 'EACCES'
      })
      expect(await removeTree(tree)).toBe(true)
      expect(existsSync(tree)).toBe(false)
    })

    it('never throws, and says so when it cannot remove the tree', async () => {
      // A path under a regular file can neither be walked nor removed.
      await writeFile(join(root, 'plain-file'), 'x')

      await expect(removeTree(join(root, 'plain-file', 'child'))).resolves.toBeTypeOf('boolean')
      expect((await stat(join(root, 'plain-file'))).isFile()).toBe(true)
    })
  })
})
