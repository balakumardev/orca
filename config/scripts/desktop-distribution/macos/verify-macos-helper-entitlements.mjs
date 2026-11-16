import { deepStrictEqual } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MACOS_NATIVE_CLI_HELPERS } from './sign-mac-app.mjs'

const app = process.argv[2]
const profile = resolve(
  import.meta.dirname,
  '../../../../resources/build/entitlements.computer-use.mac.plist'
)

// Check the sealed helper rather than assuming the packaging pass preserved its source profile.
verifyHelper(
  join(app, 'Contents', 'Resources', 'Orca Computer Use.app'),
  readPlist(readFileSync(profile))
)
for (const name of MACOS_NATIVE_CLI_HELPERS) {
  verifyHelper(join(app, 'Contents', 'MacOS', name), {})
}
console.log('macOS native helper entitlements match their intended profiles')

// Share the sealed-signature check across the native bundle and standalone Swift probes.
function verifyHelper(helper, expected) {
  const signedEntitlements = execFileSync(
    '/usr/bin/codesign',
    ['--display', '--entitlements', '-', '--xml', helper],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  deepStrictEqual(
    readPlist(signedEntitlements),
    expected,
    `Native helper entitlements do not match expected profile: ${helper}`
  )
}

// macOS normalizes both plist inputs before comparing their dictionary values.
function readPlist(input) {
  return JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      input,
      encoding: 'utf8'
    })
  )
}
