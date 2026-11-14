import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { failOnInterruption, runSystemCommand, type CommandRunner } from './custom-update-commands'
import { FREE_SPACE_MARGIN_BYTES, freeBytesOf } from './custom-update-disk'
import { CustomUpdateError } from './custom-update-errors'
import {
  diskNeededFor,
  extractArchive,
  findExtractedBundle,
  type ExtractRequest
} from './custom-update-extract'
import {
  CUSTOM_UPDATE_BUNDLE_ID,
  CUSTOM_UPDATE_TEAM_ID,
  type CustomUpdateManifest
} from './custom-update-manifest'
import { removeTree } from './custom-update-tree'

export type { CommandResult, CommandRunner } from './custom-update-commands'

export type VerifyBundleRequest = {
  zipPath: string
  workDir: string
  manifest: CustomUpdateManifest
  run?: CommandRunner
  extraction?: Pick<
    ExtractRequest,
    'getFreeBytes' | 'measure' | 'monitorIntervalMs' | 'freePollIntervalMs' | 'marginBytes'
  >
}

// The checks whose failure is a verdict on the release's own bytes: the same bytes fail them every time, on any Mac,
// so the release is set aside for good. Only a check named here is final; the others depend on the machine or on
// Apple (Gatekeeper may need to reach Apple to judge a ticket that is not stapled), so a miss there is retried and
// only repeated misses set the release aside. A check that is new is retried until someone decides it is final.
const FINAL_CHECKS: ReadonlySet<string> = new Set([
  'signing-requirement',
  'bundle-identifier',
  'bundle-version',
  'bundle-metadata',
  'archive-layout',
  'extract-size'
])

function failCheck(check: string, detail: string): never {
  throw new CustomUpdateError(
    FINAL_CHECKS.has(check) ? 'verification' : 'check-error',
    `Update check "${check}" failed: ${detail}`
  )
}

/**
 * What our CI signature has to satisfy: Apple's anchor, a Developer ID Application leaf, our team, and the app's
 * identifier. codesign decides this itself and answers with its exit code; no text it prints is parsed.
 * `custom/scripts/verify-app.sh` holds the same string, and a test keeps the two equal.
 */
export function signingRequirement(
  bundleId: string = CUSTOM_UPDATE_BUNDLE_ID,
  teamId: string = CUSTOM_UPDATE_TEAM_ID
): string {
  return [
    'anchor apple generic',
    `identifier "${bundleId}"`,
    'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    `certificate leaf[subject.OU] = "${teamId}"`
  ].join(' and ')
}

async function readPlistValue(run: CommandRunner, plist: string, key: string): Promise<string> {
  const result = await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])
  if (result.code !== 0) {
    failCheck('bundle-metadata', `${key} is unreadable`)
  }
  return result.stdout.trim()
}

// Where stapler lives when `xcrun` cannot say: no developer directory is selected, but Xcode may still be installed.
const KNOWN_STAPLER_PATHS = [
  '/Applications/Xcode.app/Contents/Developer/usr/bin/stapler',
  '/Library/Developer/CommandLineTools/usr/bin/stapler'
]

/**
 * `xcrun` opens an install dialog on a Mac without developer tools, so it only runs once `xcode-select -p` has
 * confirmed a developer directory. Without one, the usual install locations are tried by path.
 */
async function findStapler(run: CommandRunner): Promise<string | null> {
  const selected = await run('/usr/bin/xcode-select', ['-p'])
  if (selected.code === 0) {
    const found = await run('/usr/bin/xcrun', ['--find', 'stapler'])
    const path = found.stdout.trim()
    if (found.code === 0 && path.startsWith('/')) {
      return path
    }
  }
  for (const candidate of KNOWN_STAPLER_PATHS) {
    if ((await run('/bin/test', ['-x', candidate])).code === 0) {
      return candidate
    }
  }
  return null
}

