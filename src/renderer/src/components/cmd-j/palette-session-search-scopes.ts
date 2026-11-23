import type { Repo } from '../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { toAiVaultProjectKey } from '../../../../shared/ai-vault/scanning/ai-vault-project-key'
import type { AiVaultSearchScopeIdentity } from '../../../../shared/ai-vault/search/ai-vault-search-scope'
import type { PaletteSearchHost } from './palette-search-hosts'

/** Repo filters use each host's registered identity; an unknown selection never widens to all. */
export function paletteSessionSearchScopes(
  host: PaletteSearchHost,
  repos: readonly Repo[],
  repoIds?: readonly string[]
): readonly (AiVaultSearchScopeIdentity | undefined)[] {
  if (!repoIds?.length) {
    return [undefined]
  }
  const selected = new Set(repoIds)
  const keys = new Set(
    repos
      .filter(
        (repo) => selected.has(repo.id) && getRepoExecutionHostId(repo) === host.executionHostId
      )
      .map((repo) => toAiVaultProjectKey(null, repo.id))
  )
  return [...keys].flatMap((projectKey) =>
    projectKey ? [{ kind: 'project' as const, projectKey }] : []
  )
}
