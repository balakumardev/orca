// Our builds are `<upstream base>+custom.<N>`; N is global and grows across upstream bases.
const CUSTOM_BUILD_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\+custom\.(0|[1-9]\d*)$/

export type CustomBuildVersion = {
  version: string
  core: [number, number, number]
  build: number
}

export function parseCustomBuildVersion(value: string): CustomBuildVersion | null {
  const match = CUSTOM_BUILD_VERSION.exec(value)
  if (!match) {
    return null
  }
  const numbers = match.slice(1).map(Number)
  if (!numbers.every((part) => Number.isSafeInteger(part))) {
    return null
  }
  const [major, minor, patch, build] = numbers
  return { version: value, core: [major, minor, patch], build }
}

/** Parses a release tag such as `v1.4.258+custom.4`. */
export function parseCustomBuildTag(tag: string): CustomBuildVersion | null {
  return tag.startsWith('v') ? parseCustomBuildVersion(tag.slice(1)) : null
}

/** Negative when left is older: upstream base first, then the build counter. */
export function compareCustomBuilds(left: CustomBuildVersion, right: CustomBuildVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] - right.core[index]
    }
  }
  return left.build - right.build
}

/** Never offer a build on an older base or one with a lower-or-equal counter. */
export function isNewerCustomBuild(
  running: CustomBuildVersion,
  candidate: CustomBuildVersion
): boolean {
  const baseComparison = compareCustomBuilds({ ...candidate, build: 0 }, { ...running, build: 0 })
  return baseComparison >= 0 && candidate.build > running.build
}
