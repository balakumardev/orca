import { parseCustomBuildVersion } from './custom-update-version'

export const CUSTOM_UPDATE_REPO = 'balakumardev/orca'
export const CUSTOM_UPDATE_MANIFEST_ASSET = 'manifest.json'
/** Developer ID team that signs our builds (CoolSolve LLP); a bundle from any other team never installs. */
export const CUSTOM_UPDATE_TEAM_ID = 'KHD36T7C97'
/** Squirrel only accepts a bundle with the identifier of the running app. */
export const CUSTOM_UPDATE_BUNDLE_ID = 'com.stablyai.orca'
export const CUSTOM_UPDATE_MAX_ZIP_BYTES = 1024 ** 3

// What custom/scripts/package-release.sh writes into manifest.json.
export type CustomUpdateManifest = {
  version: string
  tag: string
  base: string
  asset: string
  sha256: string
  size: number
  signed: boolean
  teamId: string | null
  notarized: boolean
}

export type ManifestParseResult =
  | { ok: true; manifest: CustomUpdateManifest }
  | { ok: false; reason: string }

export function customUpdateAssetName(version: string): string {
  return `Orca-${version}-arm64-mac.zip`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(reason: string): ManifestParseResult {
  return { ok: false, reason }
}

/** Structure and cross-field consistency only; whether the build is trusted is `manifestTrustFailure`. */
export function parseCustomUpdateManifest(raw: unknown, releaseTag: string): ManifestParseResult {
  if (!isRecord(raw)) {
    return fail('manifest is not an object')
  }
  const { version, tag, base, asset, sha256, size, signed, team_id: teamId, notarized } = raw
  if (typeof version !== 'string') {
    return fail('manifest version is missing')
  }
  const build = parseCustomBuildVersion(version)
  if (!build) {
    return fail(`manifest version ${version} is not a custom build version`)
  }
  if (tag !== releaseTag || releaseTag !== `v${version}`) {
    return fail('manifest tag does not match the release tag and version')
  }
  if (typeof base !== 'string') {
    return fail('manifest base is missing')
  }
  if (/^v?(\d+\.\d+\.\d+)$/.exec(base)?.[1] !== build.core.join('.')) {
    return fail('manifest base does not match the version')
  }
  if (asset !== customUpdateAssetName(version)) {
    return fail('manifest asset name does not match the version')
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    return fail('manifest sha256 is not a lowercase sha256 digest')
  }
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > CUSTOM_UPDATE_MAX_ZIP_BYTES
  ) {
    return fail('manifest size is out of range')
  }
  if (typeof signed !== 'boolean' || typeof notarized !== 'boolean') {
    return fail('manifest signed/notarized flags are missing')
  }
  if (teamId !== null && typeof teamId !== 'string') {
    return fail('manifest team_id is malformed')
  }
  return {
    ok: true,
    manifest: { version, tag, base, asset, sha256, size, signed, teamId, notarized }
  }
}

/** The claims a download is held to before any byte is fetched; null means the manifest may proceed. */
export function manifestTrustFailure(manifest: CustomUpdateManifest): string | null {
  if (!manifest.signed || !manifest.notarized) {
    return 'the release is not marked signed and notarized'
  }
  if (manifest.teamId !== CUSTOM_UPDATE_TEAM_ID) {
    return 'the release is signed by an unexpected team'
  }
  return null
}
