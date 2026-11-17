import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import type { FolderSearchEntry, FolderSearchResult } from '../../shared/folder-search-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { getDefaultWorkspaceDir } from '../../shared/constants'
import { getFolderSearchLocations } from '../../shared/folder-search-settings'
import { getEffectiveHostSetting } from '../../shared/host-setting-overrides'
import { buildKnownOrcaWorkspaceLayouts } from '../../shared/worktree/ownership'
import { readGitMarker } from './git-marker'
import {
  deriveFolderSearchRoots,
  isLocalDiskRepo,
  type FolderSearchRoot
} from './folder-search-roots'
import {
  scanFolderRoots,
  type FolderScanLimits,
  type FolderScanResult,
  type ScannedFolder
} from './folder-search-scan'
import { collectTrackedFolderKeys, dropTrackedFolders } from './folder-search-tracked-paths'
import { FOLDER_SEARCH_CALL_TIMEOUT_MS, TIMED_OUT, withinMs } from './folder-search-time'

/** A palette open older than this scans again; opens inside it share the last scan. */
export const FOLDER_SEARCH_CACHE_TTL_MS = 10_000

export type FolderSearchStore = {
  getRepos(): Repo[]
  getFolderWorkspaces(): FolderWorkspace[]
  getAllWorktreeMetaForHost(hostId: ExecutionHostId): Record<string, unknown>
  getSettings(): GlobalSettings
}

type CachedScan = {
  key: string
  scannedAt: number
  roots: FolderSearchRoot[]
  scan: FolderScanResult
}

/** Directories Orca creates workspaces in: the global one, its history, and each project's own. */
export function managedWorkspaceDirs(
  settings: GlobalSettings,
  home: string,
  repos: readonly Repo[]
): string[] {
  const configured = getEffectiveHostSetting(
    settings,
    LOCAL_EXECUTION_HOST_ID,
    'defaultWorktreeLocation',
    settings.workspaceDir ?? ''
  ).trim()
  const layouts = [undefined, ...repos.filter(isLocalDiskRepo)].flatMap((repo) =>
    buildKnownOrcaWorkspaceLayouts(settings, repo).map((layout) => layout.path)
  )
  return [...new Set([getDefaultWorkspaceDir(home), configured, ...layouts])].filter(
    (dir) => dir.length > 0
  )
}

const keyOf = (path: string): string => normalizeRuntimePathForComparison(path)

function toEntry(folder: ScannedFolder): FolderSearchEntry {
  return { path: folder.path, kind: folder.kind, realPath: folder.realPath ?? folder.path }
}

/**
 * Lists folders in the saved local search locations. The raw scan is cached by search-root set; tracked
 * folders are removed on every call, so adding or removing a project shows at once without a rescan.
 */
