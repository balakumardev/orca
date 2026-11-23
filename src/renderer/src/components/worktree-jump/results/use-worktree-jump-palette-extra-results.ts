import { useMemo } from 'react'
import { usePaletteExtraSources } from '@/components/cmd-j/palette-extra-sources'
import {
  BOT_PALETTE_SOURCE_ID,
  type PaletteExtraSource
} from '@/components/cmd-j/palette-extra-results'
import { FOLDER_SOURCE_ID } from '@/components/cmd-j/palette-folder-selection'
import { SESSION_SOURCE_ID } from '@/components/cmd-j/palette-session-source-id'
import { comparePaletteRankedItems } from '@/lib/workspace/search/palette/cmd-j-section-leadership'
import {
  encodePaletteIdentity,
  preparePaletteActivity,
  type PaletteSearchContext
} from '../../../../../shared/palette-match/palette-ranking'
import type { ExtraPaletteItem } from '../worktree-jump-palette-model'
import type { WorktreeJumpPaletteLocalState } from '../state/use-worktree-jump-palette-local-state'

const FILTER_AWARE_SOURCE_IDS: ReadonlySet<string> = new Set([
  BOT_PALETTE_SOURCE_ID,
  FOLDER_SOURCE_ID,
  SESSION_SOURCE_ID
])

export type PaletteExtraSection = { source: PaletteExtraSource; items: ExtraPaletteItem[] }

export function useWorktreeJumpPaletteExtraResults({
  paletteSearchQuery,
  paletteSearchContext,
  visible,
  filter,
  filterActive,
  taskSourceUrl,
  scoped
}: Pick<WorktreeJumpPaletteLocalState, 'paletteSearchQuery' | 'taskSourceUrl' | 'filter'> & {
  paletteSearchContext: PaletteSearchContext
  visible: boolean
  filterActive: boolean
  /** Showing only bots: filters are paused and only the Bots source lists. */
  scoped: boolean
}) {
  // Scope before fetching: a URL is a task action; host and repository filters belong to each source.
  const { sources: allSources, hidesWorkspace: hidesPaletteWorkspace } = usePaletteExtraSources({
    query: paletteSearchQuery,
    visible,
    scoped,
    hostSearch: !scoped && !taskSourceUrl,
    hostIds: filter.hostIds,
    repoIds: filter.repoIds
  })
  // Chips filter workspaces, not bots; folders and conversations apply them themselves. A task URL scopes every source.
  const sources = useMemo(
    () =>
      allSources.filter((source) =>
        scoped
          ? source.id === BOT_PALETTE_SOURCE_ID
          : !taskSourceUrl && (!filterActive || FILTER_AWARE_SOURCE_IDS.has(source.id))
      ),
    [allSources, filterActive, scoped, taskSourceUrl]
  )
  const hasQuery = paletteSearchQuery.length > 0
  const botSource = allSources.find((source) => source.id === BOT_PALETTE_SOURCE_ID)
  const botCatalogSize = botSource?.catalogSize ?? 0
  const extraSections = useMemo<PaletteExtraSection[]>(() => {
    const ranked = (item: ExtraPaletteItem) => ({
      rank: item.result.rank,
      order: item.result.order,
      identity: item.id,
      activity: preparePaletteActivity(item.result.lastActiveAt, paletteSearchContext)
    })
    return sources
      .map((source) => {
        const items = source.results.map((result): ExtraPaletteItem => ({
          id: encodePaletteIdentity(['extra', source.id, result.id]),
          type: 'extra',
          sourceId: source.id,
          result
        }))
        items.sort((a, b) =>
          hasQuery
            ? comparePaletteRankedItems(ranked(a), ranked(b))
            : a.result.order - b.result.order
        )
        return { source, items }
      })
      .filter((section) => section.items.length > 0)
  }, [hasQuery, paletteSearchContext, sources])
  return { extraSections, hidesPaletteWorkspace, botCatalogSize }
}

export type WorktreeJumpPaletteExtraResults = ReturnType<typeof useWorktreeJumpPaletteExtraResults>
