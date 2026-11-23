import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { replaceRuntimeEnvironmentRevisions } from '../../runtime/rpc/environment-revisions/runtime-environment-revision'
import { toast } from 'sonner'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'
import { runExclusiveForRuntimeEnvironment } from './pending-runtime-repo-removals'

// Repo-routing fixtures used to live in repo-runtime-routing.test-fixture.ts; upstream deleted that
// shared test support, so this suite carries the sample catalog and window stub it needs.
const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
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
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
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

describe('repo add/catalog races', () => {
  it('does not add a selected folder to a replacement server while the add was queued', async () => {
    const remotePaths: string[] = []
    runtimeEnvironmentCall.mockImplementation(async (request) => {
      if (request.method === 'repo.add') {
        remotePaths.push(request.params.path)
      }
      return { ok: true, result: { repo: { ...localRepo, path: '/code/app' } } }
    })
    let release = () => {}
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = runExclusiveForRuntimeEnvironment('env-1', () => blocker)
    const store = createTestStore()
    let current = true
    const adding = store.getState().addRepoPath('/code/app', 'git', {
      runtimeEnvironmentId: 'env-1',
      targetGuard: {
        assertCurrent: () => {
          if (!current) {
            throw new Error('The selected server was replaced')
          }
        }
      }
    })
    current = false
    release()
    await queued

    expect(await adding).toBeNull()
    expect(remotePaths).toEqual([])
    expect(store.getState().repos).toEqual([])
  })

  it('appends the same bare ID when add returns a different host identity', async () => {
    reposAdd.mockResolvedValue({ repo: localRepo })
    const runtimeSibling: Repo = {
      ...localRepo,
      path: '/runtime/local-repo',
      executionHostId: 'runtime:env-1'
    }
    const store = createTestStore()
    store.setState({ repos: [runtimeSibling] })

    await store.getState().addRepoPath(localRepo.path)

    expect(store.getState().repos).toEqual([
      runtimeSibling,
      { ...localRepo, executionHostId: 'local' }
    ])
  })
})
