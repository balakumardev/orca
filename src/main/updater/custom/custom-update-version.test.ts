import { describe, expect, it } from 'vitest'
import {
  compareCustomBuilds,
  isNewerCustomBuild,
  parseCustomBuildTag,
  parseCustomBuildVersion
} from './custom-update-version'

function build(version: string): NonNullable<ReturnType<typeof parseCustomBuildVersion>> {
  const parsed = parseCustomBuildVersion(version)
  if (!parsed) {
    throw new Error(`fixture ${version} does not parse`)
  }
  return parsed
}

describe('custom build versions', () => {
  it('reads the running version of a custom build', () => {
    expect(parseCustomBuildVersion('1.4.258+custom.4')).toEqual({
      version: '1.4.258+custom.4',
      core: [1, 4, 258],
      build: 4
    })
  })

  it.each([
    '1.4.258',
    '1.4.258-rc.1',
    '1.4.258-custom.4',
    '1.4.258+custom.04',
    '01.4.258+custom.4',
    '1.04.258+custom.4',
    '1.4.0258+custom.4',
    '1.4.258+custom.',
    '1.4.258+local.1',
    '1.4.258+custom.4+x',
    'v1.4.258+custom.4',
    '1.4+custom.4',
    ''
  ])('treats %s as not a custom build', (value) => {
    expect(parseCustomBuildVersion(value)).toBeNull()
  })

  it('reads a release tag only with the v prefix', () => {
    expect(parseCustomBuildTag('v1.4.258+custom.4')?.build).toBe(4)
    expect(parseCustomBuildTag('1.4.258+custom.4')).toBeNull()
    expect(parseCustomBuildTag('v1.4.258')).toBeNull()
  })

  it('orders by upstream base first and the build counter second', () => {
    const ordered = [
      '1.4.259+custom.5',
      '1.4.258+custom.9',
      '1.4.258+custom.4',
      '1.3.999+custom.20'
    ]
      .map(build)
      .sort(compareCustomBuilds)
      .map((entry) => entry.version)
    expect(ordered).toEqual([
      '1.3.999+custom.20',
      '1.4.258+custom.4',
      '1.4.258+custom.9',
      '1.4.259+custom.5'
    ])
  })

  describe('which builds may replace the running one', () => {
    const running = build('1.4.258+custom.4')

    it.each([
      ['a higher counter on the same base', '1.4.258+custom.5'],
      ['a newer base with a higher counter', '1.4.259+custom.5'],
      ['a much newer base with a higher counter', '2.0.0+custom.99']
    ])('accepts %s', (_name, candidate) => {
      expect(isNewerCustomBuild(running, build(candidate))).toBe(true)
    })

    it.each([
      ['the same build', '1.4.258+custom.4'],
      ['a lower counter on the same base', '1.4.258+custom.3'],
      ['a newer base whose counter is not higher (the counter is global)', '1.4.259+custom.4'],
      ['an older base with a higher counter (never downgrade the base)', '1.4.257+custom.9']
    ])('rejects %s', (_name, candidate) => {
      expect(isNewerCustomBuild(running, build(candidate))).toBe(false)
    })
  })
})
