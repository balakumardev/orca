import { lstat, open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const GIT_FILE_READ_LIMIT_BYTES = 4096
const SUBMODULE_GIT_DIR = /[\\/]\.git[\\/]modules[\\/]/

export type GitMarker =
  | { kind: 'git-root' }
  /** `mainCheckoutPath` is null when the shared git dir is not a `.git` folder (a bare repository). */
  | { kind: 'linked-worktree'; mainCheckoutPath: string | null }

/** Reads `.git` without following links: a folder is a root, a file is a linked worktree or a submodule. */
export async function readGitMarker(dirPath: string): Promise<GitMarker | null> {
  const markerPath = join(dirPath, '.git')
  let marker: Awaited<ReturnType<typeof lstat>>
  try {
    marker = await lstat(markerPath)
  } catch {
    return null
  }
  if (marker.isDirectory()) {
    return { kind: 'git-root' }
  }
  if (!marker.isFile()) {
    return null
  }
  const gitDir = await readGitDirPointer(markerPath, dirPath)
  if (!gitDir) {
    return null
  }
  const worktreesDir = dirname(gitDir)
  if (basename(worktreesDir) === 'worktrees') {
    const commonDir = dirname(worktreesDir)
    return {
      kind: 'linked-worktree',
      mainCheckoutPath: basename(commonDir) === '.git' ? dirname(commonDir) : null
    }
  }
  // Submodules point into .git/modules, at any nesting; they are plain roots. Any other pointer is
  // not one Orca knows how to read, so the folder is not taken for a repository.
  return SUBMODULE_GIT_DIR.test(gitDir) ? { kind: 'git-root' } : null
}

async function readGitDirPointer(markerPath: string, dirPath: string): Promise<string | null> {
  let text: string
  try {
    const handle = await open(markerPath, 'r')
    try {
      const buffer = Buffer.alloc(GIT_FILE_READ_LIMIT_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, GIT_FILE_READ_LIMIT_BYTES, 0)
      text = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  const match = /^gitdir:[ \t]*(.+?)[ \t]*\r?$/m.exec(text)
  if (!match) {
    return null
  }
  return isAbsolute(match[1]) ? match[1] : resolve(dirPath, match[1])
}
