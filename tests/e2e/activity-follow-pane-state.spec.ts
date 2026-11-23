import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test } from './desktop/electron-fixtures/orca-app'
import { getActiveTabId, getActiveWorktreeId } from './desktop/renderer-probes/store'
import {
  activateTab,
  emitCodexHookStatus,
  hookAgent,
  openBlankTerminalTab,
  prepareActivityFollowSession,
  readHookEndpoint,
  rowFor,
  selectedRow,
  settleRender,
  startAgentThroughHook
} from './helpers/activity-follow-agents'
import {
  readSelectedAgentIndex,
  seedAgentsForActivePanes,
  setSidebarChrome,
  showActivityPane,
  type SeededAgent
} from './helpers/activity-sidebar'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __revealEvents?: number
  }
}

// Older 'done' agents below the seeded one, so the list overflows the pane and can be scrolled.
async function seedFillerAgents(page: Page, tabId: string, count: number): Promise<void> {
  await page.evaluate(
    ({ tabId, count }) => {
      const state = window.__store?.getState()
      const now = Date.now()
      for (let index = 0; index < count; index += 1) {
        const startedAt = now - (index + 2) * 60_000
        state?.setAgentStatus(
          `${tabId}:${crypto.randomUUID()}`,
          { state: 'done', prompt: `FILLER_${index}`, agentType: 'codex' },
          `Filler ${index}`,
          { updatedAt: startedAt, stateStartedAt: startedAt }
        )
      }
    },
    { tabId, count }
  )
}

function listScroller(page: Page): Locator {
  return page.locator('[data-activity-virtual-list]').locator('xpath=..')
}

async function readScrollTop(page: Page): Promise<number> {
  return listScroller(page).evaluate((element) => element.scrollTop)
}

