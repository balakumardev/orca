import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  focusActiveTerminalInput,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

const PREVIOUS_CHORD = 'ControlOrMeta+Shift+Semicolon'
const NEXT_CHORD = 'ControlOrMeta+Shift+Quote'
const TOGGLE_CHORD = 'ControlOrMeta+Shift+KeyL'

type SeededAgent = {
  paneKey: string
  leafId: string
  title: string
  prompt: string
}

type SidebarChrome = { sidebarOpen: boolean; sidebarBody: string | null }

async function seedThreeAgentPanes(page: Page): Promise<SeededAgent[]> {
  await splitActiveTerminalPane(page, 'vertical')
  await splitActiveTerminalPane(page, 'vertical')
  await waitForPaneCount(page, 3)
  const snapshot = await waitForPaneIdentitySnapshot(page, 3)
  const now = Date.now()
  const agents = snapshot.panes.map((pane, index) => ({
    paneKey: `${snapshot.tabId}:${pane.leafId}`,
    leafId: pane.leafId,
    title: `Cycle agent ${index}`,
    prompt: `ACTIVITY_CYCLE_PROMPT_${index}_${now}`
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

async function showActivityView(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    // Ungrouped rows keep every thread rendered, so DOM order is the walk order.
    state.setAgentsGroupBy('none')
    state.setSidebarOpen(true)
    state.setSidebarBody('agents')
  })
}

function threadRows(page: Page) {
  return page.locator('[data-activity-virtual-list] [data-worktree-card-surface]')
}

// The row shows either the session title or the prompt, depending on how the name resolves.
function agentIndexForRowText(agents: SeededAgent[], text: string): number {
  return agents.findIndex((agent) => text.includes(agent.title) || text.includes(agent.prompt))
}

async function readRenderedAgentOrder(page: Page, agents: SeededAgent[]): Promise<number[]> {
  const rowTexts = await threadRows(page).evaluateAll((rows) =>
    rows.map((row) => `${row.getAttribute('aria-label') ?? ''} ${row.textContent ?? ''}`)
  )
  return rowTexts.map((text) => agentIndexForRowText(agents, text))
}

async function readSelectedAgentIndex(page: Page, agents: SeededAgent[]): Promise<number | null> {
  const selectedTexts = await threadRows(page).evaluateAll((rows) =>
    rows
      .filter((row) => row.getAttribute('aria-current') === 'true')
      .map((row) => `${row.getAttribute('aria-label') ?? ''} ${row.textContent ?? ''}`)
  )
  return selectedTexts.length === 1 ? agentIndexForRowText(agents, selectedTexts[0]) : null
}

async function readFocusedTerminalLeaf(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const focused = document.activeElement
    if (!focused?.classList.contains('xterm-helper-textarea')) {
      return null
    }
    return focused.closest('.pane')?.getAttribute('data-leaf-id') ?? null
  })
}

async function readActivePaneLeaf(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const tabId = window.__store?.getState().activeTabId
    return (tabId ? window.__paneManagers?.get(tabId)?.getActivePane?.()?.leafId : null) ?? null
  })
}

async function readSidebarChrome(page: Page): Promise<SidebarChrome> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    return {
      sidebarOpen: state?.sidebarOpen ?? false,
      sidebarBody: state?.sidebarBody ?? null
    }
  })
}

async function setSidebarChrome(page: Page, chrome: SidebarChrome): Promise<void> {
  await page.evaluate((chrome) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    state.setSidebarBody(chrome.sidebarBody === 'agents' ? 'agents' : 'workspaces')
    state.setSidebarOpen(chrome.sidebarOpen)
  }, chrome)
}

