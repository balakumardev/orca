import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  getPaletteSearchHosts,
  paletteSearchHostGuard,
  type PaletteSearchHost
} from '@/components/cmd-j/palette-search-hosts'
import { paletteRuntimeStatus } from '@/components/cmd-j/palette-runtime-host.test-fixture'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/workspace/activation/worktree-activation-created-agent.test-fixture'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { callRuntimeEnvironment } from '../../src/main/ipc/runtime-environments/requests/runtime-environment-transport-routing'
import { enqueueRuntimeCall } from '../../src/main/ipc/runtime-environments/requests/runtime-environment-call-queue'
import { resetSharedControlSupport } from '../../src/main/ipc/runtime-environments/connections/runtime-environment-shared-control-support'
import { encodePairingOffer } from '../../src/shared/remote-runtime/pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed,
  resolveEnvironment
} from '../../src/shared/remote-runtime/host-store/runtime-environment-store'
import { redactRuntimeEnvironment } from '../../src/shared/remote-runtime/host-catalog/runtime-environments'
import type { FolderSearchEntry } from '../../src/shared/folder-search-types'
import type { Repo } from '../../src/shared/repository/repo-types'
import type { Worktree } from '../../src/shared/worktree/types'

const { sendRequest, getPath } = vi.hoisted(() => ({ sendRequest: vi.fn(), getPath: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() }
}))
vi.mock('../../src/main/runtime/construction/runtime-desktop-surface', () => ({
  getRuntimeDesktopSurface: () => ({})
}))
vi.mock('../../src/shared/remote-runtime/requests/remote-runtime-request-socket', () => ({
  sendRemoteRuntimeRequestOnSocket: sendRequest
}))

// The runtime-environments IPC test harness that carried pairingCode is gone upstream; this fixture builds
// the same pairing offer itself.
function pairingCode(
  endpoint = 'ws://127.0.0.1:6768',
  { deviceToken = 'device-token', keyByte = 1 }: { deviceToken?: string; keyByte?: number } = {}
): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken,
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(keyByte)).toString('base64')
  })
}

const initialState = useAppStore.getInitialState()
let profile: string
beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'orca-palette-post-create-'))
  getPath.mockReturnValue(profile)
})
afterEach(() => {
  resetSharedControlSupport()
  replaceRuntimeEnvironmentRevisions([])
  useAppStore.setState(initialState, true)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(profile, { recursive: true, force: true })
})

type QueueScenario = {
  entry: FolderSearchEntry
  host: PaletteSearchHost
  worktree: Worktree
  request: WorktreeCreationRequest
  occupy: () => void
}

/** Real callers and main queue share a transport boundary that records which runtime was mutated. */
export async function runQueuedPaletteAction(
  start: (scenario: QueueScenario) => unknown,
  options: { queuedMethod?: string; afterQueue?: () => void } = {}
): Promise<string[]> {
  const paired = await addEnvironmentFromPairingCode(profile, {
    name: 'selected-builder',
    pairingCode: pairingCode(),
    now: 1
  })
  await markEnvironmentUsed(profile, paired.id, { runtimeId: 'runtime-original' })
  const original = redactRuntimeEnvironment(await resolveEnvironment(profile, paired.id))
  const executionHostId = `runtime:${original.id}` as const
  const worktree: Worktree = {
    ...makeCreatedAgentWorktree(),
    createdWithAgent: undefined,
    hostId: executionHostId,
    runtimeOwnerEnvironmentId: original.id
  }
  seedEmptyActivatableWorktree(worktree)
  replaceRuntimeEnvironmentRevisions([original])
  const repo: Repo = {
    ...useAppStore.getState().repos[0]!,
    path: worktree.path,
    kind: 'folder',
    executionHostId
  }
  useAppStore.setState({
    repos: [repo],
    runtimeEnvironments: [original],
    runtimeStatusByEnvironmentId: new Map([[original.id, paletteRuntimeStatus(original)]]),
    activePendingCreationId: null,
    settings: { ...useAppStore.getState().settings!, defaultTuiAgent: 'blank' }
  })
  const host = getPaletteSearchHosts(useAppStore.getState(), [executionHostId])[0]!
  const entry: FolderSearchEntry = {
    path: worktree.path,
    kind: 'folder',
    executionHostId
  }
  const queued = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const pending = new Set<Promise<unknown>>()
  let blockers: Promise<unknown>[] = []
  const occupy = () => {
    blockers = Array.from({ length: 8 }, () =>
      enqueueRuntimeCall(original.id, 'session.tabs.createTerminal', () => release.promise)
    )
  }
  const mutations: string[] = []
  let servingRuntimeId = 'runtime-original'
  sendRequest.mockImplementation(async (_connection, method: string) => {
    if (['repo.add', 'worktree.activate', 'session.tabs.createTerminal'].includes(method)) {
      mutations.push(`${method}:${servingRuntimeId}`)
    }
    return {
      id: method,
      ok: true,
      result:
        method === 'status.get'
          ? {
              runtimeId: servingRuntimeId,
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: []
            }
          : method === 'repo.add'
            ? { repo }
            : { tab: { id: 'unexpected-terminal', leafId: 'unexpected-leaf' } },
      _meta: { runtimeId: servingRuntimeId }
    }
  })
  const call: Window['api']['runtimeEnvironments']['call'] = (args) => {
    const response = callRuntimeEnvironment(
      profile,
      args.selector,
      args.method,
      args.params,
      args.timeoutMs,
      args.expectedEnvironmentPairingRevision,
      undefined,
      { expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId }
    )
    pending.add(response)
    void response.then(
      () => pending.delete(response),
      () => pending.delete(response)
    )
    if (args.method === (options.queuedMethod ?? 'session.tabs.createTerminal')) {
      queued.resolve()
    }
    return response
  }
  vi.stubGlobal('window', {
    api: { gh: {}, folderSearch: { resolve: async () => entry }, runtimeEnvironments: { call } }
  })
  const request: WorktreeCreationRequest = {
    repoId: repo.id,
    name: 'feature',
    executionHostId,
    targetGuard: paletteSearchHostGuard(host),
    setupDecision: 'skip',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null
  }
  useAppStore.setState({
    pendingWorktreeCreations: {
      'creation-1': {
        creationId: 'creation-1',
        phase: 'creating',
        status: 'creating',
        startedAt: 1,
        indeterminate: false,
        loaderVisible: true,
        request
      }
    }
  })
  const action = Promise.resolve(start({ entry, host, worktree, request, occupy }))
  try {
    await queued.promise
    servingRuntimeId = 'runtime-restarted'
    await markEnvironmentUsed(profile, original.id, { runtimeId: servingRuntimeId })
    const restarted = { ...original, runtimeId: servingRuntimeId }
    useAppStore.setState({
      runtimeEnvironments: [restarted],
      runtimeStatusByEnvironmentId: new Map([[original.id, paletteRuntimeStatus(restarted)]])
    })
    options.afterQueue?.()
    release.resolve()
    await action
    while (pending.size > 0) {
      await Promise.allSettled(pending)
    }
    return mutations
  } finally {
    release.resolve()
    await Promise.allSettled([action, ...blockers, ...pending])
  }
}