// A real wheel scroll, which is what the list remembers across a reopen.
async function wheelListDown(page: Page, pixels: number): Promise<number> {
  const box = (await listScroller(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, pixels)
  // The list stores its offset from the scroll event, which fires with the next frame.
  await settleRender(page)
  return readScrollTop(page)
}

async function collapseGroup(page: Page, label: string): Promise<void> {
  const header = page.locator('[data-activity-sticky-header]').filter({ hasText: label })
  await expect(header).toBeVisible()
  await header
    .getByRole('button')
    .first()
    .evaluate((button) => {
      if (button instanceof HTMLElement) {
        button.click()
      }
    })
}

// An agent that reports while its row may be hidden, so wait on the store instead of the row.
async function startAgentInNewTab(
  page: Page,
  endpoint: Awaited<ReturnType<typeof readHookEndpoint>>,
  name: string
): Promise<SeededAgent> {
  const tab = await openBlankTerminalTab(page)
  const agent = hookAgent(tab.paneKey, name)
  await emitCodexHookStatus(endpoint, {
    paneKey: agent.paneKey,
    worktreeId: (await getActiveWorktreeId(page))!,
    state: 'working',
    prompt: agent.prompt
  })
  await expect
    .poll(() =>
      page.evaluate(
        (paneKey) => Boolean(window.__store?.getState().agentStatusByPaneKey.get(paneKey)),
        agent.paneKey
      )
    )
    .toBe(true)
  return agent
}

test.describe('Activity follow keeps the list state it does not own', () => {
  test.beforeEach(async ({ orcaPage }) => {
    const hasPaneManager = await prepareActivityFollowSession(orcaPage)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager, so no agent can be started in a tab.'
    )
  })

  test('reopening the pane or the sidebar keeps the scroll offset and a collapsed group', async ({
    orcaPage
  }) => {
    const firstTabId = (await getActiveTabId(orcaPage))!
    const [seed] = await seedAgentsForActivePanes(orcaPage, 1, 'Retain seed')
    await seedFillerAgents(orcaPage, firstTabId, 14)
    await showActivityPane(orcaPage)
    // The focused agent is the newest row, so it sits at the top of the list.
    await expect(selectedRow(orcaPage)).toContainText(seed.prompt)
    const scrolledTo = await wheelListDown(orcaPage, 400)
    expect(scrolledTo).toBe(400)

    const reopenings = [
      { sidebarOpen: true, activityPaneOpen: false },
      { sidebarOpen: false, activityPaneOpen: true }
    ]
    for (const hidden of reopenings) {
      await setSidebarChrome(orcaPage, hidden)
      await expect(orcaPage.locator('[data-activity-virtual-list]')).toHaveCount(0)
      await setSidebarChrome(orcaPage, { sidebarOpen: true, activityPaneOpen: true })
      await expect(selectedRow(orcaPage)).toContainText(seed.prompt)
      await expect.poll(() => readScrollTop(orcaPage)).toBeCloseTo(scrolledTo, 0)
      await settleRender(orcaPage)
      expect(await readScrollTop(orcaPage)).toBeCloseTo(scrolledTo, 0)
    }

    // A group the user collapsed stays collapsed when the pane comes back.
    await orcaPage.evaluate(() => window.__store?.getState().setAgentsGroupBy('status'))
    await collapseGroup(orcaPage, 'Done')
    await expect(rowFor(orcaPage, seed)).toHaveCount(0)
    for (const hidden of reopenings) {
      await setSidebarChrome(orcaPage, hidden)
      await expect(orcaPage.locator('[data-activity-virtual-list]')).toHaveCount(0)
      await setSidebarChrome(orcaPage, { sidebarOpen: true, activityPaneOpen: true })
      await expect(orcaPage.locator('[data-activity-sticky-header]').first()).toBeVisible()
      await settleRender(orcaPage)
      await expect(rowFor(orcaPage, seed)).toHaveCount(0)
    }
  })

  test('a hidden pane or a closed sidebar neither scrolls, opens a group nor follows', async ({
    orcaPage,
    electronApp
  }) => {
    const endpoint = await readHookEndpoint(electronApp)
    await seedAgentsForActivePanes(orcaPage, 1, 'Hidden seed')
    await showActivityPane(orcaPage)
    await orcaPage.evaluate(() => window.__store?.getState().setAgentsGroupBy('status'))
    const first = hookAgent((await openBlankTerminalTab(orcaPage)).paneKey, 'hidden first')
    await emitCodexHookStatus(endpoint, {
      paneKey: first.paneKey,
      worktreeId: (await getActiveWorktreeId(orcaPage))!,
      state: 'working',
      prompt: first.prompt
    })
    await expect(selectedRow(orcaPage)).toContainText(first.prompt)
    await collapseGroup(orcaPage, 'Working')
    await expect(rowFor(orcaPage, first)).toHaveCount(0)
    await orcaPage.evaluate(() => {
      window.__revealEvents = 0
      window.addEventListener('orca-custom:activity-thread-reveal', () => {
        window.__revealEvents = (window.__revealEvents ?? 0) + 1
      })
    })

    const hiddenStates = [
      { sidebarOpen: true, activityPaneOpen: false },
      { sidebarOpen: false, activityPaneOpen: true }
    ]
    const hiddenAgents: SeededAgent[] = []
    for (const [index, hidden] of hiddenStates.entries()) {
      await setSidebarChrome(orcaPage, hidden)
      hiddenAgents.push(await startAgentInNewTab(orcaPage, endpoint, `hidden later ${index}`))
      await settleRender(orcaPage)
      expect(await orcaPage.evaluate(() => window.__revealEvents)).toBe(0)
    }

    await setSidebarChrome(orcaPage, { sidebarOpen: true, activityPaneOpen: true })
    await expect(orcaPage.locator('[data-activity-sticky-header]').first()).toBeVisible()
    await settleRender(orcaPage)
    for (const agent of [first, ...hiddenAgents]) {
      await expect(rowFor(orcaPage, agent)).toHaveCount(0)
    }
    expect(await orcaPage.evaluate(() => window.__revealEvents)).toBe(0)
  })

  test('a filter that hides the focused row keeps the old highlight until the filter clears', async ({
    orcaPage,
    electronApp
  }) => {
    const endpoint = await readHookEndpoint(electronApp)
    const [seed] = await seedAgentsForActivePanes(orcaPage, 1, 'Filter seed')
    await showActivityPane(orcaPage)
    await orcaPage.evaluate(() => window.__store?.getState().setAgentsShowSearch(true))
    const filter = orcaPage.getByPlaceholder('Filter...')
    await filter.fill('Filter_seed')
    await expect(selectedRow(orcaPage)).toContainText(seed.prompt)

    const hidden = await startAgentInNewTab(orcaPage, endpoint, 'filtered out')
    const agents = [seed, hidden]
    await expect(rowFor(orcaPage, hidden)).toHaveCount(0)
    await settleRender(orcaPage)
    expect(await readSelectedAgentIndex(orcaPage, agents)).toBe(0)

    await filter.fill('')
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(1)
  })

  test('a followed row that is already in view does not scroll the list', async ({
    orcaPage,
    electronApp
  }) => {
    const endpoint = await readHookEndpoint(electronApp)
    const workspace = (await getActiveWorktreeId(orcaPage))!
    const firstTabId = (await getActiveTabId(orcaPage))!
    const [seed] = await seedAgentsForActivePanes(orcaPage, 1, 'In view seed')
    await seedFillerAgents(orcaPage, firstTabId, 14)
    await showActivityPane(orcaPage)
    // Three newer agents push the seeded row below the top of the list.
    const newer: SeededAgent[] = []
    for (const name of ['in view one', 'in view two', 'in view three']) {
      const agent = hookAgent((await openBlankTerminalTab(orcaPage)).paneKey, name)
      await startAgentThroughHook(orcaPage, endpoint, agent, workspace)
      newer.push(agent)
    }
    await expect(selectedRow(orcaPage)).toContainText(newer[2].prompt)
    await rowFor(orcaPage, seed).evaluate((row) => row.scrollIntoView({ block: 'center' }))
    await expect(rowFor(orcaPage, seed)).toBeInViewport({ ratio: 0.99 })
    const before = await readScrollTop(orcaPage)
    expect(before).toBeGreaterThan(0)

    await activateTab(orcaPage, firstTabId)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, [seed, ...newer])).toBe(0)
    await settleRender(orcaPage)
    expect(await readScrollTop(orcaPage)).toBeCloseTo(before, 0)
  })
})
