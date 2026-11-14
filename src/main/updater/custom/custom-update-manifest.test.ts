import { describe, expect, it } from 'vitest'
import { manifestTrustFailure, parseCustomUpdateManifest } from './custom-update-manifest'
import { SAMPLE_SHA256, sampleManifest } from './testing/custom-update-sample-release'

const VERSION = '1.4.258+custom.5'
const TAG = `v${VERSION}`

function parse(overrides: Record<string, unknown> = {}, tag = TAG) {
  return parseCustomUpdateManifest(sampleManifest(VERSION, overrides), tag)
}

describe('custom update manifest', () => {
  it('reads the manifest the release workflow writes', () => {
    expect(parse()).toEqual({
      ok: true,
      manifest: {
        version: VERSION,
        tag: TAG,
        base: 'v1.4.258',
        asset: 'Orca-1.4.258+custom.5-arm64-mac.zip',
        sha256: SAMPLE_SHA256,
        size: 300_000_000,
        signed: true,
        teamId: 'KHD36T7C97',
        notarized: true
      }
    })
  })

  it('accepts a zip of exactly 1 GiB', () => {
    expect(parse({ size: 1024 ** 3 }).ok).toBe(true)
  })

  it('accepts a base without the v prefix', () => {
    expect(parse({ base: '1.4.258' }).ok).toBe(true)
  })

  it.each([
    ['not an object', null],
    ['an array', []]
  ])('rejects a manifest that is %s', (_name, raw) => {
    expect(parseCustomUpdateManifest(raw, TAG).ok).toBe(false)
  })

  it.each([
    ['a version that is not a custom build', { version: '1.4.258' }],
    ['a tag that differs from the release tag', { tag: 'v1.4.258+custom.6' }],
    ['a base that differs from the version', { base: 'v1.4.259' }],
    ['a missing base', { base: undefined }],
    ['an asset named for another version', { asset: 'Orca-1.4.258+custom.4-arm64-mac.zip' }],
    ['an asset that is not an arm64 mac zip', { asset: 'Orca-1.4.258+custom.5-x64-mac.zip' }],
    ['an uppercase digest', { sha256: 'A'.repeat(64) }],
    ['a short digest', { sha256: 'a'.repeat(63) }],
    ['a zero size', { size: 0 }],
    ['a size beyond the cap', { size: 3 * 1024 ** 3 }],
    ['a size one byte over 1 GiB', { size: 1024 ** 3 + 1 }],
    ['a fractional size', { size: 10.5 }],
    ['a size given as text', { size: '300000000' }],
    ['missing signed and notarized flags', { signed: undefined, notarized: undefined }],
    ['a malformed team', { team_id: 7 }]
  ])('rejects %s', (_name, overrides) => {
    expect(parse(overrides).ok).toBe(false)
  })

  it('rejects a manifest read from a release with a different tag', () => {
    expect(parse({}, 'v1.4.258+custom.4').ok).toBe(false)
  })

  describe('trust claims', () => {
    function trust(overrides: Record<string, unknown>): string | null {
      const parsed = parse(overrides)
      if (!parsed.ok) {
        throw new Error(parsed.reason)
      }
      return manifestTrustFailure(parsed.manifest)
    }

    it('passes a signed, notarized build from our team', () => {
      expect(trust({})).toBeNull()
    })

    it.each([
      ['an unsigned build', { signed: false, team_id: null, notarized: false }],
      ['a signed build that is not notarized', { notarized: false }],
      ['a build from another team', { team_id: '6CX3WHS9HZ' }],
      ['a build with no team', { team_id: null }]
    ])('refuses %s', (_name, overrides) => {
      expect(trust(overrides)).not.toBeNull()
    })
  })
})
