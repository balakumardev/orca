import { toast } from 'sonner'
import type { FolderSearchEntry } from '../../../../shared/folder-search-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace/activation/workspace-activation-terminal-focus'
import { markOnboardingProjectAdded } from '@/components/onboarding/onboarding-project-checklist'
import { openProjectDefaultCheckout } from '@/components/sidebar/project-admission/completion/project-added-default-checkout'
import { getPaletteWorktreeExecutionHostId } from '@/lib/workspace/search/palette-repo-resolution'
import { getRepoWorkspaceCreationTargetHint } from '@/lib/workspace/creation/project-host-workspace-target'
import {
  getPaletteSearchHosts,
  isPaletteSearchHostCurrent,
  paletteSearchHostGuard,
  type PaletteSearchHost
} from './palette-search-hosts'
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

function assertFolderHostCurrent(
  host: PaletteSearchHost | undefined
): asserts host is PaletteSearchHost {
  if (!host || !isPaletteSearchHostCurrent(host)) {
    throw new Error(
      translate(
        'auto.components.WorktreeJumpPalette.folderHostChanged',
        'The computer for this folder changed or disconnected. Search again.'
      )
    )
  }
}

function folderHost(entry: FolderSearchEntry, offeredHost?: PaletteSearchHost): PaletteSearchHost {
  const hostId = entry.executionHostId ?? LOCAL_EXECUTION_HOST_ID
  const candidate = offeredHost ?? getPaletteSearchHosts(useAppStore.getState(), [hostId])[0]
  const host = candidate?.executionHostId === hostId ? candidate : undefined
  assertFolderHostCurrent(host)
  return host
}

function folderOpenDeps(host: PaletteSearchHost): FolderOpenDeps {
  const state = () => useAppStore.getState()
  // Local opens have no pairing lifetime; only a remote action needs a queued authority guard.
  const remoteGuard = host.runtimeEnvironmentId ? { targetGuard: paletteSearchHostGuard(host) } : {}
  const target = {
    runtimeEnvironmentId: host.runtimeEnvironmentId,
    // The main-process queue needs the original runtime identity as well as the renderer check.
    ...remoteGuard
  }
  const onCurrentHost = <T>(action: () => T): T => {
    assertFolderHostCurrent(host)
    return action()
  }
  return {
    resolve: async (path) => {
      assertFolderHostCurrent(host)
      const entry = await window.api.folderSearch.resolve(path, host.executionHostId)
      // Selection owns the authority across the await, including a replacement pairing on the same host id.
      assertFolderHostCurrent(host)
      return entry
    },
    addFolderProject: (path) => onCurrentHost(() => state().addNonGitFolder(path, target)),
    addGitProject: (path) => onCurrentHost(() => state().addRepoPath(path, 'git', target)),
    refreshWorktrees: (repoId) =>
      onCurrentHost(() =>
        state().fetchWorktrees(repoId, {
          requireAuthoritative: true,
          executionHostId: host.executionHostId
        })
      ),
    markGitProjectAdded: () => void markOnboardingProjectAdded('addedRepo'),
    openDefaultCheckout: (repoId) =>
      onCurrentHost(() =>
        openProjectDefaultCheckout({
          repoId,
          source: 'local_folder_picker',
          executionHostId: host.executionHostId,
          ...remoteGuard
        })
      ),
    listWorktrees: (repoId) =>
      (selectWorktreesByRepo(state())[repoId] ?? []).filter(
        (worktree) =>
          (getPaletteWorktreeExecutionHostId(worktree) ?? LOCAL_EXECUTION_HOST_ID) ===
          host.executionHostId
      ),
    activate: (worktree) =>
      onCurrentHost(() =>
        activateAndRevealWorkspace(worktree.id, {
          navigationIntent: 'user-open',
          executionHostId: host.executionHostId,
          ...remoteGuard
        })
      ),
    focusTerminal: queueWorkspaceActivationTerminalFocus,
    notify: (problem) => toast.error(translate(...PROBLEM_MESSAGES[problem]))
  }
}

/** The selected computer owns every add, catalog refresh, and workspace activation. */
export async function openFolderEntryInApp(
  entry: FolderSearchEntry,
  host?: PaletteSearchHost
): Promise<void> {
  try {
    await openFolderEntry(entry, folderOpenDeps(folderHost(entry, host)))
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : translate(...PROBLEM_MESSAGES['not-opened'])
    )
  }
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
export async function addFolderAndBeginNameStepInApp(
  entry: FolderSearchEntry,
  offeredHost?: PaletteSearchHost
): Promise<boolean> {
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
    const host = folderHost(entry, offeredHost)
    const base = folderOpenDeps(host)
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
    const workspaceTarget = getRepoWorkspaceCreationTargetHint(
      added.repo,
      useAppStore.getState().projectHostSetups
    )
    const ready = await waitUntilComposerTargetsRepo(repoId, undefined, workspaceTarget)
    assertFolderHostCurrent(host)
    const live = useAppStore.getState()
    const repo = live.repos.find(
      (candidate) =>
        candidate.id === repoId && getRepoExecutionHostId(candidate) === host.executionHostId
    )
    const started =
      ready &&
      repo !== undefined &&
      beginProjectNameStep({
        repoId,
        workspaceTarget,
        host,
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
