import { realpath } from 'node:fs/promises'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import { LOCAL_EXECUTION_HOST_ID, getRepoExecutionHostId } from '../../shared/execution-host'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { isFolderRepo } from '../../shared/repo-kind'
import { isWslUncPath } from '../../shared/wsl-paths'
import { readGitMarker } from './git-marker'
import type { FolderSearchRoot } from './folder-search-roots'
import type { ScannedFolder } from './folder-search-scan'
import { FOLDER_SEARCH_CALL_TIMEOUT_MS, TIMED_OUT, withinMs } from './folder-search-time'

type TrackedRepo = Pick<Repo, 'path' | 'kind' | 'connectionId' | 'executionHostId'>
type TrackedFolderWorkspace = Pick<
  FolderWorkspace,
  'folderPath' | 'connectionId' | 'executionHostId'
>
type Roots = readonly FolderSearchRoot[]

/**
 * A scanned folder always sits under a root, so a path outside every root cannot match one. A project may
 * have been registered through any spelling of the root's parent (a link and its target), so all count.
 */
function isInsideAnyRoot(roots: Roots, path: string): boolean {
  return roots.some((root) =>
    [root.path, root.realPath, ...(root.spellings ?? [])].some((spelling) =>
      isPathInsideOrEqual(spelling, path)
    )
  )
}

function isLocalRecord(record: {
  connectionId?: string | null
  executionHostId?: string | null
}): boolean {
  return !record.connectionId && getRepoExecutionHostId(record) === LOCAL_EXECUTION_HOST_ID
}

/** Real-path keys of in-root paths and written-path keys of the rest; only in-root paths touch the disk. */
async function trackedKeysFor(path: string, roots: Roots, timeoutMs: number): Promise<string[]> {
  const written = normalizeRuntimePathForComparison(path)
  if (isWslUncPath(path) || !isInsideAnyRoot(roots, path)) {
    return [written]
  }
  try {
    const resolved = await withinMs(realpath(path), timeoutMs)
    return resolved === TIMED_OUT
      ? [written]
      : [written, normalizeRuntimePathForComparison(resolved)]
  } catch {
    return [written]
  }
}

/** Keys of every local directory Orca already shows: projects, their main checkouts, workspaces. */
export async function collectTrackedFolderKeys(args: {
  repos: readonly TrackedRepo[]
  folderWorkspaces: readonly TrackedFolderWorkspace[]
  localWorktreeIds: readonly string[]
  roots: Roots
  callTimeoutMs?: number
}): Promise<Set<string>> {
  const timeoutMs = args.callTimeoutMs ?? FOLDER_SEARCH_CALL_TIMEOUT_MS
  const localRepos = args.repos.filter(isLocalRecord)
  const paths = localRepos.map((repo) => repo.path)
  // A repo registered at a linked worktree also tracks its main checkout. Only repos inside a root can
  // hide a scanned folder this way; reading any other path would be an arbitrary probe.
  const mainCheckouts = await Promise.all(
    localRepos
      .filter(
        (repo) =>
          !isFolderRepo(repo) && !isWslUncPath(repo.path) && isInsideAnyRoot(args.roots, repo.path)
      )
      .map(async (repo) => {
        const marker = await withinMs(readGitMarker(repo.path), timeoutMs)
        return marker !== TIMED_OUT && marker?.kind === 'linked-worktree'
          ? marker.mainCheckoutPath
          : null
      })
  )
  paths.push(...mainCheckouts.filter((path): path is string => path !== null))
  paths.push(
    ...args.folderWorkspaces.filter(isLocalRecord).map((workspace) => workspace.folderPath)
  )
  for (const worktreeId of args.localWorktreeIds) {
    const parsed = splitWorktreeIdForFilesystem(worktreeId)
    if (parsed?.worktreePath) {
      paths.push(parsed.worktreePath)
    }
  }
  const keys = await Promise.all(
    [...new Set(paths)].map((path) => trackedKeysFor(path, args.roots, timeoutMs))
  )
  return new Set(keys.flat())
}

/** Drops folders Orca tracks or manages, and linked worktrees whose main checkout Orca tracks. */
export async function dropTrackedFolders(
  folders: readonly ScannedFolder[],
  trackedKeys: ReadonlySet<string>,
  options: { roots: Roots; managedDirs: readonly string[]; callTimeoutMs?: number }
): Promise<ScannedFolder[]> {
  const timeoutMs = options.callTimeoutMs ?? FOLDER_SEARCH_CALL_TIMEOUT_MS
  const hidden = await Promise.all(
    folders.map(async (folder) => {
      // Scanned paths are built from a real root and never cross a link, so they need no lookup.
      const own = folder.realPath ?? folder.path
      if (
        trackedKeys.has(normalizeRuntimePathForComparison(own)) ||
        options.managedDirs.some((dir) => isPathInsideOrEqual(dir, own))
      ) {
        return true
      }
      const main = folder.kind === 'linked-worktree' ? folder.mainCheckoutPath : null
      if (main === null) {
        return false
      }
      // `main` comes from the folder's own .git file: it is read only when it points into a search root.
      const keys = await trackedKeysFor(main, options.roots, timeoutMs)
      return keys.some((key) => trackedKeys.has(key))
    })
  )
  return folders.filter((_folder, index) => !hidden[index])
}
