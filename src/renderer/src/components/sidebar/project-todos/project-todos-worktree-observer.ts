import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { getFolderWorkspaceHostId } from '../../../../../shared/folder-workspaces/folder-workspace-host-id'
import type { ProjectTodoComposerLink } from '../../../../../shared/project-todos-types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { branchName } from '@/lib/source-control/branches/branch-name'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import type { StoreObserverHost } from '@/store/store-observer-installers'
import type { AppState } from '@/store/types'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import type { ComposerModalData } from '@/components/new-workspace/composer/composer-modal-data'
import {
  completeProjectTodosForRemovedWorktrees,
  useProjectTodosStore
} from './project-todos-store'

const consumedComposerModalObjects = new WeakSet<object>()

function extractActiveComposerTodoLink(state: AppState): {
  modalObject: object
  todoLink: ProjectTodoComposerLink
  initialRepoId?: string
  initialProjectGroupId?: string
} | null {
  if (state.activeModal !== 'new-workspace-composer' || !state.modalData) {
    return null
  }
  const modalData = state.modalData as ComposerModalData
  if (!modalData.todoLink || consumedComposerModalObjects.has(modalData)) {
    return null
  }
  return {
    modalObject: modalData,
    todoLink: modalData.todoLink,
    initialRepoId: modalData.initialRepoId,
    initialProjectGroupId: modalData.initialProjectGroupId
  }
}

function resolveWorktreeLinkDetails(
  state: AppState,
  worktreeId: string,
  preferredRepoId?: string,
  fallbackHostId?: ExecutionHostId
): { worktreeId: string; hostId?: ExecutionHostId | null; displayName: string } | null {
  const candidateRepos = preferredRepoId
    ? [
        ...(state.worktreesByRepo[preferredRepoId] ? [preferredRepoId] : []),
        ...Object.keys(state.worktreesByRepo).filter((id) => id !== preferredRepoId)
      ]
    : Object.keys(state.worktreesByRepo)
  for (const repoId of candidateRepos) {
    const worktrees = state.worktreesByRepo[repoId] ?? []
    const match = worktrees.find((wt) => wt.id === worktreeId)
    if (match) {
      const repo = state.repos.find((r) => r.id === repoId)
      const hostId = getWorktreeExecutionHostId(match, repo) ?? fallbackHostId ?? null
      const displayName = match.displayName?.trim() || branchName(match.branch) || worktreeId
      return { worktreeId: match.id, hostId, displayName }
    }
  }
  return null
}

/** Links a completed background worktree creation back to the TODO item that initiated it. */
export function completeTodoWorktreeCreation(
  state: AppState,
  creationId: string,
  worktreeId: string,
  request?: Pick<WorktreeCreationRequest, 'repoId' | 'executionHostId' | 'workspaceRunContext'>
): void {
  const todoStore = useProjectTodosStore.getState()
  const pendingLink = todoStore.clearPendingCreationLink(creationId)
  if (!pendingLink) {
    return
  }
  const fallbackHostId = request?.workspaceRunContext?.hostId ?? request?.executionHostId
  const resolved = resolveWorktreeLinkDetails(
    state,
    worktreeId,
    request?.repoId,
    fallbackHostId
  ) ?? {
    worktreeId,
    ...(fallbackHostId ? { hostId: fallbackHostId } : {}),
    displayName: worktreeId
  }
  todoStore.assignTodoWorktree(pendingLink.projectKey, pendingLink.todoId, resolved)
}

function reconcilePostStartupMissingLocalWorktrees(state: AppState): void {
  const todoStore = useProjectTodosStore.getState()
  if (!todoStore.hydrated) {
    return
  }
  const localRepoIds = new Set(
    state.repos
      .filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
      .map((repo) => repo.id)
  )
  const missingTargets: { id: string; hostId: ExecutionHostId }[] = []
  for (const [projectKey, items] of Object.entries(todoStore.projects)) {
    if (!projectKey.startsWith('repo:')) {
      continue
    }
    const repoId = projectKey.slice('repo:'.length)
    if (!localRepoIds.has(repoId)) {
      continue
    }
    const knownWorktrees = state.worktreesByRepo[repoId]
    if (!knownWorktrees) {
      continue
    }
    const liveLocalIds = new Set(knownWorktrees.map((wt) => wt.id))
    for (const item of items) {
      if (item.done || !item.worktree) {
        continue
      }
      const { worktreeId, hostId } = item.worktree
      if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
        continue
      }
      if (hostId && hostId !== LOCAL_EXECUTION_HOST_ID) {
        continue
      }
      if (!liveLocalIds.has(worktreeId)) {
        missingTargets.push({ id: worktreeId, hostId: LOCAL_EXECUTION_HOST_ID })
      }
    }
  }
  if (missingTargets.length > 0) {
    completeProjectTodosForRemovedWorktrees(missingTargets)
  }
}

