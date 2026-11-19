import type { ExecutionHostId } from './execution-host/execution-host'
import type { GroupHeaderRow, WorktreeGroupBy } from './sidebar-list/row-types'

export const PROJECT_TODOS_MAX_PROJECTS = 512
export const PROJECT_TODOS_MAX_ITEMS_PER_PROJECT = 500
export const PROJECT_TODO_MAX_TEXT_LENGTH = 500

export type ProjectTodoWorktreeLink = {
  worktreeId: string
  hostId?: ExecutionHostId | null
  displayName: string
}

export type ProjectTodoItem = {
  id: string
  text: string
  done: boolean
  createdAt: number
  completedAt?: number | null
  worktree?: ProjectTodoWorktreeLink | null
}

export type ProjectTodosByProject = Record<string, ProjectTodoItem[]>

export type ProjectTodoComposerLink = {
  projectKey: string
  todoId: string
}

function normalizeWorktreeLink(raw: unknown): ProjectTodoWorktreeLink | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const { worktreeId, hostId, displayName } = raw as Record<string, unknown>
  if (typeof worktreeId !== 'string' || worktreeId.trim().length === 0) {
    return null
  }
  const trimmedName =
    typeof displayName === 'string' && displayName.trim().length > 0
      ? displayName.trim().slice(0, 120)
      : worktreeId.trim().slice(0, 120)
  const validHostId =
    hostId === 'local' ||
    (typeof hostId === 'string' && (hostId.startsWith('ssh:') || hostId.startsWith('runtime:')))
      ? (hostId as ExecutionHostId)
      : null
  return {
    worktreeId: worktreeId.trim(),
    ...(validHostId ? { hostId: validHostId } : {}),
    displayName: trimmedName
  }
}

export function normalizeProjectTodoItem(raw: unknown): ProjectTodoItem | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const { id, text, done, createdAt, completedAt, worktree } = raw as Record<string, unknown>
  if (typeof id !== 'string' || id.trim().length === 0 || typeof text !== 'string') {
    return null
  }
  const trimmedText = text.trim().slice(0, PROJECT_TODO_MAX_TEXT_LENGTH)
  if (trimmedText.length === 0) {
    return null
  }
  const normalizedDone = done === true
  const normalizedCreatedAt =
    typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt >= 0
      ? Math.trunc(createdAt)
      : 0
  const normalizedCompletedAt =
    normalizedDone &&
    typeof completedAt === 'number' &&
    Number.isFinite(completedAt) &&
    completedAt >= 0
      ? Math.trunc(completedAt)
      : null
  const normalizedWorktree = normalizeWorktreeLink(worktree)
  return {
    id: id.trim().slice(0, 128),
    text: trimmedText,
    done: normalizedDone,
    createdAt: normalizedCreatedAt,
    ...(normalizedCompletedAt !== null ? { completedAt: normalizedCompletedAt } : {}),
    ...(normalizedWorktree ? { worktree: normalizedWorktree } : {})
  }
}

export function normalizeProjectTodosByProject(raw: unknown): ProjectTodosByProject {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {}
  }
  const entries = Object.entries(raw as Record<string, unknown>).slice(
    0,
    PROJECT_TODOS_MAX_PROJECTS
  )
  const result: ProjectTodosByProject = {}
  for (const [projectKey, rawItems] of entries) {
    const trimmedKey = projectKey.trim()
    if (
      trimmedKey.length === 0 ||
      trimmedKey.length > 256 ||
      (!trimmedKey.startsWith('repo:') && !trimmedKey.startsWith('project-group:')) ||
      !Array.isArray(rawItems)
    ) {
      continue
    }
    const items: ProjectTodoItem[] = []
    const seenIds = new Set<string>()
    for (const candidate of rawItems.slice(0, PROJECT_TODOS_MAX_ITEMS_PER_PROJECT)) {
      const item = normalizeProjectTodoItem(candidate)
      if (!item || seenIds.has(item.id)) {
        continue
      }
      seenIds.add(item.id)
      items.push(item)
    }
    if (items.length > 0) {
      result[trimmedKey] = items
    }
  }
  return result
}

/** Resolves the durable project key for a sidebar header row, or null for non-project headers. */
export function getProjectTodoScopeKeyFromHeader(
  row: Pick<GroupHeaderRow, 'repo' | 'anchorRepo' | 'projectGroup'>,
  groupBy: WorktreeGroupBy
): string | null {
  if (groupBy !== 'repo') {
    return null
  }
  const targetRepo = row.anchorRepo ?? row.repo
  if (targetRepo) {
    return `repo:${targetRepo.id}`
  }
  if (
    row.projectGroup &&
    'parentPath' in row.projectGroup &&
    Boolean(row.projectGroup.parentPath)
  ) {
    return `project-group:${row.projectGroup.id}`
  }
  return null
}

/** Distinguishes per-host header copies so toggling TODOs opens under the clicked header row. */
export function getProjectTodoSectionOccurrenceKey(
  row: Pick<GroupHeaderRow, 'hostId' | 'key'>
): string {
  return row.hostId ? `${row.hostId}:${row.key}` : row.key
}

/** Builds a clean kebab-case worktree/branch seed from a quick TODO idea. */
export function slugifyTodoWorktreeName(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= 40) {
    return slug
  }
  const clipped = slug.slice(0, 40).replace(/-+$/g, '')
  const lastHyphen = clipped.lastIndexOf('-')
  return lastHyphen >= 16 ? clipped.slice(0, lastHyphen) : clipped
}
