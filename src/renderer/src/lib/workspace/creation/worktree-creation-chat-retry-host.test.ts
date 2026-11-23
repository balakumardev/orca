// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { getPaletteSearchHosts } from '@/components/cmd-j/palette-search-hosts'
import { paletteProjectCreateGuard } from '@/components/cmd-j/palette-project-create-composer'
import {
  paletteRuntimeEnvironment,
  paletteRuntimeStatus
} from '@/components/cmd-j/palette-runtime-host.test-fixture'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from '@/components/native-chat/drafts/native-chat-draft-reset'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from '../activation/worktree-activation-created-agent.test-fixture'
import {
  pendingCreationChatDraftScopeKey,
  type WorktreeCreationRequest
} from './pending-worktree-creation'
import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'
import { retryBackgroundWorktreeCreation } from './worktree-creation-flow'
import type { Worktree } from '../../../../../shared/worktree/types'

// Only layout publication is held; admission, launch, Retry, and the RPC client remain real.
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
const source = pendingCreationChatDraftScopeKey('creation-retry')
let originalApi: PropertyDescriptor | undefined
let main: TabsDrawnFromMain
beforeEach(() => {
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  resetStructuredAgentLaunchRegistryForTests()
})
afterEach(async () => {
  layoutApplyTestTransport.answerPending({ ok: false, code: 'host_not_owned' })
  await main?.settle()
  main?.close()
  resetStructuredAgentLaunchRegistryForTests()
  clearNativeChatComposerDraftsForTests()
  replaceRuntimeEnvironmentRevisions([])
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it.each(['before-retry', 'during-admission'] as const)(
  'retains chat-only Retry input when its selected host changes %s',
  async (changeAt) => {
    let environment = paletteRuntimeEnvironment()
    const executionHostId = 'runtime:builder'
    const worktree: Worktree = {
      ...makeCreatedAgentWorktree(),
      hostId: executionHostId,
      runtimeOwnerEnvironmentId: environment.id
    }
    seedEmptyActivatableWorktree(worktree)
    const publishHost = () => {
      replaceRuntimeEnvironmentRevisions([environment])
      useAppStore.setState({
        runtimeEnvironments: [environment],
        runtimeStatusByEnvironmentId: new Map([[environment.id, paletteRuntimeStatus(environment)]])
      })
    }
    publishHost()
    const host = getPaletteSearchHosts(useAppStore.getState(), [executionHostId])[0]!
    const request: WorktreeCreationRequest = {
      repoId: worktree.repoId,
      name: 'feature',
      executionHostId,
      targetGuard: paletteProjectCreateGuard(host),
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
      activeWorktreeId: worktree.id,
      activeWorkspaceExecutionHostId: executionHostId,
      repos: useAppStore.getState().repos.map((repo) => ({ ...repo, executionHostId })),
      pendingWorktreeCreations: {
        'creation-retry': {
          creationId: 'creation-retry',
          phase: 'creating',
          status: 'creating',
          startedAt: 1,
          indeterminate: false,
          loaderVisible: true,
          heldChatMessage: 'Fix billing retry',
          request
        }
      }
    })
    let admissionAllowed = false
    const firstAsked = Promise.withResolvers<void>()
    const firstRelease = Promise.withResolvers<void>()
    const asked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const attempted = Promise.withResolvers<void>()
    const mutationHosts: string[] = []
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
        if (!admissionAllowed) {
          firstAsked.resolve()
          await firstRelease.promise
          throw new Error('Original host temporarily unavailable')
        }
        asked.resolve()
        if (changeAt === 'during-admission') {
          await release.promise
        }
        return response({ supported: true })
      }
      if (args.method === 'agentSession.create') {
        mutationHosts.push(environment.runtimeId!)
        attempted.resolve()
        return response({
          ok: false,
          refusal: {
            code: 'structured_agent_session_unsupported',
            message: 'Fixture refuses creation'
          }
        })
      }
      return response({})
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gh: {}, runtimeEnvironments: { call } }
    })
    main = await drawTabsFromMain(useAppStore)
    layoutApplyTestTransport.answerWith('pending')
    const firstLaunch = launchStructuredWorktreeSession({
      creationId: 'creation-retry',
      request,
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: worktree.id,
      shouldActivateOnCompletion: false,
      activation: false,
      primaryTabId: null
    })
    await firstAsked.promise
    updateNativeChatComposerDraft(source, { text: 'Review invoices next' }, 'immediate')
    firstRelease.resolve()
    const first = await firstLaunch
    expect(first.retainedInput).toBe(true)
    admissionAllowed = true
    const replaceHost = () => {
      environment = { ...environment, pairingRevision: 2, runtimeId: 'replacement-runtime' }
      publishHost()
    }
    const retained = Promise.withResolvers<void>()
    let retryStarted = false
    const unsubscribe = useAppStore.subscribe((state) => {
      if (retryStarted && state.pendingWorktreeCreations['creation-retry']?.status === 'error') {
        retained.resolve()
      }
    })
    try {
      if (changeAt === 'before-retry') {
        replaceHost()
      }
      retryStarted = true
      retryBackgroundWorktreeCreation('creation-retry')
      if (changeAt === 'during-admission') {
        await asked.promise
        replaceHost()
        release.resolve()
      }
      await Promise.race([retained.promise, attempted.promise])
      expect(mutationHosts).toEqual([])
      expect(useAppStore.getState().pendingWorktreeCreations['creation-retry']).toMatchObject({
        status: 'error',
        worktreeId: worktree.id,
        heldChatMessage: 'Fix billing retry'
      })
      expect(readNativeChatComposerDraft(source).text).toBe('Review invoices next')
    } finally {
      unsubscribe()
      release.resolve()
    }
  }
)
