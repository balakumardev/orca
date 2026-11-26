import { expect, type ElectronApplication } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RuntimeClient } from '../../../../src/cli/runtime/client'
import { PROTOCOL_VERSION } from '../../../../src/main/daemon/protocol/daemon-protocol-version'
import { parseDaemonPidFile } from '../../../../src/main/daemon/endpoint/identity/daemon-pid-file-parse'
import type { SourceUpdateHandoffResult } from '../../../../src/main/updater/custom/source-update-handoff'
import { quotePosixShell } from '../../../../src/shared/shell/launch/shell-argument-quoting'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../src/shared/terminal/pty/lifecycle/pty-session-id-format'
import {
  processIdentityIsAlive,
  recordProcessIdentity,
  recordProcessTree,
  terminateRecordedTree,
  type RecordedProcessIdentity
} from '../daemon-lifecycle/daemon-generation-processes'
import { waitForExit } from '../electron-fixtures/electron-process-shutdown'
import { test } from '../electron-fixtures/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from '../electron-fixtures/orca-restart'
import { ensureTerminalVisible, waitForSessionReady } from '../renderer-probes/store'
import {
  expectTerminalAccessibilityText,
  readTerminalAccessibilityText
} from '../../terminal/input/terminal-accessibility-tree'
import { waitForActivePanePtyId } from '../../terminal/input/terminal'
import { readPaneIdentitySnapshot } from '../../terminal/layout/terminal-pane-identity'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForPaneCount
} from '../../terminal/layout/terminal-pane-operations'

function readEvidence(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
}

