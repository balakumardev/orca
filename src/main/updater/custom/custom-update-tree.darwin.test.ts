import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSystemCommand, type CommandRunner } from './custom-update-commands'
import { removeTree } from './custom-update-tree'
import { hostileDirectoryZip } from './testing/custom-update-acl-zip'

const run = promisify(execFile)

// These drive the real chmod and find: access control lists exist only on macOS.
const suite = process.platform === 'darwin' ? describe : describe.skip

/**
 * Removes a directory the way the repair has to, but written out independently of the code under test: by name, one
 * entry at a time, never following a link. Mode first, because `chmod -N` cannot open a directory nobody may read.
 */
async function forceRemove(path: string): Promise<void> {
  // Missing is the only answer that ends it: a directory whose ACL denies reading its attributes cannot be statted
  // until it is opened, so a failed lstat is "locked", not "gone".
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? null : undefined
  )
  if (stats === null) {
    return
  }
  if (stats?.isSymbolicLink()) {
    // Only unlinked: `chmod -N` would clear the ACL of what it points at.
    await unlink(path).catch(() => undefined)
    return
  }
  if (stats && !stats.isDirectory()) {
    await run('/bin/chmod', ['-h', '-N', path]).catch(() => undefined)
    await unlink(path).catch(() => undefined)
    return
  }
  for (const mode of [['u+rwx'], ['-N'], ['u+rwx']]) {
    await run('/bin/chmod', [...mode, path]).catch(() => undefined)
  }
  for (const name of await readdir(path).catch(() => [])) {
    await forceRemove(join(path, name))
  }
  await rmdir(path)
    .catch(() => unlink(path))
    .catch(() => undefined)
}

async function aclOf(path: string): Promise<string> {
  return (await run('/bin/ls', ['-lde', path])).stdout
}

