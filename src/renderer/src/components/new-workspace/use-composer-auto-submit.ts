import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
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
  repo
}: {
  modalData: ComposerModalData
  createDisabled: boolean
  create: () => Promise<void>
  /** The id of the project the form resolved to. */
  repo: string
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
    const step = nextAutoSubmitStep({
      enabled,
      createDisabled,
      projectIsChosen: repo === modalData.initialRepoId,
      started: startedRef.current,
      timedOut
    })
    if (step === 'press') {
      startedRef.current = true
      void create().finally(showAsDialog)
    } else if (step === 'show') {
      showAsDialog()
    }
  }, [create, createDisabled, enabled, modalData.initialRepoId, repo, showAsDialog, timedOut])
  useEffect(() => {
    if (!enabled) {
      return
    }
    const timer = setTimeout(() => setTimedOut(true), AUTO_SUBMIT_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [enabled])
}
