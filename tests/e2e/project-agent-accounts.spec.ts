import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import type {
  ProjectAgentAccountChoice,
  ProjectAgentAccountsSnapshot
} from '../../src/shared/project-agent-accounts'
import { getRepoIdFromWorktreeId } from '../../src/shared/worktree/id'
import { expect } from '@stablyai/playwright-test'
import { test } from './desktop/electron-fixtures/orca-app'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from './desktop/renderer-probes/store'
import { waitForActivePanePtyId } from './terminal/input/terminal'
import { getTerminalContent } from './terminal/layout/terminal-pane-identity'
import {
  execInTerminal,
  waitForActiveTerminalManager
} from './terminal/layout/terminal-pane-operations'

// Raw git worktree add bypasses Orca's 5s scan-cache invalidation; poll for 10s to cross the TTL and allow a slow scan.
const WORKTREE_CACHE_TTL_POLL_MS = 10_000

let nextEvaluateKey = 0

// What the page stores for one polled evaluate call, read back as plain JSON.
type PolledOutcome<Result> =
  | { state: 'pending' }
  | { state: 'done'; value: Result }
  | { state: 'failed'; error: string }

// Poll preload outcomes rather than holding a CDP promise that may be garbage-collected; args cross as JSON.
async function evaluatePolled<Args, Result>(
  page: Page,
  run: (args: Args) => Promise<Result>,
  args: Args
): Promise<Result> {
  nextEvaluateKey += 1
  const key = JSON.stringify(`__e2eEvaluatePolled${nextEvaluateKey}`)
  await page.evaluate(`(() => {
    const run = ${run.toString()};
    globalThis[${key}] = { state: 'pending' };
    Promise.resolve()
      .then(() => run(${JSON.stringify(args)}))
      .then(
        (value) => { globalThis[${key}] = { state: 'done', value }; },
        (error) => { globalThis[${key}] = { state: 'failed', error: String(error) }; }
      );
  })()`)
  const read = (): Promise<PolledOutcome<Result>> =>
    page.evaluate<PolledOutcome<Result>>(`globalThis[${key}]`)
  await expect
    .poll(async () => (await read()).state, { message: 'page work never settled' })
    .not.toBe('pending')
  const outcome = await read()
  if (outcome.state !== 'done') {
    throw new Error(outcome.state === 'failed' ? outcome.error : 'page work never settled')
  }
  return outcome.value
}

// Poll past the scan-cache TTL until every raw-Git fixture worktree appears.
async function loadWorktreesUntilPathsPresent(
  page: Page,
  repoId: string,
  expectedPaths: string[]
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ repoId, expectedPaths }) => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available')
            }
            await store.getState().fetchWorktrees(repoId)
            const registered = new Set(
              (store.getState().worktreesByRepo[repoId] ?? []).map((entry) => entry.path)
            )
            return expectedPaths.every((entry) => registered.has(entry))
          },
          { repoId, expectedPaths }
        ),
      {
        timeout: WORKTREE_CACHE_TTL_POLL_MS,
        message: `Not all worktrees registered within the worktree-cache TTL window (${expectedPaths.length} expected)`
      }
    )
    .toBe(true)
}

