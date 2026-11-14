import { customUpdateAssetName } from '../custom-update-manifest'

export const SAMPLE_ASSET_PREFIX = 'https://github.com/balakumardev/orca/releases/download/'
export const SAMPLE_SHA256 = 'a'.repeat(64)

/** A manifest exactly as custom/scripts/package-release.sh writes it. */
export function sampleManifest(
  version: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    version,
    tag: `v${version}`,
    base: `v${version.split('+')[0]}`,
    upstream_commit: 'f'.repeat(40),
    built_from_sha: 'e'.repeat(40),
    built_at: '2026-11-14T10:00:00Z',
    signed: true,
    team_id: 'KHD36T7C97',
    notarized: true,
    asset: customUpdateAssetName(version),
    sha256: SAMPLE_SHA256,
    size: 300_000_000,
    ...overrides
  }
}

/** A GitHub release as the REST API lists it, with the three assets the release workflow uploads. */
export function sampleRelease(
  version: string,
  overrides: { draft?: boolean; prerelease?: boolean; assets?: Record<string, unknown>[] } = {}
): Record<string, unknown> {
  const tag = `v${version}`
  const asset = (name: string, size: number): Record<string, unknown> => ({
    name,
    size,
    state: 'uploaded',
    browser_download_url: `${SAMPLE_ASSET_PREFIX}${tag}/${name}`
  })
  return {
    tag_name: tag,
    draft: overrides.draft ?? false,
    prerelease: overrides.prerelease ?? false,
    assets: overrides.assets ?? [
      asset('manifest.json', 600),
      asset(customUpdateAssetName(version), 300_000_000),
      asset(`${customUpdateAssetName(version)}.sha256`, 100)
    ]
  }
}
