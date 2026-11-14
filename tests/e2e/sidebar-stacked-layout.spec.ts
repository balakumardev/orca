import path from 'node:path'
import type { Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedAgentsForActivePanes, showActivityPane, threadRows } from './helpers/activity-sidebar'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

const QUICK_LINK_ITEMS = [
  'Search worktrees and browser tabs',
  'Tasks',
  'Artifacts',
  'Skills',
  'Automations',
  /^Agent Dashboard/
]

// Set SIDEBAR_LAYOUT_SHOT_DIR to keep the screenshots somewhere durable; otherwise they stay with the test output.
async function shootSidebar(
  page: Page,
  testInfo: TestInfo,
  name: string,
  extraWidth = 0
): Promise<void> {
  const body = await page.locator('[data-sidebar-stacked-body]').boundingBox()
  const viewport = await page.evaluate(() => ({ height: innerHeight }))
  if (!body) {
    throw new Error('the stacked sidebar body is not rendered')
  }
  const dir = process.env.SIDEBAR_LAYOUT_SHOT_DIR ?? testInfo.outputDir
  await page.screenshot({
    path: path.join(dir, `${name}.png`),
    clip: { x: 0, y: 0, width: body.x + body.width + 4 + extraWidth, height: viewport.height }
  })
}

async function activityPaneHeight(page: Page): Promise<number> {
  const box = await page.locator('[data-sidebar-activity-pane]').boundingBox()
  return box?.height ?? 0
}

// Row boundaries must stay contiguous: a hidden description may not leave a gap or clip the next row.
async function readRowGaps(rows: Locator): Promise<number[]> {
  const boxes = await rows.evaluateAll((elements) =>
    elements.map((element) => {
      const { top, bottom } = element.getBoundingClientRect()
      return { top, bottom }
    })
  )
  const sorted = [...boxes].sort((a, b) => a.top - b.top)
  return sorted.slice(1).map((box, index) => box.top - sorted[index].bottom)
}

async function setDescriptionVisible(page: Page, visible: boolean): Promise<void> {
  await page
    .locator('[data-sidebar-activity-header]')
    .getByRole('button', { name: /options/i })
    .click()
  const checkbox = page.getByRole('menuitemcheckbox', { name: 'Show description', exact: true })
  if ((await checkbox.getAttribute('aria-checked')) !== String(visible)) {
    await checkbox.click()
  }
  await expect(checkbox).toHaveAttribute('aria-checked', String(visible))
  await page.keyboard.press('Escape')
  await expect(checkbox).toBeHidden()
}

