import type { LidAwakeActionResult } from '../../../shared/lid-closed-awake'
import type { LidAwakeController } from './lid-awake-controller'
import type { LidAwakeControllerDeps } from './lid-awake-controller-types'

type HelperDeps = Pick<LidAwakeControllerDeps, 'installHelper' | 'removeHelper'>

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The one admin prompt: install the helper, then turn the option on. */
export async function setupLidHelper(
  controller: LidAwakeController,
  deps: HelperDeps
): Promise<LidAwakeActionResult> {
  try {
    await deps.installHelper()
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
  if ((await controller.refreshSetupState()) === 'not-installed') {
    return { ok: false, error: 'The helper did not install.' }
  }
  return controller.setConfig({ enabled: true })
}

/** Turns the option off and lets go of any hold before the helper is deleted. */
export async function removeLidHelperAndOption(
  controller: LidAwakeController,
  deps: HelperDeps
): Promise<LidAwakeActionResult> {
  await controller.setConfig({ enabled: false })
  await controller.settled()
  try {
    await deps.removeHelper()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  } finally {
    await controller.refreshSetupState()
  }
}
