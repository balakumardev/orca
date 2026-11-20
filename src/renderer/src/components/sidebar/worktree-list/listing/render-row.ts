import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'

export type RenderRow = HostSectionRow

/** A project's TODO list, drawn under its own section header while the user has it expanded. */
export type ProjectTodosRow = { type: 'project-todos'; key: string; headerRow: GroupHeaderRow }

export type RenderableRow = RenderRow | ProjectTodosRow

/**
 * The TODO slot once it joins the shared row union. Why: the shared geometry and drag helpers take a
 * HostSectionRow and skip only the row types they know, so the slot borrows pending-creation, the one
 * row type every one of them already ignores.
 */
export type ProjectTodosSlotRow = Extract<RenderRow, { type: 'pending-creation' }> & {
  todoSectionKey: string
  headerRow: GroupHeaderRow
}

export function isProjectTodosSlotRow(row: RenderRow): row is ProjectTodosSlotRow {
  return row.type === 'pending-creation' && 'todoSectionKey' in row
}

export function getRenderRowKey(row: RenderRow): string {
  if (row.type === 'host-header') {
    return `host:${row.hostId}`
  }
  if (row.type === 'header') {
    return row.hostId ? `hdr:${row.hostId}:${row.key}` : `hdr:${row.key}`
  }
  if (row.type === 'imported-worktrees-card') {
    return `imported:${row.key}`
  }
  if (row.type === 'new-external-worktrees-inbox') {
    return `inbox:${row.key}`
  }
  if (row.type === 'pending-creation') {
    return `pending:${row.creationId}`
  }
  if (row.type === 'folder-workspace') {
    return row.key
  }
  return `wt:${row.rowKey}`
}
