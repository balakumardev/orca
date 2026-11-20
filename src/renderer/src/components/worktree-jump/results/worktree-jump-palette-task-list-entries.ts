import type { Translate } from '@/i18n/use-translate'
import {
  appendPaletteListEntries,
  type PaletteItem,
  type PaletteListEntry
} from '../worktree-jump-palette-model'

export function appendPaletteTaskSection(
  entries: PaletteListEntry[],
  taskItems: readonly PaletteItem[],
  t: Translate
): void {
  if (!taskItems.length) {
    return
  }
  entries.push({
    id: '__header_tasks__',
    type: 'section-header',
    label: t('worktreeJumpPalette.tasksHeader', 'Tasks')
  })
  appendPaletteListEntries(entries, taskItems)
}
