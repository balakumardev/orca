import type { CommitMessageGenerationTarget } from '../../text-generation/source-control-text-generation-types'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../../text-generation/execution/commit-message-agent-environment'
import { projectClaudeGenerationTarget } from '../../claude-accounts/project-binding/project-claude-workspace'
import type { ProjectClaudeLocation } from '../../claude-accounts/project-binding/project-claude-binding'

export async function resolveGenerationTarget(
  worktreePath: string,
  agentId: string,
  deps: { getAgentEnvResolvers: () => CommitMessageAgentEnvironmentResolvers | undefined },
  workspace?: string | ProjectClaudeLocation
): Promise<CommitMessageGenerationTarget | null> {
  const localEnv = await prepareLocalCommitMessageAgentEnv(
    agentId,
    deps.getAgentEnvResolvers(),
    projectClaudeGenerationTarget(agentId, workspace, worktreePath)
  )
  if (!localEnv.ok) {
    return null
  }
  return { kind: 'local', cwd: worktreePath, ...(localEnv.env ? { env: localEnv.env } : {}) }
}
