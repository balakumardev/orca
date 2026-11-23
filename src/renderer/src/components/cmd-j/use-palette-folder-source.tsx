import { useEffect, useMemo, useState } from 'react'
import {
  FOLDER_SEARCH_CAPABILITY,
  type FolderSearchEntry
} from '../../../../shared/folder-search-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { PaletteHostBadgeChip } from '../worktree-jump/rows/worktree-jump-palette-row-content'
import { buildFolderPaletteResults } from './palette-folder-results'
import { PaletteFolderLeading, PaletteFolderParentLine } from './palette-folder-row-parts'
import { addFolderAndBeginNameStepInApp, openFolderEntryInApp } from './palette-folder-open-in-app'
import { FOLDER_SOURCE_ID } from './palette-folder-selection'
import type { PaletteExtraSource } from './palette-extra-results'
import { isPaletteSearchHostCurrent } from './palette-search-hosts'
import { usePaletteSearchHosts } from './use-palette-search-hosts'

type FolderList = { entries: readonly FolderSearchEntry[]; truncated: boolean }

const NO_FOLDERS: FolderList = { entries: [], truncated: false }

function isFolderSearchEntry(value: unknown): value is FolderSearchEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof value.path === 'string' &&
    'kind' in value &&
    (value.kind === 'git-root' || value.kind === 'linked-worktree' || value.kind === 'folder')
  )
}

/** The web fallback answers any list call with [], so a missing desktop bridge reads as no folders. */
function readFolderList(result: unknown): FolderList {
  if (typeof result !== 'object' || result === null || !('entries' in result)) {
    return NO_FOLDERS
  }
  return {
    entries: Array.isArray(result.entries) ? result.entries.filter(isFolderSearchEntry) : [],
    truncated: 'truncated' in result && result.truncated === true
  }
}

/** Each connected computer scans its own locations; keystrokes only rank the returned folders. */
export function usePaletteFolderSource({
  query,
  visible,
  hostIds,
  repoIds
}: {
  query: string
  visible: boolean
  hostIds?: readonly string[]
  repoIds?: readonly string[]
}): PaletteExtraSource | null {
  const desktop = !isWebClientLocation()
  const connectedHosts = usePaletteSearchHosts(hostIds)
  const hosts = useMemo(
    () =>
      connectedHosts.filter(
        (host) =>
          host.executionHostId === LOCAL_EXECUTION_HOST_ID ||
          host.capabilities.includes(FOLDER_SEARCH_CAPABILITY)
      ),
    [connectedHosts]
  )
  const repositoryScoped = Boolean(repoIds?.length)
  const [lists, setLists] = useState<ReadonlyMap<string, FolderList>>(new Map())
  useEffect(() => {
    // A closing palette keeps its rows until it has faded out; the next open starts from none.
    if (!visible) {
      return
    }
    setLists(new Map())
    // Other preloads, and test windows, carry no folder search bridge.
    if (!desktop || repositoryScoped || typeof window.api?.folderSearch?.list !== 'function') {
      return
    }
    let cancelled = false
    // Publish each leg independently so a slow or failed server never holds local results back.
    for (const host of hosts) {
      const request = host.runtimeEnvironmentId
        ? window.api.folderSearch.list(host.executionHostId)
        : window.api.folderSearch.list()
      request
        .then((result) => {
          if (!cancelled && isPaletteSearchHostCurrent(host)) {
            setLists((current) => new Map(current).set(host.key, readFolderList(result)))
          }
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [desktop, hosts, repositoryScoped, visible])

  return useMemo(() => {
    if (!desktop || repositoryScoped || query.length === 0) {
      return null
    }
    const entries = hosts.flatMap((host) =>
      (lists.get(host.key)?.entries ?? []).map((entry) => ({
        ...entry,
        executionHostId: host.executionHostId
      }))
    )
    const hostFor = (entry: FolderSearchEntry) =>
      hosts.find((host) => host.executionHostId === entry.executionHostId)!
    const results = buildFolderPaletteResults(entries, query, {
      onOpen: (entry) => void openFolderEntryInApp(entry, hostFor(entry)),
      onNewWorktree: (entry) => {
        const host = hostFor(entry)
        void addFolderAndBeginNameStepInApp(entry, host).then((added) => {
          // Main stops offering a folder once it is a project, so the row must not stay to be pressed again.
          if (added) {
            setLists((current) => {
              const list = current.get(host.key)
              return list
                ? new Map(current).set(host.key, {
                    ...list,
                    entries: list.entries.filter((candidate) => candidate.path !== entry.path)
                  })
                : current
            })
          }
        })
      },
      decorate: (entry) => ({
        leading: <PaletteFolderLeading kind={entry.kind} />,
        line: <PaletteFolderParentLine path={entry.path} />,
        trailing:
          hosts.length > 1 || entry.executionHostId !== LOCAL_EXECUTION_HOST_ID ? (
            <PaletteHostBadgeChip
              badge={{ hostId: hostFor(entry).executionHostId, label: hostFor(entry).label }}
            />
          ) : undefined
      })
    })
    if (results.length === 0) {
      return null
    }
    return {
      id: FOLDER_SOURCE_ID,
      sectionLabel: (t) =>
        hosts.some((host) => lists.get(host.key)?.truncated)
          ? t('auto.components.WorktreeJumpPalette.foldersPartialHeader', 'Folders (partial list)')
          : t('auto.components.WorktreeJumpPalette.foldersHeader', 'Folders'),
      emptyQueryCap: 0,
      typedPlacement: 'after-workspaces',
      leadsOnTie: false,
      results
    } satisfies PaletteExtraSource
  }, [desktop, hosts, lists, query, repositoryScoped])
}
