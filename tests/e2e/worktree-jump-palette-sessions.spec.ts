import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from '@stablyai/playwright-test'
import { buildFakeAgentCommandOverride } from './agents/session-fixtures/fake-agent-command-override'
import { test as base } from './desktop/electron-fixtures/orca-app'
import { waitForSessionReady } from './desktop/renderer-probes/store'
import { resolveCliCommand } from '../../src/shared/shell/command-resolution/node-cli-command-resolution'

// The Claude stub fixtures used to live in ./agents/session-fixtures/structured-claude-stub.ts; upstream
// deleted that shared test support, so this spec carries the parts it drives.

// Skip Windows until the POSIX stub wrapper has a verified .cmd equivalent.
const SUPPORTED = process.platform !== 'win32'
const STUB_SCRIPT = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'structured-claude-stub.cjs'
)

const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

type ClaudeStub = {
  command: string
  launchLog: string
  /** Each user message the stub was sent, one JSON line per turn. */
  inputLog: string
}

/** Dirs a login shell puts ahead of the launch PATH on macOS (path_helper). */
function macLoginShellPathDirs(): string[] {
  if (process.platform !== 'darwin') {
    return []
  }
  const files = [
    '/etc/paths',
    ...(existsSync('/etc/paths.d') ? readdirSync('/etc/paths.d') : []).map((name) =>
      path.join('/etc/paths.d', name)
    )
  ]
  return files.flatMap((file) => readFileSync(file, 'utf8').split('\n').filter(Boolean))
}

/** Writes the stub `claude` into `dir`; null when a system-wide claude would shadow it on PATH. */
function writeClaudeStub(dir: string): ClaudeStub | null {
  const command = path.join(dir, 'claude')
  const launchLog = path.join(dir, 'launches.jsonl')
  const inputLog = path.join(dir, 'launches-inputs.jsonl')
  const emptyHome = path.join(dir, 'empty-home')
  mkdirSync(emptyHome)
  // Refuse launch if login-shell PATH or fallback install dirs could select real Claude before the stub.
  const shadowing = resolveCliCommand('claude', {
    pathEnv: [...SYSTEM_DIRS, ...macLoginShellPathDirs()].join(path.delimiter),
    homePath: emptyHome
  })
  if (path.isAbsolute(shadowing)) {
    return null
  }
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  writeFileSync(
    command,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(STUB_SCRIPT)} ${quote(launchLog)} "$@"\n`
  )
  chmodSync(command, 0o755)
  return { command, launchLog, inputLog }
}

/** Only the stub's directory and the system tool dirs: no user bin, Homebrew or npm prefix. */
function claudeStubPath(stub: ClaudeStub): string {
  return [path.dirname(stub.command), ...SYSTEM_DIRS].join(path.delimiter)
}

const test = base.extend<{ claudeStub: ClaudeStub }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  claudeStub: async ({}, provideFixture, testInfo) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-structured-claude-'))
    const stub = writeClaudeStub(dir)
    if (!stub) {
      rmSync(dir, { recursive: true, force: true })
      testInfo.skip(true, 'a system-wide claude would shadow the stub')
      return
    }
    await provideFixture(stub)
    rmSync(dir, { recursive: true, force: true })
  },
  launchEnv: async ({ claudeStub }, provideFixture) => {
    await provideFixture({ PATH: claudeStubPath(claudeStub) })
  }
})

test.use({ seedTestRepo: false })
test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

// Neutral fixture transcripts: the first prompt is what a session is titled by, the reply is only searchable.
const KNOWN_SESSION_ID = 'c0ffee00-1111-4222-8333-444455556666'
const KNOWN_TITLE = 'refactor billing exporter'
const UNKNOWN_SESSION_ID = 'c0ffee00-aaaa-4bbb-8ccc-ddddeeeeffff'
const UNKNOWN_TITLE = 'reconcile billing ledger'
const KNOWN_REPLY = 'The quarterly rounding now happens per line item.'
const UNKNOWN_REPLY =
  'The quarterly ledger balances after the import. The quarterly totals match the quarterly report.'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=e2e@test.local', '-c', 'user.name=E2E Test', ...args], {
    cwd,
    stdio: 'pipe'
  })
}

function createGitRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-b', 'main')
  writeFileSync(path.join(repoPath, 'README.md'), '# fixture\n')
  git(repoPath, 'add', '-A')
  git(repoPath, 'commit', '-m', 'Initial commit')
}

function writeTranscript(
  home: string,
  sessionId: string,
  cwd: string,
  prompt: string,
  reply: string
): void {
  const directory = path.join(home, '.claude', 'projects', cwd.replaceAll(/[/.]/g, '-'))
  mkdirSync(directory, { recursive: true })
  const timestamp = new Date().toISOString()
  const records = [
    { type: 'user', sessionId, cwd, timestamp, message: { role: 'user', content: prompt } },
    {
      type: 'assistant',
      sessionId,
      timestamp,
      message: { role: 'assistant', content: reply }
    }
  ]
  writeFileSync(
    path.join(directory, `${sessionId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  )
}

