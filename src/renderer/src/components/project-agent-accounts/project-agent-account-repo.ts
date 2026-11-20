import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { isRepoOnCatalogHost } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import { isWslUncPath } from '../../../../shared/wsl-paths'

/** Where a project's agent account comes from; only `pinnable` projects can choose one here. */
export type ProjectAgentAccountRepoScope = 'pinnable' | 'folder' | 'elsewhere'

/** Same rule as main: git projects on this computer, outside WSL, which has its own accounts. */
export function getProjectAgentAccountRepoScope(
  repo: Pick<Repo, 'kind' | 'path' | 'connectionId' | 'executionHostId'>
): ProjectAgentAccountRepoScope {
  if (isFolderRepo(repo)) {
    return 'folder'
  }
  return isRepoOnCatalogHost(repo) && !isWslUncPath(repo.path) ? 'pinnable' : 'elsewhere'
}

/** A Windows project set to run in WSL launches its agents there, so a pin would not apply. */
export function isProjectRunningInWsl(state: AppState, repoId: string): boolean {
  const runtime = getLocalRepoProjectExecutionRuntimeContext(state, repoId)
  if (!runtime) {
    return false
  }
  return runtime.status === 'resolved'
    ? runtime.runtime.kind === 'wsl'
    : runtime.repair.preferredRuntime.kind === 'wsl'
}

export function useProjectAgentAccountRepoScope(repo: Repo): ProjectAgentAccountRepoScope {
  const runsInWsl = useAppStore((state) => isProjectRunningInWsl(state, repo.id))
  const scope = getProjectAgentAccountRepoScope(repo)
  return scope === 'pinnable' && runsInWsl ? 'elsewhere' : scope
}

/** This computer's copy of a project; a remote twin can share its repo id. */
export function findPinnableProjectRepo(repos: readonly Repo[], repoId: string): Repo | undefined {
  return repos.find(
    (repo) => repo.id === repoId && getProjectAgentAccountRepoScope(repo) === 'pinnable'
  )
}
