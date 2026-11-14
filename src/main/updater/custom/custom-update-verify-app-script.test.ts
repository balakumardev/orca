import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CUSTOM_UPDATE_BUNDLE_ID, CUSTOM_UPDATE_TEAM_ID } from './custom-update-manifest'
import { signingRequirement } from './custom-update-verifier'

// The release job proves the signing requirement on the real signed bundle with custom/scripts/verify-app.sh.
// The app checks every update against signingRequirement(). If the two strings drift apart, either the release
// job passes a build that every installed copy then rejects, or it fails a good one.
const repoFile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8')

const script = repoFile('custom/scripts/verify-app.sh')
const workflow = repoFile('.github/workflows/custom-release.yml')

describe('the release check of the signing requirement', () => {
  it('uses exactly the requirement the in-app updater uses', () => {
    const match = /^requirement='(.*)'$/m.exec(script)

    expect(match).not.toBeNull()
    expect((match?.[1] ?? '').replace('@TEAM@', CUSTOM_UPDATE_TEAM_ID)).toBe(signingRequirement())
  })

  it('names the same bundle identifier as the updater, with no placeholder for it', () => {
    const match = /^requirement='(.*)'$/m.exec(script)

    expect(match?.[1]).toContain(`identifier "${CUSTOM_UPDATE_BUNDLE_ID}"`)
    expect(match?.[1].match(/@[A-Z]+@/g)).toEqual(['@TEAM@'])
  })

  it('fills the team from the --team argument, which the release workflow sets to the updater team', () => {
    expect(script).toContain('"-R=${requirement//@TEAM@/$team}"')
    expect(workflow).toContain(`EXPECTED_TEAM_ID: ${CUSTOM_UPDATE_TEAM_ID}`)
  })

  it('hands the requirement to codesign for every signed mode and never for an unsigned build', () => {
    expect(script).toMatch(
      /if \[ "\$mode" != "unsigned" \]; then\n\s+echo "== updater signing requirement"/
    )
    expect(script).toMatch(/codesign --verify --deep --strict "-R=/)
  })

  it('is run by the release job against the built signed app', () => {
    expect(workflow).toMatch(
      /verify-app\.sh --app dist\/mac-arm64\/Orca\.app .* --mode signed --team/
    )
  })

  it('stops the script when the requirement is not met', () => {
    expect(script).toMatch(/"-R=\$\{requirement\/\/@TEAM@\/\$team\}" "\$app" \\\n\s+\|\| fail /)
  })
})

// The updater refuses a manifest that is not signed, not notarized, or from another team (manifestTrustFailure). The release
// job must refuse to publish exactly what the app would refuse, or a release goes out that nobody can install.
describe('what the release workflow publishes', () => {
  it('asks the manifest for signed, notarized and our team before it creates the release', () => {
    expect(workflow).toContain(
      `jq -e --arg team "$EXPECTED_TEAM_ID" '.signed == true and .notarized == true and .team_id == $team' manifest.json`
    )
    expect(workflow).toContain(`EXPECTED_TEAM_ID: ${CUSTOM_UPDATE_TEAM_ID}`)
  })

  it('does not tell readers the in-app updater is off: this build updates itself from these releases', () => {
    const notes = repoFile('custom/scripts/release-notes.sh')

    expect(notes).not.toMatch(/updater is disabled/i)
    expect(notes).toContain("its in-app updater reads this fork's releases")
  })

  it('refuses at planning time to publish unless the run signs and notarizes', () => {
    expect(workflow).toContain(
      'if [ "$PUBLISH" = "true" ] && { [ "$SIGN" != "true" ] || [ "$NOTARIZE" != "true" ]; }; then'
    )
  })
})
