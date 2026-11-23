import type { FolderSearchEntry } from '../../shared/folder-search-types'
import { normalizeRuntimePathForComparison } from '../../shared/file-access/cross-platform-path'
import type { FolderSearchRoot } from './folder-search-roots'
import { FOLDER_SEARCH_CALL_TIMEOUT_MS } from './folder-search-time'
import { walkSearchRoot } from './folder-search-walk'

export type ScannedFolder = FolderSearchEntry & {
  /** Where a linked worktree's shared checkout lives, when it could be read. */
  mainCheckoutPath: string | null
}

export type FolderScanLimits = {
  maxEntries: number
  /** The whole scan answers by then, with what it has. */
  budgetMs: number
  /** All directories are listed down to this depth below a search root. */
  maxDepth: number
  /** One read that takes longer ends that root's walk. */
  callTimeoutMs: number
}

export const DEFAULT_FOLDER_SCAN_LIMITS: FolderScanLimits = {
  maxEntries: 3000,
  budgetMs: 2000,
  maxDepth: 3,
  callTimeoutMs: FOLDER_SEARCH_CALL_TIMEOUT_MS
}

export type FolderScanResult = {
  folders: ScannedFolder[]
  /** The entry cap or the time ran out, or a read hung: some folders may be missing. */
  truncated: boolean
  /** The time ran out or a read hung, so a later scan may find more. */
  timedOut: boolean
}

/**
 * Walks the roots in turns, one batch of folders each, so a cap or a deadline cuts every root short by
 * a similar amount instead of leaving the last roots empty. Folders that two roots both reach are listed once.
 */
export async function scanFolderRoots(args: {
  roots: readonly FolderSearchRoot[]
  limits?: Partial<FolderScanLimits>
}): Promise<FolderScanResult> {
  const limits = { ...DEFAULT_FOLDER_SCAN_LIMITS, ...args.limits }
  const folders: ScannedFolder[] = []
  const seen = new Set<string>()
  let capped = false
  let slowRead = false
  let finished = false
  const walkers = args.roots.map((root) =>
    walkSearchRoot(root, limits, () => {
      slowRead = true
    })
  )

  const walk = async (): Promise<void> => {
    let active = walkers
    while (active.length > 0 && !capped && !finished) {
      const stillActive: typeof walkers = []
      for (const walker of active) {
        const step = await walker.next()
        if (finished || step.done) {
          continue
        }
        stillActive.push(walker)
        for (const folder of step.value) {
          const key = normalizeRuntimePathForComparison(folder.realPath ?? folder.path)
          if (seen.has(key)) {
            continue
          }
          if (folders.length >= limits.maxEntries) {
            capped = true
            break
          }
          seen.add(key)
          folders.push(folder)
        }
        if (capped) {
          break
        }
      }
      active = stillActive
    }
  }

  let deadline: ReturnType<typeof setTimeout> | undefined
  const outOfTime = new Promise<'out-of-time'>((resolve) => {
    deadline = setTimeout(() => resolve('out-of-time'), limits.budgetMs)
    deadline.unref?.()
  })
  const outcome = await Promise.race([walk().then(() => 'walked' as const), outOfTime])
  clearTimeout(deadline)
  finished = true
  // A walker waiting on a hung read never reaches its return, so these are not awaited.
  for (const walker of walkers) {
    void walker.return(undefined).catch(() => {})
  }
  const timedOut = outcome === 'out-of-time' || slowRead
  return { folders: [...folders], truncated: capped || timedOut, timedOut }
}
