import { useMemo } from 'react'
import type { HostSectionRow } from '../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { WorktreeGroupBy } from '../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../worktree-list/listing/render-row'
import { buildRenderableRows } from '../worktree-list/listing/renderable-rows'
import { useExpandedProjectTodoSectionKeys } from './project-todos-store'

/** The sidebar rows with each expanded project's TODO list inserted below its header (repo grouping only). */
export function useProjectTodoRenderRows(
  rows: HostSectionRow[],
  groupBy: WorktreeGroupBy
): RenderRow[] {
  const expandedTodoSectionKeys = useExpandedProjectTodoSectionKeys()
  return useMemo(
    () => buildRenderableRows(rows, groupBy === 'repo' ? expandedTodoSectionKeys : undefined),
    [expandedTodoSectionKeys, groupBy, rows]
  )
}
