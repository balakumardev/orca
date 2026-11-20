import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { ProjectAgentAccountProvider } from '../../../../shared/project-agent-accounts'
import type { Repo } from '../../../../shared/repository/repo-types'
import RepoBadgeLabel from '../repo/RepoBadgeLabel'
import { SearchableSetting } from '../settings/section-layout/SearchableSetting'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  getProjectAgentAccountCopy,
  getProjectAgentAccountTimingHint
} from './project-agent-account-copy'
import {
  PROJECT_AGENT_ACCOUNT_PROVIDER_VIEWS,
  type ProjectAgentAccountRoster
} from './project-agent-account-providers'
import { getProjectAgentAccountRepoScope } from './project-agent-account-repo'
import { getProjectAgentAccountsPaneSearchEntry } from './project-agent-account-search'
import {
  getProjectAgentAccountChoice,
  useProjectAgentAccounts
} from './project-agent-accounts-store'
import { ProjectAgentAccountControl, saveProjectAgentAccount } from './ProjectAgentAccountControl'
import { ProjectAgentAccountPinPicker } from './ProjectAgentAccountPinPicker'

/** "Accounts per project" in Settings > AI Provider Accounts; this computer's projects only. */
export function ProjectAgentAccountsPaneSetting({
  provider
}: {
  provider: ProjectAgentAccountProvider
}): React.JSX.Element | null {
  const { available } = useProjectAgentAccounts()
  return available ? <ProjectAgentAccountsPaneBody provider={provider} /> : null
}

function ProjectAgentAccountsPaneBody({
  provider
}: {
  provider: ProjectAgentAccountProvider
}): React.JSX.Element {
  const t = useTranslate()
  const copy = getProjectAgentAccountCopy(provider, t)
  const entry = getProjectAgentAccountsPaneSearchEntry(provider, t)
  const roster = PROJECT_AGENT_ACCOUNT_PROVIDER_VIEWS[provider].useRoster()
  const { snapshot } = useProjectAgentAccounts()
  const repos = useAppStore((state) => state.repos)
  // A picked project shows a row before it has a pin; nothing is saved until an account is chosen.
  const [pickedRepoIds, setPickedRepoIds] = useState<readonly string[]>([])
  const pinnable = useMemo(
    () => repos.filter((repo) => getProjectAgentAccountRepoScope(repo) === 'pinnable'),
    [repos]
  )
  const shown = pinnable.filter(
    (repo) =>
      getProjectAgentAccountChoice(snapshot, repo.id, provider) !== undefined ||
      pickedRepoIds.includes(repo.id)
  )
  const unpinned = pinnable.filter((repo) => !shown.includes(repo))
  const remove = (repo: Repo): void => {
    setPickedRepoIds((ids) => ids.filter((id) => id !== repo.id))
    if (getProjectAgentAccountChoice(snapshot, repo.id, provider) !== undefined) {
      void saveProjectAgentAccount({ repoId: repo.id, provider, choice: null }, t)
    }
  }
  return (
    <SearchableSetting {...entry} className="space-y-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">{copy.paneDescription}</p>
        </div>
        <ProjectAgentAccountPinPicker
          repos={unpinned}
          onPick={(repo) => setPickedRepoIds((ids) => [...ids, repo.id])}
        />
      </div>
      {roster.loaded && roster.accounts.length < 2 ? (
        <p className="text-xs text-muted-foreground">{copy.secondAccountHint}</p>
      ) : null}
      {shown.length > 0 ? (
        <div className="space-y-1.5">
          {shown.map((repo) => (
            <ProjectAccountRow
              key={repo.id}
              repo={repo}
              provider={provider}
              roster={roster}
              onRemove={() => remove(repo)}
            />
          ))}
          <p className="text-xs text-muted-foreground">{getProjectAgentAccountTimingHint(t)}</p>
        </div>
      ) : null}
    </SearchableSetting>
  )
}

function ProjectAccountRow({
  repo,
  provider,
  roster,
  onRemove
}: {
  repo: Repo
  provider: ProjectAgentAccountProvider
  roster: ProjectAgentAccountRoster
  onRemove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const unpinLabel = t('projectAgentAccounts.unpinProject', 'Unpin {{project}}', {
    project: repo.displayName
  })
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/70 py-1.5 pr-1.5 pl-3">
      <RepoBadgeLabel
        name={repo.displayName}
        color={repo.badgeColor}
        className="min-w-24 flex-1 text-sm"
      />
      <ProjectAgentAccountControl
        repoId={repo.id}
        provider={provider}
        roster={roster}
        ariaLabel={t('projectAgentAccounts.projectAccountLabel', 'Account for {{project}}', {
          project: repo.displayName
        })}
        className="w-60 shrink"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            aria-label={unpinLabel}
            onClick={onRemove}
          >
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {unpinLabel}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