type World = { repoPath: string; worktreeId: string }

/**
 * One registered project named like the typed query, a plain sibling folder, and two Claude transcripts in the
 * profile's own home: one started in the project, one in a folder Orca does not track.
 */
async function seedWorld(
  fixtures: {
    electronApp: ElectronApplication
    orcaPage: Page
    claudeStub: ClaudeStub
    registerPostElectronShutdownCleanup: (cleanup: () => Promise<void>) => void
  },
  options: { enableSearch: boolean }
): Promise<World> {
  const { electronApp, orcaPage, claudeStub, registerPostElectronShutdownCleanup } = fixtures
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-session-jump-')))
  registerPostElectronShutdownCleanup(async () => rmSync(parent, { recursive: true, force: true }))
  const repoPath = path.join(parent, 'billing-exporter')
  createGitRepo(repoPath)
  mkdirSync(path.join(parent, 'billing-notes'))
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  writeTranscript(home, KNOWN_SESSION_ID, repoPath, KNOWN_TITLE, KNOWN_REPLY)
  writeTranscript(
    home,
    UNKNOWN_SESSION_ID,
    path.join(parent, 'billing-unregistered'),
    UNKNOWN_TITLE,
    UNKNOWN_REPLY
  )

  await waitForSessionReady(orcaPage)
  const worktreeId = await orcaPage.evaluate(
    async ({ repoPath, command, searchRoot }) => {
      const store = window.__store!
      // Cmd+J scans only the configured search locations; without this it scans the profile's home, which holds the transcripts.
      await store.getState().updateSettingsOrThrow({ folderSearchLocations: [searchRoot] })
      const repo = await store.getState().addRepoPath(repoPath)
      if (!repo) {
        throw new Error('Could not register the fixture project')
      }
      // The same settings the chat specs use, so a resumed conversation launches the Claude stub.
      await store.getState().updateSettings({
        nativeChatProviders: { claude: true, codex: true },
        defaultTuiAgent: 'claude',
        agentCmdOverrides: { claude: command }
      })
      await store.getState().fetchWorktrees(repo.id)
      const worktree = store.getState().worktreesByRepo[repo.id]?.[0]
      if (!worktree) {
        throw new Error('The fixture project has no workspace')
      }
      return worktree.id
    },
    { repoPath, command: buildFakeAgentCommandOverride(claudeStub.command), searchRoot: parent }
  )
  if (options.enableSearch) {
    // Only this throwaway profile turns it on; the product default stays off.
    await orcaPage.evaluate(() =>
      window.__store!.getState().updateSettingsOrThrow({
        aiVaultSearch: { enabled: true, historyDays: null }
      })
    )
    await expect
      .poll(
        () =>
          orcaPage.evaluate(async () => {
            const status = await window.api.aiVault.searchStatus('local')
            return status.lastSweepCompletedAt !== null && status.filesIndexed >= 2
          }),
        { timeout: 60_000, message: 'the fixture transcripts were not indexed' }
      )
      .toBe(true)
  }
  return { repoPath, worktreeId }
}

