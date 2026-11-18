import { useAppStore } from '@/store/index'
import { buildAiVaultResumeStartupForWorktree } from '@/lib/agent-session/resume/history/ai-vault-resume-command'
import { describeAiVaultResumeFailure } from '@/lib/agent-session/resume/history/ai-vault-resume-refusal'
import {
  dropDeletedRemoteResumeCwd,
  prepareAiVaultSessionForTerminalResume
} from '@/lib/agent-session/resume/history/ai-vault-session-resume-preparation'
import { launchAiVaultSessionAndReveal } from '@/lib/agent-session/resume/history/launch-ai-vault-session-and-reveal'
import { notifyAiVaultSessionPreparationFailure } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-launch-feedback'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'

/**
 * Resumes a closed conversation in a new terminal tab of `workspaceId` with the steps and toasts of the
 * Agents panel's resume button (`handleResume` in `useAiVaultSessionLaunchActions`). The caller already
 * checked at Enter that the button could resume it there.
 */
export async function resumePaletteSessionInTerminal(
  session: AiVaultSession,
  workspaceId: string
): Promise<void> {
  const describeFailure = (message: string): string =>
    describeAiVaultResumeFailure(new Error(message), session.agent)
  try {
    const prepared = await dropDeletedRemoteResumeCwd(
      await prepareAiVaultSessionForTerminalResume(session)
    )
    const state = useAppStore.getState()
    const startup = buildAiVaultResumeStartupForWorktree({
      state,
      worktreeId: workspaceId,
      session: prepared,
      commandOverride: state.settings?.agentCmdOverrides?.[session.agent]
    })
    await launchAiVaultSessionAndReveal(
      { agent: session.agent, worktreeId: workspaceId, ...startup },
      describeFailure
    )
  } catch (error) {
    notifyAiVaultSessionPreparationFailure(error, session.agent, describeFailure)
  }
}
