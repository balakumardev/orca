import { toast } from 'sonner'
import { parseRoutableExecutionHostId } from '../../../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { agentLabel } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-filters'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../../../../../shared/structured-agent-cli-conversation-adoption'
import type { CliConversationRowAgent } from '../../../../../../shared/structured-agent-cli-conversation-adoption'
import { hasRuntimeRpcErrorCode } from '../../../../../../shared/runtime-rpc-error-code'
import { prepareAiVaultSessionForResume } from '@/lib/agent-session/resume/history/ai-vault-session-resume-preparation'
import { guardedAiVaultResumeRequest } from '@/lib/agent-session/resume/history/ai-vault-session-resume-host-request'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import {
  beginStructuredAgentSessionProvisionalLaunch,
  structuredLaunchOwner
} from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { admitStructuredLaunchOnHost } from '@/lib/agent-session/launch/structured-agent-session-host-admission'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { cliConversationExitGuidance } from '@/lib/agent-session/resume/history/cli-conversation-exit-guidance'
import { structuredLaunchFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import { workspaceHasSleepingAgentSessions } from '@/lib/workspace/activation/worktree-agent-activation-gate'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-tabs-sync/navigation/web-session-focus-intent'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentLaunchSettlement } from '@/lib/agent-session/launch/continuation/structured-agent-launch-settlement'
import type { NativeChatComposerFocusIntent } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import type { RuntimeTargetGuard } from '@/runtime/rpc/targets/runtime-target-guard'

/** A chat the resumed one takes the place of: it opens right after that tab. */
export type AiVaultChatReplacement = {
  afterTabId: string
  /** Told the new tab's id once it opens. */
  focusIntent: NativeChatComposerFocusIntent
  /** Called once; null means no launch began. Return true to suppress the already-handled failure toast. */
  onSettled: (settlement: StructuredAgentLaunchSettlement | null) => boolean
}

export function activateAiVaultResumeWorkspace(
  workspaceId: string,
  executionHostId?: ExecutionHostId,
  targetGuard?: RuntimeTargetGuard
): boolean {
  return (
    activateAndRevealWorkspace(
      workspaceId,
      executionHostId ? { executionHostId, ...(targetGuard ? { targetGuard } : {}) } : undefined
    ) !== false
  )
}

/** Adopt through the eligibility verdict; silent terminal fallback would hide actionable refusals. */
export async function resumeAiVaultSessionInNewChat(
  session: AiVaultSession,
  rowAgent: CliConversationRowAgent,
  worktreeId: string,
  requestId: string,
  replacing?: AiVaultChatReplacement,
  owner?: {
    executionHostId: ExecutionHostId
    isCurrent: () => boolean
    targetGuard?: RuntimeTargetGuard
  }
): Promise<void> {
  const isCurrent = () => owner?.isCurrent() !== false
  let stopWatching: (() => void) | undefined
  let awaitingSettlement = false
  try {
    if (!isCurrent()) {
      replacing?.onSettled(null)
      return
    }
    const recordingHost = parseRoutableExecutionHostId(session.executionHostId)
    // Search already resolved the recording workspace; the currently selected twin is irrelevant.
    const workspaceOwner = structuredLaunchOwner(
      {
        route: 'structured-native-chat',
        ...(owner ? { executionHostId: owner.executionHostId } : {})
      },
      worktreeId
    )
    if (
      !recordingHost ||
      recordingHost.kind === 'ssh' ||
      workspaceOwner?.executionHostId !== recordingHost.id
    ) {
      throw new Error('The conversation workspace is no longer on its recording host.')
    }
    const executionHostId = recordingHost.id
    // Watch before preparation: legacy Codex repinning can mutate the selected host's filesystem.
    const controller = owner ? new AbortController() : undefined
    if (controller) {
      stopWatching = useAppStore.subscribe(() => {
        if (!isCurrent()) {
          controller.abort()
        }
      })
    }
    // Reuse terminal preparation to repin Codex rows from legacy shared homes before host lookup.
    const [preparedSession, agent] = await Promise.all([
      prepareAiVaultSessionForResume(
        session,
        guardedAiVaultResumeRequest(executionHostId, owner?.targetGuard, controller?.signal)
      ),
      adoptingAgentOnHost(rowAgent, worktreeId, executionHostId, isCurrent)
    ])
    if (!isCurrent()) {
      replacing?.onSettled(null)
      return
    }
    const plan = adoptAgentSessionLaunchVerdict({
      route: 'structured-native-chat',
      requestId,
      agent,
      worktreeId,
      executionHostId,
      resumeFrom: { providerSessionId: preparedSession.sessionId }
    })
    const selection = useAppStore.getState()
    const waitForCreate = workspaceHasSleepingAgentSessions(selection, worktreeId)
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      // Cancellation stops preparation; the captured fence also covers requests already in the main queue.
      hooks: {
        signal: controller?.signal,
        beforeCreate: isCurrent,
        targetGuard: owner?.targetGuard
      },
      ...(replacing
        ? { afterTabId: replacing.afterTabId, focusIntent: replacing.focusIntent }
        : {}),
      beforeOpen: () => {
        if (!isCurrent()) {
          return false
        }
        if (waitForCreate) {
          return true
        }
        if (
          useAppStore.getState().activeWorktreeId !== worktreeId ||
          useAppStore.getState().activeWorkspaceExecutionHostId !== executionHostId
        ) {
          return activateAiVaultResumeWorkspace(worktreeId, executionHostId, owner?.targetGuard)
        }
        return true
      }
    })
    if (!launch) {
      replacing?.onSettled(null)
      return
    }
    awaitingSettlement = true
    void launch.settlement
      .then((settlement) => {
        if (!isCurrent()) {
          replacing?.onSettled({ kind: 'cancelled', sessionId: null })
          return
        }
        const state = useAppStore.getState()
        if (
          waitForCreate &&
          settlement.kind === 'structured' &&
          (state.activeWorktreeId !== worktreeId ||
            state.activeWorkspaceExecutionHostId !== executionHostId) &&
          state.activeWorktreeId === selection.activeWorktreeId &&
          state.activeWorkspaceExecutionHostId === selection.activeWorkspaceExecutionHostId &&
          state.activeView === selection.activeView &&
          state.worktreeNavHistory === selection.worktreeNavHistory &&
          state.worktreeNavHistoryIndex === selection.worktreeNavHistoryIndex &&
          resolveWebSessionVisibleTabId(state, selection.activeWorktreeId ?? '') ===
            resolveWebSessionVisibleTabId(selection, selection.activeWorktreeId ?? '')
        ) {
          activateAiVaultResumeWorkspace(worktreeId, executionHostId, owner?.targetGuard)
        }
        const handled = replacing?.onSettled(settlement) === true
        if (settlement.kind === 'failed' && !settlement.notified && !handled) {
          notifyAiVaultSessionResumeInChatFailure(settlement.error, rowAgent)
        }
      })
      .finally(() => stopWatching?.())
  } catch (error) {
    if (isCurrent()) {
      notifyAiVaultSessionResumeInChatFailure(error, rowAgent)
    }
    replacing?.onSettled(null)
  } finally {
    if (!awaitingSettlement) {
      stopWatching?.()
    }
  }
}

