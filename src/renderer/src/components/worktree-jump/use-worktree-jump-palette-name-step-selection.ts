import { useCallback } from 'react'
import { PROJECT_CREATE_SOURCE_ID } from '@/components/cmd-j/palette-project-create-source-id'
import type { PaletteItem } from './worktree-jump-palette-model'

/**
 * Picking a "New worktree in <Project>" row starts the name step in the open palette; every other row keeps
 * the palette's own selection, which closes it.
 */
export function useWorktreeJumpPaletteNameStepSelection(
  handleSelectItem: (item: PaletteItem) => void
): (item: PaletteItem) => void {
  return useCallback(
    (item: PaletteItem) => {
      if (item.type === 'extra' && item.sourceId === PROJECT_CREATE_SOURCE_ID) {
        item.result.onSelect()
        return
      }
      handleSelectItem(item)
    },
    [handleSelectItem]
  )
}
