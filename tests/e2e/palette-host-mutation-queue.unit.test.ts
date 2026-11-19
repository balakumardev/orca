// @vitest-environment happy-dom

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  getPaletteSearchHosts,
  isPaletteSearchHostCurrent
} from '@/components/cmd-j/palette-search-hosts'
import { paletteRuntimeStatus } from '@/components/cmd-j/palette-runtime-host.test-fixture'
import { paletteProjectCreateGuard } from '@/components/cmd-j/palette-project-create-composer'
import { openPaletteSession } from '@/components/cmd-j/palette-session-open'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { openProjectDefaultCheckout } from '@/components/sidebar/project-admission/completion/project-added-default-checkout'
import { sessionHit } from '@/components/cmd-j/palette-session-hit.test-fixture'
import { readPaletteSessionFacts } from '@/components/cmd-j/palette-session-facts'
import { resolvePaletteSessionAction } from '@/components/cmd-j/palette-session-action'
import { createGlobalSettingsFixture } from '../../src/shared/global-settings-test-fixture'
import {
  makeGroup,
  makeRepo,
  makeUnifiedTab,
  makeWorktree
} from '@/components/worktree-jump/worktree-jump-palette-test-fixtures'
import { createWebRuntimeSessionTerminalResult } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation'
import { beginStructuredAgentLaunchSettlement } from '@/lib/agent-session/launch/continuation/structured-agent-launch-settlement'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { callRuntimeEnvironment } from '../../src/main/ipc/runtime-environments/runtime-environment-transport-routing'
import { prepareRuntimeAiVaultSessionResume } from '../../src/main/ai-vault/runtime-session-scanner'
import { enqueueRuntimeCall } from '../../src/main/ipc/runtime-environments/runtime-environment-call-queue'
import { resetSharedControlSupport } from '../../src/main/ipc/runtime-environments/runtime-environment-shared-control-support'
import { pairingCode } from '../../src/main/ipc/runtime-environments/runtime-environments-ipc-test-harness'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed,
  resolveEnvironment
} from '../../src/shared/remote-runtime/host-store/runtime-environment-store'
import { redactRuntimeEnvironment } from '../../src/shared/remote-runtime/host-catalog/runtime-environments'
import type { PreloadApi } from '../../src/preload/api-types'

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

const initialState = useAppStore.getInitialState()
let profile: string
beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'orca-palette-resume-queue-'))
  getPath.mockReturnValue(profile)
})
afterEach(() => {
  resetStructuredAgentLaunchRegistryForTests()
  resetSharedControlSupport()
  replaceRuntimeEnvironmentRevisions([])
  useAppStore.setState(initialState, true)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(profile, { recursive: true, force: true })
})

