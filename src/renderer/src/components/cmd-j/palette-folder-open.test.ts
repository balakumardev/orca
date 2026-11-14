import { describe, expect, it, vi } from 'vitest'
import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { makeRepo, makeWorktree } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { openFolderEntry, type FolderOpenDeps } from './palette-folder-open'

function setup(
  options: {
    fresh?: FolderSearchEntry | null
    repo?: Repo | null
    worktrees?: Worktree[]
    activation?: { primaryTabId: string | null } | false
  } = {}
) {
  const calls: string[] = []
  const repo = options.repo === undefined ? makeRepo() : options.repo
  const deps: FolderOpenDeps = {
    resolve: vi.fn(async (path: string): Promise<FolderSearchEntry | null> => {
      calls.push(`resolve:${path}`)
      return options.fresh === undefined ? { path, kind: 'folder' } : options.fresh
    }),
    addFolderProject: vi.fn(async (path) => {
      calls.push(`add-folder:${path}`)
      return repo
    }),
    addGitProject: vi.fn(async (path) => {
      calls.push(`add-git:${path}`)
      return repo
    }),
    refreshWorktrees: vi.fn(async (repoId) => {
      calls.push(`refresh:${repoId}`)
    }),
    openDefaultCheckout: vi.fn(async (repoId) => {
      calls.push(`open-default:${repoId}`)
    }),
    markGitProjectAdded: vi.fn(() => {
      calls.push('mark-added')
    }),
    listWorktrees: () => options.worktrees ?? [],
    activate: vi.fn((worktree) => {
      calls.push(`activate:${worktree.id}`)
      return options.activation === undefined ? { primaryTabId: 'tab-1' } : options.activation
    }),
    focusTerminal: vi.fn(() => {
      calls.push('focus')
      return true
    }),
    notify: vi.fn((problem) => {
      calls.push(`notify:${problem}`)
    })
  }
  return { deps, calls }
}

const feature = makeWorktree('feature-id', 'feature', { path: '/code/feature' })

describe('openFolderEntry', () => {
  it('opens a plain folder through the folder project flow and nothing else', async () => {
    const { deps, calls } = setup({ fresh: { path: '/code/notes', kind: 'folder' } })
    expect(await openFolderEntry({ path: '/code/notes', kind: 'folder' }, deps)).toBe('opened')
    expect(calls).toEqual(['resolve:/code/notes', 'add-folder:/code/notes'])
  })

  it('adds a git root as a git project and hands the open to the default checkout flow', async () => {
    const { deps, calls } = setup({ fresh: { path: '/code/app', kind: 'git-root' } })
    expect(await openFolderEntry({ path: '/code/app', kind: 'git-root' }, deps)).toBe('opened')
    expect(calls).toEqual([
      'resolve:/code/app',
      'add-git:/code/app',
      'refresh:repo-1',
      'mark-added',
      'open-default:repo-1'
    ])
  })

  it('opens the picked linked worktree, not the default checkout of its project', async () => {
    const { deps, calls } = setup({
      fresh: { path: '/code/feature', kind: 'linked-worktree' },
      worktrees: [feature]
    })
    expect(await openFolderEntry({ path: '/code/feature', kind: 'linked-worktree' }, deps)).toBe(
      'opened'
    )
    expect(calls).toEqual([
      'resolve:/code/feature',
      'add-git:/code/feature',
      'refresh:repo-1',
      'mark-added',
      'activate:feature-id',
      'focus'
    ])
  })

  it('adds nothing when the folder is gone, and says so', async () => {
    const { deps, calls } = setup({ fresh: null })
    expect(await openFolderEntry({ path: '/code/deleted', kind: 'folder' }, deps)).toBe('gone')
    expect(calls).toEqual(['resolve:/code/deleted', 'notify:gone'])
  })

  it('opens what the main process found now, not the kind the list showed', async () => {
    const { deps, calls } = setup({ fresh: { path: '/code/was-plain', kind: 'git-root' } })
    await openFolderEntry({ path: '/code/was-plain', kind: 'folder' }, deps)
    expect(calls).toContain('add-git:/code/was-plain')
    expect(calls).not.toContain('add-folder:/code/was-plain')
  })

  it('stays quiet when the add itself failed, because the add already reported it', async () => {
    const { deps, calls } = setup({
      repo: null,
      fresh: { path: '/code/app', kind: 'git-root' }
    })
    expect(await openFolderEntry({ path: '/code/app', kind: 'git-root' }, deps)).toBe('add-failed')
    expect(calls).toEqual(['resolve:/code/app', 'add-git:/code/app'])
  })

  it('says which worktree is missing when the project has none at the picked path', async () => {
    const { deps, calls } = setup({
      fresh: { path: '/code/feature', kind: 'linked-worktree' },
      worktrees: [makeWorktree('other-id', 'other', { path: '/code/other' })]
    })
    expect(await openFolderEntry({ path: '/code/feature', kind: 'linked-worktree' }, deps)).toBe(
      'worktree-missing'
    )
    expect(calls.at(-1)).toBe('notify:worktree-missing')
  })

  it('reports a refused activation as not opened', async () => {
    const { deps, calls } = setup({
      fresh: { path: '/code/feature', kind: 'linked-worktree' },
      worktrees: [feature],
      activation: false
    })
    expect(await openFolderEntry({ path: '/code/feature', kind: 'linked-worktree' }, deps)).toBe(
      'not-opened'
    )
    expect(calls.at(-1)).toBe('notify:not-opened')
  })

  it('does not count a terminal that cannot be focused as a failure', async () => {
    const { deps } = setup({
      fresh: { path: '/code/feature', kind: 'linked-worktree' },
      worktrees: [feature]
    })
    vi.mocked(deps.focusTerminal).mockReturnValue(false)
    expect(await openFolderEntry({ path: '/code/feature', kind: 'linked-worktree' }, deps)).toBe(
      'opened'
    )
    expect(deps.focusTerminal).toHaveBeenCalledOnce()
    expect(deps.notify).not.toHaveBeenCalled()
  })
})
