import type { ProjectAgentAccountProvider } from '../../../../shared/project-agent-accounts'
import { useProjectClaudeAccountRoster } from './use-project-claude-account-roster'

export type ProjectAgentAccountOption = { id: string; label: string }

export type ProjectAgentAccountRoster = {
  loaded: boolean
  /** Accounts a project on this computer can pin. */
  accounts: readonly ProjectAgentAccountOption[]
  /** What "Follow active account" runs on right now. */
  activeLabel: string
}

export type ProjectAgentAccountProviderView = {
  /** Anchor of the provider's list in Settings > AI Provider Accounts. */
  accountsSectionId: string
  useRoster: () => ProjectAgentAccountRoster
}

/** One entry per pinnable provider; the settings surfaces render a row for each. Copy lives in project-agent-account-copy.ts. */
export const PROJECT_AGENT_ACCOUNT_PROVIDER_VIEWS: Record<
  ProjectAgentAccountProvider,
  ProjectAgentAccountProviderView
> = {
  claude: { accountsSectionId: 'accounts-claude', useRoster: useProjectClaudeAccountRoster }
}
