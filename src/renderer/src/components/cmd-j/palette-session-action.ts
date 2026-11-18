import type { AiVaultOriginalPaneTarget } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-original-pane'
import type { AiVaultResumeInChatEligibility } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-resume-in-chat'

/** What the palette knows about one transcript hit, read from the store when the row is built or chosen. */
export type PaletteSessionFacts = {
  /** The hit is a native chat's own transcript: its chat tab is reopened, never adopted a second time. */
  nativeChat: boolean
  /** A pane or retained pane that still holds this conversation. */
  originalPane: AiVaultOriginalPaneTarget | null
  /** The transcript file is still there and the host recorded a resume command for it. */
  resumable: boolean
  /** The workspace Orca tracks for the transcript's own folder, never the workspace that happens to be open. */
  ownerWorkspaceId: string | null
  /** Settings open as Chat every agent whose chat could take this conversation over; says nothing of whether one can start. */
  opensAsChat: boolean
  /** Where the Agents panel's resume button would start this conversation in a terminal, or null. */
  terminalResumeWorkspaceId: string | null
  chatResume: AiVaultResumeInChatEligibility
}

export type PaletteSessionInertReason = 'folder-not-in-orca' | 'cannot-resume'

export type PaletteSessionAction =
  | { kind: 'open-chat' }
  | { kind: 'reveal-pane'; target: AiVaultOriginalPaneTarget }
  | { kind: 'resume-terminal'; workspaceId: string }
  | { kind: 'resume-chat'; workspaceId: string }
  | { kind: 'none'; reason: PaletteSessionInertReason }

/**
 * Enter on a transcript hit: reopen the chat that owns it, else jump to the pane still holding it, else resume
 * it in the workspace that owns its folder, in a new terminal or a new chat as Settings open its agent. A
 * transcript whose folder maps to no workspace of Orca does nothing: Claude finds a conversation by its folder,
 * so resuming it anywhere else would start the wrong one.
 */
export function resolvePaletteSessionAction(facts: PaletteSessionFacts): PaletteSessionAction {
  if (facts.nativeChat) {
    return { kind: 'open-chat' }
  }
  if (facts.originalPane) {
    return { kind: 'reveal-pane', target: facts.originalPane }
  }
  if (facts.ownerWorkspaceId === null) {
    return { kind: 'none', reason: 'folder-not-in-orca' }
  }
  // CLI resumes in a terminal as the Agents panel's resume button does; a chat would keep the conversation.
  if (!facts.opensAsChat) {
    return facts.resumable && facts.terminalResumeWorkspaceId === facts.ownerWorkspaceId
      ? { kind: 'resume-terminal', workspaceId: facts.ownerWorkspaceId }
      : { kind: 'none', reason: 'cannot-resume' }
  }
  if (
    facts.resumable &&
    facts.chatResume.available &&
    facts.chatResume.workspaceId === facts.ownerWorkspaceId
  ) {
    return { kind: 'resume-chat', workspaceId: facts.ownerWorkspaceId }
  }
  return { kind: 'none', reason: 'cannot-resume' }
}
