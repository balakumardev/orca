import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXTRACTED_SIZE_FACTOR, MAX_ARCHIVE_ENTRIES } from './custom-update-extract'
import { CUSTOM_UPDATE_MAX_ZIP_BYTES } from './custom-update-manifest'

// The release job refuses a zip the in-app updater would refuse (custom/scripts/update-size-limits.sh). The script holds copies
// of the updater's limits and its own, lower ones for a build. If a copy drifts from the app's constant, the job either lets a
// release through that every installed copy rejects, or stops a good one. Both are caught here.
const repoFile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8')

const script = repoFile('custom/scripts/update-size-limits.sh')
const packaging = repoFile('custom/scripts/package-release.sh')

function constant(name: string): number {
  const match = new RegExp(`^${name}=(\\d+)$`, 'm').exec(script)
  if (!match) {
    throw new Error(`update-size-limits.sh does not set ${name} to a plain number`)
  }
  return Number(match[1])
}

describe('the release gate for the in-app updater size rule', () => {
  it('copies the expansion factor of the app', () => {
    expect(constant('UPDATER_EXTRACTED_SIZE_FACTOR')).toBe(EXTRACTED_SIZE_FACTOR)
  })

  it('copies the entry limit of the app', () => {
    expect(constant('UPDATER_MAX_ARCHIVE_ENTRIES')).toBe(MAX_ARCHIVE_ENTRIES)
  })

  it('copies the zip size limit of the app', () => {
    expect(constant('UPDATER_MAX_ZIP_BYTES')).toBe(CUSTOM_UPDATE_MAX_ZIP_BYTES)
  })

  it('keeps every limit for a build below the app limit it protects, so a growing bundle fails the release first', () => {
    expect(constant('RELEASE_MAX_EXPANSION_TENTHS')).toBeLessThan(EXTRACTED_SIZE_FACTOR * 10)
    expect(constant('RELEASE_MAX_ENTRIES')).toBeLessThan(MAX_ARCHIVE_ENTRIES)
    expect(constant('RELEASE_MAX_ZIP_BYTES')).toBeLessThan(CUSTOM_UPDATE_MAX_ZIP_BYTES)
  })

  it('leaves room for the measured bundle: 18,819 entries at 2.59 times its zip', () => {
    expect(constant('RELEASE_MAX_ENTRIES')).toBeGreaterThan(18_819)
    expect(constant('RELEASE_MAX_EXPANSION_TENTHS')).toBeGreaterThan(26)
  })

  it('reads the totals with the same pattern the app reads zipinfo with', () => {
    // The app: /^(\d+) files?, (\d+) bytes uncompressed/m (custom-update-extract.ts). The script matches the same words.
    expect(script).toContain('([0-9]+)\\ files?,\\ ([0-9]+)\\ bytes\\ uncompressed')
  })

  it('is run on the zip by the packaging script, which the release workflow calls', () => {
    expect(packaging).toMatch(/^bash "\$here\/update-size-limits\.sh" "\$zip_path"$/m)
    expect(repoFile('.github/workflows/custom-release.yml')).toContain('package-release.sh')
  })
})
