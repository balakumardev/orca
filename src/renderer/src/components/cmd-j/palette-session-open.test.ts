// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'
import { revealSessionWorkspace } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-original-pane-actions'
import { resumeAiVaultSessionInNewChat } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-resume-in-chat-launch'
import { useAppStore } from '@/store/index'
import type { PaletteSessionFacts } from './palette-session-action'
import { readPaletteSessionFacts } from './palette-session-facts'
import { sessionHit } from './palette-session-hit.test-fixture'
import { openPaletteSession } from './palette-session-open'
import { resumePaletteSessionInTerminal } from './palette-session-terminal-resume'

vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn(async () => true)
}))
vi.mock('@/lib/workspace/tabs/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: vi.fn()
}))
vi.mock(
  '@/components/right-sidebar/ai-vault/session-actions/ai-vault-original-pane-actions',
  () => ({
    revealSessionWorkspace: vi.fn(() => true)
  })
)
vi.mock(
  '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-resume-in-chat-launch',
  () => ({ resumeAiVaultSessionInNewChat: vi.fn(async () => {}) })
)
vi.mock('./palette-session-facts', async (importOriginal) => {
  const original = await importOriginal<{ paletteSessionOfHit: unknown }>()
  return { paletteSessionOfHit: original.paletteSessionOfHit, readPaletteSessionFacts: vi.fn() }
})
vi.mock('./palette-session-terminal-resume', () => ({
  resumePaletteSessionInTerminal: vi.fn(async () => {})
}))

const closed: PaletteSessionFacts = {
  nativeChat: false,
  originalPane: null,
  resumable: true,
  ownerWorkspaceId: 'wt-web',
  opensAsChat: true,
  terminalResumeWorkspaceId: 'wt-web',
  chatResume: { available: true, workspaceId: 'wt-web' }
}
const hit = sessionHit('s-1')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(revealSessionWorkspace).mockReturnValue(true)
})

describe('openPaletteSession', () => {
  it('resumes a closed conversation in a new chat of its own workspace', async () => {
    vi.mocked(readPaletteSessionFacts).mockReturnValue(closed)
    await openPaletteSession(hit)
    expect(resumeAiVaultSessionInNewChat).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agent: 'claude', sessionId: 's-1', cwd: '/code/acme-web' }),
      'claude',
      'wt-web',
      expect.any(String)
    )
    expect(activateAiVaultStructuredSession).not.toHaveBeenCalled()
  })

  it('resumes it in a new terminal of its own workspace when the agent opens as CLI', async () => {
    vi.mocked(readPaletteSessionFacts).mockReturnValue({ ...closed, opensAsChat: false })
    await openPaletteSession(hit)
    expect(resumePaletteSessionInTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agent: 'claude', sessionId: 's-1', cwd: '/code/acme-web' }),
      'wt-web'
    )
    expect(resumeAiVaultSessionInNewChat).not.toHaveBeenCalled()
  })

  it('reads the store as it is at Enter, not as it was when the row was drawn', async () => {
    vi.mocked(readPaletteSessionFacts).mockReturnValue(closed)
    await openPaletteSession(hit)
    expect(readPaletteSessionFacts).toHaveBeenCalledExactlyOnceWith(useAppStore.getState(), hit)
  })

  it('reveals the pane that still holds the conversation and focuses it', async () => {
    vi.mocked(readPaletteSessionFacts).mockReturnValue({
      ...closed,
      originalPane: {
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'wt-api',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      }
    })
    await openPaletteSession(hit)
    expect(revealSessionWorkspace).toHaveBeenCalledExactlyOnceWith('wt-api')
    expect(activateTabAndFocusPane).toHaveBeenCalledExactlyOnceWith('tab-1', 'leaf-1', {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    expect(resumeAiVaultSessionInNewChat).not.toHaveBeenCalled()
  })

  it('shows the terminal tab of the workspace that holds the pane before it focuses the pane', async () => {
    const setActiveTabType = vi.fn()
    useAppStore.setState({ setActiveTabType })
    vi.mocked(readPaletteSessionFacts).mockReturnValue({
      ...closed,
      originalPane: {
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'wt-api',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      }
    })
    await openPaletteSession(hit)
    expect(setActiveTabType).toHaveBeenCalledExactlyOnceWith('terminal', 'wt-api')
  })

  it('resumes only an agent that adopts a CLI conversation as a chat', async () => {
    vi.mocked(readPaletteSessionFacts).mockReturnValue(closed)
    await openPaletteSession(sessionHit('s-3', { agent: 'cursor' }))
    expect(resumeAiVaultSessionInNewChat).not.toHaveBeenCalled()
    await openPaletteSession(sessionHit('s-4', { agent: 'codex' }))
    expect(resumeAiVaultSessionInNewChat).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agent: 'codex', sessionId: 's-4' }),
      'codex',
      'wt-web',
      expect.any(String)
    )
  })

  it('focuses no pane when its workspace could not be revealed', async () => {
    vi.mocked(revealSessionWorkspace).mockReturnValue(false)
    vi.mocked(readPaletteSessionFacts).mockReturnValue({
      ...closed,
      originalPane: {
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'wt-api',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      }
    })
    await openPaletteSession(hit)
    expect(activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('reopens the chat that owns a native chat transcript', async () => {
    const chatHit = sessionHit('s-2', {
      structuredSession: { sessionId: 'chat-2', workspaceId: 'wt-web' }
    })
    vi.mocked(readPaletteSessionFacts).mockReturnValue({ ...closed, nativeChat: true })
    await openPaletteSession(chatHit)
    expect(activateAiVaultStructuredSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        structuredSession: { sessionId: 'chat-2', workspaceId: 'wt-web' }
      })
    )
    expect(resumeAiVaultSessionInNewChat).not.toHaveBeenCalled()
  })

  it('does nothing for a conversation whose folder Orca does not track', async () => {
    vi.mocked(readPaletteSessionFacts).mockReturnValue({
      ...closed,
      ownerWorkspaceId: null,
      chatResume: { available: true, workspaceId: 'wt-open' }
    })
    await openPaletteSession(hit)
    expect(resumeAiVaultSessionInNewChat).not.toHaveBeenCalled()
    expect(activateAiVaultStructuredSession).not.toHaveBeenCalled()
    expect(activateTabAndFocusPane).not.toHaveBeenCalled()
  })
})
