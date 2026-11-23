import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import type { ProjectAgentAccountChoice } from '../../../shared/project-agent-accounts'
import type { ProjectAgentAccountRepoStore } from '../../project-agent-accounts/project-agent-account-repo'
import { isDirectory } from '../profiles/claude-profile-homes'
import type { ClaudeProfileDescriptor } from '../profiles/claude-profile-paths'
import {
  claudeProfileMissing,
  claudeProfileSetupFailed
} from '../profiles/routing/claude-profile-launch-errors'
import { prepareClaudeProfileForLaunch } from '../profiles/routing/claude-profile-launch-preparation'
import type { ClaudeProfileSetupReport } from '../profiles/setup/claude-profile-setup'
import type { ClaudeRuntimeAuthPreparation } from '../runtime-auth/runtime-auth-types'
import type { ClaudeAccountSelectionTarget } from '../selection/runtime-selection'
import type { ProjectClaudeBinding } from './project-claude-binding'
import { writeProjectClaudePointer } from './project-claude-pointer'
import {
  applyProjectClaudeRouteEnv,
  projectClaudePointerContent,
  projectClaudePreparation,
  type ProjectClaudeRoute
} from './project-claude-route'

export type ProjectClaudeLaunch = {
  /** Claude launches only; fails closed rather than run the active account. */
  preparation: () => Promise<ClaudeRuntimeAuthPreparation>
  applyToEnv: (env: Record<string, string> | undefined) => Record<string, string>
}

type ProjectClaudeLaunchContext = Pick<
  ProjectClaudeBinding,
  'currentRoute' | 'prepareAccount' | 'systemDefaultHome'
>

const PREPARED: ClaudeProfileSetupReport = { outcome: 'prepared', surfaces: {}, warnings: [] }
const REFUSED: ClaudeProfileSetupReport = { outcome: 'refused', surfaces: {}, warnings: [] }

function publishPointer(route: ProjectClaudeRoute): boolean {
  try {
    writeProjectClaudePointer(route.pointerPath, projectClaudePointerContent(route))
    return true
  } catch (error) {
    console.warn('[project-agent-accounts] Could not write the project Claude pointer:', error)
    return false
  }
}

export function createProjectClaudeLaunch(
  context: ProjectClaudeLaunchContext,
  repoId: string,
  choice: ProjectAgentAccountChoice,
  initialRoute: ProjectClaudeRoute
): ProjectClaudeLaunch {
  let route = initialRoute
  let pointerWritten = publishPointer(route)
  const refreshRoute = (): ProjectClaudeRoute | null => {
    const next = context.currentRoute(repoId, choice)
    if (next) {
      route = next
      pointerWritten = publishPointer(next)
    }
    return next
  }
  if (choice.kind === 'account') {
    // Like terminalEnv: set up without delaying the terminal; setup waits for the login-shell env, which can change the route.
    void context
      .prepareAccount(choice.accountId)
      .then(() => {
        refreshRoute()
      })
      .catch(() => {})
  }
  return {
    applyToEnv: (env) => applyProjectClaudeRouteEnv(env, route),
    preparation: async () => {
      if (route.kind === 'account') {
        const profile: ClaudeProfileDescriptor = {
          version: 1,
          accountId: route.accountId,
          target: { executionHostId: LOCAL_EXECUTION_HOST_ID, runtime: 'host' },
          home: route.home
        }
        await prepareClaudeProfileForLaunch(profile, (value) =>
          context.prepareAccount(value.accountId).then(
            () => PREPARED,
            () => REFUSED
          )
        )
        const next = refreshRoute()
        if (!next || (next.kind === 'account' && !isDirectory(next.home))) {
          throw claudeProfileMissing()
        }
      }
      if (!pointerWritten) {
        throw claudeProfileSetupFailed()
      }
      return projectClaudePreparation(route, context.systemDefaultHome())
    }
  }
}

let installed: ProjectClaudeBinding | undefined

/** Installed only in the desktop process, beside the Claude profile router. */
export function installProjectClaudeBinding(binding: ProjectClaudeBinding | undefined): void {
  installed = binding
}

export function getProjectClaudeBinding(): ProjectClaudeBinding | undefined {
  return installed
}

/** Both PTY preflights: null means the project is not pinned and the spawn is left as it is. */
export function resolveProjectClaudeLaunch(
  deps: { store?: ProjectAgentAccountRepoStore },
  args: { worktreeId?: string; connectionId?: string | null },
  target: ClaudeAccountSelectionTarget
): ProjectClaudeLaunch | null {
  return installed ? installed.resolve(deps.store, args, target) : null
}
