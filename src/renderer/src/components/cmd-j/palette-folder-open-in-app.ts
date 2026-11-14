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
import { openFolderEntry, type FolderOpenProblem } from './palette-folder-open'

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

/** Wires the open flow to the app store and the local folder search bridge. */
export async function openFolderEntryInApp(entry: FolderSearchEntry): Promise<void> {
  const state = () => useAppStore.getState()
  await openFolderEntry(entry, {
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
  })
}
