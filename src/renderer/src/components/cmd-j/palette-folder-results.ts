import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { getRuntimePathBasename } from '../../../../shared/file-access/cross-platform-path'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import { comparePaletteRankedItems } from '@/lib/workspace/search/palette/cmd-j-section-leadership'
import type { PaletteDocumentRank } from '../../../../shared/palette-match/palette-document'
import { matchPaletteExtraFields, type PaletteExtraResult } from './palette-extra-results'

/** The section previews the best matches only; the palette's own cap of 50 would bury Workspaces. */
const FOLDER_SECTION_ROW_LIMIT = 6

export function folderPaletteEntryId(entry: FolderSearchEntry): string {
  // The same path on two computers is two destinations; keep existing local row identities.
  return entry.executionHostId && entry.executionHostId !== LOCAL_EXECUTION_HOST_ID
    ? encodePaletteIdentity([entry.executionHostId, entry.path])
    : entry.path
}

export function folderParentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed
    .slice(0, trimmed.length - getRuntimePathBasename(trimmed).length)
    .replace(/[\\/]+$/, '')
}

type RankedFolder = {
  entry: FolderSearchEntry
  rank: PaletteDocumentRank
  order: number
  title: string
  titleRanges: PaletteExtraResult['titleRanges']
}

/** Name is the primary field and the parent path the secondary one, so "personal orca" finds ~/personal/orca. */
export function buildFolderPaletteResults(
  entries: readonly FolderSearchEntry[],
  query: string,
  actions: {
    onOpen: (entry: FolderSearchEntry) => void
    /** Cmd/Ctrl+Enter; offered only on an untracked git root, the one folder a project can be added from at once. */
    onNewWorktree?: (entry: FolderSearchEntry) => void
    /** Row ornaments (icon, parent path) stay with the React code. */
    decorate: (
      entry: FolderSearchEntry
    ) => Pick<PaletteExtraResult, 'leading' | 'line' | 'trailing'>
  },
  rowLimit = FOLDER_SECTION_ROW_LIMIT
): PaletteExtraResult[] {
  const ranked: RankedFolder[] = []
  entries.forEach((entry, order) => {
    const name = getRuntimePathBasename(entry.path)
    const match = matchPaletteExtraFields(
      folderPaletteEntryId(entry),
      [
        { id: 'name', text: name, role: 'primary' },
        { id: 'path', text: folderParentPath(entry.path), role: 'secondary' }
      ],
      query
    )
    if (!match) {
      return
    }
    ranked.push({
      entry,
      rank: match.rank,
      order,
      title: name,
      titleRanges: match.rangesByField.get('name') ?? []
    })
  })
  ranked.sort((a, b) =>
    comparePaletteRankedItems(
      { rank: a.rank, order: a.order, identity: folderPaletteEntryId(a.entry) },
      { rank: b.rank, order: b.order, identity: folderPaletteEntryId(b.entry) }
    )
  )
  // The match only orders the rows inside this section. Giving the palette a rank or a quality would let a
  // folder lead the list or take Enter ahead of workspaces and actions, so the rows go in unranked, in this order.
  return ranked.slice(0, rowLimit).map(({ entry, title, titleRanges }, order) => ({
    id: folderPaletteEntryId(entry),
    title,
    titleRanges,
    rank: null,
    qualityClass: null,
    lastActiveAt: null,
    order,
    ...actions.decorate(entry),
    onSelect: () => actions.onOpen(entry),
    ...(entry.kind === 'git-root' && actions.onNewWorktree
      ? { onModEnter: () => actions.onNewWorktree?.(entry) }
      : {})
  }))
}
