import type { Locator, Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from '@stablyai/playwright-test'
import { test } from './desktop/electron-fixtures/orca-app'
import { readComposerExposure, recordComposerExposure } from './helpers/composer-exposure'
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

const armedRow = (palette: Locator): Locator => palette.locator('[cmdk-item][aria-selected="true"]')
const chips = (palette: Locator): Locator =>
  palette.locator('[data-slot="palette-new-worktree-chip"]')
const worktreeRows = (palette: Locator): Locator =>
  palette.locator('[cmdk-item][data-value^="8:worktree"]')
const footerHints = (palette: Locator): Locator =>
  palette.locator('div.justify-end.border-t').filter({ hasText: 'Close' })
const composerDialog = (page: Page): Locator =>
  page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })

async function arrowToRow(input: Locator, row: Locator): Promise<void> {
  for (let attempt = 0; attempt < 16; attempt++) {
    if ((await row.getAttribute('aria-selected')) === 'true') {
      return
    }
    await input.press('ArrowDown')
  }
  await expect(row).toHaveAttribute('aria-selected', 'true')
}

// Where each row sits and how wide its title is: a chip on the highlighted row must change neither. The palette's
// open animation scales it, so a read has to wait for the animations to end.
async function rowGeometry(palette: Locator): Promise<unknown[]> {
  await palette.evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  )
  return worktreeRows(palette).evaluateAll((rows) =>
    rows.map((row) => {
      const box = row.getBoundingClientRect()
      const title = row.querySelector('span.truncate')?.getBoundingClientRect()
      return { top: box.top, height: box.height, titleWidth: title?.width ?? null }
    })
  )
}

