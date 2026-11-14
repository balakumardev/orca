import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, parse } from 'node:path'
import type { Repo } from '../../shared/repo-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  getRepoRoutingConnectionId
} from '../../shared/execution-host'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { FOLDER_SEARCH_CALL_TIMEOUT_MS, TIMED_OUT, withinMs } from './folder-search-time'

export type FolderSearchRoot = {
  /** The parent as the user registered it; when projects reached it through several spellings, the first. */
  path: string
  /** The parent with links resolved; every directory read starts here. */
  realPath: string
  /**
   * Every spelling of this parent that a registered project went through, `path` included. A tracked path
   * under any of them is known to sit in this root, so it is the only kind of path that is resolved.
   */
  spellings?: readonly string[]
}

type RootRepo = Pick<Repo, 'path' | 'connectionId' | 'executionHostId' | 'addedAt'>

/** A search walks every root, so the list stays short: the roots of the most recently added projects win. */
export const MAX_FOLDER_SEARCH_ROOTS = 12

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

/** Local repos only: an SSH, runtime or WSL project's parent is not a folder this process can list. */
export function isLocalDiskRepo(repo: RootRepo): boolean {
  return (
    getRepoRoutingConnectionId(repo) === null &&
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
    !isWslUncPath(repo.path)
  )
}

/** On macOS and Linux a top-level folder (`/Users`, `/Volumes`, `/opt`, `/tmp`) holds users, disks or the system. */
function isTopLevelPosixFolder(path: string): boolean {
  return process.platform !== 'win32' && dirname(path) === parse(path).root
}

/**
 * The parents of registered local projects, minus places that are never a project collection: the
 * filesystem root, a top-level folder, the home folder and every folder above it, the temporary folder and
 * Orca's own workspace folders. A root inside another root stays, so its plain folders are still listed.
 */
export async function deriveFolderSearchRoots(args: {
  repos: readonly RootRepo[]
  homeDir: string
  tmpDir?: string
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
  const [homeDir, tmpDir, ...managedDirs] = await Promise.all(
    [args.homeDir, args.tmpDir ?? tmpdir(), ...args.managedWorkspaceDirs].map(resolveOrSelf)
  )
  const tmpKey = normalizeRuntimePathForComparison(tmpDir)

  const newestAddedAtByParent = new Map<string, number>()
  for (const repo of args.repos.filter(isLocalDiskRepo)) {
    const parent = dirname(repo.path)
    newestAddedAtByParent.set(
      parent,
      Math.max(newestAddedAtByParent.get(parent) ?? 0, repo.addedAt ?? 0)
    )
  }
  const resolvedParents = await Promise.all(
    [...newestAddedAtByParent].map(
      async ([parent, addedAt]): Promise<{
        parent: string
        addedAt: number
        realParent: Awaited<ReturnType<typeof resolvePath>>
      }> => ({ parent, addedAt, realParent: await resolvePath(parent, timeoutMs) })
    )
  )
  const candidates = new Map<string, Required<FolderSearchRoot> & { addedAt: number }>()
  // Folded in project order, so which spelling a root calls its own does not depend on which call returned first.
  for (const { parent, addedAt, realParent } of resolvedParents) {
    if (realParent === TIMED_OUT) {
      timedOut = true
      continue
    }
    if (
      !realParent ||
      dirname(realParent) === realParent ||
      isTopLevelPosixFolder(realParent) ||
      isPathInsideOrEqual(realParent, homeDir) ||
      normalizeRuntimePathForComparison(realParent) === tmpKey ||
      managedDirs.some((dir) => isPathInsideOrEqual(dir, realParent))
    ) {
      continue
    }
    const key = normalizeRuntimePathForComparison(realParent)
    const known = candidates.get(key)
    candidates.set(key, {
      path: known?.path ?? parent,
      realPath: realParent,
      spellings: [...(known?.spellings ?? []), parent],
      addedAt: Math.max(known?.addedAt ?? 0, addedAt)
    })
  }
  const roots = [...candidates.values()]
    .sort((a, b) => b.addedAt - a.addedAt || (a.realPath < b.realPath ? -1 : 1))
    .slice(0, args.maxRoots ?? MAX_FOLDER_SEARCH_ROOTS)
    .map(({ path, realPath, spellings }) => ({ path, realPath, spellings }))
  return { roots: roots.sort((a, b) => (a.realPath < b.realPath ? -1 : 1)), timedOut }
}