/** Try chats until one is not refused; an unreachable host keeps the requested chat so its launch reports the error. */
export async function adoptingAgentOnHost(
  rowAgent: CliConversationRowAgent,
  worktreeId: string,
  executionHostId?: ExecutionHostId,
  isCurrent?: () => boolean
): Promise<TuiAgent> {
  const [first, ...rest] = CLI_CONVERSATION_ADOPTING_AGENTS[rowAgent]
  const owner = structuredLaunchOwner(
    { route: 'structured-native-chat', ...(executionHostId ? { executionHostId } : {}) },
    worktreeId
  )
  const selector = toRuntimeWorktreeSelector(worktreeId)
  let agent: TuiAgent = first
  for (const next of rest) {
    if (isCurrent?.() === false) {
      throw new Error('session_search_host_changed')
    }
    if (
      !owner ||
      (await admitStructuredLaunchOnHost(owner.target, selector, agent)).kind !== 'declined'
    ) {
      return agent
    }
    agent = next
  }
  return agent
}

/** Ownership conflicts and missing account-home conversations need actionable errors, not generic terminal preparation failures. */
function notifyAiVaultSessionResumeInChatFailure(
  error: unknown,
  rowAgent: CliConversationRowAgent
): void {
  const failure = structuredLaunchFailure(error)
  if (
    hasRuntimeRpcErrorCode(error, 'agent_session_conflict') ||
    failure?.code === 'agent_session_conflict'
  ) {
    toast.error(
      failure?.details?.reason === 'conversationHeldElsewhere' && !failure.owner
        ? cliConversationExitGuidance(rowAgent)
        : translate(
            'auto.components.right.sidebar.AiVaultPanel.resumeInChatConflict',
            'Another chat is already holding this conversation.'
          )
    )
    return
  }
  if (
    failure?.code === 'agent_session_identity_required' &&
    failure.details?.reason === 'transcriptNotFound'
  ) {
    toast.error(
      translate(
        'components.native-chat.resumeInNewChat.notSavedYet',
        "{{agent}} hasn't saved this conversation yet. Try again after it replies.",
        { agent: agentLabel(rowAgent) }
      )
    )
    return
  }
  if (
    failure?.code === 'agent_session_identity_required' ||
    hasRuntimeRpcErrorCode(error, 'agent_session_identity_required')
  ) {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.resumeInChatTranscriptMissing',
        "This conversation's history could not be loaded, so it cannot be resumed in chat."
      )
    )
    return
  }
  toast.error(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.resumeInChatFailed',
      'Could not resume this session in a new chat.'
    )
  )
}
