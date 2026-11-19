import type { Locator, Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './desktop/electron-fixtures/orca-app'
import { waitForSessionReady } from './desktop/renderer-probes/store'

test.use({ seedTestRepo: false })

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E Test', ...args], {
    cwd,
    stdio: 'pipe'
  })
}

function createGitRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-b', 'main')
  writeFileSync(path.join(repoPath, 'README.md'), '# fixture\n')
  git(repoPath, 'add', '-A')
  git(repoPath, 'commit', '-m', 'Initial commit')
}

async function openPalette(page: Page): Promise<{ palette: Locator; input: Locator }> {
  await page.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
  const palette = page.getByRole('dialog', { name: 'Jump to...' })
  await expect(palette).toBeVisible()
  return { palette, input: palette.locator('[cmdk-input]') }
}

// Folder rows carry data-folder-search-kind; other sections may show the same name.
function folderRows(palette: Locator): Locator {
  return palette.locator('[cmdk-item]:has([data-folder-search-kind])')
}

async function arrowToRow(input: Locator, row: Locator): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    if ((await row.getAttribute('aria-selected')) === 'true') {
      return
    }
    await input.press('ArrowDown')
  }
  await expect(row).toHaveAttribute('aria-selected', 'true')
}

async function readActiveWorkspace(
  page: Page
): Promise<{ path: string; repoKind: string; isMainWorktree: boolean } | null> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    for (const [repoId, worktrees] of Object.entries(state.worktreesByRepo)) {
      const match = worktrees.find((worktree) => worktree.id === state.activeWorktreeId)
      if (match) {
        const repo = state.repos.find((candidate) => candidate.id === repoId)
        return {
          path: match.path,
          repoKind: repo?.kind ?? 'git',
          isMainWorktree: match.isMainWorktree
        }
      }
    }
    return null
  })
}

