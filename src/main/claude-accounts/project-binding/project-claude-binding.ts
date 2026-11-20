import {
  getConnectionExecutionHostId,
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
    // An unpinned spawn reads only the in-memory pins.
    const repoId = getRepoIdFromWorktreeId(spawn.worktreeId)
    const choice = this.args.pins.get(repoId, 'claude')
    if (!choice || !findProjectAgentAccountRepo(store, repoId)) {
      return null
    }
    const route = this.route(choice)
    return route ? createProjectClaudeLaunch(this, repoId, choice, route) : null
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
