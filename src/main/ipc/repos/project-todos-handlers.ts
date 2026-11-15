import { BrowserWindow, app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  PROJECT_TODOS_FILE_NAME,
  createProjectTodosService,
  type ProjectTodosService
} from '../../project-todos/project-todos-service'

let sharedProjectTodosService: ProjectTodosService | null = null

function getSharedProjectTodosService(): ProjectTodosService {
  sharedProjectTodosService ??= createProjectTodosService({
    resolveFilePath: () => join(app.getPath('userData'), PROJECT_TODOS_FILE_NAME),
    broadcast: (projects, senderWebContentsId) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents.id === senderWebContentsId) {
          continue
        }
        win.webContents.send('projectTodos:changed', projects)
      }
    }
  })
  return sharedProjectTodosService
}

export function registerProjectTodosHandlers(): void {
  const service = getSharedProjectTodosService()
  ipcMain.handle('projectTodos:list', () => service.list())
  ipcMain.handle('projectTodos:save', (event, projects: unknown) =>
    service.save(projects, event.sender.id)
  )
}
