import type { Page } from '@stablyai/playwright-test'
import { waitForPaneIdentitySnapshot } from '../terminal/input/terminal'

export type SeededAgent = {
  paneKey: string
  leafId: string
  title: string
  prompt: string
}

export type SidebarChrome = {
  sidebarOpen: boolean
  activityPaneOpen: boolean
  sidebarBody: string | null
}

// One 'done' agent per pane of the active tab, so each pane becomes a row in the sidebar Activity list.
export async function seedAgentsForActivePanes(
  page: Page,
  paneCount: number,
  titlePrefix: string
): Promise<SeededAgent[]> {
  const snapshot = await waitForPaneIdentitySnapshot(page, paneCount)
  const now = Date.now()
  const agents = snapshot.panes.map((pane, index) => ({
    paneKey: `${snapshot.tabId}:${pane.leafId}`,
    leafId: pane.leafId,
    title: `${titlePrefix} ${index}`,
    prompt: `ACTIVITY_PROMPT_${titlePrefix.replace(/\s+/g, '_')}_${index}_${now}`
  }))
  await page.evaluate(
    ({ agents, now }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      agents.forEach((agent, index) => {
        const startedAt = now - (index + 1) * 1_000
        store.getState().setAgentStatus(
          agent.paneKey,
          {
            state: 'done',
            prompt: agent.prompt,
            agentType: 'codex',
            lastAssistantMessage: `Agent ${index} finished.`
          },
          agent.title,
          { updatedAt: startedAt, stateStartedAt: startedAt }
        )
      })
    },
    { agents, now }
  )
  return agents
}

export async function showActivityPane(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    // Ungrouped rows keep every thread rendered, so DOM order is the walk order.
    state.setAgentsGroupBy('none')
    state.setSidebarOpen(true)
    state.setActivityPaneOpen(true)
  })
}

export function threadRows(page: Page) {
  return page.locator('[data-activity-virtual-list] [data-worktree-card-surface]')
}

// The row shows either the session title or the prompt, depending on how the name resolves.
export function agentIndexForRowText(agents: SeededAgent[], text: string): number {
  return agents.findIndex((agent) => text.includes(agent.title) || text.includes(agent.prompt))
}

export async function readRenderedAgentOrder(page: Page, agents: SeededAgent[]): Promise<number[]> {
  const rowTexts = await threadRows(page).evaluateAll((rows) =>
    rows.map((row) => `${row.getAttribute('aria-label') ?? ''} ${row.textContent ?? ''}`)
  )
  return rowTexts.map((text) => agentIndexForRowText(agents, text))
}

export async function readSelectedAgentIndex(
  page: Page,
  agents: SeededAgent[]
): Promise<number | null> {
  const selectedTexts = await threadRows(page).evaluateAll((rows) =>
    rows
      .filter((row) => row.getAttribute('aria-current') === 'true')
      .map((row) => `${row.getAttribute('aria-label') ?? ''} ${row.textContent ?? ''}`)
  )
  return selectedTexts.length === 1 ? agentIndexForRowText(agents, selectedTexts[0]) : null
}

// The workspace rows the top pane marks as the current page; exactly one when the list shows the active workspace.
export async function readActiveWorkspaceRowIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-sidebar-workspaces-pane] [role="option"][aria-current="page"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-worktree-id') ?? ''))
}

export async function readSidebarChrome(page: Page): Promise<SidebarChrome> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    return {
      sidebarOpen: state?.sidebarOpen ?? false,
      activityPaneOpen: state?.activityPaneOpen ?? false,
      sidebarBody: state?.sidebarBody ?? null
    }
  })
}

export async function setSidebarChrome(
  page: Page,
  chrome: Pick<SidebarChrome, 'sidebarOpen' | 'activityPaneOpen'>
): Promise<void> {
  await page.evaluate((chrome) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    state.setActivityPaneOpen(chrome.activityPaneOpen)
    state.setSidebarOpen(chrome.sidebarOpen)
  }, chrome)
}
