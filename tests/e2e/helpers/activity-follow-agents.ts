import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { emitCodexHookStatus, type readHookEndpoint } from './agent-hook-endpoint'
import {
  waitForActivePaneHookDescriptor,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './store'
import { agentIndexForRowText, threadRows, type SeededAgent } from './activity-sidebar'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __highlightLog?: string[]
    __highlightPatched?: boolean
  }
}

export function rowFor(page: Page, agent: SeededAgent): Locator {
  return threadRows(page).filter({
    hasText: new RegExp(`${agent.title}|${agent.prompt}`)
  })
}

// The fresh fixture repo raises an "Add a setup script" card over the lower rows, so click through the DOM.
export async function clickRow(page: Page, agent: SeededAgent): Promise<void> {
  await rowFor(page, agent).evaluate((row) => {
    if (row instanceof HTMLElement) {
      row.click()
    }
  })
}

export function selectedRow(page: Page): Locator {
  return page.locator(
    '[data-activity-virtual-list] [data-worktree-card-surface][aria-current="true"]'
  )
}

// A hook-reported agent shows its prompt; the title only keeps the lookup helpers uniform.
export function hookAgent(paneKey: string, name: string): SeededAgent {
  return {
    paneKey,
    leafId: paneKey.split(':')[1],
    title: `${name}_TITLE`,
    prompt: `FOLLOW_PROMPT_${name}_${Date.now()}`
  }
}

// Opens a blank terminal tab the way the tab bar's "+" does and returns the routable pane of that tab.
export async function openBlankTerminalTab(
  page: Page
): Promise<{ tabId: string; paneKey: string }> {
  const tabId = await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (!state || !worktreeId) {
      throw new Error('No active workspace to open a tab in')
    }
    const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', worktreeId)
    return tab.id
  })
  await expect.poll(() => getActiveTabId(page)).toBe(tabId)
  const descriptor = await waitForActivePaneHookDescriptor(page)
  expect(descriptor.paneKey.startsWith(`${tabId}:`)).toBe(true)
  return { tabId, paneKey: descriptor.paneKey }
}

export async function activateTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const state = window.__store?.getState()
    state?.setActiveTab(tabId)
    state?.setActiveTabType('terminal', state.activeWorktreeId)
  }, tabId)
  await expect.poll(() => getActiveTabId(page)).toBe(tabId)
}

// Two animation frames: React has committed and flushed the effects of everything that changed before the call.
export async function settleRender(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
}

// The end state of a click or chord on a row: that agent's tab is active and its pane is the tab's focused pane.
export async function waitForFocusedAgentPane(page: Page, agent: SeededAgent): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(({ paneKey, leafId }) => {
        const state = window.__store?.getState()
        const tabId = paneKey.split(':')[0]
        return (
          state?.activeTabId === tabId &&
          state.terminalLayoutsByTabId[tabId]?.activeLeafId === leafId
        )
      }, agent)
    )
    .toBe(true)
}

// The user's `claude` or `codex` reporting its first prompt, through the app's real agent-hook HTTP listener.
export async function startAgentThroughHook(
  page: Page,
  endpoint: Awaited<ReturnType<typeof readHookEndpoint>>,
  agent: SeededAgent,
  worktreeId: string
): Promise<void> {
  await emitCodexHookStatus(endpoint, {
    paneKey: agent.paneKey,
    worktreeId,
    state: 'working',
    prompt: agent.prompt
  })
  await expect(rowFor(page, agent)).toBeVisible()
}

// Records every row that is given the highlight. A MutationObserver would miss a wrong row that
// React highlights and un-highlights within one task, so this watches the attribute writes themselves.
export async function startHighlightLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__highlightLog = []
    if (window.__highlightPatched) {
      return
    }
    window.__highlightPatched = true
    const original = Element.prototype.setAttribute
    Element.prototype.setAttribute = function (name: string, value: string): void {
      if (
        name === 'aria-current' &&
        value === 'true' &&
        this.hasAttribute('data-worktree-card-surface')
      ) {
        window.__highlightLog?.push(this.getAttribute('aria-label') ?? '')
      }
      original.call(this, name, value)
    }
  })
}

export async function readHighlightLog(
  page: Page,
  agents: SeededAgent[]
): Promise<(number | null)[]> {
  const log = await page.evaluate(() => window.__highlightLog ?? [])
  return log.map((label) => agentIndexForRowText(agents, label))
}

// A started app on its first workspace with one terminal pane; false when this environment never mounts the live pane manager.
export async function prepareActivityFollowSession(page: Page): Promise<boolean> {
  await waitForSessionReady(page)
  await page.evaluate(async () => {
    const settings = await window.api.settings.set({ agentsSidebarIntroShown: true })
    window.__store?.setState({ settings })
  })
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const hasPaneManager = await waitForActiveTerminalManager(page, 30_000)
    .then(() => true)
    .catch(() => false)
  if (hasPaneManager) {
    await waitForPaneCount(page, 1, 30_000)
  }
  return hasPaneManager
}

// Makes the pane at `index` the tab's focused pane, as clicking into it does (the store keeps it as the active leaf).
export async function focusTerminalPaneAtIndex(
  page: Page,
  tabId: string,
  index: number
): Promise<string> {
  const leafId = await page.evaluate(
    ({ tabId, index }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getPanes()[index]
      if (!manager || !pane) {
        throw new Error(`No pane ${index} in tab ${tabId}`)
      }
      manager.setActivePane(pane.id, { focus: true })
      return pane.leafId
    },
    { tabId, index }
  )
  await expect
    .poll(() =>
      page.evaluate(
        (tabId) => window.__store?.getState().terminalLayoutsByTabId[tabId]?.activeLeafId,
        tabId
      )
    )
    .toBe(leafId)
  return leafId
}
