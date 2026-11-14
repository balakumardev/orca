import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runSystemCommand, type CommandRunner } from './custom-update-commands'

// Disk space is judged by what the file system allocated, not by what a header or a file size claims.
const BLOCK_BYTES = 512

export type TreeLimit = { maxBytes: number; maxEntries: number }
export type TreeMeasure = { bytes: number; entries: number; exceeded: boolean }

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** A directory nobody may list, which is what an archive can make; unlike EMFILE or EIO, that is about the archive. */
export function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
  )
}

function allocatedBytes(stats: Stats): number {
  return Math.max(stats.size, stats.blocks * BLOCK_BYTES)
}

async function listDirectory(directory: string): Promise<Dirent[] | null> {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

async function lstatIfPresent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

/**
 * Visits every entry under `root` without following links. `visit` returns true to stop early. Throws on anything
 * that cannot be read: a caller that measures must treat that as "too much", never as "nothing there".
 */
async function walkTree(root: string, visit: (stats: Stats) => boolean): Promise<void> {
  const rootStats = await lstatIfPresent(root)
  if (!rootStats || visit(rootStats)) {
    return
  }
  const pending: string[] = rootStats.isDirectory() ? [root] : []
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) {
      break
    }
    const entries = await listDirectory(directory)
    const children = await Promise.all(
      (entries ?? []).map(async (entry) => {
        const path = join(directory, entry.name)
        return { path, stats: await lstatIfPresent(path) }
      })
    )
    for (const { path, stats } of children) {
      if (!stats) {
        continue
      }
      if (visit(stats)) {
        return
      }
      if (stats.isDirectory()) {
        pending.push(path)
      }
    }
  }
}

/**
 * Allocated bytes and entry count of a tree, counting only until a limit is passed. Read-only: it changes no mode,
 * so it is safe to run while an extraction is still writing. It rejects on any read error, and a directory nobody
 * may list is one.
 */
export async function measureTree(root: string, limit: TreeLimit): Promise<TreeMeasure> {
  let bytes = 0
  let entries = 0
  await walkTree(root, (stats) => {
    bytes += allocatedBytes(stats)
    entries += 1
    return bytes > limit.maxBytes || entries > limit.maxEntries
  })
  return { bytes, entries, exceeded: bytes > limit.maxBytes || entries > limit.maxEntries }
}

// A batch of paths stays far below the argument limit of the system (about a megabyte, environment included).
const MAX_ARGUMENT_CHARS = 100_000
const ACL_SUPPORTED = process.platform === 'darwin'

/**
 * Runs `chmod <mode>` over `paths` in batches. `-h` (BSD's) is what keeps a link from being followed; elsewhere chmod
 * would follow a link given by name. `chmod -h` has to open the entry, so it fails on a directory nobody may read
 * (no read bit, or an ACL that denies listing it, with or without `readattr`). When a batch fails, the entries are
 * retried by name: `byName` is true only for paths that a directory listing named as a directory or a regular file,
 * and an entry that `lstat` now shows to be a link is left alone.
 */
async function chmodPaths(
  run: CommandRunner,
  mode: string[],
  paths: string[],
  byName: boolean
): Promise<void> {
  for (let index = 0; index < paths.length;) {
    const batch: string[] = []
    let chars = 0
    while (index < paths.length && (batch.length === 0 || chars < MAX_ARGUMENT_CHARS)) {
      chars += paths[index].length + 1
      batch.push(paths[index])
      index += 1
    }
    const result = await run('/bin/chmod', [...(ACL_SUPPORTED ? ['-h'] : []), ...mode, ...batch])
    if (result.code !== 0 && byName && ACL_SUPPORTED) {
      for (const path of batch) {
        // `lstat` still works on a directory whose ACL denies listing, so a failed `lstat` is not the only case: a
        // directory is chmodded by name whenever it is not a link. What the archive wrote is finished, so only another
        // process of this user could swap the entry for a link between this `lstat` and the `chmod`; a zip cannot.
        const stats = await lstat(path).catch(() => null)
        if (!stats || !stats.isSymbolicLink()) {
          await run('/bin/chmod', [...mode, path])
        }
      }
    }
  }
}

/**
 * Gives the owner back what an archive took away: access control lists (a deny-delete entry in a zip's `._*` files
 * survives `ditto -x -k`, whatever flags it gets) and unreadable or read-only directory modes.
 *
 * Nothing here may act on a link's target, because an archive can hold a link to any path the user owns
 * (~/Documents, ~/Desktop and ~/Library carry a deny-delete ACL of their own). `chmod -R -N` does follow links when
 * it clears ACLs, so no `-R` is used at all. The tree is walked here, level by level, and only what the directory
 * entries name as a directory is entered; `chmod -h` changes a link itself and never what it points at.
 *
 * A level is opened before it is read, so a directory with mode 000, or an ACL that denies listing (or even reading
 * its attributes, which makes `find` and `lstat` fail on it), can be entered by the time it is listed. Both ways a zip
 * can lock a directory (a mode without the read bit, an ACL that denies listing) defeat `chmod -h -N` alone, which is why
 * the mode is restored before the ACL is cleared.
 */
async function restoreOwnerAccess(root: string, run: CommandRunner): Promise<void> {
  const open = async (directories: string[]): Promise<void> => {
    // The mode first, because `chmod -N` has to open the directory, which a mode without the read bit forbids; then
    // the ACL; then the mode again, because an ACL that denied writing the mode may only have gone with the `-N`.
    await chmodPaths(run, ['u+rwx'], directories, true)
    if (ACL_SUPPORTED) {
      await chmodPaths(run, ['-N'], directories, true)
    }
    await chmodPaths(run, ['u+rwx'], directories, true)
  }
  const start = resolve(root)
  // A link as the root has nothing under it to repair, and the final remove deletes it.
  const rootStats = await lstat(start).catch(() => null)
  if (rootStats && !rootStats.isDirectory()) {
    return
  }
  await open([start])
  let level = [start]
  while (level.length > 0) {
    const subdirectories: string[] = []
    const files: string[] = []
    const links: string[] = []
    for (const directory of level) {
      try {
        // Swapped for a link since it was opened: listing it would list the link's target.
        if (!(await lstat(directory)).isDirectory()) {
          continue
        }
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const target = entry.isDirectory()
            ? subdirectories
            : entry.isSymbolicLink()
              ? links
              : files
          target.push(join(directory, entry.name))
        }
      } catch {
        // One directory that cannot be read must not stop the repair of the others; the removal reports what is left.
      }
    }
    await open(subdirectories)
    if (ACL_SUPPORTED) {
      await chmodPaths(run, ['-N'], files, true)
      await chmodPaths(run, ['-N'], links, false)
    }
    level = subdirectories
  }
}

/**
 * Deletes a tree even when an archive left entries nobody may delete. Call it only once nothing writes to the tree
 * any more. Never throws, so a failed cleanup cannot replace the error that caused it; the result says whether the
 * tree is gone, and a caller that gets `false` has to say so, because the files are still on the disk.
 */
export async function removeTree(
  root: string,
  run: CommandRunner = runSystemCommand
): Promise<boolean> {
  try {
    await rm(root, { recursive: true, force: true })
    return true
  } catch {
    // Probably entries with an ACL or a mode that forbids it: restore owner access and try again.
  }
  try {
    await restoreOwnerAccess(root, run)
  } catch {
    // Whatever could not be restored, the removal below reports.
  }
  try {
    await rm(root, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}