test.describe('Stacked sidebar', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(async () => {
      const settings = await window.api.settings.set({
        agentsSidebarIntroShown: true,
        showArtifactsButton: true,
        showSkillsButton: true,
        experimentalAgentDashboardPopout: true
      })
      window.__store?.setState({ settings })
    })
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const hasPaneManager = await waitForActiveTerminalManager(orcaPage, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager, so no agent rows can be seeded.'
    )
    await waitForPaneCount(orcaPage, 1, 30_000)
  })

  test('shows the workspace list above Activity with a draggable splitter', async ({
    orcaPage
  }, testInfo) => {
    await seedAgentsForActivePanes(orcaPage, 1, 'Layout agent')
    await showActivityPane(orcaPage)
    const workspaces = orcaPage.locator('[data-sidebar-workspaces-pane]')
    const activity = orcaPage.locator('[data-sidebar-activity-pane]')

    await expect(workspaces.locator('[data-sidebar-section-title]')).toBeVisible()
    await expect(activity.getByRole('button', { name: 'Collapse Activity' })).toBeVisible()
    await expect(threadRows(orcaPage)).toHaveCount(1)
    const workspacesBox = await workspaces.boundingBox()
    const activityBox = await activity.boundingBox()
    expect(workspacesBox!.y + workspacesBox!.height).toBeLessThanOrEqual(activityBox!.y + 1)
    // No view-switch button, and none of the quick-link rows take space in the sidebar.
    await expect(orcaPage.getByRole('button', { name: 'View activity', exact: true })).toHaveCount(
      0
    )
    await expect(
      orcaPage.getByRole('button', { name: 'Search worktrees and browser tabs' })
    ).toBeHidden()

    const splitter = orcaPage.locator('[data-sidebar-activity-splitter]')
    await expect(splitter).toBeVisible()
    const initialHeight = await activityPaneHeight(orcaPage)
    const handle = (await splitter.boundingBox())!
    const x = handle.x + handle.width / 2
    const y = handle.y + handle.height / 2
    await orcaPage.mouse.move(x, y)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(x, y - 40, { steps: 4 })
    await orcaPage.mouse.move(x, y - 80, { steps: 4 })
    await orcaPage.mouse.up()
    await expect
      .poll(async () => (await activityPaneHeight(orcaPage)) - initialHeight)
      .toBeGreaterThan(50)

    const grownHeight = await activityPaneHeight(orcaPage)
    await splitter.focus()
    await orcaPage.keyboard.press('ArrowDown')
    await orcaPage.keyboard.press('ArrowDown')
    await expect.poll(() => activityPaneHeight(orcaPage)).toBeLessThan(grownHeight - 10)
    await shootSidebar(orcaPage, testInfo, 'stacked-sidebar')
  })

  test('opens the quick links as a floating popover from the titlebar', async ({
    orcaPage
  }, testInfo) => {
    const trigger = orcaPage.locator('[data-sidebar-nav-popover-trigger]')
    const popover = orcaPage.locator('[data-sidebar-nav-popover]')

    await trigger.click()
    await expect(popover).toBeVisible()
    for (const name of QUICK_LINK_ITEMS) {
      await expect(
        popover.getByRole('button', typeof name === 'string' ? { name, exact: true } : { name })
      ).toBeVisible()
    }
    await shootSidebar(orcaPage, testInfo, 'quick-links-popover', 140)

    await orcaPage.keyboard.press('Escape')
    await expect(popover).toBeHidden()

    await trigger.click()
    await popover.getByRole('button', { name: 'Automations', exact: true }).click()
    await expect(popover).toBeHidden()
    await expect(orcaPage.getByRole('heading', { name: 'Automations', level: 1 })).toBeVisible()
  })

  test('hides the agent description until Show description is ticked and remembers the choice', async ({
    orcaPage
  }, testInfo) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 3)
    await seedAgentsForActivePanes(orcaPage, 3, 'Description agent')
    await showActivityPane(orcaPage)
    const rows = threadRows(orcaPage)
    await expect(rows).toHaveCount(3)

    await expect(rows.first()).not.toContainText('finished.')
    const hiddenHeight = (await rows.first().boundingBox())!.height
    expect((await readRowGaps(rows)).every((gap) => gap >= -1 && gap < 12)).toBe(true)
    await shootSidebar(orcaPage, testInfo, 'description-hidden')

    await setDescriptionVisible(orcaPage, true)
    await expect(rows.first()).toContainText('finished.')
    expect((await rows.first().boundingBox())!.height).toBeGreaterThan(hiddenHeight + 10)
    expect((await readRowGaps(rows)).every((gap) => gap >= -1 && gap < 12)).toBe(true)
    await shootSidebar(orcaPage, testInfo, 'description-shown')

    await setDescriptionVisible(orcaPage, false)
    await expect(rows.first()).not.toContainText('finished.')
    await expect
      .poll(async () => (await rows.first().boundingBox())!.height)
      .toBeLessThan(hiddenHeight + 2)
    expect((await readRowGaps(rows)).every((gap) => gap >= -1 && gap < 12)).toBe(true)

    await setDescriptionVisible(orcaPage, true)
    await orcaPage.reload()
    await waitForSessionReady(orcaPage)
    await showActivityPane(orcaPage)
    await orcaPage
      .locator('[data-sidebar-activity-header]')
      .getByRole('button', { name: /options/i })
      .click()
    await expect(
      orcaPage.getByRole('menuitemcheckbox', { name: 'Show description', exact: true })
    ).toHaveAttribute('aria-checked', 'true')
  })
})
