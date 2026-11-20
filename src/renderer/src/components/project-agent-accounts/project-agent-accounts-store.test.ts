import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectAgentAccountsSnapshot } from '../../../../shared/project-agent-accounts'

// Fresh module per test: the store keeps its snapshot at module level.
async function loadStore(bridge: Record<string, unknown> | undefined) {
  vi.resetModules()
  vi.stubGlobal('window', { api: { projectAgentAccounts: bridge } })
  return import('./project-agent-accounts-store')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('stays unavailable without a bridge and with the web client fallback answer', async () => {
  const missing = await loadStore(undefined)
  expect(missing.readProjectAgentAccounts().available).toBe(false)

  // The web fallback proxy answers [] for list().
  const list = vi.fn(async (): Promise<unknown> => [])
  const fallback = await loadStore({ list, onChanged: () => () => {} })
  fallback.readProjectAgentAccounts()
  // The store's own handler was attached first, so it has run once this await resumes.
  await list.mock.results[0]?.value
  expect(fallback.readProjectAgentAccounts()).toEqual({
    available: false,
    snapshot: { projects: {} }
  })
})

it('applies the first answer, later broadcasts and the answer to a change', async () => {
  let broadcast: (snapshot: ProjectAgentAccountsSnapshot) => void = () => {}
  const set = vi.fn(async () => ({
    projects: { 'repo-1': { claude: { kind: 'account' as const, accountId: 'acct-b' } } }
  }))
  const store = await loadStore({
    list: async () => ({ projects: { 'repo-1': { claude: { kind: 'system' } } } }),
    set,
    onChanged: (listener: (snapshot: ProjectAgentAccountsSnapshot) => void) => {
      broadcast = listener
      return () => {}
    }
  })
  const listener = vi.fn()
  store.subscribeProjectAgentAccounts(listener)
  await vi.waitFor(() =>
    expect(store.readProjectAgentAccounts()).toEqual({
      available: true,
      snapshot: { projects: { 'repo-1': { claude: { kind: 'system' } } } }
    })
  )
  expect(listener).toHaveBeenCalled()

  broadcast({ projects: {} })
  expect(store.readProjectAgentAccounts().snapshot).toEqual({ projects: {} })

  await store.setProjectAgentAccount({
    repoId: 'repo-1',
    provider: 'claude',
    choice: { kind: 'account', accountId: 'acct-b' }
  })
  expect(
    store.getProjectAgentAccountChoice(
      store.readProjectAgentAccounts().snapshot,
      'repo-1',
      'claude'
    )
  ).toEqual({ kind: 'account', accountId: 'acct-b' })
})
