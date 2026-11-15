import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { PaletteExtraSource } from './palette-extra-results'
import { PaletteFolderParentLine } from './palette-folder-row-parts'
import { beginProjectNameStep } from './palette-project-name-step-store'
import { PaletteProjectCreateLeading } from './palette-project-create-row-parts'
import { buildProjectCreatePaletteResults } from './palette-project-create-results'
import { PROJECT_CREATE_SOURCE_ID } from './palette-project-create-source-id'
import {
  findProjectCreateTargets,
  resolveProjectScopedCreate
} from './palette-project-create-targets'
import { usePaletteProjectCatalog } from './use-palette-project-catalog'

/** "New worktree in <Project>" for the git projects the typed query names; none for an empty query. */
export function usePaletteProjectCreateSource({
  query,
  visible
}: {
  query: string
  visible: boolean
}): PaletteExtraSource | null {
  const t = useTranslate()
  const catalog = usePaletteProjectCatalog()
  return useMemo(() => {
    // `<project>/<name>` is the Create row's job; a second row for the same project would only repeat it.
    if (!visible || query.length === 0 || resolveProjectScopedCreate(query, catalog)) {
      return null
    }
    const results = buildProjectCreatePaletteResults(findProjectCreateTargets(query, catalog), {
      title: (projectLabel) =>
        t('worktreeJumpPalette.projectCreate.rowTitle', 'New worktree in {{value0}}', {
          value0: projectLabel
        }),
      onCreate: (target) =>
        beginProjectNameStep({ repoId: target.repo.id, projectLabel: target.label }),
      decorate: (target) => ({
        leading: <PaletteProjectCreateLeading />,
        line: <PaletteFolderParentLine path={target.repo.path} />
      })
    })
    if (results.length === 0) {
      return null
    }
    return {
      id: PROJECT_CREATE_SOURCE_ID,
      sectionLabel: (translate) => translate('worktreeJumpPalette.projectCreate.header', 'Create'),
      emptyQueryCap: 0,
      typedPlacement: 'after-workspaces',
      leadsOnTie: false,
      results
    } satisfies PaletteExtraSource
  }, [catalog, query, t, visible])
}
