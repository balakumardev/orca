import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectTodosByProject } from '../../shared/project-todos-types'
import { PROJECT_TODOS_FILE_NAME, createProjectTodosService } from './project-todos-service'

describe('project-todos-service', () => {
  let rootDir: string
  let filePath: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'orca-project-todos-'))
    filePath = join(rootDir, PROJECT_TODOS_FILE_NAME)
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('persists sanitized project TODOs atomically and reloads them across service restarts', async () => {
    const broadcasts: { projects: ProjectTodosByProject; senderId?: number }[] = []
    const first = createProjectTodosService({
      resolveFilePath: () => filePath,
      broadcast: (projects, senderId) => {
        broadcasts.push({ projects, senderId })
      }
    })

    expect(first.list()).toEqual({})

    await first.save(
      {
        'repo:orca': [
          {
            id: 'todo-1',
            text: '  Add sidebar quick ideas  ',
            done: false,
            createdAt: 1700000000,
            worktree: {
              worktreeId: 'orca::/wt/ideas',
              hostId: 'local',
              displayName: 'sidebar-ideas'
            }
          },
          { id: 'empty-dropped', text: '   ', done: false, createdAt: 1 }
        ],
        'invalid-key-dropped': [{ id: 'x', text: 'ignored', done: false, createdAt: 1 }]
      },
      42
    )

    expect(broadcasts).toEqual([
      {
        senderId: 42,
        projects: {
          'repo:orca': [
            {
              id: 'todo-1',
              text: 'Add sidebar quick ideas',
              done: false,
              createdAt: 1700000000,
              worktree: {
                worktreeId: 'orca::/wt/ideas',
                hostId: 'local',
                displayName: 'sidebar-ideas'
              }
            }
          ]
        }
      }
    ])

    const restarted = createProjectTodosService({
      resolveFilePath: () => filePath,
      broadcast: () => {}
    })

    expect(restarted.list()).toEqual({
      'repo:orca': [
        {
          id: 'todo-1',
          text: 'Add sidebar quick ideas',
          done: false,
          createdAt: 1700000000,
          worktree: {
            worktreeId: 'orca::/wt/ideas',
            hostId: 'local',
            displayName: 'sidebar-ideas'
          }
        }
      ]
    })
  })

  it('recovers cleanly with an empty map when the on-disk file is corrupt JSON', async () => {
    await writeFile(filePath, '{not valid json', 'utf8')
    const service = createProjectTodosService({
      resolveFilePath: () => filePath,
      broadcast: () => {}
    })
    expect(service.list()).toEqual({})
  })
})
