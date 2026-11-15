import { toast } from 'sonner'
import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace/activation/workspace-activation-terminal-focus'
import { markOnboardingProjectAdded } from '@/components/onboarding/onboarding-project-checklist'
import { openProjectDefaultCheckout } from '@/components/sidebar/project-admission/completion/project-added-default-checkout'
import {
  addFolderEntryProject,
  openFolderEntry,
  type FolderOpenDeps,
  type FolderOpenProblem
} from './palette-folder-open'
import { waitUntilComposerTargetsRepo } from './palette-composer-target'
import { beginProjectNameStep } from './palette-project-name-step-store'
import {
  getProjectCreateLabel,
  selectPaletteProjectCatalog
} from './palette-project-create-targets'

const PROBLEM_MESSAGES: Record<FolderOpenProblem, [key: string, fallback: string]> = {
  gone: ['auto.components.WorktreeJumpPalette.folderGone', 'That folder is no longer there'],
  'worktree-missing': [
    'auto.components.WorktreeJumpPalette.folderWorktreeMissing',
    'The folder was added, but no workspace for it was found'
  ],
  'not-opened': [
    'auto.components.WorktreeJumpPalette.folderNotOpened',
    'The folder was added, but its workspace could not be opened'
  ]
}

/** The picked path lives on this machine, whatever host new projects default to. */
const LOCAL_ADD = { runtimeEnvironmentId: null }

function folderOpenDeps(): FolderOpenDeps {
  const state = () => useAppStore.getState()
  return {
    resolve: (path) => window.api.folderSearch.resolve(path),
    addFolderProject: (path) => state().addNonGitFolder(path, LOCAL_ADD),
    addGitProject: (path) => state().addRepoPath(path, 'git', LOCAL_ADD),
    refreshWorktrees: (repoId) =>
      state().fetchWorktrees(repoId, {
        requireAuthoritative: true,
        executionHostId: LOCAL_EXECUTION_HOST_ID
      }),
    markGitProjectAdded: () => void markOnboardingProjectAdded('addedRepo'),
    openDefaultCheckout: (repoId) =>
      openProjectDefaultCheckout({
        repoId,
        source: 'local_folder_picker',
        setHideDefaultBranchWorkspace: state().setHideDefaultBranchWorkspace,
        executionHostId: LOCAL_EXECUTION_HOST_ID
      }),
    listWorktrees: (repoId) =>
      (selectWorktreesByRepo(state())[repoId] ?? []).filter(
        (worktree) =>
          !worktree.runtimeOwnerEnvironmentId &&
          (!worktree.hostId || worktree.hostId === LOCAL_EXECUTION_HOST_ID)
      ),
    activate: (worktree) =>
      activateAndRevealWorkspace(worktree.id, {
        navigationIntent: 'user-open',
        executionHostId: LOCAL_EXECUTION_HOST_ID
      }),
    focusTerminal: queueWorkspaceActivationTerminalFocus,
    notify: (problem) => toast.error(translate(...PROBLEM_MESSAGES[problem]))
  }
}

/** Wires the open flow to the app store and the local folder search bridge. */
export async function openFolderEntryInApp(entry: FolderSearchEntry): Promise<void> {
  await openFolderEntry(entry, folderOpenDeps())
}

/** An add that has not settled after this long is treated as over, so one that never settles cannot block later presses. */
const NEW_WORKTREE_FLIGHT_LIMIT_MS = 15_000
let newWorktreeStartedAt: number | null = null

function reportNameStepNotStarted(): void {
  toast.error(
    translate(
      'auto.components.WorktreeJumpPalette.folderNewWorktreeNotReady',
      'The project was added, but a new worktree could not be started in it'
    )
  )
}

/**
 * Cmd/Ctrl+Enter on an untracked git root: adds the project the way Enter does, then starts the palette's name
 * step for it. The step starts only once the dialog would resolve to the new project: the auto-submitting dialog
 * presses Create only on the project the palette picked, and on another one it opens visibly and creates nothing.
 * Resolves true once the project was added, whatever happens after, so the caller can drop the folder row that
 * main no longer offers. When the step cannot start (the palette closed, the project not ready, a late failure)
 * the project stays added and a toast says so; when the add itself fails, nothing is added. A second press while
 * an add runs is ignored.
 */
export async function addFolderAndBeginNameStepInApp(entry: FolderSearchEntry): Promise<boolean> {
  const startedAt = Date.now()
  if (
    newWorktreeStartedAt !== null &&
    startedAt - newWorktreeStartedAt < NEW_WORKTREE_FLIGHT_LIMIT_MS
  ) {
    return false
  }
  newWorktreeStartedAt = startedAt
  let projectAdded = false
  try {
    const base = folderOpenDeps()
    const added = await addFolderEntryProject(entry, {
      ...base,
      addGitProject: async (path) => {
        const repo = await base.addGitProject(path)
        projectAdded = repo !== null
        return repo
      }
    })
    if (added.status !== 'added') {
      return false
    }
    const repoId = added.repo.id
    const ready = await waitUntilComposerTargetsRepo(repoId)
    const live = useAppStore.getState()
    const repo = live.repos.find((candidate) => candidate.id === repoId)
    const started =
      ready &&
      repo !== undefined &&
      beginProjectNameStep({
        repoId,
        projectLabel: getProjectCreateLabel(repo, selectPaletteProjectCatalog(live))
      })
    if (!started) {
      reportNameStepNotStarted()
    }
    return true
  } catch {
    if (projectAdded) {
      reportNameStepNotStarted()
    } else {
      toast.error(
        translate(
          'auto.components.WorktreeJumpPalette.folderNewWorktreeFailed',
          'Could not add the folder and start a new worktree'
        )
      )
    }
    return projectAdded
  } finally {
    if (newWorktreeStartedAt === startedAt) {
      newWorktreeStartedAt = null
    }
  }
}
