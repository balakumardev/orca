import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
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
  /** Git roots are listed down to this depth below a search root; plain folders only at depth 1. */
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
        !entry.name.startsWith('.') &&
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
          if (marker !== null || child.depth === 1) {
            listed.push({
              path: child.path,
              kind: marker?.kind ?? 'folder',
              realPath: child.realPath,
              mainCheckoutPath: marker?.kind === 'linked-worktree' ? marker.mainCheckoutPath : null
            })
          }
          // Do not descend into a repository: its own folders are not siblings to pick.
          if (marker === null && child.depth < limits.maxDepth) {
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
