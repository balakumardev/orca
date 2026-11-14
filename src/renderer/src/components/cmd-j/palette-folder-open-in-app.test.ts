// @vitest-environment happy-dom

import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openProjectDefaultCheckout } from '@/components/sidebar/project-admission/completion/project-added-default-checkout'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace/activation/workspace-activation-terminal-focus'
import { useAppStore } from '@/store/index'
import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import { makeRepo, makeWorktree } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { openFolderEntryInApp } from './palette-folder-open-in-app'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/components/onboarding/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: vi.fn(async () => ({}))
}))
vi.mock('@/components/sidebar/project-admission/completion/project-added-default-checkout', () => ({
  openProjectDefaultCheckout: vi.fn(async () => {})
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(() => ({ primaryTabId: 'tab-1' }))
}))
vi.mock('@/lib/workspace/activation/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn(() => true)
}))

const initialAppState = useAppStore.getInitialState()
const addRepoPath = vi.fn()
const addNonGitFolder = vi.fn()
const fetchWorktrees = vi.fn()
const setHideDefaultBranchWorkspace = vi.fn()

function resolvesTo(fresh: FolderSearchEntry | null): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { folderSearch: { resolve: vi.fn(async () => fresh) } }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  addRepoPath.mockResolvedValue(makeRepo())
  addNonGitFolder.mockResolvedValue(makeRepo())
  fetchWorktrees.mockResolvedValue(true)
  useAppStore.setState(
    {
      ...initialAppState,
      addRepoPath,
      addNonGitFolder,
      fetchWorktrees,
      setHideDefaultBranchWorkspace
    },
    true
  )
})
afterEach(() => useAppStore.setState(initialAppState, true))

describe('openFolderEntryInApp', () => {
  it('adds a plain folder with the folder project action, on this machine', async () => {
    resolvesTo({ path: '/code/notes', kind: 'folder' })
    await openFolderEntryInApp({ path: '/code/notes', kind: 'folder' })
    expect(addNonGitFolder).toHaveBeenCalledExactlyOnceWith('/code/notes', {
      runtimeEnvironmentId: null
    })
    expect(addRepoPath).not.toHaveBeenCalled()
  })

  it('adds a git root locally, refreshes it, and opens its default checkout', async () => {
    resolvesTo({ path: '/code/app', kind: 'git-root' })
    await openFolderEntryInApp({ path: '/code/app', kind: 'git-root' })
    expect(addRepoPath).toHaveBeenCalledExactlyOnceWith('/code/app', 'git', {
      runtimeEnvironmentId: null
    })
    expect(fetchWorktrees).toHaveBeenCalledExactlyOnceWith('repo-1', {
      requireAuthoritative: true,
      executionHostId: 'local'
    })
    expect(openProjectDefaultCheckout).toHaveBeenCalledExactlyOnceWith({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      setHideDefaultBranchWorkspace,
      executionHostId: 'local'
    })
  })

  it('opens the picked linked worktree through the user-open activation', async () => {
    const linked = makeWorktree('repo-1::/code/feature', 'feature', { path: '/code/feature' })
    useAppStore.setState({ worktreesByRepo: { 'repo-1': [linked] } })
    resolvesTo({ path: '/code/feature', kind: 'linked-worktree' })
    await openFolderEntryInApp({ path: '/code/feature', kind: 'linked-worktree' })
    expect(activateAndRevealWorkspace).toHaveBeenCalledExactlyOnceWith(linked.id, {
      navigationIntent: 'user-open',
      executionHostId: 'local'
    })
    expect(queueWorkspaceActivationTerminalFocus).toHaveBeenCalledWith(linked.id, {
      primaryTabId: 'tab-1'
    })
    expect(openProjectDefaultCheckout).not.toHaveBeenCalled()
  })

  it('adds nothing and tells the user when the folder is gone', async () => {
    resolvesTo(null)
    await openFolderEntryInApp({ path: '/code/deleted', kind: 'folder' })
    expect(addNonGitFolder).not.toHaveBeenCalled()
    expect(addRepoPath).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('That folder is no longer there')
  })
})