it('refuses queued palette opens, resumes, creates, and checkout updates after the selected runtime restarts', async () => {
  const paired = addEnvironmentFromPairingCode(profile, {
    name: 'selected-builder',
    pairingCode: pairingCode(),
    now: 1
  })
  markEnvironmentUsed(profile, paired.id, { runtimeId: 'runtime-original' })
  const original = redactRuntimeEnvironment(resolveEnvironment(profile, paired.id))
  const capabilities = [
    'agent-session.permission-modes.v1',
    'agent-session.structured.v1',
    'agent-session.structured.client-launch-mode.v1',
    'agent-session.structured.resume-history.v1'
  ]
  replaceRuntimeEnvironmentRevisions([original])
  useAppStore.setState({
    runtimeEnvironments: [original],
    runtimeStatusByEnvironmentId: new Map([
      [original.id, paletteRuntimeStatus(original, capabilities)]
    ]),
    settings: createGlobalSettingsFixture({ agentDefaultSurface: 'chat' })
  })
  const host = getPaletteSearchHosts(useAppStore.getState(), [`runtime:${original.id}`])[0]!
  const workspaceId = 'repo-1::/code/acme'
  const emptyWorkspaceId = 'repo-1::/code/empty'
  const freshWorkspaceId = 'repo-1::/code/fresh'
  useAppStore.setState({
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    repos: [{ ...makeRepo(), executionHostId: host.executionHostId }],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(workspaceId, 'Billing', {
          path: '/code/acme',
          hostId: host.executionHostId,
          runtimeOwnerEnvironmentId: original.id
        }),
        makeWorktree(emptyWorkspaceId, 'Empty', {
          path: '/code/empty',
          hostId: host.executionHostId,
          runtimeOwnerEnvironmentId: original.id
        }),
        makeWorktree(freshWorkspaceId, 'Fresh', {
          path: '/code/fresh',
          hostId: host.executionHostId,
          runtimeOwnerEnvironmentId: original.id
        })
      ]
    },
    detectedWorktreesByRepo: {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [
          {
            ...makeWorktree('repo-1::/code/default', 'Default', {
              path: '/code/default',
              isMainWorktree: true,
              hostId: host.executionHostId,
              runtimeOwnerEnvironmentId: original.id
            }),
            ownership: 'external',
            selectedCheckout: true,
            visible: false
          }
        ]
      }
    },
    unifiedTabsByWorktree: {
      [workspaceId]: [
        {
          ...makeUnifiedTab('remote-chat', workspaceId, 'chat-1', 'Billing'),
          contentType: 'agent-session',
          executionHostId: host.executionHostId
        }
      ]
    },
    groupsByWorktree: { [workspaceId]: [makeGroup(workspaceId, ['remote-chat'])] }
  })
  const historyHit = sessionHit('billing-history', {
    agent: 'codex',
    cwd: '/code/acme',
    executionHostId: host.executionHostId
  })
  expect(
    resolvePaletteSessionAction(readPaletteSessionFacts(useAppStore.getState(), historyHit))
  ).toEqual({ kind: 'resume-chat', workspaceId })
  const queued = Promise.withResolvers<void>()
  const createQueued = Promise.withResolvers<void>()
  const activationQueued = Promise.withResolvers<void>()
  const activationSettled = Promise.withResolvers<void>()
  const chatCreateQueued = Promise.withResolvers<void>()
  const historyCreateQueued = Promise.withResolvers<void>()
  const historyCreateSettled = Promise.withResolvers<void>()
  const workspaceQueued = Promise.withResolvers<void>()
  const workspaceSettled = Promise.withResolvers<void>()
  const preparationQueued = Promise.withResolvers<void>()
  const preparationSettled = Promise.withResolvers<void>()
  const automaticTerminalQueued = Promise.withResolvers<void>()
  const automaticTerminalSettled = Promise.withResolvers<void>()
  const freshTerminalQueued = Promise.withResolvers<void>()
  const freshTerminalSettled = Promise.withResolvers<void>()
  const visibilityQueued = Promise.withResolvers<void>()
  vi.stubGlobal('window', {
    api: {
      gh: {},
      aiVault: {
        prepareSessionResume: (
          args: Parameters<PreloadApi['aiVault']['prepareSessionResume']>[0]
        ) => {
          const response = prepareRuntimeAiVaultSessionResume(profile, original.id, args)
          preparationQueued.resolve()
          void response.then(
            () => preparationSettled.resolve(),
            () => preparationSettled.resolve()
          )
          return response
        }
      },
      runtimeEnvironments: {
        call: (args: Parameters<PreloadApi['runtimeEnvironments']['call']>[0]) => {
          // Admission is complete before the mutation waits on the saturated main queue.
          if (args.method === 'agentSession.createSupport') {
            return Promise.resolve({ id: args.method, ok: true, result: { supported: true } })
          }
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
          if (args.method === 'session.tabs.createTerminal') {
            queued.resolve()
            if (
              args.params &&
              typeof args.params === 'object' &&
              'worktree' in args.params &&
              args.params.worktree === 'id:repo-1::/code/empty'
            ) {
              automaticTerminalQueued.resolve()
              void response.then(
                () => automaticTerminalSettled.resolve(),
                automaticTerminalSettled.reject
              )
            }
            if (
              args.params &&
              typeof args.params === 'object' &&
              'worktree' in args.params &&
              args.params.worktree === 'id:repo-1::/code/fresh'
            ) {
              freshTerminalQueued.resolve()
              void response.then(() => freshTerminalSettled.resolve(), freshTerminalSettled.reject)
            }
          }
          if (args.method === 'repo.update') {
            visibilityQueued.resolve()
          }
          if (args.method === 'worktree.create') {
            createQueued.resolve()
          }
          if (args.method === 'session.tabs.activate') {
            activationQueued.resolve()
            void response.then(() => activationSettled.resolve(), activationSettled.reject)
          }
          if (args.method === 'worktree.activate') {
            workspaceQueued.resolve()
            void response.then(() => workspaceSettled.resolve(), workspaceSettled.reject)
          }
          if (args.method === 'aiVault.prepareSessionResume') {
            preparationQueued.resolve()
            void response.then(() => preparationSettled.resolve(), preparationSettled.reject)
          }
          if (args.method === 'agentSession.create') {
            if (args.params && typeof args.params === 'object' && 'resumeFrom' in args.params) {
              historyCreateQueued.resolve()
              void response.then(() => historyCreateSettled.resolve(), historyCreateSettled.reject)
            } else {
              chatCreateQueued.resolve()
            }
          }
          return response
        }
      }
    }
  })
  const mutatedOn: string[] = []
  let servingRuntimeId = 'runtime-original'
  sendRequest.mockImplementation(async (_connection, method: string) => {
    if (
      method === 'session.tabs.createTerminal' ||
      method === 'session.tabs.activate' ||
      method === 'agentSession.create' ||
      method === 'worktree.create' ||
      method === 'worktree.activate' ||
      method === 'repo.update' ||
      method === 'aiVault.prepareSessionResume'
    ) {
      mutatedOn.push(`${method}:${servingRuntimeId}`)
    }
    if (method === 'repo.update') {
      return {
        id: method,
        ok: false,
        error: { code: 'runtime_error', message: 'Fixture refused update' }
      }
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
              capabilities
            }
          : method === 'agentSession.create'
            ? {
                ok: false,
                refusal: {
                  code: 'structured_agent_session_unsupported',
                  message: 'Fixture refused creation'
                }
              }
            : method === 'aiVault.prepareSessionResume'
              ? { useRealCodexHome: true }
              : { tab: { id: 'unexpected-terminal', leafId: 'unexpected-leaf' } },
      _meta: { runtimeId: servingRuntimeId }
    }
  })
  // Occupy the real main-process foreground queue until the selected runtime has changed.
  const release = Promise.withResolvers<void>()
  const occupying = Array.from({ length: 8 }, () =>
    enqueueRuntimeCall(original.id, 'session.tabs.createTerminal', () => release.promise)
  )
  // Empty-host fallback and hidden default checkouts mutate too, after their outer open returns.
  activateAndRevealWorktree(emptyWorkspaceId, {
    executionHostId: host.executionHostId,
    targetGuard: paletteProjectCreateGuard(host)
  })
  activateAndRevealWorktree(freshWorkspaceId, {
    executionHostId: host.executionHostId,
    targetGuard: paletteProjectCreateGuard(host),
    startup: {
      command: 'codex',
      launchAgent: 'codex',
      freshAgentLaunch: { prompt: '', promptDelivery: 'auto-submit' }
    }
  })
  const openDefault = openProjectDefaultCheckout({
    repoId: 'repo-1',
    source: 'local_folder_picker',
    executionHostId: host.executionHostId,
    targetGuard: paletteProjectCreateGuard(host),
    setHideDefaultBranchWorkspace: useAppStore.getState().setHideDefaultBranchWorkspace
  }).catch(() => undefined)
  const launch = createWebRuntimeSessionTerminalResult({
    environmentId: original.id,
    worktreeId: 'remote-workspace',
    launchAgent: 'claude',
    preparedAgentCommand: true,
    agentSessionKind: 'resume',
    command: 'claude --resume billing-conversation',
    selectWorktree: false,
    expectedEnvironmentRuntimeId: host.runtimeId ?? undefined,
    isCurrent: () => isPaletteSearchHostCurrent(host)
  })
  const createWorktree = useAppStore.getState().createWorktree
  const createArgs: Parameters<typeof createWorktree> = ['repo-web', 'queued-fix']
  createArgs[25] = {
    executionHostId: host.executionHostId,
    targetGuard: paletteProjectCreateGuard(host)
  }
  const creation = createWorktree(...createArgs).then(
    () => 'created',
    () => 'failed'
  )
  const openChat = openPaletteSession(
    sessionHit('recording', {
      executionHostId: host.executionHostId,
      structuredSession: { workspaceId, sessionId: 'chat-1' }
    }),
    host
  )
  const createChat = beginStructuredAgentLaunchSettlement(
    'remote-workspace',
    'codex',
    { requestId: 'queued-chat-retry', executionHostId: host.executionHostId },
    { activate: false, targetGuard: paletteProjectCreateGuard(host) }
  )
  const resumeHistory = openPaletteSession(historyHit, host)
  const resumeLegacy = openPaletteSession(
    {
      ...historyHit,
      sessionId: 'legacy-codex',
      source: { ...historyHit.source, codexHome: '/orca/codex-runtime-home/home' }
    },
    host
  )
  try {
    await Promise.all([
      queued.promise,
      createQueued.promise,
      activationQueued.promise,
      chatCreateQueued.promise,
      historyCreateQueued.promise,
      workspaceQueued.promise,
      preparationQueued.promise,
      automaticTerminalQueued.promise,
      freshTerminalQueued.promise,
      visibilityQueued.promise
    ])
    servingRuntimeId = 'runtime-restarted'
    markEnvironmentUsed(profile, original.id, { runtimeId: 'runtime-restarted' })
    const restarted = { ...original, runtimeId: 'runtime-restarted' }
    useAppStore.setState({
      runtimeEnvironments: [restarted],
      runtimeStatusByEnvironmentId: new Map([[original.id, paletteRuntimeStatus(restarted)]])
    })
    release.resolve()
    const result = await launch
    await Promise.all([
      openChat,
      activationSettled.promise,
      createChat.settlement,
      resumeHistory,
      historyCreateSettled.promise,
      workspaceSettled.promise,
      preparationSettled.promise,
      resumeLegacy,
      automaticTerminalSettled.promise,
      freshTerminalSettled.promise,
      openDefault
    ])

    expect(await creation).toBe('failed')
    expect(mutatedOn).toEqual([])
    expect(result.outcome.status).toBe('failed')
  } finally {
    release.resolve()
    await Promise.all(occupying)
  }
})
