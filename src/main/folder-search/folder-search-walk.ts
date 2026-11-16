import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isIgnoredNestedRepoDirectory } from '../project-groups/nested-repo-scan-rules'
import { readGitMarker } from './git-marker'
import type { FolderSearchRoot } from './folder-search-roots'
import type { ScannedFolder } from './folder-search-scan'
import { TIMED_OUT, withinMs } from './folder-search-time'

type PendingDirectory = { path: string; realPath: string; depth: number }

/** Near the size of Node's file system thread pool, so one slow mount cannot queue all of it at once. */
const PROBE_CONCURRENCY = 4

export type WalkLimits = {
  /** All directories are listed down to this depth below a search root. */
  maxDepth: number
  callTimeoutMs: number
}

async function listChildDirectories(
  directory: PendingDirectory,
  timeoutMs: number
): Promise<PendingDirectory[] | typeof TIMED_OUT> {
  let entries: Dirent[] | typeof TIMED_OUT
  try {
    entries = await withinMs(readdir(directory.realPath, { withFileTypes: true }), timeoutMs)
  } catch {
    return []
  }
  if (entries === TIMED_OUT) {
    return TIMED_OUT
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        // Include dotfolders like the reference picker, but retain metadata/dependency exclusions.
        !isIgnoredNestedRepoDirectory(entry.name, [entry.name], [])
    )
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => ({
      path: join(directory.path, name),
      realPath: join(directory.realPath, name),
      depth: directory.depth + 1
    }))
}

/**
 * Walks one search root breadth first and yields the folders it finds a few at a time, so a caller can
 * interleave several roots. Never follows symbolic links. After a read that hangs it reads no further
 * in this root and calls `onSlowRead`.
 */
export async function* walkSearchRoot(
  root: FolderSearchRoot,
  limits: WalkLimits,
  onSlowRead: () => void
): AsyncGenerator<ScannedFolder[]> {
  // Roots are selectable too, but a missing path or a file must never become a folder result.
  const stat = await withinMs(lstat(root.realPath), limits.callTimeoutMs).catch(() => null)
  if (stat === TIMED_OUT) {
    onSlowRead()
    return
  }
  if (!stat?.isDirectory()) {
    return
  }
  const rootMarker = await withinMs(readGitMarker(root.realPath), limits.callTimeoutMs)
  if (rootMarker === TIMED_OUT) {
    onSlowRead()
    return
  }
  yield [
    {
      path: root.path,
      realPath: root.realPath,
      kind: rootMarker?.kind ?? 'folder',
      mainCheckoutPath: rootMarker?.kind === 'linked-worktree' ? rootMarker.mainCheckoutPath : null
    }
  ]
  let level: PendingDirectory[] = [{ path: root.path, realPath: root.realPath, depth: 0 }]
  while (level.length > 0) {
    const next: PendingDirectory[] = []
    for (const directory of level) {
      const children = await listChildDirectories(directory, limits.callTimeoutMs)
      if (children === TIMED_OUT) {
        onSlowRead()
        return
      }
      for (let start = 0; start < children.length; start += PROBE_CONCURRENCY) {
        const chunk = children.slice(start, start + PROBE_CONCURRENCY)
        const markers = await withinMs(
          Promise.all(chunk.map((child) => readGitMarker(child.realPath))),
          limits.callTimeoutMs
        )
        if (markers === TIMED_OUT) {
          onSlowRead()
          return
        }
        const listed: ScannedFolder[] = []
        for (const [index, child] of chunk.entries()) {
          const marker = markers[index]
          // A folder picker includes ordinary nested directories, including those inside Git projects.
          listed.push({
            path: child.path,
            kind: marker?.kind ?? 'folder',
            realPath: child.realPath,
            mainCheckoutPath: marker?.kind === 'linked-worktree' ? marker.mainCheckoutPath : null
          })
          if (child.depth < limits.maxDepth) {
            next.push(child)
          }
        }
        if (listed.length > 0) {
          yield listed
        }
      }
    }
    level = next
  }
}
