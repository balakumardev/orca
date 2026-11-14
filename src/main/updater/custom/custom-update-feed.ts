import { readCappedText } from './custom-update-capped-body'
import { CustomUpdateError } from './custom-update-errors'
import type { CustomUpdateFeedOrigin } from './custom-update-feed-origin'
import {
  CUSTOM_UPDATE_MANIFEST_ASSET,
  CUSTOM_UPDATE_REPO,
  parseCustomUpdateManifest,
  type CustomUpdateManifest
} from './custom-update-manifest'
import {
  compareCustomBuilds,
  isNewerCustomBuild,
  parseCustomBuildTag,
  type CustomBuildVersion
} from './custom-update-version'

export type CustomUpdateFetch = (url: string, init?: RequestInit) => Promise<Response>

export type CustomUpdateCandidate = {
  manifest: CustomUpdateManifest
  build: CustomBuildVersion
  releaseUrl: string
  zipUrl: string
}

export type CustomUpdateCheckOptions = {
  /** Versions to pass over, e.g. builds that failed verification: the next lower release is offered instead. */
  exclude?: ReadonlySet<string>
  /** A person asked: ignore a backoff that background checks honor. */
  force?: boolean
}

const RELEASES_PER_PAGE = 10
const REQUEST_TIMEOUT_MS = 30_000
const MAX_MANIFEST_BYTES = 16 * 1024
// Ten releases with their asset lists come to well under 1 MB; the cap only has to stop a runaway body.
const MAX_RELEASE_LIST_BYTES = 4 * 1024 * 1024
// Unauthenticated GitHub REST allows 60 requests an hour per IP. A check makes one list request, and manifests
// come from the release download host, which is not part of that quota.
const MIN_NETWORK_INTERVAL_MS = 60_000
const BACKOFF_BASE_MS = 15 * 60_000
const BACKOFF_MAX_MS = 6 * 60 * 60_000

type FeedDeps = {
  fetch: CustomUpdateFetch
  now: () => number
  origin: CustomUpdateFeedOrigin
  running: CustomBuildVersion
}

