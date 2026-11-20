import type {
  ProjectAgentAccountSetRequest,
  ProjectAgentAccountsSnapshot
} from '../../shared/project-agent-accounts'

export type ProjectAgentAccountsApi = {
  list: () => Promise<ProjectAgentAccountsSnapshot>
  set: (request: ProjectAgentAccountSetRequest) => Promise<ProjectAgentAccountsSnapshot>
  onChanged: (listener: (snapshot: ProjectAgentAccountsSnapshot) => void) => () => void
}