// Add a fresh repo through main so its requested worktrees never grow the worker's shared fixture repo.
async function addRepoWithWorkspaces(
  page: Page,
  testInfo: TestInfo,
  count: number
): Promise<{ repoId: string; mainId: string; ids: string[] }> {
  const root = testInfo.outputPath('repo-with-workspaces')
  const repoPath = path.join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
  git('init', '-b', 'main')
  writeFileSync(path.join(repoPath, 'README.md'), 'workspaces\n')
  git('add', 'README.md')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@test.local', 'commit', '-m', 'init')
  const realRoot = realpathSync(root)
  const worktreePaths = Array.from({ length: count }, (_, index) => {
    const worktreePath = path.join(realRoot, `workspace-${index}`)
    git('worktree', 'add', '-q', '-b', `workspace-${index}`, worktreePath)
    return worktreePath
  })
  const realRepoPath = realpathSync(repoPath)
  const repoId = await evaluatePolled(
    page,
    async (repoPath) => {
      const added = await window.api.repos.add({ path: repoPath })
      if ('error' in added) {
        throw new Error(added.error)
      }
      return added.repo.id
    },
    realRepoPath
  )
  // The add's own refresh can supersede the helper's fetch, and updateRepo skips a repo the store lacks.
  await expect
    .poll(
      () =>
        page.evaluate(async (repoId) => {
          const store = window.__store!
          await store.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
          return store.getState().repos.some((repo) => repo.id === repoId)
        }, repoId),
      { message: 'the added repo never reached the store' }
    )
    .toBe(true)
  await evaluatePolled(
    page,
    async (repoId) => {
      // Checkouts made outside Orca's workspace root are hidden by default.
      const shown = await window
        .__store!.getState()
        .updateRepo(repoId, { externalWorktreeVisibility: 'show' })
      if (!shown) {
        throw new Error(`could not show external worktrees for ${repoId}`)
      }
    },
    repoId
  )
  await loadWorktreesUntilPathsPresent(page, repoId, [realRepoPath, ...worktreePaths])
  const idByPath = await page.evaluate(
    (repoId) =>
      Object.fromEntries(
        (window.__store!.getState().worktreesByRepo[repoId] ?? []).map((worktree) => [
          worktree.path,
          worktree.id
        ])
      ),
    repoId
  )
  return {
    repoId,
    mainId: idByPath[realRepoPath]!,
    ids: worktreePaths.map((worktreePath) => idByPath[worktreePath]!)
  }
}

const ACCOUNT_A = 'e2e-project-account-a'
const ACCOUNT_B = 'e2e-project-account-b'

type ClaudeEnvProbe = { cwd: string; pointer: string; configDir: string; injected: string }

// The account router reads only <userData>/claude-profiles/<id>/home; a login keeps it off System default.
function seedClaudeAccountHome(userData: string, accountId: string, email: string): string {
  const home = path.join(userData, 'claude-profiles', accountId, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } })
  )
  return home
}