type ReleaseEntry = {
  tag: string
  build: CustomBuildVersion
  assets: Record<string, unknown>[]
  manifestUrl: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pathSegments(pathname: string): string[] | null {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
}

/** Only failures that mean "GitHub is unhappy" pause checks; being offline just fails this one check. */
function pausesChecks(failure: CustomUpdateError): boolean {
  return (
    failure.kind === 'rate-limited' || (failure.kind === 'feed' && (failure.status ?? 0) >= 500)
  )
}

export class CustomUpdateFeed {
  private etag: string | null = null
  private entries: ReleaseEntry[] | undefined
  private readonly candidates = new Map<string, CustomUpdateCandidate | null>()
  private blockedUntil = 0
  private consecutiveFailures = 0
  private lastNetworkAt = Number.NEGATIVE_INFINITY

  constructor(private readonly deps: FeedDeps) {}

  /** The newest eligible build that may replace the running one, or null. Throws `CustomUpdateError`. */
  async check(options: CustomUpdateCheckOptions = {}): Promise<CustomUpdateCandidate | null> {
    const now = this.deps.now()
    if (!options.force && now < this.blockedUntil) {
      throw new CustomUpdateError(
        'rate-limited',
        'Update checks are paused after a failed request',
        {
          retryAfterMs: this.blockedUntil - now
        }
      )
    }
    try {
      if (this.entries === undefined || now - this.lastNetworkAt >= MIN_NETWORK_INTERVAL_MS) {
        await this.refreshReleases()
      }
      const candidate = await this.select(options.exclude)
      this.consecutiveFailures = 0
      this.blockedUntil = 0
      return candidate
    } catch (error) {
      throw this.recordFailure(error)
    }
  }

  /** Milliseconds a caller should wait before asking again; 0 when requests are allowed. */
  get retryDelayMs(): number {
    return Math.max(0, this.blockedUntil - this.deps.now())
  }

  private recordFailure(error: unknown): CustomUpdateError {
    const failure =
      error instanceof CustomUpdateError
        ? error
        : new CustomUpdateError('network', error instanceof Error ? error.message : String(error), {
            cause: error
          })
    if (pausesChecks(failure)) {
      this.consecutiveFailures += 1
      const exponential = Math.min(
        BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1),
        BACKOFF_MAX_MS
      )
      const delay = Math.min(Math.max(failure.retryAfterMs ?? 0, exponential), BACKOFF_MAX_MS)
      this.blockedUntil = this.deps.now() + delay
    }
    return failure
  }

  /** One GET with its own timeout and a handle that cuts the transfer, not just the reader on top of it. */
  private async request(
    url: string,
    headers?: Record<string, string>
  ): Promise<{ response: Response; abort: () => void }> {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    const response = await this.deps.fetch(url, { ...(headers ? { headers } : {}), signal })
    return { response, abort: () => controller.abort() }
  }

  private async refreshReleases(): Promise<void> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
    if (this.etag && this.entries !== undefined) {
      headers['If-None-Match'] = this.etag
    }
    const url = `${this.deps.origin.apiBase}/repos/${CUSTOM_UPDATE_REPO}/releases?per_page=${RELEASES_PER_PAGE}`
    this.lastNetworkAt = this.deps.now()
    const { response, abort } = await this.request(url, headers)
    if (response.status === 304 && this.entries !== undefined) {
      abort()
      return
    }
    if (response.status === 403 || response.status === 429) {
      abort()
      throw new CustomUpdateError(
        'rate-limited',
        `GitHub refused the release query (${response.status})`,
        { status: response.status, retryAfterMs: this.retryAfterMs(response) }
      )
    }
    if (!response.ok) {
      abort()
      throw new CustomUpdateError(
        'feed',
        `GitHub answered the release query with ${response.status}`,
        { status: response.status }
      )
    }
    const text = await readCappedText(response, MAX_RELEASE_LIST_BYTES, abort)
    if (text === null) {
      throw new CustomUpdateError('feed', 'The release list is larger than expected')
    }
    let releases: unknown
    try {
      releases = JSON.parse(text)
    } catch {
      throw new CustomUpdateError('feed', 'The release list is not valid JSON')
    }
    if (!Array.isArray(releases)) {
      throw new CustomUpdateError('feed', 'The release list is not an array')
    }
    const entries: ReleaseEntry[] = []
    for (const release of releases) {
      const entry = this.toReleaseEntry(release)
      if (entry) {
        entries.push(entry)
      }
    }
    entries.sort((left, right) => compareCustomBuilds(right.build, left.build))
    this.entries = entries
    this.candidates.clear()
    this.etag = response.headers.get('etag')
  }

  private retryAfterMs(response: Response): number {
    const retryAfter = Number(response.headers.get('retry-after'))
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter * 1000
    }
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    if (
      response.headers.get('x-ratelimit-remaining') === '0' &&
      Number.isFinite(reset) &&
      reset > 0
    ) {
      return Math.max(0, reset * 1000 - this.deps.now())
    }
    return 0
  }

  private async select(
    exclude: ReadonlySet<string> | undefined
  ): Promise<CustomUpdateCandidate | null> {
    for (const entry of this.entries ?? []) {
      if (exclude?.has(entry.build.version)) {
        continue
      }
      const candidate = await this.loadCandidate(entry)
      if (candidate) {
        return candidate
      }
    }
    return null
  }

  private toReleaseEntry(release: unknown): ReleaseEntry | null {
    if (!isRecord(release) || release.draft !== false || release.prerelease !== false) {
      return null
    }
    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
    const build = parseCustomBuildTag(tag)
    // The tag is only a cheap pre-filter; the manifest has to agree with it.
    if (!build || !isNewerCustomBuild(this.deps.running, build) || !Array.isArray(release.assets)) {
      return null
    }
    const assets = release.assets.filter(isRecord)
    const manifestUrl = this.assetUrl(assets, CUSTOM_UPDATE_MANIFEST_ASSET, tag)
    return manifestUrl ? { tag, build, assets, manifestUrl } : null
  }

  /**
   * The download URL of a release asset, accepted only when it names exactly `<release downloads>/<tag>/<asset>`
   * on the expected origin. The parsed form is compared, so `..` segments, userinfo and queries cannot pass.
   */
  private assetUrl(assets: Record<string, unknown>[], name: string, tag: string): string | null {
    const asset = assets.find((entry) => entry.name === name)
    const value = asset?.browser_download_url
    if (typeof value !== 'string' || (asset?.state !== undefined && asset.state !== 'uploaded')) {
      return null
    }
    try {
      const actual = new URL(value)
      const base = new URL(this.deps.origin.assetUrlPrefix)
      const actualSegments = pathSegments(actual.pathname)
      const baseSegments = pathSegments(base.pathname)
      const exact =
        actual.origin === base.origin &&
        !actual.username &&
        !actual.password &&
        !actual.search &&
        !actual.hash &&
        actualSegments !== null &&
        baseSegments !== null &&
        [...baseSegments, tag, name].join('/') === actualSegments.join('/') &&
        actualSegments.length === baseSegments.length + 2
      return exact ? actual.href : null
    } catch {
      return null
    }
  }

  private async loadCandidate(entry: ReleaseEntry): Promise<CustomUpdateCandidate | null> {
    if (this.candidates.has(entry.tag)) {
      return this.candidates.get(entry.tag) ?? null
    }
    const candidate = await this.fetchCandidate(entry)
    this.candidates.set(entry.tag, candidate)
    return candidate
  }

  private async fetchCandidate(entry: ReleaseEntry): Promise<CustomUpdateCandidate | null> {
    const { response, abort } = await this.request(entry.manifestUrl)
    // A deleted manifest invalidates this release only; any other failure may clear up, so it fails the check.
    if (response.status === 404) {
      abort()
      return null
    }
    if (!response.ok) {
      abort()
      throw new CustomUpdateError(
        'feed',
        `The manifest of ${entry.tag} answered ${response.status}`,
        { status: response.status }
      )
    }
    // Read through a cap: a manifest is a few hundred bytes, and the body must not be buffered whole first.
    const text = await readCappedText(response, MAX_MANIFEST_BYTES, abort)
    let raw: unknown
    try {
      raw = text === null ? null : JSON.parse(text)
    } catch {
      return null
    }
    const parsed = parseCustomUpdateManifest(raw, entry.tag)
    if (!parsed.ok || parsed.manifest.version !== entry.build.version) {
      return null
    }
    const { manifest } = parsed
    const zipUrl = this.assetUrl(entry.assets, manifest.asset, entry.tag)
    const zipAsset = entry.assets.find((asset) => asset.name === manifest.asset)
    if (!zipUrl || (typeof zipAsset?.size === 'number' && zipAsset.size !== manifest.size)) {
      return null
    }
    return {
      manifest,
      build: entry.build,
      zipUrl,
      releaseUrl: `https://github.com/${CUSTOM_UPDATE_REPO}/releases/tag/${encodeURIComponent(entry.tag)}`
    }
  }
}
