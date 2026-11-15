import type { LidAwakeControllerDeps } from './lid-awake-controller-types'
import { RECOVERED_NOTICE, RECOVERY_FAILED_NOTICE } from './lid-awake-notices'

/** A crash, power loss or forced quit can leave sleep disabled; undo it only if the helper's own marker says it set it. */
export async function recoverLeftoverLidFlag(
  deps: Pick<LidAwakeControllerDeps, 'readSleepDisabled' | 'backend' | 'notify'>
): Promise<void> {
  if ((await deps.readSleepDisabled()) !== true) {
    return
  }
  const outcome = await deps.backend.reset()
  if (outcome === 'reset') {
    deps.notify(RECOVERED_NOTICE)
  } else if (outcome === 'failed') {
    deps.notify(RECOVERY_FAILED_NOTICE)
  }
}
