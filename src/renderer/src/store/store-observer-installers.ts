import type { AppState } from './types'
<<<<<<< HEAD
import { installTerminalParkingInputs } from './terminals/terminal-parking-input-transitions'
import { installProjectTodosWorktreeObserver } from '@/components/sidebar/project-todos/project-todos-worktree-observer'
||||||| c91a7a6ee3
import { installTerminalParkingInputs } from './terminals/terminal-parking-input-transitions'
=======
import { installTerminalParkingInputs } from './terminals/parking/terminal-parking-input-transitions'
import { installPRAutoRefreshCadenceObserver } from './github/refresh/pr-auto-refresh-cadence-observer'
>>>>>>> ea564105e3776ee51803bb69f0fc93494d5d7eba

export type StoreObserverHost = {
  getState: () => AppState
  subscribe: (listener: (state: AppState, previous: AppState) => void) => () => void
}

/** Observers installed once at store creation, before app consumers subscribe; none may wrap `set`. */
export type StoreObserverInstaller = (store: StoreObserverHost) => void

export const STORE_OBSERVER_INSTALLERS: readonly StoreObserverInstaller[] = [
  installTerminalParkingInputs,
<<<<<<< HEAD
  installProjectTodosWorktreeObserver
||||||| c91a7a6ee3
  installTerminalParkingInputs
=======
  installPRAutoRefreshCadenceObserver
>>>>>>> ea564105e3776ee51803bb69f0fc93494d5d7eba
]
