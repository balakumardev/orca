import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { getClaudeAccountLabel } from '@/lib/provider-accounts/claude-account-label'
import { emptyClaudeAccountsState } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/agent-accounts/managed-account-types'
import { getClaudeAccountRosterSyncKey } from '../status-bar/accounts/provider-account-sync-key'
import { getClaudeStatusActiveId } from '../status-bar/accounts/status-bar-claude-accounts'
import { useProviderAccountList } from '../status-bar/accounts/use-provider-account-list'
import type { ProjectAgentAccountRoster } from './project-agent-account-providers'

const LOCAL_OWNER = { kind: 'local' } as const
const EMPTY_CLAUDE_ACCOUNTS = emptyClaudeAccountsState()

/** Pins name this computer's host accounts; a WSL account signs in inside its distro. */
export function projectClaudeAccountRoster(
  state: ClaudeRateLimitAccountsState,
  loaded: boolean
): ProjectAgentAccountRoster {
  return {
    loaded,
    accounts: state.accounts
      .filter((account) => (account.managedAuthRuntime ?? 'host') === 'host')
      .map((account) => ({ id: account.id, label: account.email })),
    activeLabel: getClaudeAccountLabel(
      state,
      getClaudeStatusActiveId(state, { runtime: 'host', wslDistro: null })
    )
  }
}

export function useProjectClaudeAccountRoster(): ProjectAgentAccountRoster {
  const syncKey = useAppStore((state) => getClaudeAccountRosterSyncKey(state.settings))
  const { accounts, accountsLoaded } = useProviderAccountList(
    'claude',
    LOCAL_OWNER,
    syncKey,
    EMPTY_CLAUDE_ACCOUNTS
  )
  return useMemo(
    () => projectClaudeAccountRoster(accounts, accountsLoaded),
    [accounts, accountsLoaded]
  )
}
