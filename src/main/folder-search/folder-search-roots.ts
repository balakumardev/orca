import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Repo } from '../../shared/repository/repo-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  getRepoRoutingConnectionId
} from '../../shared/execution-host/execution-host'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/file-access/cross-platform-path'
import { isWslUncPath } from '../../shared/file-access/wsl-paths'
import { MAX_FOLDER_SEARCH_ROOTS } from '../../shared/folder-search-settings'
import { expandLeadingHomePath } from '../filesystem/home-path-expansion'
import { FOLDER_SEARCH_CALL_TIMEOUT_MS, TIMED_OUT, withinMs } from './folder-search-time'

export type FolderSearchRoot = {
  /** The configured location, with a leading home shorthand expanded. */
  path: string
  /** The location with links resolved; every directory read starts here. */
  realPath: string
  /**
   * Every configured spelling of this location, `path` included. A tracked path
   * under any of them is known to sit in this root, so it is the only kind of path that is resolved.
   */
  spellings?: readonly string[]
}

type RootRepo = Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>

/** Resolves a path, or says why not: `null` when it is missing, and `TIMED_OUT` when the call hung. */
async function resolvePath(
  path: string,
  timeoutMs: number
): Promise<string | null | typeof TIMED_OUT> {
  try {
    return await withinMs(realpath(path), timeoutMs)
  } catch {
    return null
  }
}

/** Only local projects contribute managed workspace directories. */
export function isLocalDiskRepo(repo: RootRepo): boolean {
  return (
    getRepoRoutingConnectionId(repo) === null &&
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
    !isWslUncPath(repo.path)
  )
}

/** Explicit local locations work before any project is registered, including the user's home directory. */
export async function deriveFolderSearchRoots(args: {
  locations: readonly string[]
  homeDir: string
  /** Where Orca itself creates worktrees; everything under it is already a tracked workspace. */
  managedWorkspaceDirs: readonly string[]
  maxRoots?: number
  callTimeoutMs?: number
}): Promise<{ roots: FolderSearchRoot[]; timedOut: boolean }> {
  const timeoutMs = args.callTimeoutMs ?? FOLDER_SEARCH_CALL_TIMEOUT_MS
  let timedOut = false
  const resolveOrSelf = async (path: string): Promise<string> => {
    const resolved = await resolvePath(path, timeoutMs)
    timedOut ||= resolved === TIMED_OUT
    return typeof resolved === 'string' ? resolved : path
  }
  const managedDirs = await Promise.all(args.managedWorkspaceDirs.map(resolveOrSelf))
  // Reject remote/relative paths before filesystem access; a saved location always names this host.
  const locations = [...new Set(args.locations)]
    .map((location) => expandLeadingHomePath(location, args.homeDir))
    .filter((location) => isAbsolute(location) && !isWslUncPath(location))
    .slice(0, args.maxRoots ?? MAX_FOLDER_SEARCH_ROOTS)
  const resolvedLocations = await Promise.all(
    locations.map(
      async (
        path
      ): Promise<{ path: string; realPath: Awaited<ReturnType<typeof resolvePath>> }> => ({
        path,
        realPath: await resolvePath(path, timeoutMs)
      })
    )
  )
  const candidates = new Map<string, Required<FolderSearchRoot>>()
  // Fold in settings order so an alias's display path never depends on filesystem completion order.
  for (const { path, realPath } of resolvedLocations) {
    if (realPath === TIMED_OUT) {
      timedOut = true
      continue
    }
    if (
      !realPath ||
      isWslUncPath(realPath) ||
      managedDirs.some((dir) => isPathInsideOrEqual(dir, realPath))
    ) {
      continue
    }
    const key = normalizeRuntimePathForComparison(realPath)
    const known = candidates.get(key)
    candidates.set(key, {
      path: known?.path ?? path,
      realPath,
      spellings: [...(known?.spellings ?? []), path]
    })
  }
  const roots = [...candidates.values()]
  return { roots: roots.sort((a, b) => (a.realPath < b.realPath ? -1 : 1)), timedOut }
}
