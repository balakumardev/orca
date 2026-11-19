import type { PaletteExtraResult } from './palette-extra-results'
import type { ProjectCreateTarget } from './palette-project-create-targets'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'

/** The section previews the two best projects; more rows would bury Workspaces. */
const PROJECT_CREATE_ROW_LIMIT = 2

/**
 * One row per matched project, best match first. The rows carry no rank and no quality: with one, a project could
 * lead the list or take Enter ahead of workspaces, and a typed Enter must never start a new worktree.
 */
export function buildProjectCreatePaletteResults(
  targets: readonly ProjectCreateTarget[],
  actions: {
    title: (projectLabel: string) => string
    onCreate: (target: ProjectCreateTarget) => void
    decorate: (target: ProjectCreateTarget) => Pick<PaletteExtraResult, 'leading' | 'line'>
  }
): PaletteExtraResult[] {
  return targets.slice(0, PROJECT_CREATE_ROW_LIMIT).map((target, order) => ({
    // Local selection ids stay stable; remote copies cannot collide with the local repo row.
    id:
      target.workspaceTarget.hostId === LOCAL_EXECUTION_HOST_ID
        ? target.repo.id
        : encodePaletteIdentity(['project-create', target.workspaceTarget.hostId, target.repo.id]),
    projectCreateTarget: { repoId: target.repo.id, workspaceTarget: target.workspaceTarget },
    title: actions.title(target.label),
    titleRanges: [],
    rank: null,
    qualityClass: null,
    lastActiveAt: null,
    order,
    ...actions.decorate(target),
    onSelect: () => actions.onCreate(target)
  }))
}
