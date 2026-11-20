import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import {
  getConnectionExecutionHostId,
  isNativeLocalLocation,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host'
import {
  isProjectAgentAccountId,
  type ProjectAgentAccountChoice
} from '../../../shared/project-agent-accounts'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  findProjectAgentAccountRepo,
  type ProjectAgentAccountRepoStore
} from '../../project-agent-accounts/project-agent-account-repo'
import type { ProjectAgentAccountAdapter } from '../../project-agent-accounts/project-agent-accounts-registry'
import type { ProjectAgentAccountsStore } from '../../project-agent-accounts/project-agent-accounts-store'
import type { ClaudeProfileRouter } from '../profiles/routing/claude-profile-router'
import type { ClaudeAccountSelectionTarget } from '../selection/runtime-selection'
import { createProjectClaudeLaunch, type ProjectClaudeLaunch } from './project-claude-launch'
import { projectClaudePointerPath, removeProjectClaudePointer } from './project-claude-pointer'
import type { ProjectClaudeRoute } from './project-claude-route'

export type ProjectClaudeRouter = Pick<
  ClaudeProfileRouter,
  'savedAccount' | 'coveredBySystemDefault' | 'accountHome' | 'prepareAccount' | 'systemDefaultHome'
>

/** Where a chat runs; a catalog read with no workspace passes null. */
export type ProjectClaudeLocation =
  | Pick<AgentSessionExecutionLocation, 'executionHostId' | 'wslDistro' | 'workspaceId'>
  | null
  | undefined

function sameChoice(left: ProjectAgentAccountChoice, right: ProjectAgentAccountChoice): boolean {
  return left.kind === 'system'
    ? right.kind === 'system'
    : right.kind === 'account' && left.accountId === right.accountId
}

/** Routes Claude in pinned projects through public router methods only; the router itself is untouched. */
export class ProjectClaudeBinding implements ProjectAgentAccountAdapter {
  readonly provider = 'claude' as const

  constructor(
    private readonly args: {
      router: ProjectClaudeRouter
      dataRoot: string
      pins: Pick<ProjectAgentAccountsStore, 'get'>
      /** The main store; chats name only their workspace, so the binding looks the repo up itself. */
      store?: ProjectAgentAccountRepoStore
    }
  ) {}

  isPinnableAccount(accountId: string): boolean {
    if (!isProjectAgentAccountId(accountId)) {
      return false
    }
    const account = this.args.router.savedAccount(accountId)
    return account !== undefined && (account.managedAuthRuntime ?? 'host') === 'host'
  }

  onAccountRemoved(accountId: string): void {
    if (isProjectAgentAccountId(accountId)) {
      removeProjectClaudePointer(
        projectClaudePointerPath(this.args.dataRoot, { kind: 'account', accountId })
      )
    }
  }

  /** null leaves the spawn exactly as the active account makes it. */
  resolve(
    store: ProjectAgentAccountRepoStore | undefined,
    spawn: { worktreeId?: string; connectionId?: string | null },
    target: ClaudeAccountSelectionTarget
  ): ProjectClaudeLaunch | null {
    // WSL has its own router and accounts; an SSH twin of the project runs on its own host.
    if (
      target.runtime !== 'host' ||
      !store ||
      !spawn.worktreeId ||
      getConnectionExecutionHostId(spawn.connectionId) !== LOCAL_EXECUTION_HOST_ID
    ) {
      return null
    }
    const pinned = this.pinned(store, spawn.worktreeId)
    const route = pinned && this.route(pinned.choice)
    return pinned && route
      ? createProjectClaudeLaunch(this, pinned.repoId, pinned.choice, route)
      : null
  }

  /** A chat launch follows the pin its workspace's terminals follow; publishes like resolve(). */
  resolveLocation(location: ProjectClaudeLocation): ProjectClaudeLaunch | null {
    return location && isNativeLocalLocation(location)
      ? this.resolve(this.args.store, { worktreeId: location.workspaceId }, { runtime: 'host' })
      : null
  }

  /** The pin a chat in `location` follows, read without touching any account folder. */
  pinForLocation(location: ProjectClaudeLocation): ProjectAgentAccountChoice | null {
    if (!location || !isNativeLocalLocation(location) || !this.args.store) {
      return null
    }
    const choice = this.pinned(this.args.store, location.workspaceId)?.choice
    return choice && (choice.kind === 'system' || this.isPinnableAccount(choice.accountId))
      ? choice
      : null
  }

  /** Side-effect free, for reads that must not publish a pointer or start a setup. */
  routeForLocation(location: ProjectClaudeLocation): ProjectClaudeRoute | null {
    const choice = this.pinForLocation(location)
    return choice ? this.route(choice) : null
  }

  /** The route the pin still has, or null once it was changed or its account went away. */
  currentRoute(repoId: string, choice: ProjectAgentAccountChoice): ProjectClaudeRoute | null {
    const current = this.args.pins.get(repoId, 'claude')
    return current && sameChoice(current, choice) ? this.route(choice) : null
  }

  prepareAccount(accountId: string): Promise<string> {
    return this.args.router.prepareAccount(accountId)
  }

  systemDefaultHome(): string {
    return this.args.router.systemDefaultHome()
  }

  // Unpinned callers read only the in-memory pins.
  private pinned(
    store: ProjectAgentAccountRepoStore,
    worktreeId: string
  ): { repoId: string; choice: ProjectAgentAccountChoice } | null {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const choice = this.args.pins.get(repoId, 'claude')
    return choice && findProjectAgentAccountRepo(store, repoId) ? { repoId, choice } : null
  }

  private route(choice: ProjectAgentAccountChoice): ProjectClaudeRoute | null {
    const { router, dataRoot } = this.args
    if (choice.kind === 'system') {
      return { kind: 'system', pointerPath: projectClaudePointerPath(dataRoot, { kind: 'system' }) }
    }
    if (!this.isPinnableAccount(choice.accountId)) {
      return null
    }
    const pointerPath = projectClaudePointerPath(dataRoot, {
      kind: 'account',
      accountId: choice.accountId
    })
    // An account without its own login runs on the matching System default login, as globally.
    return router.coveredBySystemDefault(choice.accountId)
      ? { kind: 'system', pointerPath }
      : {
          kind: 'account',
          accountId: choice.accountId,
          home: router.accountHome(choice.accountId),
          pointerPath
        }
  }
}
