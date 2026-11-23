import { useId } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import {
  PROJECT_AGENT_ACCOUNT_PROVIDERS,
  type ProjectAgentAccountProvider
} from '../../../../shared/project-agent-accounts'
import { isFolderRepo } from '../../../../shared/repository/repo-kind'
import type { Repo } from '../../../../shared/repository/repo-types'
import { SearchableSetting } from '../settings/section-layout/SearchableSetting'
import { Button } from '../ui/button'
import {
  getProjectAgentAccountCopy,
  getProjectAgentAccountTimingHint
} from './project-agent-account-copy'
import { PROJECT_AGENT_ACCOUNT_PROVIDER_VIEWS } from './project-agent-account-providers'
import { useProjectAgentAccountRepoScope } from './project-agent-account-repo'
import {
  getProjectAgentAccountSearchEntry,
  getProjectAgentAccountSectionId
} from './project-agent-account-search'
import {
  getProjectAgentAccountChoice,
  useProjectAgentAccounts
} from './project-agent-accounts-store'
import { ProjectAgentAccountControl } from './ProjectAgentAccountControl'

/** Project settings rows: which account each agent CLI signs in with in this project. */
export function ProjectAgentAccountsRepositorySection({
  repo,
  forceVisible
}: {
  repo: Repo
  forceVisible?: boolean
}): React.JSX.Element | null {
  const { available } = useProjectAgentAccounts()
  if (!available || isFolderRepo(repo)) {
    return null
  }
  return (
    <>
      {PROJECT_AGENT_ACCOUNT_PROVIDERS.map((provider) => (
        <ProjectProviderAccountRow
          key={provider.id}
          repo={repo}
          provider={provider.id}
          forceVisible={forceVisible}
        />
      ))}
    </>
  )
}

function ProjectProviderAccountRow({
  repo,
  provider,
  forceVisible
}: {
  repo: Repo
  provider: ProjectAgentAccountProvider
  forceVisible?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const copy = getProjectAgentAccountCopy(provider, t)
  const scope = useProjectAgentAccountRepoScope(repo)
  const labelId = useId()
  return (
    <SearchableSetting
      {...getProjectAgentAccountSearchEntry(repo, provider, t)}
      id={getProjectAgentAccountSectionId(repo.id, provider)}
      className="space-y-3 py-3"
      forceVisible={forceVisible}
    >
      <div className="min-w-0 space-y-1">
        <div id={labelId} className="text-sm font-semibold">
          {copy.title}
        </div>
        <p className="text-xs text-muted-foreground">{copy.description}</p>
      </div>
      {scope === 'pinnable' ? (
        <ProjectProviderAccountChoice repo={repo} provider={provider} labelId={labelId} />
      ) : (
        <p className="text-xs text-muted-foreground">{copy.elsewhereNote}</p>
      )}
    </SearchableSetting>
  )
}

function ProjectProviderAccountChoice({
  repo,
  provider,
  labelId
}: {
  repo: Repo
  provider: ProjectAgentAccountProvider
  labelId: string
}): React.JSX.Element {
  const t = useTranslate()
  const view = PROJECT_AGENT_ACCOUNT_PROVIDER_VIEWS[provider]
  const roster = view.useRoster()
  const { snapshot } = useProjectAgentAccounts()
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const setSettingsSearchQuery = useAppStore((state) => state.setSettingsSearchQuery)
  const pinned = getProjectAgentAccountChoice(snapshot, repo.id, provider) !== undefined
  if (roster.loaded && roster.accounts.length === 0 && !pinned) {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          {getProjectAgentAccountCopy(provider, t).noAccountsHint}
        </p>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0"
          onClick={() => {
            // A search query could hide the accounts list this opens.
            setSettingsSearchQuery('')
            openSettingsTarget({
              pane: 'accounts',
              repoId: null,
              sectionId: view.accountsSectionId
            })
          }}
        >
          {t('projectAgentAccounts.manageAccounts', 'Manage accounts')}
        </Button>
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      <ProjectAgentAccountControl
        repoId={repo.id}
        provider={provider}
        roster={roster}
        ariaLabelledBy={labelId}
      />
      <p className="text-xs text-muted-foreground">{getProjectAgentAccountTimingHint(t)}</p>
    </div>
  )
}
