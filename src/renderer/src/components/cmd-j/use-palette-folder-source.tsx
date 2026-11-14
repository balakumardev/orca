import { useEffect, useMemo, useState } from 'react'
import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { buildFolderPaletteResults } from './palette-folder-results'
import { PaletteFolderLeading, PaletteFolderParentLine } from './palette-folder-row-parts'
import { openFolderEntryInApp } from './palette-folder-open-in-app'
import { FOLDER_SOURCE_ID } from './palette-folder-selection'
import type { PaletteExtraSource } from './palette-extra-results'

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

/**
 * Folders next to registered local projects, shown only while a query is typed. Desktop only: the scan and
 * the add both name the local host explicitly, so the focused server does not change what this section means.
 */
export function usePaletteFolderSource({
  query,
  visible
}: {
  query: string
  visible: boolean
}): PaletteExtraSource | null {
  const desktop = !isWebClientLocation()
  const [list, setList] = useState<FolderList>(NO_FOLDERS)
  useEffect(() => {
    // A closing palette keeps its rows until it has faded out; the next open starts from none.
    if (!visible) {
      return
    }
    setList(NO_FOLDERS)
    // Other preloads, and test windows, carry no folder search bridge.
    if (!desktop || typeof window.api?.folderSearch?.list !== 'function') {
      return
    }
    let cancelled = false
    // One read per palette open; keystrokes only re-rank this list. Main reuses a scan younger than 10 s.
    window.api.folderSearch
      .list()
      .then((result) => {
        if (!cancelled) {
          setList(readFolderList(result))
        }
      })
      // A failed scan leaves the section empty; the rest of the palette works without it.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [desktop, visible])

  return useMemo(() => {
    if (query.length === 0 || list.entries.length === 0) {
      return null
    }
    const results = buildFolderPaletteResults(list.entries, query, {
      onOpen: (entry) => void openFolderEntryInApp(entry),
      decorate: (entry) => ({
        leading: <PaletteFolderLeading kind={entry.kind} />,
        line: <PaletteFolderParentLine path={entry.path} />
      })
    })
    if (results.length === 0) {
      return null
    }
    return {
      id: FOLDER_SOURCE_ID,
      sectionLabel: (t) =>
        list.truncated
          ? t('auto.components.WorktreeJumpPalette.foldersPartialHeader', 'Folders (partial list)')
          : t('auto.components.WorktreeJumpPalette.foldersHeader', 'Folders'),
      emptyQueryCap: 0,
      typedPlacement: 'after-workspaces',
      leadsOnTie: false,
      results
    } satisfies PaletteExtraSource
  }, [list, query])
}