test('Cmd+J lists unregistered folders in a configured location and opens them with Enter', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-folder-jump-')))
  registerPostElectronShutdownCleanup(async () => rmSync(parent, { recursive: true, force: true }))
  const registered = path.join(parent, 'fjump-registered')
  const plain = path.join(parent, 'fjump-plain-notes')
  const gitRoot = path.join(parent, 'fjump-orchard-git')
  const linkedMain = path.join(parent, 'fjump-harvest-main')
  const linked = path.join(parent, 'fjump-harvest-linked')
  const untouched = path.join(parent, 'fjump-meadow')
  // Named like a Settings entry, so a typed query matches it as well as an action.
  const settingsNamed = path.join(parent, 'settings')
  // Listed, then deleted while the palette is open.
  const doomed = path.join(parent, 'gone-soon')
  createGitRepo(registered)
  createGitRepo(gitRoot)
  createGitRepo(linkedMain)
  git(linkedMain, 'worktree', 'add', '-b', 'harvest', linked)
  mkdirSync(plain)
  mkdirSync(untouched)
  mkdirSync(settingsNamed)
  mkdirSync(doomed)
  writeFileSync(path.join(plain, 'notes.txt'), 'plain folder\n')

  await waitForSessionReady(orcaPage)
  // Locations define coverage; registering a sibling exercises the existing tracked-project filter.
  await orcaPage.evaluate(
    async ({ registeredPath, searchRoot }) => {
      await window
        .__store!.getState()
        .updateSettingsOrThrow({ folderSearchLocations: [searchRoot] })
      const repo = await window.__store!.getState().addRepoPath(registeredPath)
      if (!repo) {
        throw new Error('Could not register the fixture project')
      }
    },
    { registeredPath: registered, searchRoot: parent }
  )

  await test.step('shows a Folders section for unregistered siblings only while a query is typed', async () => {
    const { palette, input } = await openPalette(orcaPage)
    const heading = palette.getByText('Folders', { exact: true })
    await expect(heading).toHaveCount(0)
    await input.fill('fjump')
    await expect(heading).toBeVisible()
    await expect(folderRows(palette).filter({ hasText: 'fjump-' })).toHaveCount(5)
    for (const name of [
      'fjump-plain-notes',
      'fjump-orchard-git',
      'fjump-harvest-main',
      'fjump-harvest-linked',
      'fjump-meadow'
    ]) {
      await expect(folderRows(palette).filter({ hasText: name })).toHaveCount(1)
    }
    await expect(folderRows(palette).filter({ hasText: 'fjump-registered' })).toHaveCount(0)
    const screenshot = testInfo.outputPath('folders-section.png')
    await palette.screenshot({ path: screenshot, animations: 'disabled' })
    await testInfo.attach('folders-section', { path: screenshot, contentType: 'image/png' })
    await input.fill('')
    await expect(heading).toHaveCount(0)
    await orcaPage.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
  })

  const readRepoCount = (): Promise<number> =>
    orcaPage.evaluate(() => window.__store!.getState().repos.length)

  await test.step('Enter on a folder deleted after the list was read adds nothing and says so', async () => {
    const reposBefore = await readRepoCount()
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('gone-soon')
    const row = folderRows(palette).filter({ hasText: 'gone-soon' })
    await expect(row).toHaveCount(1)
    rmSync(doomed, { recursive: true, force: true })
    await arrowToRow(input, row)
    await input.press('Enter')
    await expect(palette).toHaveCount(0)
    await expect(orcaPage.getByText('That folder is no longer there')).toBeVisible()
    expect(await readRepoCount()).toBe(reposBefore)
  })

  await test.step('a typed Enter never adds a folder that is the only match', async () => {
    const reposBefore = await readRepoCount()
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('fjump-meadow')
    await expect(folderRows(palette).filter({ hasText: 'fjump-meadow' })).toHaveCount(1)
    // cmdk marks the first row on its own; it must be the Create row, as it is without this section.
    await expect(palette.locator('[cmdk-item][aria-selected="true"]')).toContainText(
      'Create worktree'
    )
    await expect(folderRows(palette).first()).toHaveAttribute('aria-selected', 'false')
    await input.press('Enter')
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeModal))
      .toBe('new-workspace-composer')
    expect(await readRepoCount()).toBe(reposBefore)
    await orcaPage.keyboard.press('Escape')
  })

  await test.step('a typed Enter never adds a folder after the highlight moved for an earlier query', async () => {
    const reposBefore = await readRepoCount()
    const { palette, input } = await openPalette(orcaPage)
    // The arrow key moves the highlight in the empty query's list; the query typed next is a new one.
    await input.press('ArrowDown')
    await input.fill('fjump-meadow')
    await expect(folderRows(palette).filter({ hasText: 'fjump-meadow' })).toHaveCount(1)
    await expect(palette.locator('[cmdk-item][aria-selected="true"]')).toContainText(
      'Create worktree'
    )
    await expect(folderRows(palette).first()).toHaveAttribute('aria-selected', 'false')
    await input.press('Enter')
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeModal))
      .toBe('new-workspace-composer')
    expect(await readRepoCount()).toBe(reposBefore)
    await orcaPage.keyboard.press('Escape')
  })

  await test.step('a typed Enter never adds a folder after an arrow key and further keystrokes narrowed the query', async () => {
    const reposBefore = await readRepoCount()
    const { palette, input } = await openPalette(orcaPage)
    // Several rows match: the registered project's workspace, five folders and Create.
    await input.fill('fjump')
    await expect(folderRows(palette).filter({ hasText: 'fjump-' })).toHaveCount(5)
    await input.press('ArrowDown')
    // Real keystrokes narrow the query until only one folder and Create match.
    await input.pressSequentially('-meadow')
    await expect(folderRows(palette)).toHaveCount(1)
    await expect(folderRows(palette).first()).toHaveAttribute('aria-selected', 'false')
    await input.press('Enter')
    // Nothing is armed here, so Enter has no event to wait for; adding a project takes well under this.
    // ast-grep-ignore: test-no-real-time-wait -- asserting that nothing happens leaves no condition to wait on
    await orcaPage.waitForTimeout(500)
    expect(await readRepoCount()).toBe(reposBefore)
    await expect(palette).toBeVisible()
    await orcaPage.keyboard.press('Escape')
  })

  await test.step('a folder named like a Settings entry does not lead the list or take Enter', async () => {
    const reposBefore = await readRepoCount()
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('settings')
    await expect(folderRows(palette).filter({ hasText: /^settings/ })).toHaveCount(1)
    // The folder is reached by arrow keys, below the rows that were there without it.
    await expect(
      palette.locator('[cmdk-item]').first().locator('[data-folder-search-kind]')
    ).toHaveCount(0)
    await input.press('Enter')
    await expect(palette).toHaveCount(0)
    expect(await readRepoCount()).toBe(reposBefore)
    expect(await orcaPage.evaluate(() => window.__store!.getState().activeView)).toBe('settings')
    await orcaPage.evaluate(() => window.__store!.getState().setActiveView('terminal'))
  })

  const openFolderByName = async (name: string, expectedPath: string): Promise<void> => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill(name)
    const row = folderRows(palette).filter({ hasText: name })
    await expect(row).toHaveCount(1)
    await arrowToRow(input, row)
    await input.press('Enter')
    await expect(palette).toHaveCount(0)
    await expect.poll(async () => (await readActiveWorkspace(orcaPage))?.path).toBe(expectedPath)
  }

  await test.step('Enter on a plain folder adds a folder project and opens it', async () => {
    await openFolderByName('fjump-plain-notes', plain)
    expect(await readActiveWorkspace(orcaPage)).toMatchObject({ repoKind: 'folder' })
  })

  await test.step('Enter on a git root adds a git project and opens its checkout', async () => {
    await openFolderByName('fjump-orchard-git', gitRoot)
    expect(await readActiveWorkspace(orcaPage)).toMatchObject({
      repoKind: 'git',
      isMainWorktree: true
    })
  })

  await test.step('Enter on a linked worktree opens that worktree, not its main checkout', async () => {
    await openFolderByName('fjump-harvest-linked', linked)
    expect(await readActiveWorkspace(orcaPage)).toMatchObject({ repoKind: 'git' })
  })

  await test.step('opened folders, and the main checkout of an opened worktree, leave the Folders section', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('fjump')
    await expect(folderRows(palette).filter({ hasText: 'fjump-meadow' })).toHaveCount(1)
    await expect(folderRows(palette).filter({ hasText: 'fjump-harvest-main' })).toHaveCount(0)
    await expect(folderRows(palette).filter({ hasText: 'fjump-plain-notes' })).toHaveCount(0)
    await expect(folderRows(palette).filter({ hasText: 'fjump-orchard-git' })).toHaveCount(0)
    await expect(folderRows(palette).filter({ hasText: 'fjump-harvest-linked' })).toHaveCount(0)
  })
})
