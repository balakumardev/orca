import type { AiVaultSearchStatus } from '../../../../shared/ai-vault/search/ai-vault-search-types'
import { isWorktreePaletteQueryTooLarge } from '../../../../shared/palette-match/worktree-palette-query-bounds'

/** One character matches nearly every transcript, so the section waits for a second. */
const SESSION_SEARCH_MIN_QUERY_LENGTH = 2

/**
 * The trimmed query to search for, or null while it is too short. Also null for a query the palette itself
 * refuses (pasted text): it then shows no Create row, so a transcript could become the first row Enter acts on.
 */
export function sessionSearchQuery(query: string): string | null {
  const trimmed = query.trim()
  if (isWorktreePaletteQueryTooLarge(trimmed)) {
    return null
  }
  return Array.from(trimmed).length >= SESSION_SEARCH_MIN_QUERY_LENGTH ? trimmed : null
}

/**
 * Whether the first full pass over the transcripts has finished. Not `phase === 'current'`: the phase reads
 * `indexing` whenever a transcript changed since the last pass, which is most of the time while an agent runs.
 */
export function isSessionIndexReady(
  status: Pick<AiVaultSearchStatus, 'enabled' | 'phase' | 'lastSweepCompletedAt'>
): boolean {
  return status.enabled && status.phase !== 'closed' && status.lastSweepCompletedAt !== null
}
