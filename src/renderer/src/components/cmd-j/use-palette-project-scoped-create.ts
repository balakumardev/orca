import { useMemo } from 'react'
import {
  resolveProjectScopedCreate,
  type ProjectScopedCreate
} from './palette-project-create-targets'
import { usePaletteProjectCatalog } from './use-palette-project-catalog'

/** The `<project>/<name>` reading of what is typed, or null while it names no single git project. */
export function usePaletteProjectScopedCreate(
  createWorktreeName: string
): ProjectScopedCreate | null {
  const catalog = usePaletteProjectCatalog()
  return useMemo(
    () => resolveProjectScopedCreate(createWorktreeName, catalog),
    [catalog, createWorktreeName]
  )
}
