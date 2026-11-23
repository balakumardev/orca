import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from '@stablyai/playwright-test'
import { test } from './desktop/electron-fixtures/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './remote/paired-runtime/client-hosts/paired-electron-client'
import { waitForSessionReady } from './desktop/renderer-probes/store'

test.use({ seedTestRepo: false })

test('opens a same-path Cmd+J folder only on the selected paired computer', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  // Allow two cold Electron startups, pairing, and shutdown on slower CI machines.
  test.setTimeout(180_000)
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-remote-folder-jump-')))
  registerPostElectronShutdownCleanup(async () => rmSync(root, { recursive: true, force: true }))
  const folder = path.join(root, 'cmdj-owned-folder')
  mkdirSync(folder)
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(
    (searchRoot) =>
      window.__store!.getState().updateSettingsOrThrow({ folderSearchLocations: [searchRoot] }),
    root
  )
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(offer, testInfo, 'Folder search server')
    const page = client.page
    await page.setViewportSize({ width: 1280, height: 800 })
    // Independent profiles see the same disk path; the selected authority must own the add.
    await page.evaluate(async (searchRoot) => {
      await window
        .__store!.getState()
        .updateSettingsOrThrow({ folderSearchLocations: [searchRoot] })
      window.__store!.setState({
        workspaceHostScope: 'all',
        visibleWorkspaceHostIds: null,
        filterRepoIds: []
      })
      window.__store!.getState().openModal('worktree-palette')
    }, root)

    const palette = page.getByRole('dialog', { name: 'Jump to...' })
    await expect(palette).toBeVisible()
    await palette.locator('[cmdk-input]').fill('cmdj-owned-folder')
    const rows = palette.locator('[cmdk-item]:has([data-folder-search-kind="folder"])')
    await expect(rows).toHaveCount(2)
    const remote = rows.filter({ hasText: 'Folder search server' })
    await expect(remote).toHaveCount(1)
    const screenshot = testInfo.outputPath('same-path-folder-hosts.png')
    await palette.screenshot({ path: screenshot, animations: 'disabled' })
    await testInfo.attach('same-path-folder-hosts', { path: screenshot, contentType: 'image/png' })

    await remote.click()
    await expect(palette).toHaveCount(0)
    await expect
      .poll(() =>
        orcaPage.evaluate(async () => (await window.api.repos.list()).map((repo) => repo.path))
      )
      .toEqual([folder])
    expect(
      await page.evaluate(async () => (await window.api.repos.list()).map((repo) => repo.path))
    ).toEqual([])
    await expect(
      page
        .locator('[data-worktree-sidebar]')
        .getByText('cmdj-owned-folder', { exact: true })
        .first()
    ).toBeVisible()
  } finally {
    await client?.dispose()
  }
})