test('Cmd+J shows where a new worktree can be made: footer, key hint on the highlighted row, Create group, Folders', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-new-worktree-hint-')))
  registerPostElectronShutdownCleanup(async () => rmSync(parent, { recursive: true, force: true }))
  const web = path.join(parent, 'acme-web')
  const notes = path.join(parent, 'notes')
  for (const repoPath of [web, notes, path.join(parent, 'fresh-app')]) {
    createGitRepo(repoPath)
  }
  // Neither is registered: they show in Folders when a query matches them.
  mkdirSync(path.join(parent, 'fresh-plain'))

  await waitForSessionReady(orcaPage)
  // Cmd+J scans only the configured search locations; this spec's folders live under its own parent.
  await orcaPage.evaluate(
    (root) => window.__store!.getState().updateSettingsOrThrow({ folderSearchLocations: [root] }),
    parent
  )
  for (const repoPath of [web, notes]) {
    await orcaPage.evaluate(async (target) => {
      if (!(await window.__store!.getState().addRepoPath(target))) {
        throw new Error(`Could not register ${target}`)
      }
    }, repoPath)
  }
  await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    const repoId = state.repos.find((repo) => repo.displayName === 'acme-web')?.id
    if (!repoId) {
      throw new Error('acme-web was not registered')
    }
    for (const name of ['auth-flow', 'docs-refresh']) {
      await state.createWorktree(repoId, name, undefined, 'skip')
    }
  })
  await expect
    .poll(() =>
      orcaPage.evaluate(() => {
        const state = window.__store!.getState()
        const repo = state.repos.find((candidate) => candidate.displayName === 'acme-web')
        return repo ? (state.worktreesByRepo[repo.id]?.length ?? 0) : 0
      })
    )
    .toBe(3)
  // acme-web is the project you are in; notes is another one.
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const repo = state.repos.find((candidate) => candidate.displayName === 'acme-web')
    const main = (repo ? (state.worktreesByRepo[repo.id] ?? []) : []).find(
      (worktree) => worktree.isMainWorktree
    )
    if (!main) {
      throw new Error('acme-web has no main workspace')
    }
    state.setActiveWorktree(main.id)
  })
  const repoCount = (): Promise<number> =>
    orcaPage.evaluate(() => window.__store!.getState().repos.length)

  await test.step('with an empty search the footer names the project of the highlighted row', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await expect(armedRow(palette)).toHaveCount(1)
    const notesRow = worktreeRows(palette).filter({ hasText: 'notes' }).first()
    await arrowToRow(input, notesRow)
    await expect(footerHints(palette).getByText('New worktree in notes')).toBeVisible()
    await expect(footerHints(palette).getByText('New worktree in acme-web')).toBeVisible()
    await expect(chips(palette)).toHaveCount(1)
    await expect(notesRow.locator('[data-slot="palette-new-worktree-chip"]')).toBeVisible()
    await orcaPage.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
  })

  await test.step('the key hint follows the highlight and moves nothing', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('acme-web')
    await expect(worktreeRows(palette)).toHaveCount(3)
    const rows = worktreeRows(palette)
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(chips(palette)).toHaveCount(1)
    await expect(rows.nth(0).locator('[data-slot="palette-new-worktree-chip"]')).toContainText(
      'New worktree'
    )
    const first = await rowGeometry(palette)

    await input.press('ArrowDown')
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(chips(palette)).toHaveCount(1)
    await expect(rows.nth(1).locator('[data-slot="palette-new-worktree-chip"]')).toBeVisible()
    expect(await rowGeometry(palette)).toEqual(first)
    // No title was cut to make room: each fits in the width it was given.
    const cut = await rows.evaluateAll((items) =>
      items.map((item) => {
        const title = item.querySelector('span.truncate')
        return title instanceof HTMLElement ? title.scrollWidth > title.clientWidth : null
      })
    )
    expect(cut).toEqual([false, false, false])

    await orcaPage.setViewportSize({ width: 560, height: 800 })
    await expect(chips(palette)).toHaveCount(1)
    await expect(chips(palette)).toBeHidden()
    await orcaPage.setViewportSize({ width: 1280, height: 800 })
    await expect(chips(palette)).toBeVisible()
    await orcaPage.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
  })

  await test.step('a query that names another project lists its New worktree row, then a Create row that names where it creates', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('notes')
    const items = palette.locator('[cmdk-item]')
    await expect(items.nth(-2)).toContainText('New worktree in notes')
    await expect(items.nth(-1)).toContainText('Create "notes" in acme-web')
    await expect(palette.getByText('Create', { exact: true })).toBeVisible()
    // Enter still opens the workspace the search armed: neither Create row is armed by a typed query.
    await expect(armedRow(palette)).toHaveAttribute('data-value', /^8:worktree/)

    // The label tells the truth: the plain Create row opens the dialog on the project you are in.
    await input.press('End')
    await expect(items.nth(-1)).toHaveAttribute('aria-selected', 'true')
    await input.press('Enter')
    const dialog = composerDialog(orcaPage)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-workspace-name-input="true"]')).toHaveValue('notes')
    await expect(
      dialog.getByRole('combobox', { name: 'Project', exact: true }).locator('xpath=..')
    ).toContainText('acme-web')
    await orcaPage.keyboard.press('Escape')
    await expect(composerDialog(orcaPage)).toHaveCount(0)
  })

  await test.step('Cmd+Enter on an untracked git root adds it and starts a worktree there with a typed name', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('fresh')
    const gitRoot = palette.locator('[cmdk-item]:has([data-folder-search-kind="git-root"])')
    const plainFolder = palette.locator('[cmdk-item]:has([data-folder-search-kind="folder"])')
    await expect(gitRoot).toHaveCount(1)
    await expect(plainFolder).toHaveCount(1)

    await arrowToRow(input, plainFolder)
    await expect(chips(palette)).toHaveCount(0)
    await arrowToRow(input, gitRoot)
    await expect(gitRoot.locator('[data-slot="palette-new-worktree-chip"]')).toContainText(
      'Add + new worktree'
    )
    await expect(footerHints(palette).getByText('Add + new worktree')).toBeVisible()
    const before = await repoCount()

    await input.press('ControlOrMeta+Enter')
    await expect(input).toHaveAttribute('placeholder', 'New worktree in fresh-app - type a name')
    expect(await repoCount()).toBe(before + 1)
    await expect(composerDialog(orcaPage)).toHaveCount(0)

    await input.pressSequentially('first-try')
    await recordComposerExposure(orcaPage)
    await input.press('Enter')
    await expect(palette).toHaveCount(0)
    await expect(composerDialog(orcaPage)).toHaveCount(0)
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const state = window.__store!.getState()
          const repo = state.repos.find((candidate) => candidate.displayName === 'fresh-app')
          const worktree = (repo ? (state.worktreesByRepo[repo.id] ?? []) : []).find(
            (entry) => entry.displayName === 'first-try'
          )
          return worktree ? state.activeWorktreeId === worktree.id : null
        })
      )
      .toBe(true)
    const exposure = await readComposerExposure(orcaPage)
    expect(exposure.sampled).toBeGreaterThan(0)
    expect(exposure).toMatchObject({
      visible: 0,
      overlay: 0,
      blurAttribute: 0,
      pointerLock: 0,
      blurred: 0
    })
    // The project was added once, and only the git root: the plain folder next to it is still a folder.
    expect(await repoCount()).toBe(before + 1)
    expect(
      await orcaPage.evaluate(() =>
        window.__store!.getState().repos.some((repo) => repo.displayName === 'fresh-plain')
      )
    ).toBe(false)
  })
})
