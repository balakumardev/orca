import { useAppStore } from '@/store/index'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type { WorktreeDefaultTabsLaunch } from '../../../../../shared/worktree/creation/launch-types'
import type { CreatedWorktreeResult } from '@/store/slices/worktrees/create/worktree-create-payload'
import type { WorktreeActivationOptions } from '../activation/worktree-activation-surface-selection'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import type { windowStartupAfterCreate } from './worktree-creation-host-agent-launch'
import { ensureWorktreeHasInitialTerminal } from '../activation/initial-surface/worktree-initial-terminal-seeding'
import { isInstantFolderWorktreeCreation } from './worktree-creation-surface'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/runtime/hosted-terminals/restoration/web-runtime-worktree-terminal-after-wake'

type CreationHostOptions = Pick<
  WorktreeActivationOptions,
  'executionHostId' | 'runtimeEnvironmentId' | 'targetGuard'
>

/** Share the original create target across activation, recovery and background startup. */
export function worktreeCreationHostOptions(
  request: WorktreeCreationRequest,
  executionHostId?: ExecutionHostId
): CreationHostOptions {
  const host = parseExecutionHostId(executionHostId)
  return {
    ...(executionHostId ? { executionHostId } : {}),
    ...(host?.kind === 'runtime' ? { runtimeEnvironmentId: host.environmentId } : {}),
    ...(request.targetGuard ? { targetGuard: request.targetGuard } : {})
  }
}

/** Recovery and background creation share host-owned seeding without reselecting a runtime. */
export function seedCreatedWorktreeHostTerminal(
  worktreeId: string,
  windowStartup: ReturnType<typeof windowStartupAfterCreate>,
  target: CreationHostOptions,
  activate = true
): void {
  ensureWebRuntimeWorktreeTerminalAfterWake(worktreeId, {
    ...target,
    startup: windowStartup.startup,
    agent: windowStartup.agent,
    activate,
    // This client just created the workspace, so an unlisted host count means empty.
    unknownHostCountIsEmpty: true
  })
}

export function prepareCreatedWorktreeActivation({
  creationId,
  request,
  result,
  windowStartup,
  defaultTabs,
  setupIsOnlySurface,
  executionHostId
}: {
  creationId: string
  request: WorktreeCreationRequest
  result: CreatedWorktreeResult
  windowStartup: ReturnType<typeof windowStartupAfterCreate>
  defaultTabs: WorktreeDefaultTabsLaunch | undefined
  setupIsOnlySurface: boolean
  executionHostId?: ExecutionHostId
}): { primaryTabId: string | null; options: WorktreeActivationOptions } {
  const onCreationHost = worktreeCreationHostOptions(request, executionHostId)
  let primaryTabId: string | null = null
  const instantFolder = isInstantFolderWorktreeCreation(useAppStore.getState(), request)
  if (instantFolder) {
    // Metadata is not a destination surface; build the selected ordinary tabs before navigation.
    primaryTabId = ensureWorktreeHasInitialTerminal(
      useAppStore.getState(),
      result.worktree.id,
      windowStartup.startup,
      result.setup,
      request.issueCommand,
      defaultTabs,
      {
        activateCreatedTabs: false,
        ...onCreationHost,
        ...windowStartup.terminalOptions,
        ...(request.agent !== null || setupIsOnlySurface ? { callerProvidesSurface: true } : {})
      }
    )
  }
  return {
    primaryTabId,
    options: {
      sidebarRevealBehavior: 'auto',
      ...onCreationHost,
      ...(windowStartup.agent !== null ? { agent: windowStartup.agent } : {}),
      ...(primaryTabId
        ? { worktreeCreationId: creationId, providesInitialSurface: true }
        : {
            // Seeding above owns setup delivery; passing it again opens a second Setup tab.
            ...(result.setup && !instantFolder ? { setup: result.setup } : {}),
            ...(defaultTabs ? { defaultTabs } : {}),
            ...(windowStartup.startup ? { startup: windowStartup.startup } : {}),
            ...(request.issueCommand ? { issueCommand: request.issueCommand } : {}),
            ...windowStartup.terminalOptions,
            ...(setupIsOnlySurface ? { providesInitialSurface: true } : {})
          })
    }
  }
}
