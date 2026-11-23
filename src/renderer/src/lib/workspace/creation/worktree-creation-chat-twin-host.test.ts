// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { makeSnapshot } from '@/runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import {
  getPaletteSearchHosts,
  paletteSearchHostGuard
} from '@/components/cmd-j/palette-search-hosts'
import {
  paletteRuntimeEnvironment,
  paletteRuntimeStatus
} from '@/components/cmd-j/palette-runtime-host.test-fixture'
import { registerNativeChatPane } from '@/components/native-chat/composer/focus/native-chat-composer-mount'
import {
  makeCreatedAgentWorktree,
  seedAlreadyActiveWorktree
} from '../activation/worktree-activation-created-agent.test-fixture'
import { CreateIntentParams } from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import type { AgentSessionHistoryPage } from '../../../../../shared/agent-session/agent-session-wire'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import { retryBackgroundWorktreeCreation } from './worktree-creation-flow'

// A persisted local twin makes accidental publication into main observable.
vi.mock('../../../../../shared/workspace-layout/layout-owner-switch', () => ({
  ORCA_LAYOUT_OWNER_IS_MAIN: true
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)

const initialState = useAppStore.getInitialState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
let main: TabsDrawnFromMain
afterEach(async () => {
  await main?.settle()
  main?.close()
  resetStructuredAgentLaunchRegistryForTests()
  replaceRuntimeEnvironmentRevisions([])
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it('keeps a retried remote chat out of its selected local twin', async () => {
  const environment = paletteRuntimeEnvironment()
  const local = makeCreatedAgentWorktree()
  const remote: Worktree = {
    ...local,
    hostId: 'runtime:builder',
    runtimeOwnerEnvironmentId: environment.id
  }
  seedAlreadyActiveWorktree(local, {
    worktreesByRepo: { [local.repoId]: [local, remote] },
    activeWorkspaceExecutionHostId: 'local'
  })
  replaceRuntimeEnvironmentRevisions([environment])
  const repo = useAppStore.getState().repos[0]!
  useAppStore.setState({
    repos: [repo, { ...repo, executionHostId: 'runtime:builder' }],
    runtimeEnvironments: [environment],
    runtimeStatusByEnvironmentId: new Map([[environment.id, paletteRuntimeStatus(environment)]]),
    activeWorktreeId: local.id,
    activeWorkspaceExecutionHostId: 'local',
    activePendingCreationId: 'remote-create'
  })
  const host = getPaletteSearchHosts(useAppStore.getState(), ['runtime:builder'])[0]!
  const request: WorktreeCreationRequest = {
    repoId: remote.repoId,
    name: 'feature',
    executionHostId: 'runtime:builder',
    targetGuard: paletteSearchHostGuard(host),
    setupDecision: 'skip',
    agent: 'codex',
    agentLaunchRoute: 'structured-native-chat',
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null
  }
  useAppStore.setState({
    pendingWorktreeCreations: {
      'remote-create': {
        creationId: 'remote-create',
        phase: 'creating',
        status: 'error',
        startedAt: 1,
        indeterminate: false,
        loaderVisible: true,
        request,
        chatInputHandedOff: true,
        worktreeId: remote.id
      }
    }
  })
  const created = Promise.withResolvers<void>()
  let remoteSnapshot = makeSnapshot([], { worktree: remote.id, activeTabType: null })
  const call: Window['api']['runtimeEnvironments']['call'] = async (args) => {
    const response = (result: unknown) => ({
      id: args.method,
      ok: true as const,
      result,
      _meta: { runtimeId: environment.runtimeId! }
    })
    if (args.method === 'status.get') {
      return response(
        paletteRuntimeStatus(environment, ['agent-session.permission-modes.v1']).status
      )
    }
    if (args.method === 'agentSession.createSupport') {
      return response({ supported: true })
    }
    if (args.method === 'agentSession.create') {
      const { envelope } = CreateIntentParams.parse(args.params)
      const tabId = `structured-agent-session-${envelope.sessionId}`
      remoteSnapshot = makeSnapshot(
        [
          {
            type: 'agent-session',
            id: tabId,
            title: 'Codex',
            sessionId: envelope.sessionId,
            agent: 'codex',
            isActive: true
          }
        ],
        { worktree: remote.id, activeTabId: tabId, activeTabType: 'agent-session' }
      )
      const cursor = { epoch: 'remote-epoch', sequence: 0 }
      const page: AgentSessionHistoryPage = {
        sessionId: envelope.sessionId,
        epoch: 'remote-epoch',
        fence: 1,
        direction: 'tail',
        items: [],
        removedItemIds: [],
        submissions: [],
        window: { oldest: null, newest: null, nextCursor: cursor },
        liveCursor: cursor,
        hasOlder: false,
        hasNewer: false,
        latestTurn: null
      }
      created.resolve()
      return response({
        ok: true,
        replayed: false,
        fence: 1,
        cursor,
        value: { sessionId: envelope.sessionId, fence: 1, page, unconfirmedClientMessageIds: [] }
      })
    }
    if (args.method === 'session.tabs.list') {
      return response(remoteSnapshot)
    }
    return response({})
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gh: {}, runtimeEnvironments: { call } }
  })
  main = await drawTabsFromMain(useAppStore)
  const completed = Promise.withResolvers<void>()
  let unmount: (() => void) | undefined
  const unsubscribe = useAppStore.subscribe((state) => {
    const tab = state.unifiedTabsByWorktree[remote.id]?.find(
      (tab) => tab.contentType === 'agent-session'
    )
    if (tab && !unmount) {
      unmount = registerNativeChatPane(tab.id, () => true)
    }
    if (!state.pendingWorktreeCreations['remote-create']) {
      completed.resolve()
    }
  })
  try {
    retryBackgroundWorktreeCreation('remote-create')
    await completed.promise
    await created.promise
    await main.settle()
    const state = useAppStore.getState()
    expect.soft(state.activeWorkspaceExecutionHostId).toBe('runtime:builder')
    expect.soft(state.getActiveTab(remote.id)?.executionHostId).toBe('runtime:builder')
    expect
      .soft(
        layoutApplyTestTransport.mainModel?.workspaces[local.id]?.tabs.map(({ id, kind }) => ({
          id,
          kind
        }))
      )
      .toEqual([{ id: 'tab-1', kind: 'terminal' }])
  } finally {
    unsubscribe()
    unmount?.()
  }
})
