import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'

export type RenderRow = HostSectionRow

export type ProjectTodosRenderRow = {
  type: 'project-todos'
  key: string
  headerRow: GroupHeaderRow
}

export type VirtualRenderRow = RenderRow | ProjectTodosRenderRow

export function getRenderRowKey(row: VirtualRenderRow): string {
  if (row.type === 'host-header') {
    return `host:${row.hostId}`
  }
  if (row.type === 'header') {
    return row.hostId ? `hdr:${row.hostId}:${row.key}` : `hdr:${row.key}`
  }
  if (row.type === 'project-todos') {
    return `todos:${row.key}`
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
