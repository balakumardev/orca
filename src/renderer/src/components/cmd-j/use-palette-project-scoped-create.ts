import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import { getRepoWorkspaceCreationTargetHint } from '@/lib/workspace/creation/project-host-workspace-target'
import {
  parseGitHubIssueOrPRLink,
  parseGitHubIssueOrPRNumber
} from '../../../../shared/github/repositories/links'
import {
  selectPaletteComposerTargetState,
  resolvePaletteComposerTarget
} from './palette-composer-target'
import {
  findProjectCreateTargets,
  getProjectCreateLabel,
  resolveProjectScopedCreate,
  type ProjectScopedCreate
} from './palette-project-create-targets'
import { usePaletteProjectCatalog } from './use-palette-project-catalog'

/**
 * What the plain Create row says it creates. `<project>/<name>` names its project and the name after the slash.
 * When the text names a project without that form (the "New worktree in <Project>" rows are shown above), the row
 * names the project it will create in instead, the one the New worktree dialog opens on, so the two rows read as
 * a pair and neither is mistaken for the other. Null while neither applies: the row keeps its plain label,
 * also for a GitHub issue or pull request number or link, which Enter opens as that item, not in a project.
 */
export function usePaletteProjectScopedCreate(
  createWorktreeName: string
): ProjectScopedCreate | null {
  const catalog = usePaletteProjectCatalog()
  const composerTarget = useAppStore(useShallow(selectPaletteComposerTargetState))
  return useMemo(() => {
    const scoped = resolveProjectScopedCreate(createWorktreeName, catalog)
    if (scoped) {
      return scoped
    }
    if (
      createWorktreeName.length === 0 ||
      parseGitHubIssueOrPRLink(createWorktreeName) !== null ||
      parseGitHubIssueOrPRNumber(createWorktreeName) !== null ||
      findProjectCreateTargets(createWorktreeName, catalog).length === 0
    ) {
      return null
    }
    // Use the composer's resolved checkout rather than repicking a same-id repo on another host.
    const repo = resolvePaletteComposerTarget(composerTarget)?.repo
    return repo
      ? {
          repoId: repo.id,
          projectLabel: getProjectCreateLabel(repo, catalog),
          name: createWorktreeName,
          workspaceTarget: getRepoWorkspaceCreationTargetHint(repo, catalog.projectHostSetups)
        }
      : null
  }, [catalog, composerTarget, createWorktreeName])
}
