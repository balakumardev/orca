import { useCallback, useRef } from 'react'
import { isPaletteSearchHostCurrent } from '../cmd-j/palette-search-hosts'
import type { ComposerModalData } from './composer/composer-modal-data'

/** Dismissal cancels submissions; hidden ones also expire with their captured search owner. */
export function useComposerSubmissionCancellation(
  modalData: ComposerModalData,
  onClose: () => void
) {
  const submitCancelledRef = useRef(false)
  const handleDismiss = useCallback(() => {
    submitCancelledRef.current = true
    onClose()
  }, [onClose])
  const submissionHost = modalData.autoSubmit ? modalData.autoSubmitHost : undefined
  const isSubmissionCancelled = useCallback(
    () =>
      submitCancelledRef.current ||
      Boolean(submissionHost && !isPaletteSearchHostCurrent(submissionHost)),
    [submissionHost]
  )
  return { handleDismiss, isSubmissionCancelled }
}
