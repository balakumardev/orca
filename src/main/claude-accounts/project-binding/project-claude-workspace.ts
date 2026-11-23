import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host/execution-host'
import { wslDistroForCommand } from '../../../shared/file-access/wsl-paths'
import type { RuntimePtyWorktreeRecord } from '../../runtime/terminal/records/runtime-terminal-state-records'
import { claudeRoutedHomeAsync } from '../profiles/routing/claude-profile-routed-home'
import type { ClaudeProfileRouter } from '../profiles/routing/claude-profile-router'
import type { ClaudeRuntimeAuthPreparation } from '../runtime-auth/runtime-auth-types'
import type { ProjectClaudeLocation } from './project-claude-binding'
import { getProjectClaudeBinding } from './project-claude-launch'
import { projectClaudePreparation } from './project-claude-route'

/** Chat launches: null keeps the active account; a pinned project fails closed instead. */
export function projectClaudeLaunchPreparation(
  location: ProjectClaudeLocation
): Promise<ClaudeRuntimeAuthPreparation> | null {
  return getProjectClaudeBinding()?.resolveLocation(location)?.preparation() ?? null
}

/** Commit and PR text: a pinned project's diff goes to its pinned account, never the active one. */
export function projectClaudeGenerationPreparation(
  target: { runtime?: 'host' | 'wsl'; workspaceId?: string } | undefined
): Promise<ClaudeRuntimeAuthPreparation> | null {
  return target?.workspaceId && target.runtime !== 'wsl'
    ? projectClaudeLaunchPreparation({
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: target.workspaceId
      })
    : null
}

/** Branch and chat names: a target only where the pin applies, so every other generation is unchanged. */
export function projectClaudeGenerationTarget(
  agentId: string,
  workspace: string | ProjectClaudeLocation,
  cwd: string
): { workspaceId: string } | undefined {
  const location: ProjectClaudeLocation =
    typeof workspace === 'string'
      ? { executionHostId: LOCAL_EXECUTION_HOST_ID, wslDistro: null, workspaceId: workspace }
      : workspace
  // A WSL path runs the generation in its distro, which has its own accounts.
  const pinned =
    agentId === 'claude' &&
    !wslDistroForCommand(cwd) &&
    getProjectClaudeBinding()?.pinForLocation(location)
  return pinned && location ? { workspaceId: location.workspaceId } : undefined
}

/** `orca claude-teams` in a pinned project's terminal: the leader runs on the pinned account. */
export function projectClaudeTerminalPreparation(
  pty:
    | Pick<
        RuntimePtyWorktreeRecord,
        'worktreeId' | 'worktreeInferredFromCwd' | 'connectionId' | 'isWsl' | 'wslDistro'
      >
    | undefined
): Promise<ClaudeRuntimeAuthPreparation> | null {
  // A WSL pane runs under its distro's own accounts; a workspace guessed from the cwd decides nothing.
  return pty && !pty.isWsl && !pty.wslDistro && !pty.worktreeInferredFromCwd
    ? projectClaudeLaunchPreparation({
        executionHostId: getConnectionExecutionHostId(pty.connectionId),
        wslDistro: null,
        workspaceId: pty.worktreeId
      })
    : null
}

/** ClaudeProfileRouter.preparation() for a pinned project, read without side effects. */
export function projectClaudePolicy(
  location: ProjectClaudeLocation
): ClaudeRuntimeAuthPreparation | null {
  const binding = getProjectClaudeBinding()
  const route = binding?.routeForLocation(location)
  return binding && route ? projectClaudePreparation(route, binding.systemDefaultHome()) : null
}

/** claudeRoutedHomeAsync for the project a chat runs in; null still means System default. */
export function claudeRoutedHomeForLocation(
  router: Pick<
    ClaudeProfileRouter,
    'selectedProfile' | 'savedAccount' | 'userConfigDir' | 'userHome' | 'accountHome'
  >,
  location: ProjectClaudeLocation,
  availability: 'checked' | 'identity'
): Promise<string | null> {
  const pin = getProjectClaudeBinding()?.pinForLocation(location)
  if (!pin) {
    return claudeRoutedHomeAsync(router, availability)
  }
  if (pin.kind === 'system') {
    return Promise.resolve(null)
  }
  const { accountId } = pin
  // The pinned account stands in for the selected one; the login and folder checks are upstream's.
  return claudeRoutedHomeAsync(
    {
      selectedProfile: () => ({
        version: 1,
        accountId,
        target: { executionHostId: LOCAL_EXECUTION_HOST_ID, runtime: 'host' },
        home: router.accountHome(accountId)
      }),
      savedAccount: (id) => router.savedAccount(id),
      userConfigDir: () => router.userConfigDir(),
      userHome: router.userHome
    },
    availability
  )
}
