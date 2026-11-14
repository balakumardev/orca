import { vi } from 'vitest'
import type { CycleRequest } from '../custom-update-cycle'
import { CustomUpdateError } from '../custom-update-errors'
import type { CustomUpdateCandidate, CustomUpdateCheckOptions } from '../custom-update-feed'
import { parseCustomUpdateManifest } from '../custom-update-manifest'
import { CustomUpdateState } from '../custom-update-state'
import { parseCustomBuildVersion } from '../custom-update-version'
import type { CustomUpdaterDeps } from '../custom-updater-types'
import { SAMPLE_SHA256, sampleManifest } from './custom-update-sample-release'

export const V7 = '1.4.258+custom.7'
export const V6 = '1.4.258+custom.6'

export function candidate(
  version: string,
  overrides: Record<string, unknown> = {}
): CustomUpdateCandidate {
  const parsed = parseCustomUpdateManifest(sampleManifest(version, overrides), `v${version}`)
  const build = parseCustomBuildVersion(version)
  if (!parsed.ok || !build) {
    throw new Error('bad candidate fixture')
  }
  return {
    manifest: parsed.manifest,
    build,
    zipUrl: `https://github.com/balakumardev/orca/releases/download/v${version}/${parsed.manifest.asset}`,
    releaseUrl: `https://github.com/balakumardev/orca/releases/tag/v${version}`
  }
}

export const verificationFailure = (): CustomUpdateError =>
  new CustomUpdateError('verification', 'Update check "signing-requirement" failed')

export function setup(options: {
  offers: CustomUpdateCandidate[]
  /** What `verify` throws for a version, as a plain value so a test can pass an error nobody classified. */
  failingVersions?: Record<string, unknown>
  /** What `download` throws for a version, after it has been recorded as started. */
  downloadFailures?: Record<string, unknown>
  /** What `stage` throws for a version, as a plain value so a test can pass an error nobody classified. */
  stagingFailures?: Record<string, unknown>
  userInitiated?: boolean
  rejected?: string[]
  ignoreExclude?: boolean
  /** Free space on the disk, as the cycle reads it before it downloads. */
  free?: () => number
  /** State from an earlier run, as after a restart. */
  state?: CustomUpdateState
  /** The clock of the state and of the updater. */
  now?: () => number
}) {
  const downloaded: string[] = []
  const now = options.now ?? ((): number => 1)
  const currentVersion = (): string | undefined =>
    /v(1\.4\.258\+custom\.\d+)\//.exec(downloaded.at(-1) ?? '')?.[1]
  const state = options.state ?? new CustomUpdateState(null, now)
  for (const version of options.rejected ?? []) {
    state.reject(version, SAMPLE_SHA256, 'verification')
  }
  const everyVersion = options.offers.map((offer) => offer.manifest.version)
  // The versions the state holds against the offered releases.
  const rejected = (): Set<string> =>
    new Set(everyVersion.filter((version) => state.isRejected(version, SAMPLE_SHA256)))
  const check = vi.fn(
    async (check?: CustomUpdateCheckOptions) =>
      options.offers.find(
        (offer) => options.ignoreExclude || !check?.exclude?.has(offer.manifest.version)
      ) ?? null
  )
  const log = vi.fn()
  const deps = {
    now,
    getFreeBytes: async () => options.free?.() ?? 10 ** 12,
    log,
    mac: { beginDownload: vi.fn() },
    download: vi.fn(async (request: { url: string }) => {
      downloaded.push(request.url)
      const version = currentVersion()
      if (version && options.downloadFailures && version in options.downloadFailures) {
        throw options.downloadFailures[version]
      }
    }),
    verify: vi.fn(async ({ manifest }: { manifest: { version: string } }) => {
      const failure = options.failingVersions?.[manifest.version]
      if (failure) {
        throw failure
      }
      return ['archive-layout']
    }),
    stage: vi.fn(async () => {
      const version = currentVersion()
      if (version && options.stagingFailures && version in options.stagingFailures) {
        throw options.stagingFailures[version]
      }
    }),
    nativeUpdater: () => ({}),
    prepareStaging: () => null
  } as unknown as CustomUpdaterDeps
  const request: CycleRequest = {
    feed: { check, retryDelayMs: 0 },
    host: { sendStatus: vi.fn() },
    deps,
    state,
    userInitiated: options.userInitiated ?? false,
    updatesRoot: '/nonexistent-orca-updates',
    onDownloadStart: vi.fn(async () => undefined)
  }
  return {
    request,
    check,
    log,
    state,
    get rejected() {
      return rejected()
    },
    downloaded,
    deps
  }
}
