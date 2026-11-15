import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { ProjectTodosByProject } from '../../shared/project-todos-types'

export const projectTodosApi = {
  list: () => ipcRenderer.invoke('projectTodos:list'),
  save: (projects) => ipcRenderer.invoke('projectTodos:save', projects),
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, projects: ProjectTodosByProject): void => {
      listener(projects)
    }
    ipcRenderer.on('projectTodos:changed', handler)
    return () => {
      ipcRenderer.removeListener('projectTodos:changed', handler)
    }
  }
} satisfies PreloadApi['projectTodos']