export function createFolderSearchService(options: {
  store: FolderSearchStore
  homeDir?: string
  ttlMs?: number
  limits?: Partial<FolderScanLimits>
  maxRoots?: number
  now?: () => number
  scan?: typeof scanFolderRoots
}): {
  list: () => Promise<FolderSearchResult>
  resolve: (path: string) => Promise<FolderSearchEntry | null>
} {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? FOLDER_SEARCH_CACHE_TTL_MS
  const timeoutMs = options.limits?.callTimeoutMs ?? FOLDER_SEARCH_CALL_TIMEOUT_MS
  let cache: CachedScan | null = null
  let inFlight: { key: string; promise: Promise<CachedScan> } | null = null
  /** What the last list call offered, by path and real path: the only folders `resolve` will answer for. */
  let offered: { roots: FolderSearchRoot[]; byKey: Map<string, ScannedFolder> } | null = null

  const scanRoots = async (key: string, roots: FolderSearchRoot[]): Promise<CachedScan> => {
    const scan = await (options.scan ?? scanFolderRoots)({ roots, limits: options.limits })
    const fresh = { key, scannedAt: now(), roots, scan }
    // A scan that hung or ran out of time is partial; the next call should try again, not reuse it.
    cache = scan.timedOut ? null : fresh
    return fresh
  }

  const visibleFolders = async (
    folders: readonly ScannedFolder[],
    roots: FolderSearchRoot[],
    repos: Repo[]
  ): Promise<ScannedFolder[]> => {
    const { store } = options
    // Registered parent aliases are filtering-only roots; saved locations still define what is scanned.
    const parents = [...new Set(repos.filter(isLocalDiskRepo).map((repo) => dirname(repo.path)))]
    const parentRoots = await deriveFolderSearchRoots({
      locations: parents,
      homeDir: options.homeDir ?? homedir(),
      managedWorkspaceDirs: [],
      maxRoots: parents.length,
      callTimeoutMs: timeoutMs
    })
    const filterRoots = [...roots, ...parentRoots.roots]
    const tracked = await collectTrackedFolderKeys({
      repos,
      folderWorkspaces: store.getFolderWorkspaces(),
      localWorktreeIds: Object.keys(store.getAllWorktreeMetaForHost(LOCAL_EXECUTION_HOST_ID)),
      roots: filterRoots,
      callTimeoutMs: timeoutMs
    })
    return dropTrackedFolders(folders, tracked, {
      roots: filterRoots,
      managedDirs: managedWorkspaceDirs(store.getSettings(), options.homeDir ?? homedir(), repos),
      callTimeoutMs: timeoutMs
    })
  }

  return {
    async list() {
      const { store } = options
      const home = options.homeDir ?? homedir()
      const repos = store.getRepos()
      const derived = await deriveFolderSearchRoots({
        // Home is the first-run fallback; discovery never depends on a registered project.
        locations: getFolderSearchLocations(store.getSettings()),
        homeDir: home,
        managedWorkspaceDirs: managedWorkspaceDirs(store.getSettings(), home, repos),
        maxRoots: options.maxRoots,
        callTimeoutMs: timeoutMs
      })
      // Editing an alias spelling must refresh both displayed paths and tracked-path comparisons.
      const key = JSON.stringify(derived.roots)
      let scanned: CachedScan
      if (cache && cache.key === key && now() - cache.scannedAt < ttlMs) {
        scanned = cache
      } else {
        // Concurrent palette opens share one scan instead of walking the disk twice.
        let running = inFlight?.key === key ? inFlight.promise : undefined
        if (!running) {
          const started: Promise<CachedScan> = scanRoots(key, derived.roots).finally(() => {
            if (inFlight?.promise === started) {
              inFlight = null
            }
          })
          running = started
          inFlight = { key, promise: started }
        }
        scanned = await running
      }
      const byKey = new Map<string, ScannedFolder>()
      for (const folder of scanned.scan.folders) {
        byKey.set(keyOf(folder.path), folder)
        byKey.set(keyOf(folder.realPath ?? folder.path), folder)
      }
      offered = { roots: scanned.roots, byKey }
      const visible = await visibleFolders(scanned.scan.folders, scanned.roots, repos)
      return {
        entries: visible.map(toEntry),
        truncated: scanned.scan.truncated || derived.timedOut
      }
    },

    async resolve(path) {
      const held = offered
      const folder = held?.byKey.get(keyOf(path))
      if (!held || !folder) {
        return null
      }
      // Only the folder main itself listed is read, and only at the real path main recorded for it.
      const target = folder.realPath ?? folder.path
      const stat = await withinMs(lstat(target), timeoutMs).catch(() => null)
      if (stat === TIMED_OUT || !stat?.isDirectory()) {
        cache = null
        return null
      }
      const marker = await withinMs(readGitMarker(target), timeoutMs)
      const fresh: ScannedFolder = {
        ...folder,
        kind: marker === TIMED_OUT || marker === null ? 'folder' : marker.kind,
        mainCheckoutPath:
          marker !== TIMED_OUT && marker?.kind === 'linked-worktree'
            ? marker.mainCheckoutPath
            : null
      }
      const [visible] = await visibleFolders([fresh], held.roots, options.store.getRepos())
      return visible ? toEntry(visible) : null
    }
  }
}
