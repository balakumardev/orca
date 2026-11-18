import { describe, expect, it } from 'vitest'
import { resolvePaletteSessionAction, type PaletteSessionFacts } from './palette-session-action'

const pane = { paneKey: 'tab-1:leaf-1', worktreeId: 'wt-web', tabId: 'tab-1', leafId: 'leaf-1' }

/** A closed conversation whose folder is a tracked workspace and that a chat can take over. */
const resumable: PaletteSessionFacts = {
  nativeChat: false,
  originalPane: null,
  resumable: true,
  ownerWorkspaceId: 'wt-web',
  opensAsChat: true,
  terminalResumeWorkspaceId: 'wt-web',
  chatResume: { available: true, workspaceId: 'wt-web' }
}

describe('resolvePaletteSessionAction', () => {
  it('resumes a closed conversation in a new chat of the workspace that owns its folder', () => {
    expect(resolvePaletteSessionAction(resumable)).toEqual({
      kind: 'resume-chat',
      workspaceId: 'wt-web'
    })
  })

  it('resumes it in a new terminal of that workspace instead when Settings open the agent as CLI', () => {
    expect(resolvePaletteSessionAction({ ...resumable, opensAsChat: false })).toEqual({
      kind: 'resume-terminal',
      workspaceId: 'wt-web'
    })
    // Also for an agent no chat can take over, such as Cursor.
    expect(
      resolvePaletteSessionAction({
        ...resumable,
        opensAsChat: false,
        chatResume: { available: false, reason: 'agent' }
      })
    ).toEqual({ kind: 'resume-terminal', workspaceId: 'wt-web' })
  })

  it('never hands it to a chat for an agent opened as CLI, when the terminal cannot take it there', () => {
    for (const terminalResumeWorkspaceId of [null, 'wt-open-elsewhere']) {
      expect(
        resolvePaletteSessionAction({ ...resumable, opensAsChat: false, terminalResumeWorkspaceId })
      ).toEqual({ kind: 'none', reason: 'cannot-resume' })
    }
    expect(
      resolvePaletteSessionAction({ ...resumable, opensAsChat: false, resumable: false })
    ).toEqual({ kind: 'none', reason: 'cannot-resume' })
  })

  it('jumps to the pane that still holds the conversation instead of resuming it', () => {
    expect(resolvePaletteSessionAction({ ...resumable, originalPane: pane })).toEqual({
      kind: 'reveal-pane',
      target: pane
    })
  })

  it('reopens the chat that owns a native chat transcript, even with a pane or a workspace', () => {
    expect(
      resolvePaletteSessionAction({ ...resumable, nativeChat: true, originalPane: pane })
    ).toEqual({ kind: 'open-chat' })
    expect(
      resolvePaletteSessionAction({
        ...resumable,
        nativeChat: true,
        ownerWorkspaceId: null,
        chatResume: { available: false, reason: 'already-structured' }
      })
    ).toEqual({ kind: 'open-chat' })
  })

  it('does nothing for a folder that maps to no workspace, however eligible the chat looks', () => {
    expect(
      resolvePaletteSessionAction({
        ...resumable,
        ownerWorkspaceId: null,
        chatResume: { available: true, workspaceId: 'wt-open-elsewhere' }
      })
    ).toEqual({ kind: 'none', reason: 'folder-not-in-orca' })
  })

  it('does nothing when the chat would open in a workspace other than the owner', () => {
    expect(
      resolvePaletteSessionAction({
        ...resumable,
        chatResume: { available: true, workspaceId: 'wt-open-elsewhere' }
      })
    ).toEqual({ kind: 'none', reason: 'cannot-resume' })
  })

  it('does nothing when the transcript is gone or the agent has no chat to take it over', () => {
    expect(resolvePaletteSessionAction({ ...resumable, resumable: false })).toEqual({
      kind: 'none',
      reason: 'cannot-resume'
    })
    expect(
      resolvePaletteSessionAction({
        ...resumable,
        chatResume: { available: false, reason: 'agent' }
      })
    ).toEqual({ kind: 'none', reason: 'cannot-resume' })
  })
})
