import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type FolderSearchTestTree = {
  /** Real path of a fresh temp directory. */
  root: string
  cleanup: () => Promise<void>
}

export async function createFolderSearchTestTree(): Promise<FolderSearchTestTree> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-folder-search-')))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

export async function makeGitRoot(path: string): Promise<void> {
  await mkdir(join(path, '.git'), { recursive: true })
}

export async function makePlainFolder(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/** A checkout whose `.git` file points at `<main>/.git/worktrees/<name>`, like `git worktree add`. */
export async function makeLinkedWorktree(args: {
  path: string
  mainCheckout: string
  name: string
}): Promise<void> {
  const gitDir = join(args.mainCheckout, '.git', 'worktrees', args.name)
  await mkdir(gitDir, { recursive: true })
  await mkdir(args.path, { recursive: true })
  await writeFile(join(args.path, '.git'), `gitdir: ${gitDir}\n`)
}

/** A submodule checkout: a `.git` file that points into `.git/modules`. */
export async function makeSubmoduleCheckout(path: string, superproject: string): Promise<void> {
  const gitDir = join(superproject, '.git', 'modules', 'vendored')
  await mkdir(gitDir, { recursive: true })
  await mkdir(path, { recursive: true })
  await writeFile(join(path, '.git'), `gitdir: ${gitDir}\n`)
}