async function openPalette(page: Page): Promise<{ palette: Locator; input: Locator }> {
  await page.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
  const palette = page.getByRole('dialog', { name: 'Jump to...' })
  await expect(palette).toBeVisible()
  return { palette, input: palette.locator('[cmdk-input]') }
}

// Session rows carry data-palette-session-agent; workspaces and folders may show the same words.
const sessionRows = (palette: Locator): Locator =>
  palette.locator('[cmdk-item]:has([data-palette-session-agent])')
const folderRows = (palette: Locator): Locator =>
  palette.locator('[cmdk-item]:has([data-folder-search-kind])')

async function arrowToRow(input: Locator, row: Locator): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    if ((await row.getAttribute('aria-selected')) === 'true') {
      return
    }
    await input.press('ArrowDown')
  }
  await expect(row).toHaveAttribute('aria-selected', 'true')
}

const readTabCount = (page: Page, worktreeId: string): Promise<number> =>
  page.evaluate(
    (id) => window.__store!.getState().unifiedTabsByWorktree[id]?.length ?? 0,
    worktreeId
  )

/** True once the Claude stub was started as `claude --resume <sessionId>`, as a terminal resume starts it. */
function stubResumed(launchLog: string, sessionId: string): boolean {
  if (!existsSync(launchLog)) {
    return false
  }
  return readFileSync(launchLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .some((line) => {
      const entry: unknown = JSON.parse(line)
      const args =
        entry && typeof entry === 'object' && 'args' in entry && Array.isArray(entry.args)
          ? entry.args.map(String)
          : []
      const at = args.indexOf('--resume')
      return at !== -1 && args[at + 1] === sessionId
    })
}

/**
 * Type 'quarterly' by the given means, then press Enter. The fixture lists the session whose folder is not in
 * Orca (inert) first and the resumable one after it, so cmdk skips the first row and picks the second by itself.
 * Enter must still do only what it does without this section: open the Create worktree composer.
 */
async function expectTypedEnterOnlyCreates(
  page: Page,
  palette: Locator,
  input: Locator,
  worktreeId: string
): Promise<void> {
  await expect(sessionRows(palette)).toHaveCount(2)
  await expect(sessionRows(palette).first()).toHaveAttribute('aria-disabled', 'true')
  await expect(sessionRows(palette).nth(1)).toHaveAttribute('aria-disabled', 'false')
  await expect(palette.locator('[cmdk-item][aria-selected="true"]')).toContainText(
    'Create worktree'
  )
  const tabsBefore = await readTabCount(page, worktreeId)
  await input.press('Enter')
  await expect
    .poll(() => page.evaluate(() => window.__store!.getState().activeModal))
    .toBe('new-workspace-composer')
  expect(await readTabCount(page, worktreeId)).toBe(tabsBefore)
  await page.keyboard.press('Escape')
}

test('Cmd+J lists transcript hits after Workspaces and Folders and resumes a closed one in its own workspace', async ({
  electronApp,
  orcaPage,
  claudeStub,
  registerPostElectronShutdownCleanup
}) => {
  const { worktreeId } = await seedWorld(
    { electronApp, orcaPage, claudeStub, registerPostElectronShutdownCleanup },
    { enableSearch: true }
  )

  await test.step('shows a Sessions section after the workspace and the folder that match the typed query', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await expect(palette.getByText('Sessions', { exact: true })).toHaveCount(0)
    await input.fill('billing')
    await expect(sessionRows(palette)).toHaveCount(2)
    await expect(folderRows(palette)).toHaveCount(1)
    const workspace = palette
      .locator(
        '[cmdk-item]:not(:has([data-folder-search-kind])):not(:has([data-palette-session-agent]))'
      )
      .filter({ hasText: 'billing-exporter' })
      .first()
    await expect(workspace).toBeVisible()
    const top = async (row: Locator): Promise<number> => (await row.first().boundingBox())!.y
    const [workspaceTop, folderTop, sessionTop] = [
      await top(workspace),
      await top(folderRows(palette)),
      await top(sessionRows(palette))
    ]
    expect(workspaceTop).toBeLessThan(folderTop)
    expect(folderTop).toBeLessThan(sessionTop)
    await expect(palette.getByText('Sessions', { exact: true })).toBeVisible()
    // The matched word is marked in the one-line excerpt of a reply that does not contain the title.
    await input.fill('quarterly')
    await expect(sessionRows(palette)).toHaveCount(2)
    await expect(
      sessionRows(palette).first().locator('[data-palette-session-snippet] mark').first()
    ).toHaveText('quarterly')
    await input.fill('')
    await expect(palette.getByText('Sessions', { exact: true })).toHaveCount(0)
    await orcaPage.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
  })

  await test.step('a typed Enter never opens or resumes a session', async () => {
    const tabsBefore = await readTabCount(orcaPage, worktreeId)
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('quarterly')
    await expect(sessionRows(palette)).toHaveCount(2)
    // Only sessions match: cmdk marks the first row on its own, and it must be Create, as without this section.
    await expect(palette.locator('[cmdk-item][aria-selected="true"]')).toContainText(
      'Create worktree'
    )
    await expect(sessionRows(palette).first()).toHaveAttribute('aria-selected', 'false')
    await input.press('Enter')
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeModal))
      .toBe('new-workspace-composer')
    expect(await readTabCount(orcaPage, worktreeId)).toBe(tabsBefore)
    await orcaPage.keyboard.press('Escape')
  })

  await test.step('a typed Enter never opens a session after the highlight moved for an earlier query', async () => {
    const tabsBefore = await readTabCount(orcaPage, worktreeId)
    const { palette, input } = await openPalette(orcaPage)
    await input.press('ArrowDown')
    await input.fill('quarterly')
    await expect(sessionRows(palette)).toHaveCount(2)
    await expect(palette.locator('[cmdk-item][aria-selected="true"]')).toContainText(
      'Create worktree'
    )
    await input.press('Enter')
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeModal))
      .toBe('new-workspace-composer')
    expect(await readTabCount(orcaPage, worktreeId)).toBe(tabsBefore)
    await orcaPage.keyboard.press('Escape')
  })

  await test.step('a typed Enter never opens a session after a query was replaced by another', async () => {
    // Starting queries that list sessions, list none, and are too short; the second query replaces each at once
    // (the hits of the first have not landed) and after the hits of the first have landed.
    const starts = [
      { text: 'billing', listsSessions: true },
      { text: 'refactor billing', listsSessions: true },
      { text: 'bill', listsSessions: false },
      { text: 'xyz-none', listsSessions: false },
      { text: 'b', listsSessions: false }
    ]
    for (const { text, listsSessions } of starts) {
      for (const waitForHits of [false, true]) {
        const { palette, input } = await openPalette(orcaPage)
        await input.fill(text)
        if (waitForHits && listsSessions) {
          await expect(sessionRows(palette).first()).toBeVisible()
        }
        await input.fill('quarterly')
        await expectTypedEnterOnlyCreates(orcaPage, palette, input, worktreeId)
      }
    }
  })

  await test.step('a typed Enter never opens a session after an arrow key and a replaced query', async () => {
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('billing')
    await expect(sessionRows(palette)).toHaveCount(2)
    await input.press('ArrowDown')
    await input.press('ArrowDown')
    await input.fill('quarterly')
    await expectTypedEnterOnlyCreates(orcaPage, palette, input, worktreeId)
  })

  await test.step('a typed Enter never opens a session after typing at different speeds', async () => {
    for (const typing of [
      [{ text: 'quarterly', delay: 30 }],
      [{ text: 'quarterly', delay: 90 }],
      [
        { text: 'quar', delay: 200 },
        { text: 'terly', delay: 20 }
      ]
    ]) {
      const { palette, input } = await openPalette(orcaPage)
      for (const { text, delay } of typing) {
        await input.pressSequentially(text, { delay })
      }
      await expectTypedEnterOnlyCreates(orcaPage, palette, input, worktreeId)
    }
  })

  await test.step('a typed Enter never opens a session after the name step of a new worktree was left', async () => {
    await orcaPage.evaluate((id) => window.__store!.getState().setActiveWorktree(id), worktreeId)
    // Entering a workspace opens its first tab; the count the checks below compare with must include it.
    await expect.poll(() => readTabCount(orcaPage, worktreeId)).toBeGreaterThan(0)
    for (const leaveWith of ['Escape', 'Backspace']) {
      const { palette, input } = await openPalette(orcaPage)
      await input.fill('quarterly')
      await expect(sessionRows(palette)).toHaveCount(2)
      // Cmd/Ctrl+Shift+Enter starts a new worktree in the project of the workspace you are in.
      await input.press('ControlOrMeta+Shift+Enter')
      await expect(input).toHaveAttribute('aria-placeholder', /^New worktree in billing-exporter/)
      await expect(input).toHaveValue('')
      await input.press(leaveWith)
      await expect(input).toHaveValue('quarterly')
      await expectTypedEnterOnlyCreates(orcaPage, palette, input, worktreeId)
    }
  })

  await test.step('a session whose folder is no workspace of Orca is listed but inert', async () => {
    const tabsBefore = await readTabCount(orcaPage, worktreeId)
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('billing')
    const row = sessionRows(palette).filter({ hasText: UNKNOWN_TITLE })
    await expect(row).toHaveCount(1)
    await expect(row).toHaveAttribute('aria-disabled', 'true')
    await expect(row.locator('[data-palette-session-where]')).toHaveAttribute(
      'data-palette-session-inert',
      'folder-not-in-orca'
    )
    // The arrow keys walk past it, and a click on it does nothing.
    for (let step = 0; step < 8; step++) {
      await input.press('ArrowDown')
    }
    await expect(row).toHaveAttribute('aria-selected', 'false')
    await row.click({ force: true })
    // Nothing is armed here, so there is no event to wait for; a resume starts well within this.
    // ast-grep-ignore: test-no-real-time-wait -- asserting that nothing happens leaves no condition to wait on
    await orcaPage.waitForTimeout(500)
    await expect(palette).toBeVisible()
    expect(await readTabCount(orcaPage, worktreeId)).toBe(tabsBefore)
    await orcaPage.keyboard.press('Escape')
  })

  await test.step('Enter on a closed session of a known workspace resumes it in a new chat tab there', async () => {
    const tabsBefore = await readTabCount(orcaPage, worktreeId)
    const { palette, input } = await openPalette(orcaPage)
    await input.fill('billing')
    const row = sessionRows(palette).filter({ hasText: KNOWN_TITLE })
    await expect(row).toHaveCount(1)
    // Resume needs the agent catalog, which loads after the rows; the row is armed only once it can go.
    await expect(row).toHaveAttribute('aria-disabled', 'false')
    await arrowToRow(input, row)
    await input.press('Enter')
    await expect(palette).toHaveCount(0)
    // The chat adopts the transcript and shows its history; the stub itself starts only with the first prompt.
    await expect
      .poll(() => readTabCount(orcaPage, worktreeId), { timeout: 30_000 })
      .toBeGreaterThan(tabsBefore)
    const chat = orcaPage.locator('[data-native-chat-root="true"]')
    await expect(chat.getByText(KNOWN_REPLY, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(chat.getByText(UNKNOWN_REPLY, { exact: true })).toHaveCount(0)
    // The index links the resumed conversation to the chat that adopted it, in this workspace.
    await expect
      .poll(() =>
        orcaPage.evaluate(async (sessionId) => {
          const response = await window.api.aiVault.searchSessions(
            { query: 'quarterly', limit: 6 },
            'local'
          )
          if (response.kind !== 'results') {
            return null
          }
          return (
            response.hits.find((hit) => hit.sessionId === sessionId)?.structuredSession
              ?.workspaceId ?? null
          )
        }, KNOWN_SESSION_ID)
      )
      .toBe(worktreeId)
    expect(await orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId)).toBe(
      worktreeId
    )
  })
})

