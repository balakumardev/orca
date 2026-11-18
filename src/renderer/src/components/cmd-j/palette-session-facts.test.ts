// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makeRepo, makeWorktree } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { resolvePaletteSessionAction } from './palette-session-action'
import { readPaletteSessionFacts } from './palette-session-facts'
import { sessionHit } from './palette-session-hit.test-fixture'

// The Session History resolver offers the open workspace as a fallback when the session's own workspace is
// missing. These tests answer as if a chat could be started anywhere, so only the palette's own rule is under test.
const resolveResume = vi.hoisted(() =>
  vi.fn((_args: { activeWorktreeId: string | null }) => ({
    resumeState: { blocked: false, worktreeId: 'wt-open', usesSessionWorktree: false },
    resumeInChat: { available: true, workspaceId: 'wt-open' }
  }))
)
vi.mock(
  '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-resume-in-chat-workspace',
  () => ({ resolveAiVaultHistoryRowResume: resolveResume })
)

const initialAppState = useAppStore.getInitialState()

beforeEach(() => {
  useAppStore.setState(
    {
      ...initialAppState,
      repos: [makeRepo()],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree('wt-open', 'Open workspace', { path: '/code/open' }),
          makeWorktree('wt-web', 'Acme web', { path: '/code/acme-web' }),
          makeWorktree('wt-old', 'Old branch', { path: '/code/old-branch', isArchived: true })
        ]
      },
      activeWorktreeId: 'wt-open'
    },
    true
  )
})
afterEach(() => useAppStore.setState(initialAppState, true))

function facts(overrides: Parameters<typeof sessionHit>[1]) {
  return readPaletteSessionFacts(useAppStore.getState(), sessionHit('s-1', overrides))
}

describe('readPaletteSessionFacts', () => {
  it('names the workspace that owns the transcript folder, also for a folder inside it', () => {
    expect(facts({ cwd: '/code/acme-web' }).ownerWorkspaceId).toBe('wt-web')
    expect(facts({ cwd: '/code/acme-web/packages/ui' }).ownerWorkspaceId).toBe('wt-web')
  })

  it('names no workspace for a folder Orca does not track, though another workspace is open', () => {
    expect(facts({ cwd: '/code/unknown-repo' }).ownerWorkspaceId).toBeNull()
    expect(facts({ cwd: null }).ownerWorkspaceId).toBeNull()
    expect(resolvePaletteSessionAction(facts({ cwd: '/code/unknown-repo' }))).toEqual({
      kind: 'none',
      reason: 'folder-not-in-orca'
    })
  })

  it('names no workspace for an archived one', () => {
    expect(facts({ cwd: '/code/old-branch' }).ownerWorkspaceId).toBeNull()
  })

  it('never resumes into the open workspace, even when the resolver offers it', () => {
    expect(resolvePaletteSessionAction(facts({ cwd: '/code/acme-web' }))).toEqual({
      kind: 'none',
      reason: 'cannot-resume'
    })
  })

  it('asks the resume resolver with no active workspace, so it cannot fall back to the open one', () => {
    facts({ cwd: '/code/unknown-repo' })
    expect(resolveResume).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeWorktreeId: null })
    )
    expect(useAppStore.getState().activeWorktreeId).toBe('wt-open')
  })

  it('marks a hit whose transcript is a native chat, and one whose transcript is gone', () => {
    expect(
      facts({ structuredSession: { sessionId: 'chat-1', workspaceId: 'wt-web' } }).nativeChat
    ).toBe(true)
    expect(facts({}).nativeChat).toBe(false)
    expect(facts({ source: { presence: 'missing' }, resumeCommand: undefined }).resumable).toBe(
      false
    )
    expect(facts({}).resumable).toBe(true)
  })

  it('opens as chat only when Settings open every chat that could take the conversation over as Chat', () => {
    useAppStore.setState({
      settings: {
        ...initialAppState.settings!,
        agentDefaultSurface: 'chat',
        nativeChatProviders: { claude: false, opencode: false }
      }
    })
    expect(facts({ agent: 'claude' }).opensAsChat).toBe(false)
    expect(facts({ agent: 'codex' }).opensAsChat).toBe(true)
    // An OpenCode chat can take an OpenCode 2 conversation over, and OpenCode opens as CLI.
    expect(facts({ agent: 'opencode2' }).opensAsChat).toBe(false)
  })

  it('names where the Agents panel would resume it in a terminal', () => {
    resolveResume.mockReturnValueOnce({
      resumeState: { blocked: false, worktreeId: 'wt-web', usesSessionWorktree: true },
      resumeInChat: { available: true, workspaceId: 'wt-web' }
    })
    expect(facts({}).terminalResumeWorkspaceId).toBe('wt-web')
  })
})
