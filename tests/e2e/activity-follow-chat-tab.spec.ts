import { expect } from './desktop/electron-fixtures/orca-app'
import { readHookEndpoint } from './agents/session-fixtures/agent-hook-endpoint'
import { SUPPORTED, openStubChat, test } from './agents/session-fixtures/structured-claude-stub'
import { getActiveTabType, getActiveWorktreeId } from './desktop/renderer-probes/store'
import {
  activateTab,
  hookAgent,
  openBlankTerminalTab,
  startAgentThroughHook
} from './helpers/activity-follow-agents'
import { readSelectedAgentIndex, showActivityPane } from './helpers/activity-sidebar'

test.describe('Activity highlight follows a native chat tab', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('moves to the chat when its tab opens, from the tab strip or Cmd+J, and back to a terminal agent', async ({
    orcaPage,
    electronApp,
    claudeStub
  }) => {
    const endpoint = await readHookEndpoint(electronApp)
    const workspace = (await getActiveWorktreeId(orcaPage))!
    const chat = await openStubChat(orcaPage, claudeStub.command)
    const chatTabId = (await chat.tab.getAttribute('data-tab-id'))!
    await chat.composer.fill('hello activity')
    await chat.send.click()
    await expect(chat.reply).toBeVisible({ timeout: 30_000 })
    await showActivityPane(orcaPage)
    const chatAgent = {
      paneKey: '',
      leafId: '',
      title: 'hello activity',
      prompt: 'hello activity'
    }
    await expect.poll(() => readSelectedAgentIndex(orcaPage, [chatAgent])).toBe(0)

    // A terminal agent in a new tab takes the highlight; the chat tab brings it back.
    const terminalTab = await openBlankTerminalTab(orcaPage)
    const terminalAgent = hookAgent(terminalTab.paneKey, 'chat neighbour')
    await startAgentThroughHook(orcaPage, endpoint, terminalAgent, workspace)
    const agents = [chatAgent, terminalAgent]
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(1)
    await chat.tab.click()
    await expect.poll(() => getActiveTabType(orcaPage)).toBe('agent-session')
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(0)

    // The same through the Cmd+J palette.
    await activateTab(orcaPage, terminalTab.tabId)
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(1)
    await orcaPage.evaluate(() => window.__store?.getState().openModal('worktree-palette'))
    const dialog = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    await expect(dialog).toBeVisible()
    await dialog.locator(`[cmdk-item][data-value$="${chatTabId}"]`).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => getActiveTabType(orcaPage)).toBe('agent-session')
    await expect.poll(() => readSelectedAgentIndex(orcaPage, agents)).toBe(0)
  })
})
