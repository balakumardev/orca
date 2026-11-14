import type { UpdateCheckOptions } from '../../../shared/update-status-types'
import type { registerMacUpdaterEvents } from '../mac-install/updater-mac-install'
import type { downloadUpdateZip } from './custom-update-download'
import type {
  CustomUpdateCandidate,
  CustomUpdateCheckOptions,
  CustomUpdateFetch
} from './custom-update-feed'
import type { CustomUpdateFeedOrigin } from './custom-update-feed-origin'
import type { NativeUpdaterPort, stageUpdateWithSquirrel } from './custom-update-squirrel-staging'
import type {
  CommandRunner,
  VerifyBundleRequest,
  verifyUpdateBundle
} from './custom-update-verifier'
import type { CustomBuildVersion } from './custom-update-version'

export type MacUpdaterEventsContext = Parameters<typeof registerMacUpdaterEvents>[0]

/** What the updater needs from upstream's lifecycle: status delivery and its install preflight. */
export type CustomUpdaterHost = MacUpdaterEventsContext & {
  isInstalling: () => boolean
  handleQuitAndInstallFailure: (error?: unknown) => boolean
}

export type CustomUpdateFeedPort = {
  check: (options?: CustomUpdateCheckOptions) => Promise<CustomUpdateCandidate | null>
  readonly retryDelayMs: number
}

export type CustomUpdaterDeps = {
  runtime: () => {
    platform: string
    arch: string
    isPackaged: boolean
    version: string
    userDataDir: string
  }
  env: Record<string, string | undefined>
  now: () => number
  random: () => number
  fetch: CustomUpdateFetch
  nativeUpdater: () => NativeUpdaterPort
  runCommand?: CommandRunner
  getFreeBytes?: (directory: string) => Promise<number>
  extraction?: VerifyBundleRequest['extraction']
  prepareStaging: () => Promise<void> | null
  createFeed: (config: {
    running: CustomBuildVersion
    origin: CustomUpdateFeedOrigin
  }) => CustomUpdateFeedPort
  download: typeof downloadUpdateZip
  verify: typeof verifyUpdateBundle
  stage: typeof stageUpdateWithSquirrel
  mac: {
    beginDownload: () => void
    setPreflightInProgress: (value: boolean) => void
    registerEvents: (context: MacUpdaterEventsContext) => void
    installDelayMs: number
  }
  log: (event: string, data?: Record<string, string | number | boolean | null>) => void
}

/** What upstream's `UpdaterSetup` calls; a fake of this is all a test of the hooks needs. */
export type CustomUpdaterPort = {
  start: (host: CustomUpdaterHost) => boolean
  checkFromMenu: (options?: UpdateCheckOptions) => boolean
  checkInBackground: () => boolean
  download: () => boolean
  quitAndInstall: () => boolean
  invokeNativeInstall: () => boolean
}
