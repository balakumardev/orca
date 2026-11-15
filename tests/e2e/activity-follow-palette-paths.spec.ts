import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import {
  splitActiveTerminalPane,
  waitForActivePaneHookDescriptor,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  switchToOtherWorktree,
  switchToWorktree
} from './helpers/store'
import {
  activateTab,
  focusTerminalPaneAtIndex,
  hookAgent,
  openBlankTerminalTab,
  prepareActivityFollowSession,
  settleRender,
  startAgentThroughHook,
  waitForFocusedAgentPane
} from './helpers/activity-follow-agents'
import {
  readSelectedAgentIndex,
  seedAgentsForActivePanes,
  showActivityPane,
  type SeededAgent
} from './helpers/activity-sidebar'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

type PaletteScenario = {
  agents: SeededAgent[]
  workspaceA: string
  workspaceB: string
  tabIds: { a1: string; a2: string; blank: string; b1: string }
}

// Workspace A holds tab 1 (agent A1), tab 2 (agent A2) and a blank tab 3; workspace B holds one tab (agent B1).
// The app ends on A's blank tab with the highlight left on B1, the last agent it followed.
async function seedPaletteScenario(
  page: Page,
  electronApp: ElectronApplication
): Promise<PaletteScenario> {
  const endpoint = await readHookEndpoint(electronApp)
  const workspaceA = (await getActiveWorktreeId(page))!
  const a1TabId = (await getActiveTabId(page))!
  const [a1] = await seedAgentsForActivePanes(page, 1, 'Palette A1')
  await showActivityPane(page)
  const a2Tab = await openBlankTerminalTab(page)
  const a2 = hookAgent(a2Tab.paneKey, 'palette A2')
  await startAgentThroughHook(page, endpoint, a2, workspaceA)
  const blankTab = await openBlankTerminalTab(page)
  const workspaceB = await switchToOtherWorktree(page, workspaceA)
  expect(workspaceB).not.toBeNull()
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const bPane = await waitForActivePaneHookDescriptor(page)
  const b1 = hookAgent(bPane.paneKey, 'palette B1')
  await startAgentThroughHook(page, endpoint, b1, bPane.worktreeId)
  await switchToWorktree(page, workspaceA)
  await expect.poll(() => getActiveTabId(page)).toBe(blankTab.tabId)
  const agents = [a1, a2, b1]
  await expect.poll(() => readSelectedAgentIndex(page, agents)).toBe(2)
  return {
    agents,
    workspaceA,
    workspaceB: workspaceB!,
    tabIds: { a1: a1TabId, a2: a2Tab.tabId, blank: blankTab.tabId, b1: bPane.paneKey.split(':')[0] }
  }
}

// Native menu accelerators need OS focus, so open the same palette through the store, as the wake spec does.
async function openPalette(page: Page): Promise<Locator> {
  await page.evaluate(() => window.__store?.getState().openModal('worktree-palette'))
  const dialog = page.getByRole('dialog', { name: 'Jump to...' })
  await expect(dialog).toBeVisible()
  return dialog
}

// A palette row's value ends with the id of the tab it opens.
function tabRow(dialog: Locator, tabId: string): Locator {
  return dialog.locator(`[cmdk-item][data-value$="${tabId}"]`)
}

async function pickRow(dialog: Locator, row: Locator): Promise<void> {
  await expect(row).toBeVisible()
  await row.click()
  await expect(dialog).toBeHidden()
}

