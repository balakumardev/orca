import type { ProjectTodosByProject } from '../../shared/project-todos-types'

export type ProjectTodosApi = {
  list: () => Promise<ProjectTodosByProject>
  save: (projects: ProjectTodosByProject) => Promise<ProjectTodosByProject>
  onChanged: (listener: (projects: ProjectTodosByProject) => void) => () => void
}
