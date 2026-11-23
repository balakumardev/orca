import type { Project, ProjectHostSetup } from '../../../../shared/project/project-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import {
  getRepoWorkspaceCreationTargetHint,
  type WorkspaceCreationTargetHint
} from '@/lib/workspace/creation/project-host-workspace-target'
import { getNewWorkspaceDialogEligibleRepos } from '../../../../shared/new-workspace/new-workspace-dialog-repo'
import { isGitRepoKind } from '../../../../shared/repository/repo-kind'
import { getProjectHeaderRevealTarget } from '../../../../shared/sidebar-list/sections/project-section-grouping'
import { searchCmdJProjectResults } from './palette-project-results'
import {
  cmdJPaletteTokenScore,
  normalizeCmdJPaletteQuery,
  uniqueCmdJPaletteQueryTokens
} from './palette-query-tokens'

export type PaletteProjectCatalog = {
  repos: readonly Repo[]
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
}

export function selectPaletteProjectCatalog(state: PaletteProjectCatalog): PaletteProjectCatalog {
  return {
    repos: state.repos,
    projects: state.projects,
    projectHostSetups: state.projectHostSetups
  }
}

/** Share exact checkout lookup between row shortcuts and final name-step validation. */
export function getUsableGitProjectRepo(
  repoId: string | null,
  repos: readonly Repo[],
  hostId?: ExecutionHostId
): Repo | null {
  const candidates = repos.filter(
    (repo) => repo.id === repoId && (!hostId || getRepoExecutionHostId(repo) === hostId)
  )
  const repo = candidates.length === 1 ? candidates[0] : null
  return repo && isGitRepoKind(repo) && getNewWorkspaceDialogEligibleRepos([repo]).length > 0
    ? repo
    : null
}

/** Re-read the chosen host and setup; a same-id repo elsewhere is never a substitute. */
export function resolvePaletteProjectCreateRepo(
  repoId: string,
  catalog: PaletteProjectCatalog,
  workspaceTarget?: WorkspaceCreationTargetHint
): Repo | null {
  const repo = getUsableGitProjectRepo(repoId, catalog.repos, workspaceTarget?.hostId)
  if (!repo) {
    return null
  }
  if (workspaceTarget) {
    const liveTarget = getRepoWorkspaceCreationTargetHint(repo, catalog.projectHostSetups)
    if (
      liveTarget.projectId !== workspaceTarget.projectId ||
      (workspaceTarget.projectHostSetupId &&
        liveTarget.projectHostSetupId !== workspaceTarget.projectHostSetupId)
    ) {
      return null
    }
  }
  return repo
}

export type ProjectCreateTarget = {
  repo: Repo
  label: string
  workspaceTarget: WorkspaceCreationTargetHint
  /** The query equals the project's own title, which the palette ranks as decisive intent. */
  exact: boolean
}

/**
 * Git projects the new-workspace composer can target, ordered as the palette orders project rows. The palette's
 * own aliases ("project", "repo") match every project, so only a match on the name counts here.
 */
export function findProjectCreateTargets(
  query: string,
  catalog: PaletteProjectCatalog
): ProjectCreateTarget[] {
  const normalizedQuery = normalizeCmdJPaletteQuery(query)
  const tokens = uniqueCmdJPaletteQueryTokens(normalizedQuery)
  return searchCmdJProjectResults({ query, projectGroups: [], ...catalog }).flatMap((result) => {
    if (result.kind !== 'project') {
      return []
    }
    const { repo } = result
    const matchesName =
      normalizeCmdJPaletteQuery(result.title).startsWith(normalizedQuery) ||
      cmdJPaletteTokenScore(tokens, [result.title, repo.displayName]) > 0
    if (
      !matchesName ||
      !isGitRepoKind(repo) ||
      getNewWorkspaceDialogEligibleRepos([repo]).length === 0
    ) {
      return []
    }
    return [
      {
        repo,
        label: result.title,
        workspaceTarget: getRepoWorkspaceCreationTargetHint(repo, catalog.projectHostSetups),
        exact: result.qualityClass === 'exact-intent'
      }
    ]
  })
}

export type ProjectScopedCreate = {
  repoId: string
  projectLabel: string
  name: string
  workspaceTarget: WorkspaceCreationTargetHint
}

/**
 * `<project>/<name>`: the part before the first slash is a project's own title, compared whole and ignoring case,
 * and names exactly one git project. A prefix or a part of a name never scopes: branch-style names such as
 * `fix/login` or `feat/login` stay plain worktree names. The rest of the text is the workspace name.
 */
export function resolveProjectScopedCreate(
  query: string,
  catalog: PaletteProjectCatalog
): ProjectScopedCreate | null {
  const text = query.trim()
  const slash = text.indexOf('/')
  // A URL is an issue or PR link, never a project path.
  if (slash <= 0 || /^\w+:\/\//.test(text)) {
    return null
  }
  const token = text.slice(0, slash).trim()
  const name = text.slice(slash + 1).trim()
  if (!token || !name) {
    return null
  }
  const exact = findProjectCreateTargets(token, catalog).filter((match) => match.exact)
  return exact.length === 1
    ? {
        repoId: exact[0].repo.id,
        projectLabel: exact[0].label,
        name,
        workspaceTarget: exact[0].workspaceTarget
      }
    : null
}

/** The name the palette's project rows show for a repo (its project group name when it has one). */
export function getProjectCreateLabel(repo: Repo, catalog: PaletteProjectCatalog): string {
  // Project headers also group by repo id, so resolve their labels inside the selected host.
  const hostId = getRepoExecutionHostId(repo)
  const repoMap = new Map(
    catalog.repos
      .filter((candidate) => getRepoExecutionHostId(candidate) === hostId)
      .map((candidate) => [candidate.id, candidate])
  )
  const target = getProjectHeaderRevealTarget(repo.id, repoMap, {
    projects: catalog.projects,
    projectHostSetups: catalog.projectHostSetups.filter((setup) => setup.hostId === hostId)
  })
  return target.label || repo.displayName
}
