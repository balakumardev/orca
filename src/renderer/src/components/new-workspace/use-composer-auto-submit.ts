import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import type { ComposerCardSourceProps } from '@/hooks/composer-state/card-projection/composer-card-contract'
import { isPaletteSearchHostCurrent } from '../cmd-j/palette-search-hosts'
import {
  AUTO_SUBMIT_TIMEOUT_MS,
  nextAutoSubmitStep,
  stillNeedsUser,
  withoutAutoSubmit
} from './composer-auto-submit-open'
import type { ComposerModalData } from './composer/composer-modal-data'

/**
 * The Cmd+J name step opens the dialog with `autoSubmit`: the dialog is hidden and non-modal (no overlay, blur,
 * pointer lock or focus trap) and presses its own Create as soon as the form is ready, so the default agent,
 * setup policy and remote projects are the dialog's own. When Create leaves it open (a setup prompt, an error)
 * or the form is not ready in time, the dialog is opened again as an ordinary one, without the flag. A form that
 * resolved to another project than the one opened for (it falls back when that one's host is unknown) is shown
 * at once and creates nothing.
 */
export function useComposerAutoSubmit({
  modalData,
  createDisabled,
  create,
  target
}: {
  modalData: ComposerModalData
  createDisabled: boolean
  create: () => Promise<void>
  /** The host-owned project and checkout the form resolved to. */
  target: Pick<
    ComposerCardSourceProps,
    'repoId' | 'selectedProjectId' | 'selectedRepoExecutionHostId' | 'selectedProjectHostSetupId'
  >
}): void {
  const enabled = modalData.autoSubmit === true
  const startedRef = useRef(false)
  const [timedOut, setTimedOut] = useState(false)
  const showAsDialog = useCallback((): void => {
    const live = useAppStore.getState()
    if (stillNeedsUser(live, modalData)) {
      live.openModal('new-workspace-composer', withoutAutoSubmit(modalData))
    }
  }, [modalData])
  useEffect(() => {
    // Repo ids can collide across hosts; hidden creation requires the complete chosen target.
    const expected = modalData.initialWorkspaceTarget
    const targetIsChosen =
      !expected ||
      (target.selectedRepoExecutionHostId === expected.hostId &&
        target.selectedProjectId === expected.projectId &&
        (!expected.projectHostSetupId ||
          target.selectedProjectHostSetupId === expected.projectHostSetupId))
    // A ready replacement can reuse every target id while the hidden form waits.
    const host = modalData.autoSubmitHost
    const hostIsChosen =
      !expected?.hostId.startsWith('runtime:') ||
      Boolean(host && host.executionHostId === expected?.hostId && isPaletteSearchHostCurrent(host))
    const step = nextAutoSubmitStep({
      enabled,
      createDisabled,
      projectIsChosen: target.repoId === modalData.initialRepoId && targetIsChosen && hostIsChosen,
      started: startedRef.current,
      timedOut
    })
    if (step === 'press') {
      startedRef.current = true
      void create().finally(showAsDialog)
    } else if (step === 'show') {
      showAsDialog()
    }
  }, [create, createDisabled, enabled, modalData, showAsDialog, target, timedOut])
  useEffect(() => {
    if (!enabled) {
      return
    }
    const timer = setTimeout(() => setTimedOut(true), AUTO_SUBMIT_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [enabled])
}
