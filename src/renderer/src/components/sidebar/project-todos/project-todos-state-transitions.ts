import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import {
  PROJECT_TODOS_MAX_ITEMS_PER_PROJECT,
  PROJECT_TODO_MAX_TEXT_LENGTH,
  type ProjectTodoItem,
  type ProjectTodosByProject,
  type ProjectTodoWorktreeLink
} from '../../../../../shared/project-todos-types'

export type RemovedWorktreeCompletionTarget = {
  id: string
  hostId?: ExecutionHostId | null
}

export const EMPTY_EXPANDED_TODO_KEYS: ReadonlySet<string> = new Set()

export function toggleKeyInReadonlySet(
  current: ReadonlySet<string>,
  key: string
): { next: ReadonlySet<string>; added: boolean } {
  const next = new Set(current)
  const added = !next.has(key)
  if (added) {
    next.add(key)
  } else {
    next.delete(key)
  }
  return { next: next.size === 0 ? EMPTY_EXPANDED_TODO_KEYS : next, added }
}

export function removeCollapseKeyMatches(
  current: ReadonlySet<string>,
  collapseKey: string
): ReadonlySet<string> | null {
  if (current.size === 0) {
    return null
  }
  let changed = false
  const next = new Set<string>()
  for (const key of current) {
    if (key === collapseKey || key.endsWith(`:${collapseKey}`)) {
      changed = true
      continue
    }
    next.add(key)
  }
  if (!changed) {
    return null
  }
  return next.size === 0 ? EMPTY_EXPANDED_TODO_KEYS : next
}

function updateProjectList(
  projects: ProjectTodosByProject,
  projectKey: string,
  nextItems: ProjectTodoItem[]
): ProjectTodosByProject {
  if (nextItems.length === 0) {
    if (!(projectKey in projects)) {
      return projects
    }
    const next = { ...projects }
    delete next[projectKey]
    return next
  }
  return { ...projects, [projectKey]: nextItems }
}

function worktreeLinkMatchesRemoval(
  link: ProjectTodoWorktreeLink,
  target: RemovedWorktreeCompletionTarget
): boolean {
  if (link.worktreeId !== target.id) {
    return false
  }
  if (link.hostId && target.hostId) {
    return link.hostId === target.hostId
  }
  return true
}

export function createProjectTodoItem(rawText: string): ProjectTodoItem | null {
  const trimmed = rawText.trim().slice(0, PROJECT_TODO_MAX_TEXT_LENGTH)
  if (!trimmed) {
    return null
  }
  return {
    id: createNonSecureContextUuid(),
    text: trimmed,
    done: false,
    createdAt: Date.now()
  }
}

export function insertProjectTodoItem(
  projects: ProjectTodosByProject,
  projectKey: string,
  item: ProjectTodoItem
): ProjectTodosByProject {
  const existing = projects[projectKey] ?? []
  const nextItems = [item, ...existing].slice(0, PROJECT_TODOS_MAX_ITEMS_PER_PROJECT)
  return updateProjectList(projects, projectKey, nextItems)
}

export function toggleProjectTodoItemDone(
  projects: ProjectTodosByProject,
  projectKey: string,
  todoId: string
): ProjectTodosByProject | null {
  const existing = projects[projectKey]
  if (!existing) {
    return null
  }
  let changed = false
  const now = Date.now()
  const nextItems = existing.map((item) => {
    if (item.id !== todoId) {
      return item
    }
    changed = true
    const nextDone = !item.done
    return {
      ...item,
      done: nextDone,
      ...(nextDone ? { completedAt: now } : { completedAt: null })
    }
  })
  return changed ? updateProjectList(projects, projectKey, nextItems) : null
}

export function renameProjectTodoItem(
  projects: ProjectTodosByProject,
  projectKey: string,
  todoId: string,
  rawText: string
): ProjectTodosByProject | null {
  const trimmed = rawText.trim().slice(0, PROJECT_TODO_MAX_TEXT_LENGTH)
  if (!trimmed) {
    return null
  }
  const existing = projects[projectKey]
  if (!existing) {
    return null
  }
  let changed = false
  const nextItems = existing.map((item) => {
    if (item.id !== todoId || item.text === trimmed) {
      return item
    }
    changed = true
    return { ...item, text: trimmed }
  })
  return changed ? updateProjectList(projects, projectKey, nextItems) : null
}

export function removeProjectTodoItem(
  projects: ProjectTodosByProject,
  projectKey: string,
  todoId: string
): ProjectTodosByProject | null {
  const existing = projects[projectKey]
  if (!existing) {
    return null
  }
  const nextItems = existing.filter((item) => item.id !== todoId)
  return nextItems.length === existing.length
    ? null
    : updateProjectList(projects, projectKey, nextItems)
}

export function removeCompletedProjectTodos(
  projects: ProjectTodosByProject,
  projectKey: string
): ProjectTodosByProject | null {
  const existing = projects[projectKey]
  if (!existing) {
    return null
  }
  const nextItems = existing.filter((item) => !item.done)
  return nextItems.length === existing.length
    ? null
    : updateProjectList(projects, projectKey, nextItems)
}

export function setProjectTodoItemWorktree(
  projects: ProjectTodosByProject,
  projectKey: string,
  todoId: string,
  worktree: ProjectTodoWorktreeLink | null
): ProjectTodosByProject | null {
  const existing = projects[projectKey]
  if (!existing) {
    return null
  }
  let changed = false
  const nextItems = existing.map((item) => {
    if (item.id !== todoId) {
      return item
    }
    changed = true
    return {
      ...item,
      ...(worktree ? { worktree } : { worktree: null })
    }
  })
  return changed ? updateProjectList(projects, projectKey, nextItems) : null
}

export function markTodosCompletedForRemovedWorktrees(
  projects: ProjectTodosByProject,
  targets: readonly RemovedWorktreeCompletionTarget[]
): { nextProjects: ProjectTodosByProject | null; completedCount: number } {
  if (targets.length === 0) {
    return { nextProjects: null, completedCount: 0 }
  }
  let completedCount = 0
  const now = Date.now()
  let nextProjects: ProjectTodosByProject | null = null
  for (const [projectKey, items] of Object.entries(projects)) {
    let projectChanged = false
    const updated = items.map((item) => {
      const link = item.worktree
      if (item.done || !link) {
        return item
      }
      const matched = targets.some((target) => worktreeLinkMatchesRemoval(link, target))
      if (!matched) {
        return item
      }
      projectChanged = true
      completedCount += 1
      return {
        ...item,
        done: true,
        completedAt: now
      }
    })
    if (projectChanged) {
      nextProjects ??= { ...projects }
      nextProjects[projectKey] = updated
    }
  }
  return { nextProjects, completedCount }
}
