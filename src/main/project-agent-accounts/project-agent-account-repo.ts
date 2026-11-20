import { isRepoOnCatalogHost } from '../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../shared/repository/repo-kind'
import type { Repo } from '../../shared/repository/repo-types'
import type { Store } from '../persistence/loading-store/store'

export type ProjectAgentAccountRepoStore = Pick<Store, 'getRepos'>

/** Only git projects on this computer: a remote twin's accounts live on its own host. */
export function isProjectAgentAccountRepo(repo: Repo): boolean {
  return !isFolderRepo(repo) && isRepoOnCatalogHost(repo)
}

/** Hosts can share a repo id, so this looks for this computer's copy rather than the first row. */
export function findProjectAgentAccountRepo(
  store: ProjectAgentAccountRepoStore,
  repoId: string
): Repo | null {
  return (
    store.getRepos().find((repo) => repo.id === repoId && isProjectAgentAccountRepo(repo)) ?? null
  )
}
