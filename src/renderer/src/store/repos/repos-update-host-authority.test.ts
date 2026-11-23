import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { replaceRuntimeEnvironmentRevisions } from '../../runtime/rpc/environment-revisions/runtime-environment-revision'
import { toast } from 'sonner'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'

// Repo-routing fixtures used to live in repo-runtime-routing.test-fixture.ts; upstream deleted that
// shared test support, so this suite carries the sample catalog and window stub it needs.
const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2
}

const reposList: Mock = vi.fn()
const reposAdd: Mock = vi.fn()
const reposPickFolder: Mock = vi.fn()
const reposClone: Mock = vi.fn()
const reposRemoveForHost: Mock = vi.fn()
const reposUpdate: Mock = vi.fn()
const reposReorder: Mock = vi.fn()
const reposReorderForHost: Mock = vi.fn()
const projectsCreateHostSetup: Mock = vi.fn()
const projectsSetupExistingFolder: Mock = vi.fn()
const projectsUpdateHostSetup: Mock = vi.fn()
const projectsDeleteHostSetup: Mock = vi.fn()
const projectsUpdate: Mock = vi.fn()
const projectGroupsMoveProject: Mock = vi.fn()
const ptyKill: Mock = vi.fn()
const runtimeEnvironmentCall: Mock = vi.fn()
const runtimeEnvironmentTransportCall: Mock = vi.fn()
const orcaProfileFindProjectProfiles: Mock = vi.fn()
const uiSet: Mock = vi.fn()
const ephemeralVmListRuntimes: Mock = vi.fn()
const ephemeralVmCleanup: Mock = vi.fn()
const runtimeEnvironmentsList: Mock = vi.fn()

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

beforeEach(() => {
  replaceRuntimeEnvironmentRevisions([])
  clearRuntimeCompatibilityCacheForTests()
  vi.mocked(toast.error).mockReset()
  vi.mocked(toast.info).mockReset()
  vi.mocked(toast.success).mockReset()
  vi.mocked(toast.warning).mockReset()
  reposList.mockReset()
  reposAdd.mockReset()
  reposPickFolder.mockReset()
  reposClone.mockReset()
  reposRemoveForHost.mockReset()
  reposUpdate.mockReset()
  reposReorder.mockReset()
  reposReorderForHost.mockReset()
  projectsCreateHostSetup.mockReset()
  projectsSetupExistingFolder.mockReset()
  projectsUpdateHostSetup.mockReset()
  projectsDeleteHostSetup.mockReset()
  projectsUpdate.mockReset()
  projectGroupsMoveProject.mockReset()
  ptyKill.mockReset()
  orcaProfileFindProjectProfiles.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  uiSet.mockReset()
  uiSet.mockResolvedValue(undefined)
  ephemeralVmListRuntimes.mockReset().mockResolvedValue([])
  ephemeralVmCleanup.mockReset()
  runtimeEnvironmentsList.mockReset().mockResolvedValue([])
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: {
        list: reposList,
        add: reposAdd,
        clone: reposClone,
        pickFolder: reposPickFolder,
        removeForHost: reposRemoveForHost,
        update: reposUpdate,
        reorder: reposReorder,
        reorderForHost: reposReorderForHost
      },
      projects: {
        update: projectsUpdate,
        createHostSetup: projectsCreateHostSetup,
        setupExistingFolder: projectsSetupExistingFolder,
        updateHostSetup: projectsUpdateHostSetup,
        deleteHostSetup: projectsDeleteHostSetup
      },
      projectGroups: {
        moveProject: projectGroupsMoveProject
      },
      orcaProfiles: {
        findProjectProfiles: orcaProfileFindProjectProfiles
      },
      pty: { kill: ptyKill },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCall,
        list: runtimeEnvironmentsList
      },
      ephemeralVm: {
        listRuntimes: ephemeralVmListRuntimes,
        cleanup: ephemeralVmCleanup
      },
      ui: { set: uiSet }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('retires a late repo reply and the next serialized update when their selected host changes', async () => {
  const store = createTestStore()
  const owner: Repo = { ...remoteRepo, executionHostId: 'runtime:env-1' }
  store.setState({ repos: [owner] })
  const sent = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<{ ok: true; result: { repo: Repo } }>()
  const remoteWrites: string[] = []
  runtimeEnvironmentCall.mockImplementation((request) => {
    const displayName = request.params.updates.displayName
    remoteWrites.push(displayName)
    if (displayName === 'First rename') {
      sent.resolve()
      return reply.promise
    }
    return Promise.resolve({ ok: true, result: { repo: { ...owner, displayName } } })
  })
  let current = true
  const targetGuard = {
    assertCurrent: () => {
      if (!current) {
        throw new Error('The selected server was replaced')
      }
    }
  }
  const first = store.getState().updateRepo(
    owner.id,
    { displayName: 'First rename' },
    {
      hostId: 'runtime:env-1',
      targetGuard
    }
  )
  await sent.promise
  const queued = store.getState().updateRepo(
    owner.id,
    { displayName: 'Queued rename' },
    {
      hostId: 'runtime:env-1',
      targetGuard
    }
  )
  // The response belongs to the old host even though the catalog now holds its replacement.
  current = false
  store.setState({ repos: [{ ...owner, displayName: 'Replacement server' }] })
  reply.resolve({ ok: true, result: { repo: { ...owner, displayName: 'First rename' } } })

  expect.soft(await Promise.all([first, queued])).toEqual([false, false])
  expect.soft(store.getState().repos[0]?.displayName).toBe('Replacement server')
  expect(remoteWrites).toEqual(['First rename'])
})
