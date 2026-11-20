import { useMemo } from 'react'
import {
  getProjectTodoScopeKeyFromHeader,
  getProjectTodoSectionOccurrenceKey
} from '../../../../../../shared/project-todos-types'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/sections/group-keys'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { ProjectTodosSlotRow, RenderRow, RenderableRow } from './render-row'
import { useExpandedProjectTodoSectionKeys } from '../../project-todos/project-todos-store'

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
): RenderableRow[] {
  if (!expandedTodoSectionKeys || expandedTodoSectionKeys.size === 0) {
    return rows
  }
  // A project's TODO list draws under its own header, so it takes the next slot after it.
  const renderRows: RenderableRow[] = []
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

function toSectionRow(row: RenderableRow): RenderRow {
  if (row.type !== 'project-todos') {
    return row
  }
  const slotKey = `todos:${row.key}`
  const slot: ProjectTodosSlotRow = {
    type: 'pending-creation',
    key: slotKey,
    creationId: slotKey,
    repo: row.headerRow.repo,
    todoSectionKey: row.key,
    headerRow: row.headerRow
  }
  return slot
}

/** The measured rows: a TODO slot joins the shared row union instead of widening it. */
export function useRenderableRows(rows: HostSectionRow[], groupBy: WorktreeGroupBy): RenderRow[] {
  const expandedTodoSectionKeys = useExpandedProjectTodoSectionKeys()
  const todoSectionKeys = groupBy === 'repo' ? expandedTodoSectionKeys : undefined
  return useMemo(
    () => buildRenderableRows(rows, todoSectionKeys).map(toSectionRow),
    [rows, todoSectionKeys]
  )
}
