import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test } from './desktop/electron-fixtures/orca-app'
import {
  emitCodexHookStatus,
  readHookEndpoint
} from './agents/session-fixtures/agent-hook-endpoint'
import { focusActiveTerminalInput } from './terminal/input/terminal'
import { waitForActivePaneHookDescriptor } from './terminal/input/terminal-active-pane'
import {
  focusLastTerminalPane,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './terminal/layout/terminal-pane-operations'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  switchToOtherWorktree,
  switchToWorktree
} from './desktop/renderer-probes/store'
import {
  activateTab,
  clickRow,
  hookAgent,
  openBlankTerminalTab,
  prepareActivityFollowSession,
  readHighlightLog,
  rowFor,
  selectedRow,
  settleRender,
  startAgentThroughHook,
  startHighlightLog,
  waitForFocusedAgentPane
} from './helpers/activity-follow-agents'
import {
  readSelectedAgentIndex,
  seedAgentsForActivePanes,
  showActivityPane,
  threadRows,
  type SeededAgent
} from './helpers/activity-sidebar'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

const NEXT_CHORD = 'ControlOrMeta+Shift+Quote'

// An agent row with no terminal tab behind it: the workspace can be opened, but no pane can take focus. It has to be
// live: a finished local agent whose tab is gone is no longer listed at all.
async function seedRetainedAgentInWorkspace(page: Page, prompt: string): Promise<SeededAgent> {
  const paneKey = await page.evaluate((prompt) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (!state || !worktreeId) {
      throw new Error('No active workspace for the retained agent')
    }
    // A tab id that was never created here: a closed tab's id is refused by the status slice.
    const paneKey = `${crypto.randomUUID()}:${crypto.randomUUID()}`
    const startedAt = Date.now() - 5_000
    state.setAgentStatus(
      paneKey,
      {
        state: 'working',
        prompt,
        agentType: 'codex',
        lastAssistantMessage: 'Working on without a tab.'
      },
      'Retained agent',
      { updatedAt: startedAt, stateStartedAt: startedAt },
      { worktreeId }
    )
    return paneKey
  }, prompt)
  return { paneKey, leafId: paneKey.split(':')[1], title: 'Retained agent', prompt }
}