test('Cmd+J resumes a closed session in a new terminal of its workspace when Claude opens as CLI', async ({
  electronApp,
  orcaPage,
  claudeStub,
  registerPostElectronShutdownCleanup
}) => {
  const { worktreeId } = await seedWorld(
    { electronApp, orcaPage, claudeStub, registerPostElectronShutdownCleanup },
    { enableSearch: true }
  )
  // The world opens Claude as a chat; this profile opens it as CLI, as when the chat UI is turned off.
  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettingsOrThrow({
      nativeChatProviders: { claude: false, codex: true }
    })
  )
  const tabsBefore = await readTabCount(orcaPage, worktreeId)
  const { palette, input } = await openPalette(orcaPage)
  await input.fill('billing')
  const row = sessionRows(palette).filter({ hasText: KNOWN_TITLE })
  await expect(row).toHaveAttribute('aria-disabled', 'false')
  await arrowToRow(input, row)
  await input.press('Enter')
  await expect(palette).toHaveCount(0)
  // A terminal runs Claude's own resume of the conversation.
  await expect
    .poll(() => stubResumed(claudeStub.launchLog, KNOWN_SESSION_ID), { timeout: 30_000 })
    .toBe(true)
  // In a new tab of the session's own workspace, now in front; no chat tab opens to take it over.
  await expect.poll(() => readTabCount(orcaPage, worktreeId)).toBeGreaterThan(tabsBefore)
  const tabTypes = await orcaPage.evaluate(
    (id) =>
      (window.__store!.getState().unifiedTabsByWorktree[id] ?? []).map((tab) => tab.contentType),
    worktreeId
  )
  expect(tabTypes).toContain('terminal')
  expect(tabTypes).not.toContain('agent-session')
  expect(await orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId)).toBe(
    worktreeId
  )
})

