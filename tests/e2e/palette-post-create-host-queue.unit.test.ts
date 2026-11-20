// @vitest-environment happy-dom

import { expect, it, vi } from 'vitest'
import { runQueuedPaletteAction } from './palette-post-create-host-queue.test-fixture'
import { useAppStore } from '@/store/index'
import { openFolderEntryInApp } from '@/components/cmd-j/palette-folder-open-in-app'
import { executeWorktreeCreation } from '@/lib/workspace/creation/worktree-creation-flow-execute'
import { openDeclinedTerminal } from '@/lib/agent-session/launch/structured-agent-session-action-launch'
import { openBackgroundDeclinedTerminal } from '@/lib/workspace/creation/worktree-creation-background-mount'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import * as provisionalLaunch from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { launchStructuredWorktreeSession } from '@/lib/workspace/creation/worktree-creation-structured-session'

it('refuses a queued folder add after the selected runtime restarts', async () => {
  const mutations = await runQueuedPaletteAction(
    ({ entry, host, occupy }) => {
      occupy()
      return openFolderEntryInApp({ ...entry, kind: 'git-root' }, host)
    },
    { queuedMethod: 'repo.add' }
  )
  expect(mutations).toEqual([])
})

it('refuses queued folder reveal effects after its successful add and a runtime restart', async () => {
  const mutations = await runQueuedPaletteAction(({ entry, host, occupy }) => {
    // Hold only the effects after the successful add; discovery and admission remain real.
    vi.spyOn(useAppStore.getState(), 'fetchWorktrees').mockImplementation(async () => {
      occupy()
      return true
    })
    return openFolderEntryInApp(entry, host)
  })
  expect(mutations).toEqual(['repo.add:runtime-original'])
})

it.each([
  { mode: 'foreground', activePendingCreationId: 'creation-1' },
  { mode: 'background', activePendingCreationId: null }
])('refuses queued $mode creation effects after a runtime restart', async (selection) => {
  const mutations = await runQueuedPaletteAction(({ worktree, request, occupy }) => {
    useAppStore.setState({ activePendingCreationId: selection.activePendingCreationId })
    // The backend has created the checkout; exercise the real post-create continuation.
    vi.spyOn(useAppStore.getState(), 'createWorktree').mockImplementation(async () => {
      occupy()
      return { worktree, startupTerminal: { spawned: false } }
    })
    return executeWorktreeCreation('creation-1', request)
  })
  expect(mutations).toEqual([])
})

it('refuses a queued default-chat terminal fallback after the selected runtime restarts', async () => {
  const mutations = await runQueuedPaletteAction(async ({ worktree, host, request, occupy }) => {
    occupy()
    const fallback = await openDeclinedTerminal(
      {
        plan: adoptAgentSessionLaunchVerdict({
          route: 'structured-native-chat',
          requestId: 'default-chat',
          agent: 'codex',
          worktreeId: worktree.id,
          executionHostId: host.executionHostId
        }),
        hooks: { targetGuard: request.targetGuard },
        target: { worktreeId: worktree.id, executionHostId: host.executionHostId }
      },
      worktree.id,
      {
        executionHostId: host.executionHostId,
        target: { kind: 'environment', environmentId: host.runtimeEnvironmentId! }
      }
    )
    return fallback.completion
  })
  expect(mutations).toEqual([])
})

it('refuses a queued background-chat terminal fallback even when cancellation arrives in the queue', async () => {
  const abandoned = new AbortController()
  const mutations = await runQueuedPaletteAction(
    ({ worktree, host, request, occupy }) => {
      occupy()
      return openBackgroundDeclinedTerminal(
        { worktreeId: worktree.id, request: { ...request, agent: 'codex' } },
        { kind: 'environment', environmentId: host.runtimeEnvironmentId! },
        undefined,
        abandoned.signal
      ).completion
    },
    { afterQueue: () => abandoned.abort() }
  )
  expect(mutations).toEqual([])
})

it('refuses queued layout-refusal recovery after the selected runtime restarts', async () => {
  const mutations = await runQueuedPaletteAction(({ worktree, request, occupy }) => {
    // Supply the layout owner's refusal; the recovery launcher and RPC queue stay real.
    vi.spyOn(provisionalLaunch, 'beginStructuredAgentSessionProvisionalLaunch').mockImplementation(
      ({ onTabOpenSettled }) => {
        onTabOpenSettled?.(null, 'layout-refused')
        return {
          sessionId: null,
          tab: null,
          settlement: Promise.resolve({ kind: 'cancelled', sessionId: null }),
          cancel: () => undefined
        }
      }
    )
    useAppStore.setState({ activePendingCreationId: 'creation-1' })
    useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
      heldChatMessage: 'Inspect workspace'
    })
    occupy()
    return launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request: { ...request, agent: 'codex', agentLaunchRoute: 'structured-native-chat' },
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: worktree.id,
      shouldActivateOnCompletion: true,
      activation: false,
      primaryTabId: null
    })
  })
  expect(mutations).toEqual([])
})
