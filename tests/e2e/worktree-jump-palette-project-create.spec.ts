import type { Locator, Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './desktop/electron-fixtures/orca-app'
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

const worktreeRows = (palette: Locator): Locator =>
  palette.locator('[cmdk-item][data-value^="8:worktree"]')
const newWorktreeRow = (palette: Locator, project: string): Locator =>
  palette.locator('[cmdk-item]', { hasText: `New worktree in ${project}` })
const armedRow = (palette: Locator): Locator => palette.locator('[cmdk-item][aria-selected="true"]')

async function arrowToRow(input: Locator, row: Locator): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    if ((await row.getAttribute('aria-selected')) === 'true') {
      return
    }
    await input.press('ArrowDown')
  }
  await expect(row).toHaveAttribute('aria-selected', 'true')
}

function composerDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
}

// The picker draws the committed project's name over its combobox input.
function composerProject(dialog: Locator): Locator {
  return dialog.getByRole('combobox', { name: 'Project', exact: true }).locator('xpath=..')
}

// The search footer's hints, which name the project each chord would act on.
const footerHints = (palette: Locator): Locator =>
  palette.locator('div.justify-end.border-t').filter({ hasText: 'Close' })
const nameStepPrompt = (project: string): string => `New worktree in ${project} - type a name`
// The palette's name step: the project is chosen and the input now takes the worktree name.
async function expectNameStep(palette: Locator, input: Locator, project: string): Promise<void> {
  await expect(input).toHaveAttribute('placeholder', nameStepPrompt(project))
  await expect(palette.locator('[data-slot="palette-project-name-step"]')).toContainText(
    `New worktree in ${project}`
  )
  await expect(palette.locator('[cmdk-item]:visible')).toHaveCount(0)
}

type CreatedWorktree = { branch: string; isActive: boolean }
// The worktree named `displayName` in `repoName`, as the store and git both see it.
async function readCreatedWorktree(
  page: Page,
  repoName: string,
  displayName: string
): Promise<CreatedWorktree | null> {
  const found = await page.evaluate(
    ({ repoName, displayName }) => {
      const state = window.__store!.getState()
      const repo = state.repos.find((candidate) => candidate.displayName === repoName)
      const worktree = repo
        ? (state.worktreesByRepo[repo.id] ?? []).find((entry) => entry.displayName === displayName)
        : undefined
      return worktree && repo
        ? {
            repoPath: repo.path,
            worktreePath: worktree.path,
            isActive: state.activeWorktreeId === worktree.id
          }
        : null
    },
    { repoName, displayName }
  )
  if (!found) {
    return null
  }
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: found.worktreePath,
    encoding: 'utf8'
  }).trim()
  return { branch, isActive: found.isActive }
}

async function closeComposer(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(composerDialog(page)).toHaveCount(0)
}

