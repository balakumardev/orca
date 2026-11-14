import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import { getNextWorktreePaletteSelection } from '@/lib/workspace/search/worktrees/worktree-palette-create-action'

export const FOLDER_SOURCE_ID = 'folders'

const FOLDER_ROW_ID_PREFIX = encodePaletteIdentity(['extra', FOLDER_SOURCE_ID])

export function isFolderPaletteItemId(itemId: string): boolean {
  return itemId.startsWith(FOLDER_ROW_ID_PREFIX)
}

/**
 * What Enter arms when a query is typed and the user has not moved the highlight. A folder is never that
 * default: adding a project from a typed Enter would be a surprise, so folders are reached with the arrow
 * keys. A folder the user moved to stays selected.
 */
export function getNextPaletteSelectionWithoutFolderDefault(
  args: Parameters<typeof getNextWorktreePaletteSelection>[0]
): string {
  const keepsCurrentFolder = !args.queryChanged
  return getNextWorktreePaletteSelection({
    ...args,
    selectableItemIds: args.selectableItemIds.filter(
      (id) =>
        !isFolderPaletteItemId(id) || (keepsCurrentFolder && id === args.currentSelectedItemId)
    )
  })
}

/**
 * cmdk marks the first row selected by itself whenever the query changes. When that row is a folder and
 * the user has not moved the highlight since the query changed, the selection goes to the row cmdk would
 * have picked without folders, so Enter does what it did before this section existed. A move for an
 * earlier query does not count.
 */
export function keepFolderOffAutoSelection(args: {
  nextItemId: string
  selectableItemIds: readonly string[]
  movedSinceQueryChange: boolean
}): string {
  const { nextItemId, selectableItemIds } = args
  if (
    args.movedSinceQueryChange ||
    !isFolderPaletteItemId(nextItemId) ||
    nextItemId !== selectableItemIds[0]
  ) {
    return nextItemId
  }
  return selectableItemIds.find((id) => !isFolderPaletteItemId(id)) ?? ''
}
