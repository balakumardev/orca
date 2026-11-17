import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('folder search locations save through Settings and discover an unregistered non-Git folder', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  await waitForSessionReady(orcaPage)
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const workspace = path.join(home, 'workspace')
  mkdirSync(path.join(workspace, 'ramp-workspace'), { recursive: true })

  // Keep the native dialog hidden while exercising its real IPC handler and the saved settings.
  await electronApp.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, workspace)
  await orcaPage.evaluate(() => window.__store!.getState().openSettingsPage())
  await orcaPage.getByRole('button', { name: /^Workspace folder/ }).click()
  const setting = orcaPage.locator('#general-folder-search-locations')
  await expect(setting.getByText('Home (~)', { exact: true })).toBeVisible()
  await setting.getByRole('button', { name: 'Remove ~', exact: true }).click()
  await expect(setting.getByText('Add a folder to enable folder discovery.')).toBeVisible()
  await setting.getByRole('button', { name: 'Add folders', exact: true }).click()
  await expect(setting.getByText(workspace, { exact: true })).toBeVisible()

  for (const theme of ['light', 'dark'] as const) {
    await orcaPage.evaluate(async (theme) => {
      await window.__store!.getState().updateSettingsOrThrow({ theme })
    }, theme)
    const screenshot = testInfo.outputPath(`folder-search-settings-${theme}.png`)
    await setting.screenshot({ path: screenshot, animations: 'disabled' })
    await testInfo.attach(`folder-search-settings-${theme}`, {
      path: screenshot,
      contentType: 'image/png'
    })
  }

  // Reload hydrates Settings from main again instead of relying on the component's previous state.
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => window.__store!.getState().openSettingsPage())
  await orcaPage.getByRole('button', { name: /^Workspace folder/ }).click()
  await expect(setting.getByText(workspace, { exact: true })).toBeVisible()
  await expect(setting.getByText('Home (~)', { exact: true })).toHaveCount(0)
  await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())

  await orcaPage.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
  const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
  await palette.locator('[cmdk-input]').fill('ramp-workspace')
  const row = palette
    .locator('[cmdk-item]:has([data-folder-search-kind])')
    .filter({ hasText: 'ramp-workspace' })
  await expect(row).toBeVisible()
  const screenshot = testInfo.outputPath('ramp-workspace-discovery.png')
  await palette.screenshot({ path: screenshot, animations: 'disabled' })
  await testInfo.attach('ramp-workspace-discovery', { path: screenshot, contentType: 'image/png' })
})