test('Cmd+J shows no Sessions section and asks the index nothing while Agent Session History search is off', async ({
  electronApp,
  orcaPage,
  claudeStub,
  registerPostElectronShutdownCleanup
}) => {
  await seedWorld(
    { electronApp, orcaPage, claudeStub, registerPostElectronShutdownCleanup },
    { enableSearch: false }
  )
  await electronApp.evaluate(({ ipcMain }) => {
    const calls = { search: 0, status: 0 }
    // The main process keeps the counts on `process`, which a later evaluate reads back.
    const holder: { pid: number; sessionSearchCalls?: typeof calls } = process
    holder.sessionSearchCalls = calls
    ipcMain.removeHandler('aiVault:searchSessions')
    ipcMain.handle('aiVault:searchSessions', () => {
      calls.search += 1
      return { kind: 'unavailable', reason: 'no-service' }
    })
    ipcMain.removeHandler('aiVault:searchStatus')
    ipcMain.handle('aiVault:searchStatus', () => {
      calls.status += 1
      return { enabled: false, phase: 'idle', filesIndexed: 0, generation: 0 }
    })
  })
  expect(
    await orcaPage.evaluate(
      () => window.__store!.getState().settings?.aiVaultSearch?.enabled ?? false
    )
  ).toBe(false)

  const { palette, input } = await openPalette(orcaPage)
  await input.fill('billing')
  // The folder next to the project proves the palette settled; the transcripts match too, but stay hidden.
  await expect(folderRows(palette)).toHaveCount(1)
  // Nothing is shown here, so there is no event to wait for; a search starts within about 150 ms.
  // ast-grep-ignore: test-no-real-time-wait -- asserting that nothing happens leaves no condition to wait on
  await orcaPage.waitForTimeout(600)
  await expect(palette.getByText('Sessions', { exact: true })).toHaveCount(0)
  await expect(sessionRows(palette)).toHaveCount(0)
  expect(
    await electronApp.evaluate(() => {
      const holder: { pid: number; sessionSearchCalls?: { search: number; status: number } } =
        process
      return holder.sessionSearchCalls
    })
  ).toEqual({ search: 0, status: 0 })
})
