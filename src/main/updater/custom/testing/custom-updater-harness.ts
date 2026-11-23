import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, vi } from 'vitest'
import type { UpdateStatus } from '../../../../shared/updater/update-status-types'
import type { CustomUpdateCandidate, CustomUpdateCheckOptions } from '../custom-update-feed'
import { parseCustomUpdateManifest } from '../custom-update-manifest'
import { parseCustomBuildVersion } from '../custom-update-version'
import { CustomUpdater } from '../custom-updater'
import type { CustomUpdaterDeps, CustomUpdaterHost } from '../custom-updater-types'
import { sampleManifest } from './custom-update-sample-release'

export const RUNNING = '1.4.258+custom.4'
export const NEXT = '1.4.258+custom.5'
export const FIRST_CHECK_MS = 90_000

export function candidateFor(version: string, manifestOverrides: Record<string, unknown> = {}) {
  const parsed = parseCustomUpdateManifest(
    sampleManifest(version, manifestOverrides),
    `v${version}`
  )
  const build = parseCustomBuildVersion(version)
  if (!parsed.ok || !build) {
    throw new Error('bad candidate fixture')
  }
  const candidate: CustomUpdateCandidate = {
    manifest: parsed.manifest,
    build,
    zipUrl: `https://github.com/balakumardev/orca/releases/download/v${version}/${parsed.manifest.asset}`,
    releaseUrl: `https://github.com/balakumardev/orca/releases/tag/v${version}`
  }
  return candidate
}

export function createHarness(
  userDataDir: string,
  overrides: Partial<CustomUpdaterDeps> = {},
  version = RUNNING
) {
  const statuses: UpdateStatus[] = []
  let current: UpdateStatus = { state: 'idle' }
  const host: CustomUpdaterHost = {
    getCurrentStatus: () => current,
    hasInstallableDownloadedVersion: () => false,
    getPendingInstallVersion: () => '',
    getKnownReleaseUrl: () => undefined,
    performQuitAndInstall: vi.fn(),
    commitStagedMacInstall: vi.fn(),
    finishMacStaging: () => null,
    isAwaitingMacStaging: () => false,
    failMacStaging: vi.fn(),
    shouldDeferMacQuitForInstall: () => true,
    sendStatus: vi.fn((status: UpdateStatus) => {
      current = status
      statuses.push(status)
    }),
    isInstalling: vi.fn(() => false),
    handleQuitAndInstallFailure: vi.fn(() => true)
  }
  const nativeUpdater = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn()
  })
  const feed = {
    check: vi
      .fn<(options?: CustomUpdateCheckOptions) => Promise<CustomUpdateCandidate | null>>()
      .mockResolvedValue(null),
    retryDelayMs: 0
  }
  const steps: string[] = []
  const deps: CustomUpdaterDeps = {
    runtime: () => ({
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      version,
      userDataDir
    }),
    env: {},
    now: () => Date.now(),
    // Answered at once: a real statfs would finish outside the fake clock's reach and make timing in these tests depend on the disk.
    getFreeBytes: async () => 10 ** 12,
    random: () => 0.5,
    fetch: vi.fn(),
    nativeUpdater: () => nativeUpdater,
    prepareStaging: () => null,
    createFeed: vi.fn(() => feed),
    download: vi.fn(async (request) => {
      steps.push('download')
      await mkdir(dirname(request.destination), { recursive: true })
      await writeFile(request.destination, 'zip')
      request.onProgress(40)
    }),
    verify: vi.fn(async () => {
      steps.push('verify')
      return ['archive-layout']
    }),
    stage: vi.fn(async () => {
      steps.push('stage')
    }),
    mac: {
      beginDownload: vi.fn(),
      setPreflightInProgress: vi.fn(),
      registerEvents: vi.fn(),
      installDelayMs: 100
    },
    log: vi.fn(),
    ...overrides
  }
  const updater = new CustomUpdater(deps)
  const settle = () => vi.advanceTimersByTimeAsync(0)
  return {
    updater,
    host,
    deps,
    feed,
    nativeUpdater,
    statuses,
    steps,
    settle,
    current: () => current
  }
}

export type Harness = ReturnType<typeof createHarness>

/** A feed that serves these candidates newest first and skips the versions a check excludes. */
export function offer(t: Harness, ...candidates: CustomUpdateCandidate[]): void {
  t.feed.check.mockImplementation(
    async (options) =>
      candidates.find((candidate) => !options?.exclude?.has(candidate.manifest.version)) ?? null
  )
}

export async function untilStatus(t: Harness, state: UpdateStatus['state']): Promise<void> {
  await vi.waitFor(() => expect(t.current().state).toBe(state))
}