async function checkNotarization(run: CommandRunner, app: string): Promise<string[]> {
  // Gatekeeper's own verdict: a Developer ID app accepted from a notarization ticket. The app path is ours and
  // fixed, so nothing in the output can come from the bundle.
  const assessment = await run('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'exec', app])
  const verdict = `${assessment.stderr}\n${assessment.stdout}`
  if (
    assessment.code !== 0 ||
    !verdict.includes('accepted') ||
    !verdict.includes('source=Notarized Developer ID')
  ) {
    failCheck(
      'notarization',
      'Gatekeeper does not accept the bundle as a notarized Developer ID app'
    )
  }
  const stapler = await findStapler(run)
  if (!stapler) {
    // Not every Mac has Xcode. Gatekeeper already accepted the bundle above, so this is a missing extra check.
    return ['spctl-notarized', 'stapler-skipped-not-installed']
  }
  const staple = await run(stapler, ['validate', app])
  if (staple.code !== 0) {
    failCheck('stapler', 'no valid notarization ticket is stapled to the bundle')
  }
  return ['spctl-notarized', 'stapler']
}

async function verifyExtractedBundle(
  request: VerifyBundleRequest,
  run: CommandRunner,
  extractDir: string
): Promise<string[]> {
  await mkdir(extractDir, { recursive: true, mode: 0o700 })
  await extractArchive({
    zipPath: request.zipPath,
    destination: extractDir,
    zipBytes: request.manifest.size,
    run,
    ...request.extraction
  })
  const app = await findExtractedBundle(extractDir)
  // The signature comes first: only a bundle that satisfies it gets its Info.plist read at all.
  const signature = await run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    `-R=${signingRequirement()}`,
    app
  ])
  if (signature.code !== 0) {
    failCheck(
      'signing-requirement',
      'the signature does not verify or is not our Developer ID signature'
    )
  }
  const plist = join(app, 'Contents', 'Info.plist')
  if ((await readPlistValue(run, plist, 'CFBundleIdentifier')) !== CUSTOM_UPDATE_BUNDLE_ID) {
    failCheck('bundle-identifier', 'the bundle identifier is not the running app')
  }
  if (
    (await readPlistValue(run, plist, 'CFBundleShortVersionString')) !== request.manifest.version
  ) {
    failCheck('bundle-version', 'the bundle version differs from the manifest')
  }
  const notarization = await checkNotarization(run, app)
  return [
    'extract-size',
    'archive-layout',
    'signing-requirement',
    'bundle-identifier',
    'bundle-version',
    ...notarization
  ]
}

/**
 * An error nobody classified says nothing about the release: a tool that could not run, a file system that failed
 * (EIO, EMFILE, EACCES). It is retried, and counted as a strike; only the checks above are verdicts. ENOSPC says the
 * disk filled up at some moment, which another program can cause and undo: it is a disk-space failure only when the
 * file system, asked now, shows less room than the margin, and then it carries that figure and what the update needs.
 */
async function toVerificationFailure(
  error: unknown,
  request: VerifyBundleRequest
): Promise<CustomUpdateError> {
  if (error instanceof CustomUpdateError) {
    return error
  }
  if (error instanceof Error && 'code' in error && error.code === 'ENOSPC') {
    const readFree = request.extraction?.getFreeBytes ?? freeBytesOf
    // The work directory may be what could not be made, so its parent is asked when it is not there.
    const free = await readFree(request.workDir)
      .catch(() => readFree(dirname(request.workDir)))
      .catch(() => null)
    if (free !== null && free < (request.extraction?.marginBytes ?? FREE_SPACE_MARGIN_BYTES)) {
      return new CustomUpdateError(
        'disk-space',
        'There is not enough free disk space for the update',
        { cause: error, freeBytes: free, neededBytes: diskNeededFor(request.manifest.size) }
      )
    }
  }
  return new CustomUpdateError('check-error', 'Update check "verify" failed: unexpected error', {
    cause: error
  })
}

/**
 * Extracts a copy of the downloaded zip and holds the app to what the release workflow asserted.
 * Returns the names of the checks that ran; throws a `CustomUpdateError` on the first miss. Only a miss in one of
 * `FINAL_CHECKS` (kind `verification`) is final; a disk-space shortage, a tool that ran past its time limit or could
 * not run, and anything unexpected are retryable. The extracted copy is removed either way (a failed removal never
 * replaces the error): only the hashed zip is ever handed to macOS. The hardened runtime flag is not asserted here:
 * notarization (checked below) requires it and the release workflow asserts it on the built app.
 */
export async function verifyUpdateBundle(request: VerifyBundleRequest): Promise<string[]> {
  // A tool that is stopped for taking too long must not be mistaken for a failed check.
  const run = failOnInterruption(request.run ?? runSystemCommand)
  const extractDir = join(request.workDir, 'extracted')
  try {
    return await verifyExtractedBundle(request, run, extractDir)
  } catch (error) {
    throw await toVerificationFailure(error, request)
  } finally {
    await removeTree(extractDir)
  }
}