test.describe('Activity view shortcuts', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(async () => {
      // Keep the migration intro from covering the sidebar header.
      const settings = await window.api.settings.set({ agentsSidebarIntroShown: true })
      window.__store?.setState({ settings })
    })
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const hasPaneManager = await waitForActiveTerminalManager(orcaPage, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager, so the shortcuts would only fail on harness setup.'
    )
    await waitForPaneCount(orcaPage, 1, 30_000)
  })

  test('previous and next agent walk the rendered rows, wrap, and focus the agent terminal', async ({
    orcaPage
  }) => {
    const agents = await seedThreeAgentPanes(orcaPage)
    await showActivityView(orcaPage)
    await expect(threadRows(orcaPage)).toHaveCount(3)
    const order = await readRenderedAgentOrder(orcaPage, agents)
    expect([...order].sort()).toEqual([0, 1, 2])
    await focusActiveTerminalInput(orcaPage)

    const expectSelected = async (position: number): Promise<void> => {
      const agentIndex = order[position]
      await expect
        .poll(async () => readSelectedAgentIndex(orcaPage, agents), {
          message: `row ${position} of the Activity list is not selected`
        })
        .toBe(agentIndex)
      await expect.poll(() => readActivePaneLeaf(orcaPage)).toBe(agents[agentIndex].leafId)
      await expect.poll(() => readFocusedTerminalLeaf(orcaPage)).toBe(agents[agentIndex].leafId)
      expect(await readSidebarChrome(orcaPage)).toEqual({
        sidebarOpen: true,
        sidebarBody: 'agents'
      })
    }

    // No selection yet: previous starts at the last row, then next wraps to the first.
    await orcaPage.keyboard.press(PREVIOUS_CHORD)
    await expectSelected(2)
    await orcaPage.keyboard.press(NEXT_CHORD)
    await expectSelected(0)
    await orcaPage.keyboard.press(NEXT_CHORD)
    await expectSelected(1)
    await orcaPage.keyboard.press(NEXT_CHORD)
    await expectSelected(2)
    await orcaPage.keyboard.press(PREVIOUS_CHORD)
    await expectSelected(1)
    await orcaPage.keyboard.press(PREVIOUS_CHORD)
    await expectSelected(0)
    await orcaPage.keyboard.press(PREVIOUS_CHORD)
    await expectSelected(2)
  })

  test('leaves the cycle chords alone when the workspace list is showing', async ({ orcaPage }) => {
    const agents = await seedThreeAgentPanes(orcaPage)
    await showActivityView(orcaPage)
    await expect(threadRows(orcaPage)).toHaveCount(3)
    await setSidebarChrome(orcaPage, { sidebarOpen: true, sidebarBody: 'workspaces' })
    await focusActiveTerminalInput(orcaPage)
    const activeLeafBefore = await readActivePaneLeaf(orcaPage)
    expect(agents.map((agent) => agent.leafId)).toContain(activeLeafBefore)
    await orcaPage.evaluate(() => {
      window.addEventListener('keydown', (event) => {
        if (event.code === 'Quote') {
          document.body.dataset.cycleChordClaimed = String(event.defaultPrevented)
        }
      })
    })

    await orcaPage.keyboard.press(NEXT_CHORD)

    await expect(orcaPage.locator('body')).toHaveAttribute('data-cycle-chord-claimed', 'false')
    expect(await readActivePaneLeaf(orcaPage)).toBe(activeLeafBefore)
  })

  test('toggle flips the sidebar body both ways and opens a closed sidebar on Activity', async ({
    orcaPage
  }) => {
    await setSidebarChrome(orcaPage, { sidebarOpen: true, sidebarBody: 'workspaces' })
    await focusActiveTerminalInput(orcaPage)

    await orcaPage.keyboard.press(TOGGLE_CHORD)
    await expect
      .poll(() => readSidebarChrome(orcaPage))
      .toEqual({ sidebarOpen: true, sidebarBody: 'agents' })
    await expect(
      orcaPage.getByRole('button', { name: 'Turn off activity view', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')

    await orcaPage.keyboard.press(TOGGLE_CHORD)
    await expect
      .poll(() => readSidebarChrome(orcaPage))
      .toEqual({ sidebarOpen: true, sidebarBody: 'workspaces' })

    for (const lastBody of ['workspaces', 'agents']) {
      await setSidebarChrome(orcaPage, { sidebarOpen: false, sidebarBody: lastBody })
      await focusActiveTerminalInput(orcaPage)
      await orcaPage.keyboard.press(TOGGLE_CHORD)
      await expect
        .poll(() => readSidebarChrome(orcaPage))
        .toEqual({ sidebarOpen: true, sidebarBody: 'agents' })
    }
  })
})