test.describe('Activity highlight follows the active agent', () => {
  test.beforeEach(async ({ orcaPage }) => {
    const hasPaneManager = await prepareActivityFollowSession(orcaPage)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager, so no agent can be started in a tab.'
    )
  })

  test('follows an agent started in a new tab and tab switches, and ignores a background start', async ({
    orcaPage,
    electronApp
  }) => {
    const endpoint = await readHookEndpoint(electronApp)
    const workspaceA = (await getActiveWorktreeId(orcaPage))!
    const firstTabId = (await getActiveTabId(orcaPage))!
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const seeded = await seedAgentsForActivePanes(orcaPage, 2, 'Follow seed')
    await showActivityPane(orcaPage)
    await expect(threadRows(orcaPage)).toHaveCount(2)

    // A manual click highlights its row, as before.
    await clickRow(orcaPage, seeded[0])
    await expect.poll(() => readSelectedAgentIndex(orcaPage, seeded)).toBe(0)

    // The owner's report: a new tab, then an agent started in it.
    const blankTab = await openBlankTerminalTab(orcaPage)
    // A tab without an agent keeps the highlight where it was.
    expect(await readSelectedAgentIndex(orcaPage, seeded)).toBe(0)
    const started = hookAgent(blankTab.paneKey, 'new tab')
    const everyAgent = [...seeded, started]
    await startAgentThroughHook(orcaPage, endpoint, started, workspaceA)
    await expect
      .poll(() => readSelectedAgentIndex(orcaPage, everyAgent), {
        message: 'the Activity highlight did not move to the agent started in the active tab'
      })
      .toBe(2)

    // Switching tabs: the highlight goes back to the focused pane's agent, then to the new tab's.
    await activateTab(orcaPage, firstTabId)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, everyAgent)).toBe(0)
    // Two agents in one tab: the highlight follows the pane that has focus.
    await focusLastTerminalPane(orcaPage)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, everyAgent)).toBe(1)
    await activateTab(orcaPage, blankTab.tabId)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, everyAgent)).toBe(2)

    // An agent that starts in another workspace, which is in the background, does not take the highlight.
    const workspaceB = await switchToOtherWorktree(orcaPage, workspaceA)
    expect(workspaceB).not.toBeNull()
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const backgroundPane = await waitForActivePaneHookDescriptor(orcaPage)
    await switchToWorktree(orcaPage, workspaceA)
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(workspaceA)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, everyAgent)).toBe(2)
    const background = hookAgent(backgroundPane.paneKey, 'background workspace')
    await startAgentThroughHook(orcaPage, endpoint, background, backgroundPane.worktreeId)
    await settleRender(orcaPage)
    expect(await readSelectedAgentIndex(orcaPage, [...everyAgent, background])).toBe(2)
  })

  test('scrolls the followed row into view and opens its collapsed group', async ({
    orcaPage,
    electronApp
  }) => {
    const endpoint = await readHookEndpoint(electronApp)
    const workspaceA = (await getActiveWorktreeId(orcaPage))!
    const [seed] = await seedAgentsForActivePanes(orcaPage, 1, 'Scroll seed')
    const firstTabId = (await getActiveTabId(orcaPage))!
    // Enough older rows to overflow the pane, so the newest row sits above the fold once the list is scrolled down.
    await orcaPage.evaluate(
      ({ firstTabId }) => {
        const state = window.__store?.getState()
        const now = Date.now()
        for (let index = 0; index < 14; index += 1) {
          const startedAt = now - (index + 2) * 60_000
          state?.setAgentStatus(
            `${firstTabId}:${crypto.randomUUID()}`,
            { state: 'done', prompt: `FILLER_${index}`, agentType: 'codex' },
            `Filler ${index}`,
            { updatedAt: startedAt, stateStartedAt: startedAt }
          )
        }
        state?.setAgentsGroupBy('none')
      },
      { firstTabId }
    )
    await showActivityPane(orcaPage)
    await clickRow(orcaPage, seed)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, [seed])).toBe(0)
    const scroller = orcaPage.locator('[data-activity-virtual-list]').locator('xpath=..')
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(200)

    const blankTab = await openBlankTerminalTab(orcaPage)
    const started = hookAgent(blankTab.paneKey, 'scrolled')
    await emitCodexHookStatus(endpoint, {
      paneKey: started.paneKey,
      worktreeId: workspaceA,
      state: 'working',
      prompt: started.prompt
    })
    await expect(selectedRow(orcaPage)).toContainText(started.prompt)
    await expect(selectedRow(orcaPage)).toBeInViewport({ ratio: 0.99 })

    // Group the list by status and collapse the group that holds the followed row; a second tab's agent joins it.
    await orcaPage.evaluate(() => window.__store?.getState().setAgentsGroupBy('status'))
    const workingHeader = orcaPage
      .locator('[data-activity-sticky-header]')
      .filter({ hasText: 'Working' })
    await expect(workingHeader).toBeVisible()
    await workingHeader
      .getByRole('button')
      .first()
      .evaluate((button) => {
        if (button instanceof HTMLElement) {
          button.click()
        }
      })
    await expect(rowFor(orcaPage, started)).toHaveCount(0)
    const second = await openBlankTerminalTab(orcaPage)
    const secondAgent = hookAgent(second.paneKey, 'collapsed group')
    await emitCodexHookStatus(endpoint, {
      paneKey: secondAgent.paneKey,
      worktreeId: workspaceA,
      state: 'working',
      prompt: secondAgent.prompt
    })
    await expect(selectedRow(orcaPage)).toContainText(secondAgent.prompt)
    await expect(selectedRow(orcaPage)).toBeInViewport({ ratio: 0.99 })
  })

  test('click and cycle chords keep their row, without a flash of the pane they pass through', async ({
    orcaPage
  }) => {
    const firstTabId = (await getActiveTabId(orcaPage))!
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const seeded = await seedAgentsForActivePanes(orcaPage, 2, 'Chord seed')
    await showActivityPane(orcaPage)
    await expect(threadRows(orcaPage)).toHaveCount(2)
    // Pane 0 is the tab's last focused pane when the user comes back to it.
    await clickRow(orcaPage, seeded[0])
    await expect.poll(() => readSelectedAgentIndex(orcaPage, seeded)).toBe(0)
    await openBlankTerminalTab(orcaPage)
    await startHighlightLog(orcaPage)

    // Selecting pane 1 re-activates the tab while its stored focus is still pane 0.
    await clickRow(orcaPage, seeded[1])
    await expect.poll(() => getActiveTabId(orcaPage)).toBe(firstTabId)
    await waitForFocusedAgentPane(orcaPage, seeded[1])
    await settleRender(orcaPage)
    expect(await readSelectedAgentIndex(orcaPage, seeded)).toBe(1)
    expect(await readHighlightLog(orcaPage, seeded)).toEqual([1])

    // The chord does the same from a tab that has no agent.
    await openBlankTerminalTab(orcaPage)
    await focusActiveTerminalInput(orcaPage)
    await startHighlightLog(orcaPage)
    await orcaPage.keyboard.press(NEXT_CHORD)
    await waitForFocusedAgentPane(orcaPage, seeded[0])
    await settleRender(orcaPage)
    const afterChord = await readSelectedAgentIndex(orcaPage, seeded)
    expect(afterChord).toBe(0)
    expect(await readHighlightLog(orcaPage, seeded)).toEqual([0])
  })

  test('a click on a row whose tab is gone keeps that row, though the workspace it opens has an agent focused', async ({
    orcaPage
  }) => {
    const workspaceA = (await getActiveWorktreeId(orcaPage))!
    const [agentA] = await seedAgentsForActivePanes(orcaPage, 1, 'Retained home')
    const workspaceB = await switchToOtherWorktree(orcaPage, workspaceA)
    expect(workspaceB).not.toBeNull()
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneCount(orcaPage, 1, 30_000)
    const [agentB] = await seedAgentsForActivePanes(orcaPage, 1, 'Retained away')
    const retained = await seedRetainedAgentInWorkspace(orcaPage, `RETAINED_PROMPT_${Date.now()}`)
    const agents = [agentA, agentB, retained]
    await switchToWorktree(orcaPage, workspaceA)
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(workspaceA)
    await showActivityPane(orcaPage)
    await expect(threadRows(orcaPage)).toHaveCount(3)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(0)
    await startHighlightLog(orcaPage)

    await clickRow(orcaPage, retained)

    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(workspaceB)
    await waitForFocusedAgentPane(orcaPage, agentB)
    await settleRender(orcaPage)
    expect(await readSelectedAgentIndex(orcaPage, agents)).toBe(2)
    expect(await readHighlightLog(orcaPage, agents)).toEqual([2])
  })
})
