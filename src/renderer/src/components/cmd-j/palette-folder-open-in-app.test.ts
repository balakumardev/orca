// @vitest-environment happy-dom

import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openProjectDefaultCheckout } from '@/components/sidebar/project-admission/completion/project-added-default-checkout'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace/activation/workspace-activation-terminal-focus'
import { useAppStore } from '@/store/index'
import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import { makeRepo, makeWorktree } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { addFolderAndBeginNameStepInApp, openFolderEntryInApp } from './palette-folder-open-in-app'
import { endProjectNameStep, getProjectNameStep } from './palette-project-name-step-store'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
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

describe('addFolderAndBeginNameStepInApp', () => {
  const gitRoot: FolderSearchEntry = { path: '/code/app', kind: 'git-root' }
  const added = { ...makeRepo(), id: 'repo-app', path: '/code/app', displayName: 'app' }

  beforeEach(() => {
    useAppStore.setState({ activeModal: 'worktree-palette' })
    resolvesTo(gitRoot)
  })
  afterEach(() => {
    endProjectNameStep()
    vi.useRealTimers()
  })

  it('adds the git root locally and starts the name step on the new project once the store has it', async () => {
    addRepoPath.mockImplementation(async () => {
      useAppStore.setState({ repos: [added] })
      return added
    })
    await expect(addFolderAndBeginNameStepInApp(gitRoot)).resolves.toBe(true)

    expect(addRepoPath).toHaveBeenCalledExactlyOnceWith('/code/app', 'git', {
      runtimeEnvironmentId: null
    })
    expect(fetchWorktrees).toHaveBeenCalledExactlyOnceWith('repo-app', {
      requireAuthoritative: true,
      executionHostId: 'local'
    })
    expect(openProjectDefaultCheckout).not.toHaveBeenCalled()
    expect(getProjectNameStep()).toMatchObject({
      repoId: 'repo-app',
      projectLabel: 'app',
      projectPath: '/code/app',
      name: '',
      workspaceTarget: { hostId: 'local', projectId: 'repo:repo-app' }
    })
  })

  it('waits for a project the store does not hold yet instead of starting the step too early', async () => {
    addRepoPath.mockResolvedValue(added)
    const pending = addFolderAndBeginNameStepInApp(gitRoot)
    await vi.waitFor(() => expect(fetchWorktrees).toHaveBeenCalled())
    expect(getProjectNameStep()).toBeNull()

    useAppStore.setState({ repos: [added] })
    await pending
    expect(getProjectNameStep()).toMatchObject({ repoId: 'repo-app' })
  })

  it('tells the user and starts no step when the project never reaches the store', async () => {
    vi.useFakeTimers()
    addRepoPath.mockResolvedValue(added)
    const pending = addFolderAndBeginNameStepInApp(gitRoot)
    await vi.advanceTimersByTimeAsync(3100)

    // The project is added whatever happens to the step, so the caller drops the folder row.
    await expect(pending).resolves.toBe(true)
    expect(getProjectNameStep()).toBeNull()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'The project was added, but a new worktree could not be started in it'
    )
  })

  it('tells the user, and keeps the project, when the palette closed while it was added', async () => {
    addRepoPath.mockImplementation(async () => {
      useAppStore.setState({ repos: [added], activeModal: 'none' })
      return added
    })
    await expect(addFolderAndBeginNameStepInApp(gitRoot)).resolves.toBe(true)

    expect(getProjectNameStep()).toBeNull()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'The project was added, but a new worktree could not be started in it'
    )
  })

  it('reports the project as added when reading its worktrees fails after the add', async () => {
    addRepoPath.mockResolvedValue(added)
    fetchWorktrees.mockRejectedValue(new Error('boom'))
    await expect(addFolderAndBeginNameStepInApp(gitRoot)).resolves.toBe(true)

    expect(getProjectNameStep()).toBeNull()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'The project was added, but a new worktree could not be started in it'
    )
  })

  it('leaves the palette as it was when the add fails, and does not add twice on a second press', async () => {
    addRepoPath.mockResolvedValue(null)
    await expect(
      Promise.all([
        addFolderAndBeginNameStepInApp(gitRoot),
        addFolderAndBeginNameStepInApp(gitRoot)
      ])
    ).resolves.toEqual([false, false])

    expect(addRepoPath).toHaveBeenCalledTimes(1)
    expect(getProjectNameStep()).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('adds nothing for a folder that is no longer a git root', async () => {
    resolvesTo({ path: '/code/app', kind: 'folder' })
    await addFolderAndBeginNameStepInApp(gitRoot)

    expect(addRepoPath).not.toHaveBeenCalled()
    expect(getProjectNameStep()).toBeNull()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('That folder is no longer there')
  })

  it('reports a failure that escapes the add and starts no step', async () => {
    addRepoPath.mockRejectedValue(new Error('boom'))
    await addFolderAndBeginNameStepInApp(gitRoot)

    expect(getProjectNameStep()).toBeNull()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'Could not add the folder and start a new worktree'
    )
  })
})
