import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { PaletteExtraSource } from './palette-extra-results'
import { PaletteFolderParentLine } from './palette-folder-row-parts'
import { beginProjectNameStep } from './palette-project-name-step-store'
import { PaletteProjectCreateLeading } from './palette-project-create-row-parts'
import { buildProjectCreatePaletteResults } from './palette-project-create-results'
import { PROJECT_CREATE_SOURCE_ID } from './palette-project-create-source-id'
import {
  findProjectCreateTargets,
  resolveProjectScopedCreate,
  type ProjectCreateTarget
} from './palette-project-create-targets'
import { usePaletteProjectCatalog } from './use-palette-project-catalog'
import { usePaletteSearchHosts } from './use-palette-search-hosts'
import { getPaletteSearchHosts } from './palette-search-hosts'
import { PaletteHostBadgeChip } from '../worktree-jump/worktree-jump-palette-primitives'

/** Keep store reads outside compiled hooks while capturing each offered row's exact pairing. */
function readProjectCreateHosts(targets: readonly ProjectCreateTarget[]) {
  const state = useAppStore.getState()
  return new Map(
    targets.map(({ workspaceTarget }) => [
      workspaceTarget.hostId,
      getPaletteSearchHosts(state, [workspaceTarget.hostId]).find(
        (host) => host.executionHostId === workspaceTarget.hostId
      ) ?? null
    ])
  )
}

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
  const hosts = usePaletteSearchHosts()
  return useMemo(() => {
    // `<project>/<name>` is the Create row's job; a second row for the same project would only repeat it.
    if (!visible || query.length === 0 || resolveProjectScopedCreate(query, catalog)) {
      return null
    }
    const targets = findProjectCreateTargets(query, catalog)
    // A saved row keeps the exact pairing that offered it, including a globally deduplicated alias.
    const targetHosts = readProjectCreateHosts(targets)
    const results = buildProjectCreatePaletteResults(targets, {
      title: (projectLabel) =>
        t('worktreeJumpPalette.projectCreate.rowTitle', 'New worktree in {{value0}}', {
          value0: projectLabel
        }),
      onCreate: (target) =>
        beginProjectNameStep({
          repoId: target.repo.id,
          projectLabel: target.label,
          workspaceTarget: target.workspaceTarget,
          host: targetHosts.get(target.workspaceTarget.hostId) ?? null
        }),
      decorate: (target) => ({
        leading: <PaletteProjectCreateLeading />,
        // Same-path copies need a visible host label as well as a host-qualified action.
        line: (
          <>
            <PaletteHostBadgeChip
              badge={
                hosts.length > 1
                  ? {
                      hostId: target.workspaceTarget.hostId,
                      label:
                        hosts.find((host) => host.executionHostId === target.workspaceTarget.hostId)
                          ?.label ?? target.workspaceTarget.hostId
                    }
                  : null
              }
            />
            <PaletteFolderParentLine path={target.repo.path} />
          </>
        )
      })
    })
    if (results.length === 0) {
      return null
    }
    return {
      id: PROJECT_CREATE_SOURCE_ID,
      sectionLabel: (translate) => translate('worktreeJumpPalette.projectCreate.header', 'Create'),
      emptyQueryCap: 0,
      typedPlacement: 'before-create',
      leadsOnTie: false,
      results
    } satisfies PaletteExtraSource
  }, [catalog, hosts, query, t, visible])
}
