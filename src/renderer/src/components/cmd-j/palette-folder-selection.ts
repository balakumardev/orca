import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import { getNextWorktreePaletteSelection } from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { PROJECT_CREATE_SOURCE_ID } from './palette-project-create-source-id'
import { SESSION_SOURCE_ID } from './palette-session-source-id'

export const FOLDER_SOURCE_ID = 'folders'

// Rows that act on projects, the disk or a past conversation: reached by moving to them, never by a typed Enter.
const UNARMED_ROW_ID_PREFIXES = [FOLDER_SOURCE_ID, PROJECT_CREATE_SOURCE_ID, SESSION_SOURCE_ID].map(
  (sourceId) => encodePaletteIdentity(['extra', sourceId])
)

export function isUnarmedByDefaultPaletteItemId(itemId: string): boolean {
  return UNARMED_ROW_ID_PREFIXES.some((prefix) => itemId.startsWith(prefix))
}

/**
 * What Enter arms when a query is typed and the user has not moved the highlight. A folder, a "New worktree
 * in <Project>" row or a past session is never that default: adding a project, starting a worktree or resuming
 * a conversation from a typed Enter would be a surprise, so those rows are reached with the arrow keys. One the user moved to stays selected.
 */
export function getNextPaletteSelectionWithoutFolderDefault(
  args: Parameters<typeof getNextWorktreePaletteSelection>[0]
): string {
  const keepsCurrentFolder = !args.queryChanged
  return getNextWorktreePaletteSelection({
    ...args,
    selectableItemIds: args.selectableItemIds.filter(
      (id) =>
        !isUnarmedByDefaultPaletteItemId(id) ||
        (keepsCurrentFolder && id === args.currentSelectedItemId)
    )
  })
}

/**
 * cmdk marks the first row selected by itself whenever the query changes. When that row is a folder, a
 * "New worktree" row or a session and the user has not moved the highlight since the query changed, the selection goes to
 * the row cmdk would have picked without them, so Enter does what it did before those sections existed. A move
 * for an earlier query does not count.
 */
export function keepFolderOffAutoSelection(args: {
  nextItemId: string
  selectableItemIds: readonly string[]
  movedSinceQueryChange: boolean
}): string {
  const { nextItemId, selectableItemIds } = args
  if (
    args.movedSinceQueryChange ||
    !isUnarmedByDefaultPaletteItemId(nextItemId) ||
    nextItemId !== selectableItemIds[0]
  ) {
    return nextItemId
  }
  return selectableItemIds.find((id) => !isUnarmedByDefaultPaletteItemId(id)) ?? ''
}
