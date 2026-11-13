import { execFileSync } from 'node:child_process'

const FULL_COMMIT = /^[0-9a-f]{40}$/

// Pin official skill installs to the full build commit so installed and bundled skills agree on every channel.
export function resolveBuildSourceCommit(env = process.env) {
  // A fork's HEAD does not exist upstream, so a custom build pins skills to an upstream commit it names itself.
  const override = env.ORCA_BUILD_COMMIT?.trim()
  if (override !== undefined) {
    if (!FULL_COMMIT.test(override)) {
      throw new Error(
        `ORCA_BUILD_COMMIT is set to "${override}", which is not a full 40-character lowercase commit hash.`
      )
    }
    return override
  }
  let commit = ''
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch (error) {
    throw new Error(
      `Could not read the source commit with \`git rev-parse HEAD\`: ${
        error instanceof Error ? error.message : String(error)
      }. Orca builds must run from a git checkout so official skills can pin to it.`
    )
  }
  if (!FULL_COMMIT.test(commit)) {
    throw new Error(`\`git rev-parse HEAD\` returned "${commit}", not a full commit hash.`)
  }
  return commit
}
