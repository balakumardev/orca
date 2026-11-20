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
import {
  isPaletteSearchHostCurrent,
  paletteSearchHostGuard,
  type PaletteSearchHost
} from './palette-search-hosts'
import { guardedAiVaultResumeRequest } from '@/lib/agent-session/resume/history/ai-vault-session-resume-host-request'
import { paletteSessionOwnerState } from './palette-session-owner-state'
import { readHostAgentLaunchDefaults } from '@/runtime/agent-launch-settings/agent-launch-settings-transport'

/**
 * Resumes a closed conversation in a new terminal tab of `workspaceId` with the steps and toasts of the
 * Agents panel's resume button (`handleResume` in `useAiVaultSessionLaunchActions`). The caller already
 * checked at Enter that the button could resume it there.
 */
export async function resumePaletteSessionInTerminal(
  session: AiVaultSession,
  workspaceId: string,
  host?: PaletteSearchHost
): Promise<void> {
  const isCurrent = () => !host || isPaletteSearchHostCurrent(host)
  const describeFailure = (message: string): string =>
    describeAiVaultResumeFailure(new Error(message), session.agent)
  try {
    if (!isCurrent()) {
      return
    }
    const preparedHome = await prepareAiVaultSessionForTerminalResume(
      session,
      guardedAiVaultResumeRequest(session.executionHostId, paletteSearchHostGuard(host))
    )
    if (!isCurrent()) {
      return
    }
    const prepared = await dropDeletedRemoteResumeCwd(preparedHome)
    if (!isCurrent()) {
      return
    }
    const state = paletteSessionOwnerState(useAppStore.getState(), session.executionHostId)
    // CLI command overrides and arguments are read from the recording server, never the desktop.
    const defaults = host?.runtimeEnvironmentId
      ? await readHostAgentLaunchDefaults({
          environmentId: host.runtimeEnvironmentId,
          pairingRevision: host.pairingRevision ?? undefined,
          runtimeId: host.runtimeId ?? undefined
        })
      : null
    if (!isCurrent()) {
      return
    }
    const launchSettings = host?.runtimeEnvironmentId ? defaults?.settings : state.settings
    const startup = buildAiVaultResumeStartupForWorktree({
      state,
      launchSettings: launchSettings ?? null,
      worktreeId: workspaceId,
      session: prepared,
      commandOverride: launchSettings?.agentCmdOverrides?.[session.agent],
      agentArgs: launchSettings?.agentDefaultArgs?.[session.agent]
    })
    await launchAiVaultSessionAndReveal(
      {
        agent: session.agent,
        worktreeId: workspaceId,
        executionHostId: session.executionHostId,
        targetGuard: paletteSearchHostGuard(host),
        isCurrent,
        // Forward the search snapshot rather than recapturing the host after preparation.
        expectedEnvironmentRuntimeId: host?.runtimeId ?? undefined,
        ...startup
      },
      describeFailure
    )
  } catch (error) {
    if (isCurrent()) {
      notifyAiVaultSessionPreparationFailure(error, session.agent, describeFailure)
    }
  }
}