export function installProjectTodosWorktreeObserver(store: StoreObserverHost): void {
  void useProjectTodosStore
    .getState()
    .hydrateProjectTodos()
    .then(() => {
      const current = store.getState()
      if (current.startupWorktreeRefreshCompleted) {
        reconcilePostStartupRefresh(current)
      }
    })

  let reconciledStartup = false
  const reconcilePostStartupRefresh = (state: AppState): void => {
    if (reconciledStartup) {
      return
    }
    reconciledStartup = true
    reconcilePostStartupMissingLocalWorktrees(state)
  }

  store.subscribe((state, previous) => {
    // 1. Sync collapsed project headers -> close expanded TODO section for that header.
    if (state.collapsedGroups !== previous.collapsedGroups) {
      for (const key of state.collapsedGroups) {
        if (!previous.collapsedGroups.has(key)) {
          useProjectTodosStore.getState().closeTodoSectionsForCollapseKey(key)
        }
      }
    }

    // 2. Bind new pending worktree creations launched while NewWorkspaceComposerModal had a todoLink.
    if (state.pendingWorktreeCreations !== previous.pendingWorktreeCreations) {
      const composerTodo =
        extractActiveComposerTodoLink(previous) ?? extractActiveComposerTodoLink(state)
      if (composerTodo) {
        for (const [creationId, entry] of Object.entries(state.pendingWorktreeCreations)) {
          if (creationId in previous.pendingWorktreeCreations) {
            continue
          }
          if (composerTodo.initialRepoId && entry.request.repoId !== composerTodo.initialRepoId) {
            continue
          }
          consumedComposerModalObjects.add(composerTodo.modalObject)
          useProjectTodosStore
            .getState()
            .bindPendingCreationToTodo(creationId, composerTodo.todoLink)
          break
        }
      }

      // Eagerly link as soon as worktreeId is stamped on a bound pending creation, and clean up cancelled ones.
      const pendingCreationById = useProjectTodosStore.getState().pendingCreationById
      for (const [creationId, link] of Object.entries(pendingCreationById)) {
        const entry = state.pendingWorktreeCreations[creationId]
        if (!entry) {
          useProjectTodosStore.getState().clearPendingCreationLink(creationId)
          continue
        }
        if (entry.worktreeId) {
          const details = resolveWorktreeLinkDetails(
            state,
            entry.worktreeId,
            entry.request.repoId,
            entry.request.workspaceRunContext?.hostId ?? entry.request.executionHostId
          )
          if (details) {
            useProjectTodosStore.getState().clearPendingCreationLink(creationId)
            useProjectTodosStore
              .getState()
              .assignTodoWorktree(link.projectKey, link.todoId, details)
          }
        }
      }
    }

    // 3. Handle folder-workspace creation auto-linking & folder-workspace deletion auto-completion.
    const nextFolders = selectFolderWorkspaces(state)
    const prevFolders = selectFolderWorkspaces(previous)
    if (nextFolders !== prevFolders) {
      const composerTodo =
        extractActiveComposerTodoLink(previous) ?? extractActiveComposerTodoLink(state)
      if (composerTodo) {
        const prevIds = new Set(prevFolders.map((fw) => fw.id))
        const added = nextFolders.find(
          (fw) =>
            !prevIds.has(fw.id) &&
            (!composerTodo.initialProjectGroupId ||
              fw.projectGroupId === composerTodo.initialProjectGroupId)
        )
        if (added) {
          consumedComposerModalObjects.add(composerTodo.modalObject)
          useProjectTodosStore
            .getState()
            .assignTodoWorktree(composerTodo.todoLink.projectKey, composerTodo.todoLink.todoId, {
              worktreeId: folderWorkspaceKey(added.id),
              hostId: getFolderWorkspaceHostId(added, state.projectGroups),
              displayName: added.name
            })
        }
      }

      if (prevFolders.length > 0) {
        const nextIds = new Set(nextFolders.map((fw) => fw.id))
        const liveGroupIds = new Set((state.projectGroups ?? []).map((pg) => pg.id))
        const removedFolderTargets = prevFolders
          .filter((fw) => !nextIds.has(fw.id) && liveGroupIds.has(fw.projectGroupId))
          .map((fw) => ({
            id: folderWorkspaceKey(fw.id),
            hostId: getFolderWorkspaceHostId(fw, previous.projectGroups)
          }))
        if (removedFolderTargets.length > 0) {
          completeProjectTodosForRemovedWorktrees(removedFolderTargets)
        }
      }
    }

    // 4. Reconcile local worktrees removed while Orca was closed once startup refresh completes.
    if (state.startupWorktreeRefreshCompleted && !previous.startupWorktreeRefreshCompleted) {
      reconcilePostStartupRefresh(state)
    }
  })
}
