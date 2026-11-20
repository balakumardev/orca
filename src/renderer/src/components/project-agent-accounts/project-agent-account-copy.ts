import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ProjectAgentAccountProvider } from '../../../../shared/project-agent-accounts'

export type ProjectAgentAccountCopy = {
  /** Brand name users search for; never translated. */
  keyword: string
  title: string
  description: string
  elsewhereNote: string
  noAccountsHint: string
  paneDescription: string
  secondAccountHint: string
}

const COPY: Record<ProjectAgentAccountProvider, (t: Translate) => ProjectAgentAccountCopy> = {
  claude: (t) => ({
    keyword: 'claude',
    title: t('projectAgentAccounts.claude.title', 'Claude account'),
    description: t(
      'projectAgentAccounts.claude.description',
      'The Claude account this project’s terminals and chats sign in with.'
    ),
    elsewhereNote: t(
      'projectAgentAccounts.claude.elsewhereNote',
      'This project runs on another host or in WSL, so it uses that host’s active Claude account.'
    ),
    noAccountsHint: t(
      'projectAgentAccounts.claude.noAccountsHint',
      'This computer has no saved Claude accounts yet, so every project uses System default.'
    ),
    paneDescription: t(
      'projectAgentAccounts.claude.paneDescription',
      'Pin a project to one Claude account. Projects you don’t pin follow the active account.'
    ),
    secondAccountHint: t(
      'projectAgentAccounts.claude.secondAccountHint',
      'Add a second account to use different accounts in different projects.'
    )
  })
}

export function getProjectAgentAccountCopy(
  provider: ProjectAgentAccountProvider,
  t: Translate = translate
): ProjectAgentAccountCopy {
  return COPY[provider](t)
}

export function getProjectAgentAccountTimingHint(t: Translate = translate): string {
  return t(
    'projectAgentAccounts.timingHint',
    'Applies to terminals and chats you open after this. Open terminals keep their account until reopened.'
  )
}
