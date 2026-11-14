import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readGitMarker } from './git-marker'
import {
  createFolderSearchTestTree,
  makeGitRoot,
  makePlainFolder,
  type FolderSearchTestTree
} from './folder-search-tree.test-fixture'

let tree: FolderSearchTestTree

beforeEach(async () => {
  tree = await createFolderSearchTestTree()
})
afterEach(() => tree.cleanup())

async function checkoutWithGitFile(content: string): Promise<string> {
  const path = join(tree.root, 'checkout')
  await mkdir(path)
  await writeFile(join(path, '.git'), content)
  return path
}

describe('readGitMarker', () => {
  it('reads a .git folder as a git root and a folder without one as no marker', async () => {
    await makeGitRoot(join(tree.root, 'repo'))
    await makePlainFolder(join(tree.root, 'plain'))
    expect(await readGitMarker(join(tree.root, 'repo'))).toEqual({ kind: 'git-root' })
    expect(await readGitMarker(join(tree.root, 'plain'))).toBeNull()
  })

  it('reads a pointer into <main>/.git/worktrees as a linked worktree of that main checkout', async () => {
    const main = join(tree.root, 'main')
    const checkout = await checkoutWithGitFile(`gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`)
    expect(await readGitMarker(checkout)).toEqual({
      kind: 'linked-worktree',
      mainCheckoutPath: main
    })
  })

  it('reads a linked worktree of a bare repository without a main checkout', async () => {
    const checkout = await checkoutWithGitFile(
      `gitdir: ${join(tree.root, 'bare.git', 'worktrees', 'wt')}\n`
    )
    expect(await readGitMarker(checkout)).toEqual({
      kind: 'linked-worktree',
      mainCheckoutPath: null
    })
  })

  it.each([
    ['a submodule', '.git/modules/lib'],
    ['a submodule of a submodule', '.git/modules/lib/modules/inner']
  ])('reads %s as a plain git root', async (_label, relativeGitDir) => {
    const checkout = await checkoutWithGitFile(
      `gitdir: ${join(tree.root, 'super', relativeGitDir)}\n`
    )
    expect(await readGitMarker(checkout)).toEqual({ kind: 'git-root' })
  })

  it.each([
    ['a pointer to some other folder', 'gitdir: /somewhere/else\n'],
    ['text without a pointer', 'not a git file\n'],
    ['an empty file', '']
  ])('does not take %s for a repository', async (_label, content) => {
    expect(await readGitMarker(await checkoutWithGitFile(content))).toBeNull()
  })
})
