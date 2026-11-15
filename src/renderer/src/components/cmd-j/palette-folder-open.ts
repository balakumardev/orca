import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ActivateAndRevealResult } from '@/lib/workspace/activation/worktree-activation-outcome'
import { pickLinkedWorktree } from './palette-linked-worktree-match'

export type FolderOpenProblem = 'gone' | 'worktree-missing' | 'not-opened'
export type FolderOpenOutcome = 'opened' | 'add-failed' | FolderOpenProblem

export type FolderOpenDeps = {
  /** Asks main for the folder as it is now; null when it is gone or no longer one to offer. */
  resolve: (path: string) => Promise<FolderSearchEntry | null>
  addFolderProject: (path: string) => Promise<Repo | null>
  addGitProject: (path: string) => Promise<Repo | null>
  refreshWorktrees: (repoId: string) => Promise<unknown>
  markGitProjectAdded: () => void
  openDefaultCheckout: (repoId: string) => Promise<unknown>
  listWorktrees: (repoId: string) => readonly Worktree[]
  activate: (worktree: Worktree) => ActivateAndRevealResult | false
  focusTerminal: (worktreeId: string, activation: ActivateAndRevealResult) => boolean
  notify: (problem: FolderOpenProblem) => void
}

/** The add Enter and Cmd/Ctrl+Enter share: the git project, its worktrees read, the onboarding step marked. */
async function addGitFolderProject(path: string, deps: FolderOpenDeps): Promise<Repo | null> {
  const repo = await deps.addGitProject(path)
  if (!repo) {
    // The add already explained the failure, or opened its own confirmation.
    return null
  }
  await deps.refreshWorktrees(repo.id)
  deps.markGitProjectAdded()
  return repo
}

/**
 * Cmd/Ctrl+Enter on an untracked git root: the same add Enter does, without opening the default checkout, so the
 * caller can start a new worktree in the project. Only a git root that main still offers is added.
 */
export async function addFolderEntryProject(
  picked: FolderSearchEntry,
  deps: FolderOpenDeps
): Promise<{ status: 'added'; repo: Repo } | { status: 'gone' | 'add-failed' }> {
  const entry = await deps.resolve(picked.path)
  if (entry?.kind !== 'git-root') {
    deps.notify('gone')
    return { status: 'gone' }
  }
  const repo = await addGitFolderProject(entry.path, deps)
  return repo ? { status: 'added', repo } : { status: 'add-failed' }
}

/**
 * Opens a folder with the flows Add Project already has: a folder project, or a git project handed to the
 * default checkout. Only a linked worktree is opened here, because Add Project would open the main
 * checkout beside it instead of the picked one.
 */
export async function openFolderEntry(
  picked: FolderSearchEntry,
  deps: FolderOpenDeps
): Promise<FolderOpenOutcome> {
  const entry = await deps.resolve(picked.path)
  if (!entry) {
    deps.notify('gone')
    return 'gone'
  }
  if (entry.kind === 'folder') {
    // The folder project flow opens the folder itself.
    return (await deps.addFolderProject(entry.path)) ? 'opened' : 'add-failed'
  }
  const repo = await addGitFolderProject(entry.path, deps)
  if (!repo) {
    return 'add-failed'
  }
  if (entry.kind === 'git-root') {
    await deps.openDefaultCheckout(repo.id)
    return 'opened'
  }
  const worktree = pickLinkedWorktree(deps.listWorktrees(repo.id), entry)
  if (!worktree) {
    deps.notify('worktree-missing')
    return 'worktree-missing'
  }
  const activation = deps.activate(worktree)
  if (!activation) {
    deps.notify('not-opened')
    return 'not-opened'
  }
  // A terminal that cannot take focus is not a failed open.
  deps.focusTerminal(worktree.id, activation)
  return 'opened'
}
