import { create } from 'zustand'
import type {
  ProjectTodoComposerLink,
  ProjectTodoItem,
  ProjectTodosByProject,
  ProjectTodoWorktreeLink
} from '../../../../../shared/project-todos-types'
import {
  loadPersistedProjectTodos,
  savePersistedProjectTodos,
  subscribePersistedProjectTodosChanged
} from './project-todos-persistence-client'
import {
  EMPTY_EXPANDED_TODO_KEYS,
  createProjectTodoItem,
  insertProjectTodoItem,
  markTodosCompletedForRemovedWorktrees,
  removeCollapseKeyMatches,
  removeCompletedProjectTodos,
  removeProjectTodoItem,
  renameProjectTodoItem,
  setProjectTodoItemWorktree,
  toggleKeyInReadonlySet,
  toggleProjectTodoItemDone,
  type RemovedWorktreeCompletionTarget
} from './project-todos-state-transitions'

export { EMPTY_EXPANDED_TODO_KEYS, type RemovedWorktreeCompletionTarget }

export const EMPTY_PROJECT_TODO_ITEMS: readonly ProjectTodoItem[] = []

type ProjectTodosStoreState = {
  hydrated: boolean
  hasLocalMutations: boolean
  projects: ProjectTodosByProject
  expandedSectionKeys: ReadonlySet<string>
  doneExpandedSectionKeys: ReadonlySet<string>
  focusInputSectionKey: string | null
  pendingCreationById: Record<string, ProjectTodoComposerLink>
  hydrateProjectTodos: () => Promise<void>
  toggleTodoSection: (sectionKey: string, options?: { focusInput?: boolean }) => void
  openTodoSection: (sectionKey: string, options?: { focusInput?: boolean }) => void
  closeTodoSection: (sectionKey: string) => void
  closeTodoSectionsForCollapseKey: (collapseKey: string) => void
  consumeFocusInputRequest: (sectionKey: string) => boolean
  toggleDoneSection: (sectionKey: string) => void
  addTodo: (projectKey: string, text: string) => ProjectTodoItem | null
  toggleTodoDone: (projectKey: string, todoId: string) => void
  updateTodoText: (projectKey: string, todoId: string, text: string) => void
  deleteTodo: (projectKey: string, todoId: string) => void
  clearCompletedTodos: (projectKey: string) => void
  assignTodoWorktree: (
    projectKey: string,
    todoId: string,
    worktree: ProjectTodoWorktreeLink | null
  ) => void
  bindPendingCreationToTodo: (creationId: string, link: ProjectTodoComposerLink) => void
  clearPendingCreationLink: (creationId: string) => ProjectTodoComposerLink | undefined
  completeTodosForRemovedWorktrees: (targets: readonly RemovedWorktreeCompletionTarget[]) => number
}

let hydrationPromise: Promise<void> | null = null
let unsubscribeBroadcast: (() => void) | null = null

function persistProjectsSnapshot(projects: ProjectTodosByProject): void {
  void savePersistedProjectTodos(projects)
}