test.describe('Activity highlight follows the Cmd+J palette', () => {
  test.beforeEach(async ({ orcaPage }) => {
    const hasPaneManager = await prepareActivityFollowSession(orcaPage)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager, so no agent can be started in a tab.'
    )
  })

  test('a tab row in the same workspace moves the highlight, and a tab without an agent keeps it', async ({
    orcaPage,
    electronApp
  }) => {
    const { agents, tabIds } = await seedPaletteScenario(orcaPage, electronApp)

    let dialog = await openPalette(orcaPage)
    await pickRow(dialog, tabRow(dialog, tabIds.a2))
    await waitForFocusedAgentPane(orcaPage, agents[1])
    await settleRender(orcaPage)
    expect(await readSelectedAgentIndex(orcaPage, agents)).toBe(1)

    dialog = await openPalette(orcaPage)
    await pickRow(dialog, tabRow(dialog, tabIds.a1))
    await waitForFocusedAgentPane(orcaPage, agents[0])
    await settleRender(orcaPage)
    expect(await readSelectedAgentIndex(orcaPage, agents)).toBe(0)

    // The blank tab only shows up when searched for.
    dialog = await openPalette(orcaPage)
    await dialog.getByRole('combobox').fill('Terminal 3')
    await pickRow(dialog, tabRow(dialog, tabIds.blank))
    await expect.poll(() => getActiveTabId(orcaPage)).toBe(tabIds.blank)
    await settleRender(orcaPage)
    expect(await readSelectedAgentIndex(orcaPage, agents)).toBe(0)
  })

  test('a tab row and a workspace row in another workspace move the highlight', async ({
    orcaPage,
    electronApp
  }) => {
    const { agents, workspaceA, workspaceB, tabIds } = await seedPaletteScenario(
      orcaPage,
      electronApp
    )
    await activateTab(orcaPage, tabIds.a2)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(1)

    // Workspace and tab change in one pick.
    let dialog = await openPalette(orcaPage)
    await pickRow(dialog, tabRow(dialog, tabIds.b1))
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(workspaceB)
    await waitForFocusedAgentPane(orcaPage, agents[2])
    await settleRender(orcaPage)
    expect(await readSelectedAgentIndex(orcaPage, agents)).toBe(2)

    // The workspace row opens the tab that workspace was last on.
    // The branch name depends on the machine's git defaults (main here, master on CI), so read it.
    const workspaceAName = await orcaPage.evaluate(
      (id) =>
        Object.values(window.__store?.getState().worktreesByRepo ?? {})
          .flat()
          .find((worktree) => worktree.id === id)?.displayName,
      workspaceA
    )
    expect(workspaceAName).toBeTruthy()
    dialog = await openPalette(orcaPage)
    const workspaceRow = dialog.locator('[cmdk-item][data-value^="8:worktree"]').filter({
      hasText: workspaceAName
    })
    await pickRow(dialog, workspaceRow)
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(workspaceA)
    await waitForFocusedAgentPane(orcaPage, agents[1])
    await settleRender(orcaPage)
    expect(await readSelectedAgentIndex(orcaPage, agents)).toBe(1)
  })

  test('the Cmd+digit jumps follow, in the palette and on the workspace list', async ({
    orcaPage,
    electronApp
  }) => {
    const { agents, workspaceA, workspaceB, tabIds } = await seedPaletteScenario(
      orcaPage,
      electronApp
    )
    const sendDigit = (index: number): Promise<void> =>
      electronApp.evaluate(({ BrowserWindow }, index) => {
        // The channel the main process sends when Cmd+digit is pressed.
        BrowserWindow.getAllWindows()[0].webContents.send('ui:jumpToWorktreeIndex', index)
      }, index)
    const agentIndexByTabId = new Map([
      [tabIds.a1, 0],
      [tabIds.a2, 1],
      [tabIds.b1, 2]
    ])

    // With the palette open the digit picks the nth recent row. Take the first row that opens an
    // agent other than the highlighted one, so the pick has to move the highlight.
    for (let pick = 0; pick < 2; pick += 1) {
      const dialog = await openPalette(orcaPage)
      const rowValues = await dialog
        .locator('[cmdk-item][data-value^="13:workspace-tab"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-value') ?? ''))
      const highlighted = await readSelectedAgentIndex(orcaPage, agents)
      const rowAgents = rowValues.map(
        (value) => [...agentIndexByTabId].find(([tabId]) => value.endsWith(tabId))?.[1]
      )
      const digit = rowAgents.findIndex((agent) => agent !== undefined && agent !== highlighted)
      expect(digit).toBeGreaterThanOrEqual(0)
      const expectedAgent = rowAgents[digit]!
      await sendDigit(digit)
      await expect(dialog).toBeHidden()
      await waitForFocusedAgentPane(orcaPage, agents[expectedAgent])
      await settleRender(orcaPage)
      expect(await readSelectedAgentIndex(orcaPage, agents)).toBe(expectedAgent)
    }

    // With the palette closed the digit jumps to the nth workspace in the list.
    await switchToWorktree(orcaPage, workspaceA)
    await activateTab(orcaPage, tabIds.a1)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(0)
    const listedWorkspaces = await orcaPage
      .locator('[data-sidebar-workspaces-pane] [role="option"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-worktree-id') ?? ''))
    const workspaceBIndex = listedWorkspaces.indexOf(workspaceB)
    expect(workspaceBIndex).toBeGreaterThanOrEqual(0)
    await sendDigit(workspaceBIndex)
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(workspaceB)
    await waitForFocusedAgentPane(orcaPage, agents[2])
    await settleRender(orcaPage)
    expect(await readSelectedAgentIndex(orcaPage, agents)).toBe(2)
  })

  test('a split tab: the palette lands on its stored pane and the highlight goes to the tab’s one running agent', async ({
    orcaPage,
    electronApp
  }) => {
    const endpoint = await readHookEndpoint(electronApp)
    const workspaceA = (await getActiveWorktreeId(orcaPage))!
    await showActivityPane(orcaPage)
    // Tab 1 has two panes; only the second runs an agent.
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const split = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const running = hookAgent(`${split.tabId}:${split.panes[1].leafId}`, 'split running')
    await startAgentThroughHook(orcaPage, endpoint, running, workspaceA)
    // Tab 2 holds another agent and takes over, so the highlight is somewhere else.
    const otherTab = await openBlankTerminalTab(orcaPage)
    const other = hookAgent(otherTab.paneKey, 'split other')
    await startAgentThroughHook(orcaPage, endpoint, other, workspaceA)
    const agents = [running, other]
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(1)

    // Leave tab 1 with its first pane (no agent) as the stored focus.
    await activateTab(orcaPage, split.tabId)
    const firstLeaf = await focusTerminalPaneAtIndex(orcaPage, split.tabId, 0)
    await activateTab(orcaPage, otherTab.tabId)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(1)

    let dialog = await openPalette(orcaPage)
    await pickRow(dialog, tabRow(dialog, split.tabId))
    await expect.poll(() => getActiveTabId(orcaPage)).toBe(split.tabId)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(0)
    // Highlight only: the pane that has focus is still the tab's stored one.
    expect(
      await orcaPage.evaluate(
        (tabId) => window.__store?.getState().terminalLayoutsByTabId[tabId]?.activeLeafId,
        split.tabId
      )
    ).toBe(firstLeaf)

    // A finished agent in the focused pane does not outrank the running one beside it.
    await orcaPage.evaluate(
      ({ paneKey }) =>
        window.__store
          ?.getState()
          .setAgentStatus(
            paneKey,
            { state: 'done', prompt: 'SNAPSHOT_PROMPT', agentType: 'codex' },
            'Snapshot pane',
            { updatedAt: Date.now() - 1_000, stateStartedAt: Date.now() - 1_000 }
          ),
      { paneKey: `${split.tabId}:${firstLeaf}` }
    )
    await activateTab(orcaPage, otherTab.tabId)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(1)
    dialog = await openPalette(orcaPage)
    await pickRow(dialog, tabRow(dialog, split.tabId))
    await expect.poll(() => getActiveTabId(orcaPage)).toBe(split.tabId)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(0)
  })

  test('a split tab with two running agents and a focused pane without one keeps the highlight', async ({
    orcaPage,
    electronApp
  }) => {
    const endpoint = await readHookEndpoint(electronApp)
    const workspaceA = (await getActiveWorktreeId(orcaPage))!
    await showActivityPane(orcaPage)
    const crowded = await openBlankTerminalTab(orcaPage)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 3)
    const panes = (await waitForPaneIdentitySnapshot(orcaPage, 3)).panes
    const agentOne = hookAgent(`${crowded.tabId}:${panes[1].leafId}`, 'crowded one')
    const agentTwo = hookAgent(`${crowded.tabId}:${panes[2].leafId}`, 'crowded two')
    await startAgentThroughHook(orcaPage, endpoint, agentOne, workspaceA)
    await startAgentThroughHook(orcaPage, endpoint, agentTwo, workspaceA)
    const otherTab = await openBlankTerminalTab(orcaPage)
    const other = hookAgent(otherTab.paneKey, 'crowded other')
    await startAgentThroughHook(orcaPage, endpoint, other, workspaceA)
    const agents = [agentOne, agentTwo, other]
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(2)

    await activateTab(orcaPage, crowded.tabId)
    await focusTerminalPaneAtIndex(orcaPage, crowded.tabId, 0)
    await activateTab(orcaPage, otherTab.tabId)
    const dialog = await openPalette(orcaPage)
    await pickRow(dialog, tabRow(dialog, crowded.tabId))
    await expect.poll(() => getActiveTabId(orcaPage)).toBe(crowded.tabId)
    await settleRender(orcaPage)
    expect(await readSelectedAgentIndex(orcaPage, agents)).toBe(2)
  })
})
