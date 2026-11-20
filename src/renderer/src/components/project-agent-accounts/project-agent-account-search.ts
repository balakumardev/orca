import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  PROJECT_AGENT_ACCOUNT_PROVIDERS,
  type ProjectAgentAccountProvider
} from '../../../../shared/project-agent-accounts'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { SettingsSearchEntry } from '../settings/search/settings-search'
import { searchKeywordTranslator } from '../settings/search/settings-search-keywords'
import { getProjectAgentAccountCopy } from './project-agent-account-copy'

/** Starts with `repo-<id>-` so Settings resolves the project from it. */
export function getProjectAgentAccountSectionId(
  repoId: string,
  provider: ProjectAgentAccountProvider
): string {
  return `repo-${repoId}-agent-account-${provider}`
}

function accountKeywords(t: Translate): string[] {
  const translateSearchKeyword = searchKeywordTranslator(t)
  return [
    ...translateSearchKeyword('projectAgentAccounts.search.account', 'account'),
    ...translateSearchKeyword('projectAgentAccounts.search.pin', 'pin'),
    ...translateSearchKeyword('projectAgentAccounts.search.login', 'login'),
    ...translateSearchKeyword('projectAgentAccounts.search.perProject', 'per project')
  ]
}

export function getProjectAgentAccountSearchEntry(
  repo: Pick<Repo, 'displayName'>,
  provider: ProjectAgentAccountProvider,
  t: Translate = translate
): SettingsSearchEntry {
  const copy = getProjectAgentAccountCopy(provider, t)
  return {
    title: copy.title,
    description: copy.description,
    keywords: [repo.displayName, copy.keyword, ...accountKeywords(t)]
  }
}

/** The project pane's account rows, one per provider; git projects only. */
export function getProjectAgentAccountSearchEntries(
  repo: Pick<Repo, 'displayName'>,
  t: Translate = translate
): SettingsSearchEntry[] {
  return PROJECT_AGENT_ACCOUNT_PROVIDERS.map((provider) =>
    getProjectAgentAccountSearchEntry(repo, provider.id, t)
  )
}

export function getProjectAgentAccountsPaneSearchEntry(
  provider: ProjectAgentAccountProvider,
  t: Translate = translate
): SettingsSearchEntry {
  const copy = getProjectAgentAccountCopy(provider, t)
  return {
    title: t('projectAgentAccounts.paneTitle', 'Accounts per project'),
    description: copy.paneDescription,
    keywords: [copy.keyword, ...accountKeywords(t)]
  }
}
