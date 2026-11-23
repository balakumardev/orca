import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'

/**
 * The worktree a picked linked worktree became in its project. Git records the path as it was typed
 * when the worktree was made, which can differ from the folder's spelling on disk only in letter case,
 * so after an exact match this accepts a case-only match, but only when exactly one worktree has it.
 */
export function pickLinkedWorktree(
  worktrees: readonly Worktree[],
  entry: Pick<FolderSearchEntry, 'path' | 'realPath'>
): Worktree | null {
  const pickedPaths = [entry.path, entry.realPath]
    .filter((path): path is string => Boolean(path))
    .map(normalizeRuntimePathForComparison)
  const exact = worktrees.find((worktree) =>
    pickedPaths.includes(normalizeRuntimePathForComparison(worktree.path))
  )
  if (exact) {
    return exact
  }
  const pickedLowercase = new Set(pickedPaths.map((path) => path.toLowerCase()))
  const sameUpToCase = worktrees.filter((worktree) =>
    pickedLowercase.has(normalizeRuntimePathForComparison(worktree.path).toLowerCase())
  )
  return sameUpToCase.length === 1 ? sameUpToCase[0] : null
}
