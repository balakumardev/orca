import type { AiVaultSearchHit } from '../../../../shared/ai-vault/search/ai-vault-search-types'
import { matchPaletteExtraFields, type PaletteExtraResult } from './palette-extra-results'

/** The section previews the best transcript hits only; the palette's own cap of 50 would bury Workspaces and Create. */
const SESSION_SECTION_ROW_LIMIT = 5

/** One row per conversation: a transcript can be listed under more than one hit key. */
export function paletteSessionHitId(hit: AiVaultSearchHit): string {
  return JSON.stringify([hit.agent, hit.sessionId, hit.source.filePath ?? ''])
}

/** The title, or the given placeholder when the transcript has none. */
export function paletteSessionTitle(hit: AiVaultSearchHit, untitled: string): string {
  return hit.title.trim() || untitled
}

export function buildSessionPaletteResults(
  hits: readonly AiVaultSearchHit[],
  query: string,
  actions: {
    untitled: string
    onOpen: (hit: AiVaultSearchHit) => void
    /** True when Enter on the row has nowhere to go. */
    isInert: (hit: AiVaultSearchHit) => boolean
    /** Row ornaments (icon, project line, snippet) stay with the React code. */
    decorate: (hit: AiVaultSearchHit) => Pick<PaletteExtraResult, 'leading' | 'line'>
  },
  rowLimit = SESSION_SECTION_ROW_LIMIT
): PaletteExtraResult[] {
  const seen = new Set<string>()
  const results: PaletteExtraResult[] = []
  for (const hit of hits) {
    const id = paletteSessionHitId(hit)
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    const title = paletteSessionTitle(hit, actions.untitled)
    const updatedAt = hit.updatedAt === null ? Number.NaN : Date.parse(hit.updatedAt)
    // The index already ranked the hits by relevance. The palette gets no rank and no quality, so a transcript
    // hit never leads the list or takes Enter ahead of workspaces and actions; `order` keeps the index order.
    results.push({
      id,
      title,
      titleRanges:
        matchPaletteExtraFields(
          id,
          [{ id: 'title', text: title, role: 'primary' }],
          query
        )?.rangesByField.get('title') ?? [],
      rank: null,
      qualityClass: null,
      lastActiveAt: Number.isNaN(updatedAt) ? null : updatedAt,
      order: results.length,
      inert: actions.isInert(hit),
      ...actions.decorate(hit),
      onSelect: () => actions.onOpen(hit)
    })
    if (results.length === rowLimit) {
      break
    }
  }
  return results
}