suite(
  'removing a tree whose entries an archive made undeletable (skipped when not on macOS)',
  () => {
    let root: string
    let counter = 0

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'orca tree acl '))
    })
    afterAll(async () => {
      // Not removeTree: a failing test is exactly when it cannot be trusted to clear what it left.
      await forceRemove(root)
    })

    async function fresh(name: string): Promise<string> {
      counter += 1
      const directory = join(root, `${name}-${counter}`)
      await mkdir(directory)
      return directory
    }

    /** What macOS puts on ~/Documents, ~/Desktop and ~/Library: a directory and a file nobody may delete, and mode 0500. */
    async function victim(): Promise<{ directory: string; file: string }> {
      const directory = join(await fresh('victim'), 'precious')
      await mkdir(directory)
      const file = join(directory, 'file')
      await writeFile(file, 'x')
      await run('/bin/chmod', ['+a', 'everyone deny delete', file])
      await run('/bin/chmod', ['+a', 'everyone deny delete', directory])
      await run('/bin/chmod', ['500', directory])
      return { directory, file }
    }

    async function expectUntouched(target: { directory: string; file: string }): Promise<void> {
      expect(await aclOf(target.directory)).toContain('deny delete')
      expect(await aclOf(target.file)).toContain('deny delete')
      expect(((await stat(target.directory)).mode & 0o777).toString(8)).toBe('500')
      expect(await readFile(target.file, 'utf8')).toBe('x')
      await run('/bin/chmod', ['-N', target.directory, target.file])
      await run('/bin/chmod', ['700', target.directory])
    }

    /** A tree `rm` cannot empty: a read-only directory (so the first remove fails) that holds a link to `target`. */
    async function treeWithLinksTo(target: { directory: string; file: string }): Promise<string> {
      const tree = await fresh('tree')
      await mkdir(join(tree, 'closed'))
      await symlink(target.directory, join(tree, 'closed', 'dir-link'))
      await symlink(target.file, join(tree, 'closed', 'file-link'))
      await run('/bin/chmod', ['555', join(tree, 'closed')])
      return tree
    }

    it('never clears the ACL, or the mode, of what a link deep in the tree points at', async () => {
      const target = await victim()
      const tree = await treeWithLinksTo(target)

      expect(await removeTree(tree)).toBe(true)

      expect(existsSync(tree)).toBe(false)
      await expectUntouched(target)
    })

    it('never changes what a directory swapped for a link, between the failed remove and the repair, points at', async () => {
      const target = await victim()
      const tree = await fresh('swap')
      await mkdir(join(tree, 'closed'))
      await writeFile(join(tree, 'closed', 'file'), 'x')
      await run('/bin/chmod', ['+a', 'everyone deny delete', join(tree, 'closed', 'file')])
      await run('/bin/chmod', ['000', join(tree, 'closed')])
      // Another process swaps the closed directory for a link after `rm` failed, before the first repair command.
      let swapped = false
      const swapping: CommandRunner = async (file, args, options) => {
        if (!swapped) {
          swapped = true
          await run('/bin/chmod', ['-N', join(tree, 'closed')])
          await run('/bin/chmod', ['700', join(tree, 'closed')])
          await run('/bin/chmod', ['-N', join(tree, 'closed', 'file')])
          await rm(join(tree, 'closed'), { recursive: true, force: true })
          await symlink(target.directory, join(tree, 'closed'))
        }
        return runSystemCommand(file, args, options)
      }

      await removeTree(tree, swapping)

      expect(swapped).toBe(true)
      await expectUntouched(target)
    })

    it('removes the link and nothing else when the root itself is a link', async () => {
      const target = await victim()
      const link = join(await fresh('root-link'), 'link')
      await symlink(target.directory, link)

      expect(await removeTree(link)).toBe(true)

      await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' })
      await expectUntouched(target)
    })

    describe.each([
      ['mode 0000', 'chmod', '000'],
      ['mode 0200 (write only)', 'chmod', '200'],
      [
        'an ACL that denies listing and searching, and reading attributes',
        'acl',
        'deny list,search,readattr'
      ],
      [
        'an ACL that denies listing and searching (lstat still works on it)',
        'acl',
        'deny list,search'
      ],
      [
        'an ACL that denies listing, searching and deleting children',
        'acl',
        'deny list,search,delete_child'
      ]
    ])('a directory with %s that holds an entry nobody may delete', (_label, how, setting) => {
      it('is removed completely', async () => {
        const tree = await fresh('closed')
        await mkdir(join(tree, 'a', 'b'), { recursive: true })
        await writeFile(join(tree, 'a', 'b', 'file'), 'x')
        await mkdir(join(tree, 'a', 'b', 'sub'))
        await run('/bin/chmod', ['+a', 'everyone deny delete', join(tree, 'a', 'b', 'file')])
        await run('/bin/chmod', ['+a', 'everyone deny delete_child', join(tree, 'a', 'b', 'sub')])
        for (const closed of [join(tree, 'a', 'b'), join(tree, 'a')]) {
          await (how === 'chmod'
            ? chmod(closed, Number.parseInt(setting, 8))
            : run('/bin/chmod', ['+a', `everyone ${setting}`, closed]))
        }

        expect(await removeTree(tree)).toBe(true)

        expect(existsSync(tree)).toBe(false)
      })
    })

    /**
     * Trees the real `ditto -x -k` restores from a hostile zip, which a hand-made tree cannot stand in for: ditto
     * itself is what applies the ACL and the mode, and it applies them after it has written the files. The ACL names
     * are the file ones that the archive's `com.apple.acl.text` uses (`read` is `list` on a directory, `execute` is
     * `search`), and none of them includes `readattr`, so `lstat` still works on the directory.
     */
    describe('a tree restored by the real ditto from a hostile zip', () => {
      async function restored(options: {
        mode: number
        acl: string
        links?: string[]
      }): Promise<string> {
        const source = await fresh('zip')
        const zip = join(source, 'hostile.zip')
        await writeFile(zip, hostileDirectoryZip(options))
        const destination = join(source, 'extracted')
        await mkdir(destination)
        // ditto may exit with an error of its own once the directory it just restored cannot be entered.
        await run('/usr/bin/ditto', ['-x', '-k', zip, destination]).catch(() => undefined)
        return destination
      }

      it.each([
        ['list and search', 'read,execute'],
        ['list, search and delete_child', 'read,execute,delete_child'],
        ['list and delete_child', 'read,delete_child'],
        ['search and delete_child', 'execute,delete_child'],
        ['writesecurity, list and delete_child', 'writesecurity,read,delete_child'],
        ['writesecurity, list, search and delete_child', 'writesecurity,read,execute,delete_child']
      ])(
        'a directory whose ACL denies %s, with mode 755, is removed completely',
        async (_label, acl) => {
          const destination = await restored({ mode: 0o755, acl })
          const directory = join(destination, 'Orca.app', 'a')
          expect((await lstat(directory)).isDirectory()).toBe(true)
          expect(await aclOf(directory)).toContain('deny')

          expect(await removeTree(destination)).toBe(true)

          expect(existsSync(destination)).toBe(false)
        }
      )

      it.each([
        ['0200', 0o200],
        ['0300', 0o300],
        ['0100', 0o100]
      ])(
        'a directory with mode %s and an ACL that denies delete_child is removed completely',
        async (_label, mode) => {
          const destination = await restored({ mode, acl: 'delete_child' })
          const directory = join(destination, 'Orca.app', 'a')
          expect((await stat(directory)).mode & 0o777).toBe(mode)
          expect(await aclOf(directory)).toContain('deny delete_child')

          expect(await removeTree(destination)).toBe(true)

          expect(existsSync(destination)).toBe(false)
        }
      )

      // ditto cannot restore a link under a directory it cannot search (it leaves a plain file instead), so these two
      // lock listing only: the walk has to open the locked directory, and then meets a link in the directory below.
      it.each([
        ['an ACL that denies listing, with mode 755', 0o755, 'read,delete_child'],
        ['mode 0300 and an ACL that denies delete_child', 0o300, 'delete_child']
      ])('never follows a link below the directory with %s', async (_label, mode, acl) => {
        const target = await victim()
        const destination = await restored({ mode, acl, links: [target.directory, target.file] })
        for (const [name, points] of [
          ['link-0', target.directory],
          ['link-1', target.file]
        ]) {
          const link = join(destination, 'Orca.app', 'a', 'b', name)
          expect((await lstat(link)).isSymbolicLink()).toBe(true)
          expect(await readlink(link)).toBe(points)
        }

        expect(await removeTree(destination)).toBe(true)

        expect(existsSync(destination)).toBe(false)
        await expectUntouched(target)
      })
    })
  }
)
