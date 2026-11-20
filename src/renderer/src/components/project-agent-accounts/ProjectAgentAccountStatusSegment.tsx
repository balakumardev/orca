import { Pin } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from '../status-bar/status-bar-context-menu-policy'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { findPinnableProjectRepo, isProjectRunningInWsl } from './project-agent-account-repo'
import { getProjectAgentAccountSectionId } from './project-agent-account-search'
import {
  getProjectAgentAccountChoice,
  useProjectAgentAccounts
} from './project-agent-accounts-store'
import { projectClaudePinApplies } from './project-claude-pin'

const NO_ACCOUNTS: [] = []

/** The active workspace's project on this computer, while a pin could apply to it. */
function activePinnableRepoId(state: AppState): string | null {
  const hostId = state.activeWorkspaceExecutionHostId
  if ((hostId && hostId !== LOCAL_EXECUTION_HOST_ID) || !state.activeWorktreeId) {
    return null
  }
  const repo = findPinnableProjectRepo(state.repos, getRepoIdFromWorktreeId(state.activeWorktreeId))
  return repo && !isProjectRunningInWsl(state, repo.id) ? repo.id : null
}

/** Shown only while the active project is pinned, since a global switch then does not reach it. */
export function ProjectAgentAccountStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const { available, snapshot } = useProjectAgentAccounts()
  const repoId = useAppStore(activePinnableRepoId)
  const saved = useAppStore((state) => state.settings?.claudeManagedAccounts ?? NO_ACCOUNTS)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const choice = repoId ? getProjectAgentAccountChoice(snapshot, repoId, 'claude') : undefined
  if (!available || !repoId || !choice || !projectClaudePinApplies(choice, saved)) {
    return null
  }
  const label =
    choice.kind === 'system'
      ? t('projectAgentAccounts.select.system', 'System default')
      : (saved.find((account) => account.id === choice.accountId)?.email ?? choice.accountId)
  const detail = t(
    'projectAgentAccounts.statusTooltip',
    'This project uses {{account}}. Change it in project settings.',
    { account: label }
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
          className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          aria-label={detail}
          onClick={() => {
            openSettingsTarget({
              pane: 'repo',
              repoId,
              hostId: LOCAL_EXECUTION_HOST_ID,
              sectionId: getProjectAgentAccountSectionId(repoId, 'claude')
            })
            openSettingsPage()
          }}
        >
          <Pin className="size-3" />
          {iconOnly ? null : (
            <span className="max-w-40 truncate text-2xs font-medium">{label}</span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {detail}
      </TooltipContent>
    </Tooltip>
  )
}
