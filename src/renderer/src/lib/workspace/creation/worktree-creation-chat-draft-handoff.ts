import { useAppStore } from '@/store/index'
import { moveStructuredAgentLaunchDraft } from '@/lib/agent-session/launch/structured-agent-session-launch-draft'
import { getStructuredAgentSessionLaunchOwner } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/workspace-mounting/background-terminal-worktree-mount'
import {
  nativeChatComposerSelection,
  waitForNativeChatComposerHandoff
} from '@/components/native-chat/composer/focus/native-chat-composer-mount'
import '@/components/native-chat/composer/focus/use-native-chat-composer-reveal-focus'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'

const HANDOFF_READY_TIMEOUT_MS = 5000

/** Moves the pending creation's unsent draft into the chat tab that replaced it, on the creation's own host. */
export async function handOffCreationChatDraft(
  tabId: string | null,
  context: {
    creationId: string
    worktreeId: string
    shouldActivateOnCompletion: boolean
    sourceScope: string
    abandoned: AbortSignal
    revealAbandoned: AbortSignal
    isTargetCurrent: () => boolean
  }
): Promise<void> {
  const { creationId, worktreeId, sourceScope, abandoned, revealAbandoned } = context
  const tab = tabId ? useAppStore.getState().getTab(tabId) : null
  if (tab?.contentType !== 'agent-session' || !context.isTargetCurrent()) {
    return
  }
  const state = useAppStore.getState()
  if (
    context.shouldActivateOnCompletion &&
    state.activeView === 'terminal' &&
    state.activePendingCreationId === creationId
  ) {
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tab.id] })
    await waitForNativeChatComposerHandoff(
      sourceScope,
      tab.id,
      revealAbandoned,
      HANDOFF_READY_TIMEOUT_MS
    )
  }
  if (abandoned.aborted) {
    return
  }
  const selection = revealAbandoned.aborted ? undefined : nativeChatComposerSelection(sourceScope)
  if (selection) {
    captureNativeChatComposerFocusIntent().request(tab.id)
  }
  const executionHostId = tab.executionHostId ?? getStructuredAgentSessionLaunchOwner(tab.entityId)
  if (executionHostId) {
    moveStructuredAgentLaunchDraft(
      { sessionId: tab.entityId, worktreeId, executionHostId },
      sourceScope,
      selection
    )
  }
}
