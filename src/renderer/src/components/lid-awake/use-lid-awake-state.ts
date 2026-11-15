import { useEffect, useState } from 'react'
import type { LidAwakeState } from '../../../../shared/lid-closed-awake'

/** null until the main process answers; stays null where the feature does not exist (not macOS, web client). */
export function useLidAwakeState(): LidAwakeState | null {
  const [state, setState] = useState<LidAwakeState | null>(null)
  useEffect(() => {
    const api = window.api?.lidAwake
    if (!api) {
      return
    }
    let mounted = true
    const unsubscribe = api.onChanged((next) => {
      if (mounted) {
        setState(next)
      }
    })
    void api
      .getState()
      .then((next) => {
        if (mounted) {
          setState(next)
        }
      })
      .catch(() => {})
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])
  return state
}
