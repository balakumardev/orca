import type { Page } from '@stablyai/playwright-test'
import { test } from './desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { focusActiveTerminalInput } from './terminal/input/terminal'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './terminal/layout/terminal-pane-operations'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  switchToOtherWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './desktop/renderer-probes/store'
import {
  readActiveWorkspaceRowIds,
  readRenderedAgentOrder,
  readSelectedAgentIndex,
  readSidebarChrome,
  seedAgentsForActivePanes,
  setSidebarChrome,
  showActivityPane,
  threadRows
} from './helpers/activity-sidebar'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

const PREVIOUS_CHORD = 'ControlOrMeta+Shift+Semicolon'
const NEXT_CHORD = 'ControlOrMeta+Shift+Quote'
const TOGGLE_CHORD = 'ControlOrMeta+Shift+KeyL'

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

test.describe('Activity pane shortcuts', () => {
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
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 3)
    const agents = await seedAgentsForActivePanes(orcaPage, 3, 'Cycle agent')
    await showActivityPane(orcaPage)
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
      // Both panes stay on screen: the workspace list is never swapped out for Activity.
      expect(await readSidebarChrome(orcaPage)).toEqual({
        sidebarOpen: true,
        activityPaneOpen: true,
        sidebarBody: 'workspaces'
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

  test('the workspace list follows the agent the chords select', async ({ orcaPage }) => {
    const workspaceA = await getActiveWorktreeId(orcaPage)
    expect(workspaceA).not.toBeNull()
    const [agentA] = await seedAgentsForActivePanes(orcaPage, 1, 'Follow A')
    const workspaceB = await switchToOtherWorktree(orcaPage, workspaceA!)
    expect(workspaceB).not.toBeNull()
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneCount(orcaPage, 1, 30_000)
    const [agentB] = await seedAgentsForActivePanes(orcaPage, 1, 'Follow B')
    const agents = [agentA, agentB]
    const workspaceOfAgent = [workspaceA!, workspaceB!]
    await showActivityPane(orcaPage)
    await expect(threadRows(orcaPage)).toHaveCount(2)
    await focusActiveTerminalInput(orcaPage)

    // The collapsed project hides both workspaces; selecting an agent must open it again.
    // The control sits under the section title until hover, so click it through the DOM.
    await orcaPage
      .getByRole('button', { name: 'Collapse all projects', exact: true })
      .evaluate((button) => (button as HTMLElement).click())
    await expect(orcaPage.locator('[data-sidebar-workspaces-pane] [role="option"]')).toHaveCount(0)

    for (let press = 0; press < 4; press += 1) {
      await orcaPage.keyboard.press(NEXT_CHORD)
      await expect.poll(async () => readSelectedAgentIndex(orcaPage, agents)).not.toBeNull()
      const selected = (await readSelectedAgentIndex(orcaPage, agents))!
      await expect
        .poll(() => readActiveWorkspaceRowIds(orcaPage), {
          message: `press ${press}: the top pane does not show agent ${selected}'s workspace as active`
        })
        .toEqual([workspaceOfAgent[selected]])
      await expect(
        orcaPage.locator(
          `[data-sidebar-workspaces-pane] [role="option"][data-worktree-id="${workspaceOfAgent[selected]}"]`
        )
      ).toBeInViewport()
    }
  })

  test('leaves the cycle chords alone while the Activity pane is collapsed', async ({
    orcaPage
  }) => {
    const [agentA] = await seedAgentsForActivePanes(orcaPage, 1, 'Collapsed agent')
    await showActivityPane(orcaPage)
    await expect(threadRows(orcaPage)).toHaveCount(1)
    await setSidebarChrome(orcaPage, { sidebarOpen: true, activityPaneOpen: false })
    await expect(threadRows(orcaPage)).toHaveCount(0)
    await focusActiveTerminalInput(orcaPage)
    expect(await readActivePaneLeaf(orcaPage)).toBe(agentA.leafId)
    await orcaPage.evaluate(() => {
      window.addEventListener('keydown', (event) => {
        if (event.code === 'Quote') {
          document.body.dataset.cycleChordClaimed = String(event.defaultPrevented)
        }
      })
    })

    await orcaPage.keyboard.press(NEXT_CHORD)

    await expect(orcaPage.locator('body')).toHaveAttribute('data-cycle-chord-claimed', 'false')
  })

  test('toggle collapses and expands the Activity pane and opens a closed sidebar on it', async ({
    orcaPage
  }) => {
    await seedAgentsForActivePanes(orcaPage, 1, 'Toggle agent')
    await showActivityPane(orcaPage)
    await expect(threadRows(orcaPage)).toHaveCount(1)
    await focusActiveTerminalInput(orcaPage)
    const activityHeaderButton = (name: string) =>
      orcaPage.locator('[data-sidebar-activity-header]').getByRole('button', { name, exact: true })

    await orcaPage.keyboard.press(TOGGLE_CHORD)
    await expect(threadRows(orcaPage)).toHaveCount(0)
    await expect(activityHeaderButton('Expand Activity')).toBeVisible()
    await expect(orcaPage.locator('[data-sidebar-workspaces-pane]')).toBeVisible()
    expect(await readSidebarChrome(orcaPage)).toEqual({
      sidebarOpen: true,
      activityPaneOpen: false,
      sidebarBody: 'workspaces'
    })

    await orcaPage.keyboard.press(TOGGLE_CHORD)
    await expect(threadRows(orcaPage)).toHaveCount(1)
    await expect(activityHeaderButton('Collapse Activity')).toBeVisible()

    for (const lastPaneState of [true, false]) {
      await setSidebarChrome(orcaPage, { sidebarOpen: false, activityPaneOpen: lastPaneState })
      await focusActiveTerminalInput(orcaPage)
      await orcaPage.keyboard.press(TOGGLE_CHORD)
      await expect
        .poll(() => readSidebarChrome(orcaPage))
        .toEqual({ sidebarOpen: true, activityPaneOpen: true, sidebarBody: 'workspaces' })
      await expect(threadRows(orcaPage)).toHaveCount(1)
    }
  })
})