export const useProjectTodosStore = create<ProjectTodosStoreState>((set, get) => {
  const applyProjectUpdate = (nextProjects: ProjectTodosByProject | null): void => {
    if (!nextProjects) {
      return
    }
    persistProjectsSnapshot(nextProjects)
    set({ projects: nextProjects, hasLocalMutations: true })
  }

  return {
    hydrated: false,
    hasLocalMutations: false,
    projects: {},
    expandedSectionKeys: EMPTY_EXPANDED_TODO_KEYS,
    doneExpandedSectionKeys: EMPTY_EXPANDED_TODO_KEYS,
    focusInputSectionKey: null,
    pendingCreationById: {},

    hydrateProjectTodos: async () => {
      if (get().hydrated) {
        return
      }
      if (hydrationPromise) {
        return hydrationPromise
      }
      unsubscribeBroadcast ??= subscribePersistedProjectTodosChanged((projects) => {
        set({ projects, hydrated: true })
      })
      hydrationPromise = loadPersistedProjectTodos()
        .then((loaded) => {
          set((state) => {
            if (state.hasLocalMutations) {
              const merged: ProjectTodosByProject = { ...loaded, ...state.projects }
              persistProjectsSnapshot(merged)
              return { projects: merged, hydrated: true }
            }
            return { projects: loaded, hydrated: true }
          })
        })
        .finally(() => {
          hydrationPromise = null
        })
      return hydrationPromise
    },

    toggleTodoSection: (sectionKey, options) => {
      set((state) => {
        const { next, added } = toggleKeyInReadonlySet(state.expandedSectionKeys, sectionKey)
        return {
          expandedSectionKeys: next,
          focusInputSectionKey:
            added && options?.focusInput
              ? sectionKey
              : state.focusInputSectionKey === sectionKey
                ? null
                : state.focusInputSectionKey
        }
      })
    },

    openTodoSection: (sectionKey, options) => {
      set((state) => ({
        expandedSectionKeys: new Set(state.expandedSectionKeys).add(sectionKey),
        focusInputSectionKey: options?.focusInput ? sectionKey : state.focusInputSectionKey
      }))
    },

    closeTodoSection: (sectionKey) => {
      set((state) => {
        if (!state.expandedSectionKeys.has(sectionKey)) {
          return state
        }
        const { next } = toggleKeyInReadonlySet(state.expandedSectionKeys, sectionKey)
        return {
          expandedSectionKeys: next,
          focusInputSectionKey:
            state.focusInputSectionKey === sectionKey ? null : state.focusInputSectionKey
        }
      })
    },

    closeTodoSectionsForCollapseKey: (collapseKey) => {
      set((state) => {
        const next = removeCollapseKeyMatches(state.expandedSectionKeys, collapseKey)
        return next ? { expandedSectionKeys: next } : state
      })
    },

    consumeFocusInputRequest: (sectionKey) => {
      if (get().focusInputSectionKey !== sectionKey) {
        return false
      }
      set({ focusInputSectionKey: null })
      return true
    },

    toggleDoneSection: (sectionKey) => {
      set((state) => ({
        doneExpandedSectionKeys: toggleKeyInReadonlySet(state.doneExpandedSectionKeys, sectionKey)
          .next
      }))
    },

    addTodo: (projectKey, rawText) => {
      const item = createProjectTodoItem(rawText)
      if (!item) {
        return null
      }
      applyProjectUpdate(insertProjectTodoItem(get().projects, projectKey, item))
      return item
    },

    toggleTodoDone: (projectKey, todoId) => {
      applyProjectUpdate(toggleProjectTodoItemDone(get().projects, projectKey, todoId))
    },

    updateTodoText: (projectKey, todoId, rawText) => {
      applyProjectUpdate(renameProjectTodoItem(get().projects, projectKey, todoId, rawText))
    },

    deleteTodo: (projectKey, todoId) => {
      applyProjectUpdate(removeProjectTodoItem(get().projects, projectKey, todoId))
    },

    clearCompletedTodos: (projectKey) => {
      applyProjectUpdate(removeCompletedProjectTodos(get().projects, projectKey))
    },

    assignTodoWorktree: (projectKey, todoId, worktree) => {
      applyProjectUpdate(setProjectTodoItemWorktree(get().projects, projectKey, todoId, worktree))
    },

    bindPendingCreationToTodo: (creationId, link) => {
      set((state) => ({
        pendingCreationById: { ...state.pendingCreationById, [creationId]: link }
      }))
    },

    clearPendingCreationLink: (creationId) => {
      const existing = get().pendingCreationById[creationId]
      if (!existing) {
        return undefined
      }
      set((state) => {
        const next = { ...state.pendingCreationById }
        delete next[creationId]
        return { pendingCreationById: next }
      })
      return existing
    },

    completeTodosForRemovedWorktrees: (targets) => {
      const { nextProjects, completedCount } = markTodosCompletedForRemovedWorktrees(
        get().projects,
        targets
      )
      applyProjectUpdate(nextProjects)
      return completedCount
    }
  }
})

export function useExpandedProjectTodoSectionKeys(): ReadonlySet<string> {
  return useProjectTodosStore((state) => state.expandedSectionKeys)
}

export function completeProjectTodosForRemovedWorktrees(
  targets: readonly RemovedWorktreeCompletionTarget[]
): number {
  return useProjectTodosStore.getState().completeTodosForRemovedWorktrees(targets)
}
