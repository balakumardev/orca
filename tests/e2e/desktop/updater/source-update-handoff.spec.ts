import { expect, type ElectronApplication } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { RuntimeClient } from '../../../../src/cli/runtime/client'
import { PROTOCOL_VERSION } from '../../../../src/main/daemon/protocol/daemon-protocol-version'
import { parseDaemonPidFile } from '../../../../src/main/daemon/endpoint/identity/daemon-pid-file-parse'
import type { SourceUpdateHandoffResult } from '../../../../src/main/updater/custom/source-update-handoff'
import { quotePosixShell } from '../../../../src/shared/shell/launch/shell-argument-quoting'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../src/shared/terminal/pty/lifecycle/pty-session-id-format'
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

const execFileAsync = promisify(execFile)
const PROCESS_QUERY_TIMEOUT_MS = 5_000
const PROCESS_QUERY_MAX_BYTES = 8 * 1024 * 1024

const processQueryOptions = {
  encoding: 'utf8' as const,
  timeout: PROCESS_QUERY_TIMEOUT_MS,
  maxBuffer: PROCESS_QUERY_MAX_BYTES,
  windowsHide: true
}

type RecordedProcessIdentity = {
  pid: number
  startedAtMs: number
}

type ProcessRow = RecordedProcessIdentity & {
  parentPid: number
}

async function waitForCondition(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (await predicate()) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function readWindowsProcessRows(): Promise<ProcessRow[]> {
  const command = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);',
    '$rows = Get-CimInstance Win32_Process | ForEach-Object {',
    '  [PSCustomObject]@{',
    '    pid = [int]$_.ProcessId;',
    '    parentPid = [int]$_.ParentProcessId;',
    "    startedAt = if ($null -eq $_.CreationDate) { $null } else { $_.CreationDate.ToUniversalTime().ToString('O', [System.Globalization.CultureInfo]::InvariantCulture) }",
    '  }',
    '};',
    '$rows | ConvertTo-Json -Compress'
  ].join(' ')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    processQueryOptions
  )
  const parsed = JSON.parse(stdout || '[]') as
    | { pid?: unknown; parentPid?: unknown; startedAt?: unknown }
    | { pid?: unknown; parentPid?: unknown; startedAt?: unknown }[]
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((row) => {
    const pid = Number(row.pid)
    const parentPid = Number(row.parentPid)
    const startedAtMs = typeof row.startedAt === 'string' ? Date.parse(row.startedAt) : Number.NaN
    return Number.isInteger(pid) && Number.isInteger(parentPid) && Number.isFinite(startedAtMs)
      ? [{ pid, parentPid, startedAtMs }]
      : []
  })
}

async function readPosixProcessRows(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,lstart='], {
    ...processQueryOptions,
    // Why: start identity must not depend on a CI host's locale or timezone.
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC0' }
  })
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) {
      return []
    }
    const startedAtMs = Date.parse(`${match[3]} UTC`)
    return Number.isFinite(startedAtMs)
      ? [{ pid: Number(match[1]), parentPid: Number(match[2]), startedAtMs }]
      : []
  })
}

async function readProcessRows(): Promise<ProcessRow[]> {
  return process.platform === 'win32' ? readWindowsProcessRows() : readPosixProcessRows()
}

async function recordProcessIdentity(pid: number): Promise<RecordedProcessIdentity> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Cannot record invalid fixture pid ${pid}`)
  }
  const row = (await readProcessRows()).find((candidate) => candidate.pid === pid)
  if (!row) {
    throw new Error(`Could not record process-start identity for fixture pid ${pid}`)
  }
  return { pid, startedAtMs: row.startedAtMs }
}

async function processIdentityIsAlive(identity: RecordedProcessIdentity): Promise<boolean> {
  const current = (await readProcessRows()).find((row) => row.pid === identity.pid)
  return current !== undefined && current.startedAtMs === identity.startedAtMs
}

async function processIdentityLiveness(
  identities: readonly RecordedProcessIdentity[]
): Promise<Map<number, boolean>> {
  const rowsByPid = new Map((await readProcessRows()).map((row) => [row.pid, row]))
  return new Map(
    identities.map((identity) => {
      const current = rowsByPid.get(identity.pid)
      return [identity.pid, current !== undefined && current.startedAtMs === identity.startedAtMs]
    })
  )
}

async function recordProcessTree(
  root: RecordedProcessIdentity
): Promise<RecordedProcessIdentity[]> {
  const rows = await readProcessRows()
  const currentRoot = rows.find((row) => row.pid === root.pid)
  if (!currentRoot || currentRoot.startedAtMs !== root.startedAtMs) {
    throw new Error(`Fixture root pid ${root.pid} changed incarnation before tree capture`)
  }

  const childrenByParent = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.parentPid) ?? []
    children.push(row)
    childrenByParent.set(row.parentPid, children)
  }
  const recorded: RecordedProcessIdentity[] = [root]
  const pending = [...(childrenByParent.get(root.pid) ?? [])]
  while (pending.length > 0) {
    const row = pending.pop()
    if (!row) {
      continue
    }
    recorded.push({ pid: row.pid, startedAtMs: row.startedAtMs })
    pending.push(...(childrenByParent.get(row.pid) ?? []))
  }
  return recorded
}

async function terminateRecordedProcess(identity: RecordedProcessIdentity): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/pid', String(identity.pid), '/f'], processQueryOptions)
    } else {
      process.kill(identity.pid, 'SIGKILL')
    }
    return true
  } catch {
    // The exact process incarnation may exit between validation and signalling.
    return false
  }
}

/** Resolves to whether cleanup actually signalled a recorded process. */
async function terminateRecordedTree(identities: RecordedProcessIdentity[]): Promise<boolean> {
  const unique = [...new Map(identities.map((identity) => [identity.pid, identity])).values()]
  let signalled = false
  for (const identity of unique.toReversed()) {
    // Revalidate start identity before cleanup so PID reuse cannot authorize signalling an unrelated process.
    if (!(await processIdentityIsAlive(identity))) {
      continue
    }
    signalled = (await terminateRecordedProcess(identity)) || signalled
  }
  await waitForCondition(
    'recorded fixture process tree to be absent',
    async () => {
      const liveness = await processIdentityLiveness(unique)
      return unique.every((identity) => !liveness.get(identity.pid))
    },
    5_000
  )
  return signalled
}

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