test('source-update quit preserves the running terminal and output produced while Electron is absent', async ({
  testRepoPath
}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'Source-update handoff is macOS-only')
  test.setTimeout(300_000)
  const session = createRestartSession(testInfo, {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_SOURCE_UPDATE_HANDOFF: '1'
  })
  let app: ElectronApplication | undefined
  const recordedProcesses: RecordedProcessIdentity[] = []
  try {
    const evidenceDir = path.join(session.userDataDir, 'handoff-evidence')
    mkdirSync(evidenceDir)
    const scriptPath = path.join(evidenceDir, 'persistent-shell.sh')
    const nonce = randomUUID().replaceAll('-', '').slice(0, 16)
    // The file gate makes the second PTY output impossible before the app has actually exited.
    writeFileSync(
      scriptPath,
      `#!/bin/sh
set -eu
evidence_dir=$1
nonce=$2
stty -echo
trap 'stty echo' EXIT
printf '\\033[2J\\033[HREADY:%s:%s\\n' "$nonce" "$$"
printf '%s\\n' "$$" > "$evidence_dir/child.pid"
while [ ! -f "$evidence_dir/app-exited" ]; do sleep 0.1; done
printf 'ABSENT:%s:%s\\n' "$nonce" "$$"
printf '%s\\n' "$$" > "$evidence_dir/absent.pid"
while IFS= read -r request; do
  printf 'REATTACHED:%s:%s:%s\\n' "$nonce" "$$" "$request"
done
`
    )

    const first = await session.launch()
    app = first.app
    await first.page.setViewportSize({ width: 1440, height: 900 })
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    await waitForSessionReady(first.page)
    await ensureTerminalVisible(first.page)
    await waitForActiveTerminalManager(first.page)
    await waitForPaneCount(first.page, 1)
    const ptyId = await waitForActivePanePtyId(first.page)
    expect(ptyId, 'the terminal must be daemon-backed, not an in-process fallback').toContain(
      PTY_SESSION_ID_SEPARATOR
    )
    const originalPane = await readPaneIdentitySnapshot(first.page)
    if (!originalPane) {
      throw new Error('The initial terminal has no pane identity')
    }
    const { tabId } = originalPane
    await execInTerminal(
      first.page,
      ptyId,
      `/bin/sh ${quotePosixShell(scriptPath)} ${quotePosixShell(evidenceDir)} ${quotePosixShell(nonce)}`
    )
    const childPidPath = path.join(evidenceDir, 'child.pid')
    await expect.poll(() => readEvidence(childPidPath), { timeout: 30_000 }).toMatch(/^[1-9]\d*\n$/)
    const childPid = Number(readEvidence(childPidPath))
    const child = await recordProcessIdentity(childPid)
    recordedProcesses.push(child)
    await expectTerminalAccessibilityText(first.page, tabId, `READY:${nonce}:${childPid}`)
    const daemonPidPath = path.join(
      session.userDataDir,
      'daemon',
      `daemon-v${PROTOCOL_VERSION}.pid`
    )
    const daemonPid = parseDaemonPidFile(readFileSync(daemonPidPath, 'utf8'))?.pid
    if (!daemonPid) {
      throw new Error('The terminal daemon has no valid PID record')
    }
    const daemon = await recordProcessIdentity(daemonPid)
    recordedProcesses.push(...(await recordProcessTree(daemon)))

    const client = new RuntimeClient(session.userDataDir, 30_000, null, null)
    const before = await client.call('status.get')
    const firstProcess = first.app.process()
    const response = await client.call<SourceUpdateHandoffResult>(
      'updater.quitForSourceUpdate',
      null
    )
    expect(response.result).toEqual({ state: 'quitting', pid: firstProcess.pid })
    expect(response._meta.runtimeId).toBe(before._meta.runtimeId)

    // Observe the RPC's own quit; fixture close or signals here would conceal a broken handoff.
    expect(await waitForExit(firstProcess, 30_000), 'handoff did not exit Electron').toBe(true)
    expect(firstProcess.exitCode).toBe(0)
    expect(firstProcess.signalCode).toBeNull()
    expect(await processIdentityIsAlive(daemon), 'quit killed the terminal daemon').toBe(true)
    expect(await processIdentityIsAlive(child), 'quit killed the running shell child').toBe(true)
    writeFileSync(path.join(evidenceDir, 'app-exited'), '')
    await expect
      .poll(() => readEvidence(path.join(evidenceDir, 'absent.pid')), {
        timeout: 15_000,
        message: 'the original shell did not produce output while Electron was absent'
      })
      .toBe(`${childPid}\n`)
    expect(await processIdentityIsAlive(daemon)).toBe(true)
    expect(await processIdentityIsAlive(child)).toBe(true)
    await session.close(first.app)
    app = undefined

    const second = await session.launch()
    app = second.app
    await second.page.setViewportSize({ width: 1440, height: 900 })
    await waitForSessionReady(second.page)
    await waitForActiveTerminalManager(second.page)
    await waitForPaneCount(second.page, 1)
    await expect
      .poll(() => readPaneIdentitySnapshot(second.page))
      .toMatchObject({
        tabId,
        panes: [{ leafId: originalPane.panes[0]!.leafId, ptyId }]
      })
    expect(parseDaemonPidFile(readFileSync(daemonPidPath, 'utf8'))?.pid).toBe(daemonPid)
    expect(await processIdentityIsAlive(daemon)).toBe(true)
    expect(await processIdentityIsAlive(child)).toBe(true)
    await expect(
      second.page.locator(`[data-terminal-tab-id="${tabId}"] .xterm-screen`)
    ).toBeVisible()
    await expectTerminalAccessibilityText(second.page, tabId, `READY:${nonce}:${childPid}`)
    await expectTerminalAccessibilityText(second.page, tabId, `ABSENT:${nonce}:${childPid}`)

    // Repeated probes are harmless input to this reader while restored xterm replay drains.
    const challenge = randomUUID().slice(0, 8)
    await expect
      .poll(
        async () => {
          await second.page.evaluate(
            ({ tabId, challenge }) => {
              const pane = window.__paneManagers?.get(tabId)?.getActivePane()
              if (!pane) {
                throw new Error('The restored terminal pane disappeared')
              }
              pane.terminal.input(`${challenge}\r`, true)
            },
            { tabId, challenge }
          )
          return readTerminalAccessibilityText(second.page, tabId)
        },
        { timeout: 15_000, message: 'the reattached terminal could not reach the original shell' }
      )
      .toContain(`REATTACHED:${nonce}:${childPid}:${challenge}`)
  } finally {
    try {
      await session.dispose(app)
    } finally {
      // Also reap an orphaned child if a regression killed the daemon before fixture cleanup.
      await terminateRecordedTree(recordedProcesses)
    }
  }
})
