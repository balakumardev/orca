import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'
import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { useAppStore } from '@/store/index'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { adoptsCliConversations } from '../../../../shared/agent-session/view/structured-agent-cli-conversation-adoption'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault/search/ai-vault-search-types'
import { revealSessionWorkspace } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-original-pane-actions'
import { resumeAiVaultSessionInNewChat } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-resume-in-chat-launch'
import { resolvePaletteSessionAction } from './palette-session-action'
import { paletteSessionOfHit, readPaletteSessionFacts } from './palette-session-facts'
import { resumePaletteSessionInTerminal } from './palette-session-terminal-resume'
import {
  getPaletteSearchHosts,
  isPaletteSearchHostCurrent,
  paletteSearchHostGuard,
  type PaletteSearchHost
} from './palette-search-hosts'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'

/**
 * Enter on a transcript hit. The store is read again here, so a tab that closed or a workspace that went away
 * since the row was drawn decides what happens, not the row. Failures are reported by the same Session History
 * code that reports them in the panel (toasts for a missing workspace, a held conversation, a missing transcript).
 */
export async function openPaletteSession(
  hit: AiVaultSearchHit,
  source?: PaletteSearchHost
): Promise<void> {
  const state = useAppStore.getState()
  const session = paletteSessionOfHit(hit)
  const host =
    source ??
    getPaletteSearchHosts(state, [session.executionHostId]).find(
      (candidate) => candidate.executionHostId === session.executionHostId
    )
  // Enter rechecks the captured authority before any focus, preparation, or launch effect.
  if (
    !host ||
    host.executionHostId !== session.executionHostId ||
    !isPaletteSearchHostCurrent(host, state)
  ) {
    return
  }
  const isCurrent = () => isPaletteSearchHostCurrent(host)
  const action = resolvePaletteSessionAction(readPaletteSessionFacts(state, hit))
  if (action.kind === 'open-chat') {
    await activateAiVaultStructuredSession(
      session,
      undefined,
      runtimeTargetForOwnerEnvironment(host.runtimeEnvironmentId),
      isCurrent,
      host.runtimeId ?? undefined,
      paletteSearchHostGuard(host)
    )
  } else if (action.kind === 'reveal-pane') {
    const { worktreeId, tabId, leafId } = action.target
    if (revealSessionWorkspace(worktreeId, session.executionHostId, paletteSearchHostGuard(host))) {
      useAppStore.getState().setActiveTabType('terminal', worktreeId)
      activateTabAndFocusPane(tabId, leafId, {
        flashFocusedPane: true,
        scrollToBottomIfOutputSinceLastView: true
      })
    }
  } else if (action.kind === 'resume-terminal') {
    await resumePaletteSessionInTerminal(session, action.workspaceId, host)
  } else if (action.kind === 'resume-chat' && adoptsCliConversations(session.agent)) {
    await resumeAiVaultSessionInNewChat(
      session,
      session.agent,
      action.workspaceId,
      createNonSecureContextUuid(),
      undefined,
      {
        executionHostId: session.executionHostId,
        isCurrent,
        targetGuard: paletteSearchHostGuard(host)
      }
    )
  }
}
