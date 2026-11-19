import {
  getProjectTodoScopeKeyFromHeader,
  getProjectTodoSectionOccurrenceKey
} from '../../../../../../shared/project-todos-types'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/sections/group-keys'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { RenderRow } from './render-row'

export type WorktreeItemRow = Extract<HostSectionRow, { type: 'item' }>
export type FolderWorkspaceItemRow = Extract<HostSectionRow, { type: 'folder-workspace' }>

export function isWorktreeItemRow(row: HostSectionRow): row is WorktreeItemRow {
  return row.type === 'item'
}

export function isPinnedWorktreeRow(row: WorktreeItemRow): boolean {
  return row.sectionKey === PINNED_GROUP_KEY
}

// Each visible workspace owns a measured virtual slot, including expanded descendants.
export function buildRenderableRows(
  rows: HostSectionRow[],
  expandedTodoSectionKeys?: ReadonlySet<string>
): RenderRow[] {
  if (!expandedTodoSectionKeys || expandedTodoSectionKeys.size === 0) {
    return rows
  }
  const renderRows: RenderRow[] = []
  for (const row of rows) {
    renderRows.push(row)
    if (row.type !== 'header') {
      continue
    }
    const todoSectionKey = getProjectTodoSectionOccurrenceKey(row)
    if (
      expandedTodoSectionKeys.has(todoSectionKey) &&
      getProjectTodoScopeKeyFromHeader(row, 'repo') !== null
    ) {
      renderRows.push({ type: 'project-todos', key: todoSectionKey, headerRow: row })
    }
  }
  return renderRows
}
