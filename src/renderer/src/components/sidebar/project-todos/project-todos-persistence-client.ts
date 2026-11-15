import {
  normalizeProjectTodosByProject,
  type ProjectTodosByProject
} from '../../../../../shared/project-todos-types'

const LOCAL_STORAGE_FALLBACK_KEY = 'orca-custom.projectTodos.v1'

function hasDesktopProjectTodosBridge(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.api?.projectTodos?.list === 'function' &&
    typeof window.api?.projectTodos?.save === 'function'
  )
}

function readLocalStorageFallback(): ProjectTodosByProject {
  if (typeof window === 'undefined') {
    return {}
  }
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_FALLBACK_KEY)
    if (!raw) {
      return {}
    }
    return normalizeProjectTodosByProject(JSON.parse(raw))
  } catch {
    return {}
  }
}

function writeLocalStorageFallback(projects: ProjectTodosByProject): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(LOCAL_STORAGE_FALLBACK_KEY, JSON.stringify(projects))
  } catch {
    // Ignore storage quota errors in fallback mode.
  }
}

export async function loadPersistedProjectTodos(): Promise<ProjectTodosByProject> {
  if (hasDesktopProjectTodosBridge()) {
    try {
      const loaded = await window.api.projectTodos.list()
      return normalizeProjectTodosByProject(loaded)
    } catch {
      return readLocalStorageFallback()
    }
  }
  return readLocalStorageFallback()
}

export async function savePersistedProjectTodos(
  projects: ProjectTodosByProject
): Promise<ProjectTodosByProject> {
  const normalized = normalizeProjectTodosByProject(projects)
  if (hasDesktopProjectTodosBridge()) {
    try {
      return await window.api.projectTodos.save(normalized)
    } catch {
      writeLocalStorageFallback(normalized)
      return normalized
    }
  }
  writeLocalStorageFallback(normalized)
  return normalized
}

export function subscribePersistedProjectTodosChanged(
  listener: (projects: ProjectTodosByProject) => void
): () => void {
  if (typeof window === 'undefined' || typeof window.api?.projectTodos?.onChanged !== 'function') {
    return () => {}
  }
  return window.api.projectTodos.onChanged((projects) => {
    listener(normalizeProjectTodosByProject(projects))
  })
}
