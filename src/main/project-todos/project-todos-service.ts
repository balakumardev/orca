import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer'
import {
  normalizeProjectTodosByProject,
  type ProjectTodosByProject
} from '../../shared/project-todos-types'

export const PROJECT_TODOS_FILE_NAME = 'project-todos.json'
const FORMAT_VERSION = 1
const MAX_FILE_BYTES = 2 * 1024 * 1024

type PersistedProjectTodosEnvelope = {
  version: number
  projects: ProjectTodosByProject
}

function readBoundedText(filePath: string): string | null {
  try {
    if (!lstatSync(filePath).isFile()) {
      return null
    }
  } catch {
    return null
  }
  const openFlags =
    constants.O_RDONLY |
    (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0) |
    (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)
  let fd: number
  try {
    fd = openSync(filePath, openFlags)
  } catch {
    return null
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return null
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, null)
      if (bytesRead === 0) {
        break
      }
      offset += bytesRead
    }
    if (offset > MAX_FILE_BYTES) {
      return null
    }
    return buffer.subarray(0, offset).toString('utf8')
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {}
  }
}

function parseEnvelope(text: string): ProjectTodosByProject {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== FORMAT_VERSION ||
    !('projects' in parsed)
  ) {
    return {}
  }
  return normalizeProjectTodosByProject((parsed as { projects: unknown }).projects)
}

export type ProjectTodosService = {
  list: () => ProjectTodosByProject
  save: (projects: unknown, senderWebContentsId?: number) => Promise<ProjectTodosByProject>
}

export function createProjectTodosService(args: {
  resolveFilePath: () => string
  broadcast: (projects: ProjectTodosByProject, senderWebContentsId?: number) => void
}): ProjectTodosService {
  const writer = new AtomicSnapshotWriter(args.resolveFilePath, { skipUnchanged: true })
  let cached: ProjectTodosByProject | null = null

  const ensureLoaded = (): ProjectTodosByProject => {
    if (cached !== null) {
      return cached
    }
    const raw = readBoundedText(args.resolveFilePath())
    cached = raw === null ? {} : parseEnvelope(raw)
    return cached
  }

  return {
    list: () => ensureLoaded(),
    save: async (rawProjects: unknown, senderWebContentsId?: number) => {
      const normalized = normalizeProjectTodosByProject(rawProjects)
      cached = normalized
      const payload: PersistedProjectTodosEnvelope = {
        version: FORMAT_VERSION,
        projects: normalized
      }
      await writer.write(() => `${JSON.stringify(payload, null, 2)}\n`)
      args.broadcast(normalized, senderWebContentsId)
      return normalized
    }
  }
}