test('Cmd+J starts a worktree in a project from the keyboard, with a name typed in the palette', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-project-create-')))
  registerPostElectronShutdownCleanup(async () => rmSync(parent, { recursive: true, force: true }))
  const web = path.join(parent, 'acme-web')
  const api = path.join(parent, 'acme-api')
  const notes = path.join(parent, 'notes')
  for (const repoPath of [web, api, notes]) {
    createGitRepo(repoPath)
  }
  // Not registered: it shows in Folders when a query matches it.
  mkdirSync(path.join(parent, 'acme-docs'))

  await waitForSessionReady(orcaPage)
  // Cmd+J scans only the configured search locations; this spec's folders live under its own parent.
  await orcaPage.evaluate(
    (root) => window.__store!.getState().updateSettingsOrThrow({ folderSearchLocations: [root] }),
    parent
  )
  for (const repoPath of [web, api, notes]) {
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
        const web = state.repos.find((repo) => repo.displayName === 'acme-web')
        return web ? (state.worktreesByRepo[web.id]?.length ?? 0) : 0
      })
    )
    .toBe(3)

  const activeRepoName = (): Promise<string | null> =>
    orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const repoId = Object.entries(state.worktreesByRepo).find(([, worktrees]) =>
        worktrees.some((worktree) => worktree.id === state.activeWorktreeId)
      )?.[0]
      return state.repos.find((repo) => repo.id === repoId)?.displayName ?? null
    })
  const countWorktrees = (repoName: string): Promise<number> =>
    orcaPage.evaluate((name) => {
      const state = window.__store!.getState()
      const repo = state.repos.find((candidate) => candidate.displayName === name)
      return repo ? (state.worktreesByRepo[repo.id]?.length ?? 0) : 0
    }, repoName)

  await test.step('a typed project name lists its workspaces, then a New worktree row, and Enter opens the workspace', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('acme-web')
    await expect(worktreeRows(palette)).toHaveCount(3)
    const row = newWorktreeRow(palette, 'acme-web')
    await expect(row).toHaveCount(1)

    const order = await palette
      .locator('[cmdk-item]')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-value') ?? ''))
    const rowIndex = order.findIndex((value) => value.startsWith('5:extra14:project-create'))
    expect(order.slice(0, rowIndex).filter((value) => value.startsWith('8:worktree'))).toHaveLength(
      3
    )
    expect(order.slice(rowIndex + 1).some((value) => value.startsWith('8:worktree'))).toBe(false)

    await expect(armedRow(palette)).toHaveAttribute('data-value', /^8:worktree/)
    // The armed row is chosen by the search, so the footer names its project (no workspace is open yet).
    await expect(footerHints(palette).getByText('New worktree in acme-web')).toBeVisible()
    await expect(footerHints(palette).getByText(/New worktree in/)).toHaveCount(1)
    const armedText = await armedRow(palette).innerText()
    await input.press('Enter')
    await expect(palette).toHaveCount(0)
    await expect(composerDialog(orcaPage)).toHaveCount(0)
    await expect.poll(activeRepoName).toBe('acme-web')
    // The workspace that opened is the one the palette had armed, not a new or another one.
    const activeName = await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      return (
        Object.values(state.worktreesByRepo)
          .flat()
          .find((worktree) => worktree.id === state.activeWorktreeId)?.displayName ?? null
      )
    })
    expect(activeName).not.toBeNull()
    expect(armedText).toContain(activeName)
    expect(await countWorktrees('acme-web')).toBe(3)
  })

  await test.step('no task search starts and no Tasks rows show, even with a connected Linear account', async () => {
    await electronApp.evaluate(({ ipcMain }) => {
      process.env.E2E_LINEAR_SEARCH_CALLS = '0'
      ipcMain.removeHandler('linear:status')
      ipcMain.removeHandler('linear:searchIssues')
      ipcMain.handle('linear:status', () => ({
        connected: true,
        viewer: null,
        activeWorkspaceId: 'workspace-e2e',
        selectedWorkspaceId: 'workspace-e2e',
        workspaces: [
          {
            id: 'workspace-e2e',
            displayName: 'E2E User',
            email: null,
            organizationId: 'organization-e2e',
            organizationName: 'E2E',
            organizationUrlKey: 'e2e'
          }
        ]
      }))
      ipcMain.handle('linear:searchIssues', () => {
        process.env.E2E_LINEAR_SEARCH_CALLS = String(
          Number(process.env.E2E_LINEAR_SEARCH_CALLS) + 1
        )
        return []
      })
    })
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('acme-web')
    await expect(worktreeRows(palette)).toHaveCount(3)
    // The task search waits 600 ms before it sends anything, so look after that.
    // ast-grep-ignore: test-no-real-time-wait -- asserting that no request is sent leaves no condition to wait on
    await orcaPage.waitForTimeout(1500)
    await expect(palette.getByText('Tasks', { exact: true })).toHaveCount(0)
    expect(await electronApp.evaluate(() => process.env.E2E_LINEAR_SEARCH_CALLS)).toBe('0')
    await orcaPage.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
  })

  await test.step('the New worktree rows end the list: after the workspaces and the Folders section, just above the plain Create row', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('acme')
    await expect(newWorktreeRow(palette, 'acme-web')).toHaveCount(1)
    await expect(newWorktreeRow(palette, 'acme-api')).toHaveCount(1)
    await expect(palette.getByText('Folders', { exact: true })).toBeVisible()
    const rows = await palette.locator('[cmdk-item]').evaluateAll((items) =>
      items.map((item) => ({
        value: item.getAttribute('data-value') ?? '',
        folder: item.querySelector('[data-folder-search-kind]') !== null
      }))
    )
    const projectIndexes = rows.flatMap((row, index) =>
      row.value.startsWith('5:extra14:project-create') ? [index] : []
    )
    const folderIndexes = rows.flatMap((row, index) => (row.folder ? [index] : []))
    expect(projectIndexes).toHaveLength(2)
    expect(folderIndexes).toHaveLength(1)
    const lastWorkspace = rows.map((row) => row.value.startsWith('8:worktree')).lastIndexOf(true)
    expect(lastWorkspace).toBeLessThan(folderIndexes[0])
    expect(folderIndexes[0]).toBeLessThan(Math.min(...projectIndexes))
    expect(projectIndexes).toEqual([rows.length - 3, rows.length - 2])
    expect(rows.at(-1)?.value).toBe('__create_worktree__')
    await orcaPage.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
  })

  await test.step('the New worktree row opens a name step; Esc returns to the search text; a name and Enter create and open it', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('acme-api')
    const row = newWorktreeRow(palette, 'acme-api')
    await expect(row).toHaveAttribute('aria-selected', 'false')
    await arrowToRow(input, row)
    await input.press('Enter')
    await expectNameStep(palette, input, 'acme-api')
    await expect(input).toHaveValue('')
    await expect(composerDialog(orcaPage)).toHaveCount(0)

    await input.press('Escape')
    await expect(palette).toBeVisible()
    await expect(input).toHaveValue('acme-api')
    await expect(input).not.toHaveAttribute('placeholder', nameStepPrompt('acme-api'))

    await arrowToRow(input, row)
    await input.press('Enter')
    await expectNameStep(palette, input, 'acme-api')
    // Enter on an empty name does nothing.
    await input.press('Enter')
    await expect(input).toHaveAttribute('placeholder', nameStepPrompt('acme-api'))
    expect(await countWorktrees('acme-api')).toBe(1)

    await input.pressSequentially('login-fix')
    // The dialog does the creating out of sight, with the CPU slowed so every frame it exists in is sampled.
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await recordComposerExposure(orcaPage)
    // Three Enters in one tick, before the palette can unmount: only one worktree may come of them.
    await input.evaluate((element) => {
      for (let press = 0; press < 3; press += 1) {
        element.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        )
      }
    })
    await expect(palette).toHaveCount(0)
    await expect(composerDialog(orcaPage)).toHaveCount(0)
    await expect
      .poll(() => readCreatedWorktree(orcaPage, 'acme-api', 'login-fix'))
      .toMatchObject({
        isActive: true
      })
    const created = await readCreatedWorktree(orcaPage, 'acme-api', 'login-fix')
    expect(created?.branch).toContain('login-fix')
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const exposure = await readComposerExposure(orcaPage)
    expect(exposure.sampled).toBeGreaterThan(0)
    expect(exposure).toMatchObject({
      visible: 0,
      overlay: 0,
      blurAttribute: 0,
      pointerLock: 0,
      blurred: 0
    })
    expect(await activeRepoName()).toBe('acme-api')
    expect(await countWorktrees('acme-api')).toBe(2)
  })

  await test.step('Cmd+Enter on a workspace row opens the name step for its project; Backspace on an empty name goes back', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('notes')
    await expect(worktreeRows(palette).first()).toContainText('notes')
    await expect(armedRow(palette)).toHaveAttribute('data-value', /^8:worktree/)
    await input.press('ControlOrMeta+Enter')
    await expectNameStep(palette, input, 'notes')
    await input.press('Backspace')
    await expect(input).toHaveValue('notes')
    await expect(worktreeRows(palette).first()).toBeVisible()

    await input.press('ControlOrMeta+Enter')
    await expectNameStep(palette, input, 'notes')
    await input.pressSequentially('notes-fix')
    await input.press('Enter')
    await expect(palette).toHaveCount(0)
    await expect
      .poll(() => readCreatedWorktree(orcaPage, 'notes', 'notes-fix'))
      .toMatchObject({
        isActive: true
      })
    expect(await countWorktrees('notes')).toBe(2)
  })

  await test.step('Cmd+Shift+Enter on an empty search names a worktree in the project you are in', async () => {
    expect(await activeRepoName()).toBe('notes')
    const { palette, input } = await openPalette(orcaPage)
    await expect(footerHints(palette).getByText('New worktree in notes')).toBeVisible()
    await input.press('ControlOrMeta+Shift+Enter')
    await expectNameStep(palette, input, 'notes')
    await input.press('Escape')
    await expect(palette).toBeVisible()
    await expect(input).toHaveValue('')
    await orcaPage.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
  })

  await test.step('the name step reads as a name field, not a search, and its Esc and Backspace exits never arm a folder', async () => {
    const { palette, input } = await openPalette(orcaPage)
    const repoCount = (): Promise<number> =>
      orcaPage.evaluate(() => window.__store!.getState().repos.length)
    const before = await repoCount()
    await input.fill('acme-do')
    await expect(palette.locator('[data-folder-search-kind]')).toHaveCount(1)
    await input.press('ControlOrMeta+Shift+Enter')
    await expectNameStep(palette, input, 'notes')
    await expect(
      palette.locator('[data-cmdk-input-wrapper] svg.lucide-git-branch-plus')
    ).toHaveCount(1)
    await expect(palette.locator('[data-cmdk-input-wrapper] svg.lucide-search')).toHaveCount(0)
    await expect(palette.getByRole('button', { name: 'Filter' })).toHaveCount(0)
    await input.press('Escape')
    await expect(input).toHaveValue('acme-do')

    // Leaving by Esc, by Backspace on an empty name, and after list keys were pressed in the step.
    const exits: string[][] = [
      ['Escape'],
      ['Backspace'],
      ['ArrowDown', 'Home', 'Escape'],
      ['Control+n', 'Escape'],
      ['a', 'b', 'Backspace', 'Backspace', 'Backspace']
    ]
    for (const keys of exits) {
      await input.press('ControlOrMeta+Shift+Enter')
      await expectNameStep(palette, input, 'notes')
      for (const key of keys) {
        await input.press(key)
      }
      await expect(input).toHaveValue('acme-do')
      await expect(palette.locator('[cmdk-item][aria-selected="true"]')).not.toHaveAttribute(
        'data-value',
        /extra7:folders/
      )
      // Enter is what Enter did before the step existed: it never adds the folder as a project.
      await input.press('Enter')
      await expect(composerDialog(orcaPage)).toBeVisible()
      expect(await repoCount()).toBe(before)
      await closeComposer(orcaPage)
      await openPalette(orcaPage)
      await input.fill('acme-do')
      await expect(palette.locator('[data-folder-search-kind]')).toHaveCount(1)
    }
    await orcaPage.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
  })

  await test.step('the name step moves the text caret with Home and End, and has no list to move', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.press('ControlOrMeta+Shift+Enter')
    await expectNameStep(palette, input, 'notes')
    const caret = (): Promise<number | null> =>
      input.evaluate((el) => (el instanceof HTMLInputElement ? el.selectionStart : null))
    await input.pressSequentially('abcdef')
    await expect(input).toHaveValue('abcdef')
    await expect(input).toBeFocused()
    await expect.poll(caret).toBe(6)
    await input.press('Home')
    await expect.poll(caret).toBe(0)
    await input.pressSequentially('X')
    await expect(input).toHaveValue('Xabcdef')
    await input.press('End')
    await expect.poll(caret).toBe(7)
    await input.pressSequentially('Y')
    await expect(input).toHaveValue('XabcdefY')
    for (const key of ['ArrowDown', 'ArrowUp', 'Tab', 'PageDown']) {
      await input.press(key)
    }
    await expectNameStep(palette, input, 'notes')
    await expect(input).toHaveValue('XabcdefY')
    await orcaPage.keyboard.press('Escape')
    await orcaPage.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
  })

  await test.step('a Backspace held through the exit from the name step leaves the search text whole', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('acme-web')
    await expect(armedRow(palette)).toHaveAttribute('data-value', /^8:worktree/)
    await input.press('ControlOrMeta+Enter')
    await expectNameStep(palette, input, 'acme-web')
    await expect(input).toHaveValue('')
    // A key pressed down again while it is still down is sent as an auto-repeat, as holding it is.
    for (let held = 0; held < 4; held += 1) {
      await orcaPage.keyboard.down('Backspace')
    }
    await orcaPage.keyboard.up('Backspace')
    await expect(input).toHaveValue('acme-web')
    await orcaPage.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
  })

  await test.step('a narrow window wraps the footer hints instead of clipping them', async () => {
    await orcaPage.setViewportSize({ width: 560, height: 800 })
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('acme-web')
    await expect(footerHints(palette).getByText('New worktree in acme-web')).toBeVisible()
    const clipped = await footerHints(palette).evaluate(
      (footer) => footer.scrollWidth > footer.clientWidth
    )
    expect(clipped).toBe(false)
    await orcaPage.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
    await orcaPage.setViewportSize({ width: 1280, height: 800 })
  })

  await test.step('Cmd+Enter on a row with no project does what Enter does', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('settings')
    await expect(armedRow(palette)).toHaveAttribute('data-value', /quick-action|settings/)
    // No project on the row: only the chord for the workspace you are in is offered.
    await expect(footerHints(palette).getByText(/New worktree in/)).toHaveCount(1)
    await input.press('ControlOrMeta+Enter')
    await expect(palette).toHaveCount(0)
    await expect(composerDialog(orcaPage)).toHaveCount(0)
    expect(await orcaPage.evaluate(() => window.__store!.getState().activeView)).toBe('settings')
    await orcaPage.evaluate(() => window.__store!.getState().setActiveView('terminal'))
  })

  await test.step('project/name opens the name step with the name filled in, and only a second Enter creates', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('acme-web/some-name')
    const create = palette.locator('[cmdk-item]', { hasText: 'Create "some-name" in acme-web' })
    await expect(create).toHaveCount(1)
    await expect(newWorktreeRow(palette, 'acme-web')).toHaveCount(0)
    await expect(create).toHaveAttribute('aria-selected', 'false')
    await input.press('End')
    await expect(create).toHaveAttribute('aria-selected', 'true')
    await input.press('Enter')
    await expectNameStep(palette, input, 'acme-web')
    await expect(input).toHaveValue('some-name')
    expect(await countWorktrees('acme-web')).toBe(3)
    await input.press('Enter')
    await expect(palette).toHaveCount(0)
    await expect
      .poll(() => readCreatedWorktree(orcaPage, 'acme-web', 'some-name'))
      .toMatchObject({
        isActive: true
      })
    expect(await countWorktrees('acme-web')).toBe(4)
  })

  await test.step('a worktree from the name step is made exactly like one made with Create in the New worktree dialog', async () => {
    // A setup script that runs by default shows any difference in what the new workspace opens.
    await orcaPage.evaluate(async () => {
      const state = window.__store!.getState()
      const repo = state.repos.find((candidate) => candidate.displayName === 'notes')
      await state.updateRepo(repo!.id, {
        hookSettings: {
          mode: 'override',
          setupRunPolicy: 'run-by-default',
          setupAgentStartupPolicy: 'start-immediately',
          scripts: { setup: 'true', archive: '' }
        }
      })
    })
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('notes')
    await expect(armedRow(palette)).toHaveAttribute('data-value', /^8:worktree/)
    await input.press('ControlOrMeta+Enter')
    await expectNameStep(palette, input, 'notes')
    await input.pressSequentially('same-name-a')
    await input.press('Enter')
    await expect(palette).toHaveCount(0)
    await expect.poll(() => readCreatedWorktree(orcaPage, 'notes', 'same-name-a')).not.toBeNull()

    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const repoId = state.repos.find((repo) => repo.displayName === 'notes')?.id
      state.openModal('new-workspace-composer', {
        initialRepoId: repoId,
        prefilledName: 'same-name-b'
      })
    })
    const dialog = composerDialog(orcaPage)
    await expect(dialog.locator('[data-workspace-name-input="true"]')).toHaveValue('same-name-b')
    await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
    await expect.poll(() => readCreatedWorktree(orcaPage, 'notes', 'same-name-b')).not.toBeNull()

    const record = (displayName: string) =>
      orcaPage.evaluate((name) => {
        const state = window.__store!.getState()
        const repo = state.repos.find((candidate) => candidate.displayName === 'notes')
        const worktree = (state.worktreesByRepo[repo!.id] ?? []).find(
          (entry) => entry.displayName === name
        )
        return {
          branch: worktree?.branch?.replace(name, '<name>'),
          baseRef: worktree?.baseRef,
          displayNameMode: worktree?.displayNameMode,
          workspaceStatus: worktree?.workspaceStatus,
          linkedIssue: worktree?.linkedIssue,
          linkedPR: worktree?.linkedPR,
          comment: worktree?.comment,
          isArchived: worktree?.isArchived,
          hasStartPoint: typeof worktree?.head === 'string' && worktree.head.length === 40,
          createdWithAgent: worktree?.createdWithAgent ?? null,
          tabs: (state.tabsByWorktree[worktree!.id] ?? []).map((tab) => tab.title)
        }
      }, displayName)
    await expect.poll(async () => (await record('same-name-a')).tabs.length).toBeGreaterThan(0)
    await expect.poll(async () => (await record('same-name-b')).tabs.length).toBeGreaterThan(0)
    const both = async () => ({
      fromNameStep: await record('same-name-a'),
      fromDialog: await record('same-name-b')
    })
    await expect
      .poll(
        async () => {
          const { fromNameStep, fromDialog } = await both()
          return JSON.stringify(fromNameStep) === JSON.stringify(fromDialog)
        },
        { message: 'the two worktrees settle to the same record' }
      )
      .toBe(true)
    const { fromNameStep, fromDialog } = await both()
    expect(fromNameStep).toEqual(fromDialog)
    expect(fromNameStep).toMatchObject({
      branch: 'refs/heads/<name>',
      baseRef: 'main',
      displayNameMode: 'fixed',
      workspaceStatus: 'in-progress',
      linkedIssue: null,
      linkedPR: null,
      comment: '',
      isArchived: false,
      hasStartPoint: true
    })
  })

  await test.step('a query without a single project before the slash keeps the dialog hand-off', async () => {
    const { palette, input } = await openPalette(orcaPage)
    // Only a whole project title scopes: a prefix of one (or of its name) is just part of a branch-style name.
    await input.fill('acme-w/some-name')
    await expect(
      palette.locator('[cmdk-item]', { hasText: 'Create worktree "acme-w/some-name"' })
    ).toHaveCount(1)
    await input.fill('acme/some-name')
    const create = palette.locator('[cmdk-item]', { hasText: 'Create worktree "acme/some-name"' })
    await expect(create).toHaveCount(1)
    await input.press('End')
    await expect(create).toHaveAttribute('aria-selected', 'true')
    await input.press('Enter')
    const dialog = composerDialog(orcaPage)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-workspace-name-input="true"]')).toHaveValue('acme/some-name')
    await closeComposer(orcaPage)
  })

  await test.step('a project that asks about its setup script takes the name to the New worktree dialog', async () => {
    await orcaPage.evaluate(async () => {
      const state = window.__store!.getState()
      const repo = state.repos.find((candidate) => candidate.displayName === 'acme-api')
      if (!repo) {
        throw new Error('acme-api was not registered')
      }
      await state.updateRepo(repo.id, {
        hookSettings: {
          mode: 'override',
          setupRunPolicy: 'ask',
          setupAgentStartupPolicy: 'start-immediately',
          scripts: { setup: 'true', archive: '' }
        }
      })
    })
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('acme-api')
    await expect(armedRow(palette)).toHaveAttribute('data-value', /^8:worktree/)
    await input.press('ControlOrMeta+Enter')
    await expectNameStep(palette, input, 'acme-api')
    await input.pressSequentially('ops-fix')
    const before = await countWorktrees('acme-api')
    await input.press('Enter')
    const dialog = composerDialog(orcaPage)
    await expect(dialog).toBeVisible()
    await expect(composerProject(dialog)).toContainText('acme-api')
    await expect(dialog.locator('[data-workspace-name-input="true"]')).toHaveValue('ops-fix')
    expect(await countWorktrees('acme-api')).toBe(before)
    // It was opened again as an ordinary dialog: the flag is gone from what any later Reopen would carry.
    expect(
      await orcaPage.evaluate(() => 'autoSubmit' in (window.__store!.getState().modalData ?? {}))
    ).toBe(false)
    await closeComposer(orcaPage)
  })

  const remoteName = 'remote-proj'
  const projects = ['acme-web', 'acme-api', 'notes', remoteName]
  const countAll = (): Promise<number[]> => Promise.all(projects.map(countWorktrees))
  // Names the project in the palette's name step and hands a name to the New worktree dialog.
  const startNamed = async (name: string): Promise<void> => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill(remoteName)
    await expect(armedRow(palette)).toHaveCount(1)
    await input.press('ControlOrMeta+Enter')
    await expectNameStep(palette, input, remoteName)
    await input.pressSequentially(name)
    await input.press('Enter')
  }

  await test.step('a project whose host Orca does not know is never made in another project, and its dialog shows at once', async () => {
    // The form falls back to a ready project when the chosen one cannot be used; pressing Create out of sight there
    // would put the worktree in a project nobody chose.
    const remote = path.join(parent, remoteName)
    createGitRepo(remote)
    await orcaPage.evaluate(async (target) => {
      const store = window.__store!
      const repo = await store.getState().addRepoPath(target)
      if (!repo) {
        throw new Error(`Could not register ${target}`)
      }
      // An SSH target the store has never heard of. RepoUpdate does not list connectionId, but the store applies
      // the update as given; the name is repeated so the object still shares a property with RepoUpdate.
      const patch = { displayName: repo.displayName, connectionId: 'ssh-fake-1' }
      await store.getState().updateRepo(repo.id, patch)
    }, remote)
    const before = await countAll()
    await startNamed('where-does-it-land')

    const dialog = composerDialog(orcaPage)
    // Well before the four seconds a form that is not ready waits.
    await expect(dialog).toBeVisible({ timeout: 3000 })
    await expect(dialog.locator('[data-workspace-name-input="true"]')).toHaveValue(
      'where-does-it-land'
    )
    expect(await countAll()).toEqual(before)
    await closeComposer(orcaPage)
    expect(await countAll()).toEqual(before)
  })

  await test.step('a second open while the first still works out of sight starts from scratch and makes its own worktree', async () => {
    // A known but disconnected host keeps the first dialog hidden and not ready until it is shown after four seconds.
    await orcaPage.evaluate(() => {
      window.__store!.setState({
        sshTargetLabels: new Map([['ssh-fake-1', 'Build box']]),
        sshConnectionStates: new Map([
          [
            'ssh-fake-1',
            { targetId: 'ssh-fake-1', status: 'disconnected', error: null, reconnectAttempt: 0 }
          ]
        ])
      })
    })
    const before = await countAll()
    await startNamed('first-hidden')
    await expect(
      orcaPage.locator('[data-slot="dialog-content"][data-autosubmit="true"]')
    ).toHaveCount(1)
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const repo = state.repos.find((candidate) => candidate.displayName === 'acme-web')
      if (!repo) {
        throw new Error('acme-web was not registered')
      }
      state.openModal('new-workspace-composer', {
        initialRepoId: repo.id,
        prefilledName: 'second-auto',
        autoSubmit: true
      })
    })

    await expect.poll(() => countWorktrees('acme-web')).toBe(before[0] + 1)
    expect(await readCreatedWorktree(orcaPage, 'acme-web', 'second-auto')).not.toBeNull()
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeModal))
      .toBe('none')
    await expect(composerDialog(orcaPage)).toHaveCount(0)
    expect((await countAll()).slice(1)).toEqual(before.slice(1))
  })
})
