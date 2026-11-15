import type {
  LidAwakeActionResult,
  LidAwakeConfig,
  LidAwakeState
} from '../../shared/lid-closed-awake'

export type LidAwakeApi = {
  getState: () => Promise<LidAwakeState>
  onChanged: (callback: (state: LidAwakeState) => void) => () => void
  setConfig: (patch: Partial<LidAwakeConfig>) => Promise<LidAwakeActionResult>
  setup: () => Promise<LidAwakeActionResult>
  remove: () => Promise<LidAwakeActionResult>
  releaseNow: () => Promise<void>
}
