import { describe, expect, it } from 'vitest'
import { resolveBuildSourceCommit } from './build-source-commit.mjs'

describe('resolveBuildSourceCommit', () => {
  it('prefers a full ORCA_BUILD_COMMIT over the checkout HEAD', () => {
    const commit = 'c91a7a6ee3f0d2b4a5e6978c1d3b2a4f5e6d7c8b'

    expect(resolveBuildSourceCommit({ ORCA_BUILD_COMMIT: `${commit}\n` })).toBe(commit)
  })

  it.each(['c91a7a6ee3', 'C91A7A6EE3F0D2B4A5E6978C1D3B2A4F5E6D7C8B', `${'a'.repeat(39)}g`, ''])(
    'rejects a malformed ORCA_BUILD_COMMIT of %j',
    (value) => {
      expect(() => resolveBuildSourceCommit({ ORCA_BUILD_COMMIT: value })).toThrow(
        /ORCA_BUILD_COMMIT is set to .* not a full 40-character lowercase commit hash/
      )
    }
  )
})