function savedAccount(id: string, email: string, home: string) {
  return {
    id,
    email,
    managedAuthPath: home,
    managedAuthRuntime: 'host' as const,
    authMethod: 'subscription-oauth' as const,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function readPointer(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

async function setPin(
  page: Page,
  repoId: string,
  choice: ProjectAgentAccountChoice
): Promise<ProjectAgentAccountsSnapshot> {
  return page.evaluate(
    ({ repoId, choice }) =>
      window.api.projectAgentAccounts.set({ repoId, provider: 'claude', choice }),
    { repoId, choice }
  )
}

// A new tab spawns with the pin as it is now; open terminals keep the env they started with.
async function probeNewTerminal(page: Page, worktreeId: string): Promise<ClaudeEnvProbe> {
  await page.evaluate(
    ({ worktreeId, repoId }) => {
      const state = window.__store!.getState()
      state.setActiveRepo(repoId)
      state.setActiveView('terminal')
      state.setActiveWorktree(worktreeId)
      const tab = state.createTab(worktreeId)
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal', worktreeId)
    },
    { worktreeId, repoId: getRepoIdFromWorktreeId(worktreeId) }
  )
  await waitForActiveTerminalManager(page)
  const ptyId = await waitForActivePanePtyId(page)
  const marker = `${Date.now()}${Math.floor(Math.random() * 1e6)}`
  // The format string keeps the echoed command line from matching the printed one.
  await execInTerminal(
    page,
    ptyId,
    `printf 'PAA%s:[%s][%s][%s][%s]\\n' "${marker}" "$PWD" "$ORCA_CLAUDE_PROFILE_POINTER" "$CLAUDE_CONFIG_DIR" "$ORCA_CLAUDE_INJECTED_CONFIG_DIR"`
  )
  const pattern = new RegExp(
    `PAA${marker}:\\[([^\\]]*)\\]\\[([^\\]]*)\\]\\[([^\\]]*)\\]\\[([^\\]]*)\\]`
  )
  let probe: ClaudeEnvProbe | null = null
  await expect
    .poll(
      async () => {
        // Long paths can soft-wrap; the brackets still delimit each value.
        const content = (await getTerminalContent(page, 8000)).replace(/[\r\n]/g, '')
        const match = pattern.exec(content)
        probe = match
          ? { cwd: match[1]!, pointer: match[2]!, configDir: match[3]!, injected: match[4]! }
          : null
        return probe !== null
      },
      { timeout: 20_000, message: 'The terminal never printed its Claude environment' }
    )
    .toBe(true)
  return probe!
}

test.describe('Per-project Claude accounts', () => {
  test('a pinned project routes new terminals to its account; others keep the active one', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const unpinnedWorktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))

    // (a) Two signed-in managed accounts, A selected globally.
    const homeA = seedClaudeAccountHome(userData, ACCOUNT_A, 'account-a@example.invalid')
    const homeB = seedClaudeAccountHome(userData, ACCOUNT_B, 'account-b@example.invalid')
    await orcaPage.evaluate(
      async (accounts) => {
        await window.__store!.getState().updateSettings({
          claudeManagedAccounts: accounts,
          activeClaudeManagedAccountId: accounts[0]!.id,
          activeClaudeManagedAccountIdsByRuntime: { host: accounts[0]!.id, wsl: {} }
        })
      },
      [
        savedAccount(ACCOUNT_A, 'account-a@example.invalid', homeA),
        savedAccount(ACCOUNT_B, 'account-b@example.invalid', homeB)
      ]
    )
    await expect
      .poll(async () => {
        const listed = await orcaPage.evaluate(() => window.api.claudeAccounts.list())
        return {
          active: listed.activeAccountId,
          ready: listed.accounts
            .filter((account) => !account.needsSignIn && !account.runsOnSystemDefault)
            .map((account) => account.id)
            .sort()
        }
      })
      .toEqual({ active: ACCOUNT_A, ready: [ACCOUNT_A, ACCOUNT_B] })

    const pinned = await addRepoWithWorkspaces(orcaPage, testInfo, 0)
    const pointerRoot = path.join(userData, 'project-agent-accounts', 'pointers', 'claude')
    const pointerB = path.join(pointerRoot, 'accounts', ACCOUNT_B)
    const systemPointer = path.join(pointerRoot, 'system')
    const repoPath = await orcaPage.evaluate(
      (worktreeId) => window.__store!.getState().getKnownWorktreeById(worktreeId)?.path ?? null,
      pinned.mainId
    )

    // (b) The pinned project's terminal runs on B through its own pointer.
    const pinnedToB = await setPin(orcaPage, pinned.repoId, {
      kind: 'account',
      accountId: ACCOUNT_B
    })
    expect(pinnedToB.projects[pinned.repoId]).toEqual({
      claude: { kind: 'account', accountId: ACCOUNT_B }
    })
    expect(await probeNewTerminal(orcaPage, pinned.mainId)).toEqual({
      cwd: repoPath,
      pointer: pointerB,
      configDir: homeB,
      injected: homeB
    })
    await expect.poll(() => readPointer(pointerB)).toBe(homeB)

    // (c) An unpinned project keeps the global pointer and the active account.
    const unpinned = await probeNewTerminal(orcaPage, unpinnedWorktreeId)
    expect(unpinned).toMatchObject({
      pointer: path.join(userData, 'claude-profiles', 'selected-host'),
      configDir: homeA,
      injected: homeA
    })
    await expect
      .poll(() => readPointer(path.join(userData, 'claude-profiles', 'selected-host')))
      .toBe(homeA)

    // (d) System default drops Orca's injected config dir and publishes an empty pointer.
    await setPin(orcaPage, pinned.repoId, { kind: 'system' })
    expect(await probeNewTerminal(orcaPage, pinned.mainId)).toEqual({
      cwd: repoPath,
      pointer: systemPointer,
      configDir: '',
      injected: ''
    })
    await expect.poll(() => readPointer(systemPointer)).toBe('')

    // (e) Removing the pinned account drops its pin and its pointer.
    await setPin(orcaPage, pinned.repoId, { kind: 'account', accountId: ACCOUNT_B })
    await expect.poll(() => readPointer(pointerB)).toBe(homeB)
    await orcaPage.evaluate(
      (accountId) => window.api.claudeAccounts.remove({ accountId }),
      ACCOUNT_B
    )
    await expect
      .poll(async () => {
        const snapshot = await orcaPage.evaluate(() => window.api.projectAgentAccounts.list())
        return {
          pin: snapshot.projects[pinned.repoId]?.claude ?? null,
          pointer: existsSync(pointerB),
          folder: existsSync(path.dirname(homeB))
        }
      })
      .toEqual({ pin: null, pointer: false, folder: false })
  })
})
