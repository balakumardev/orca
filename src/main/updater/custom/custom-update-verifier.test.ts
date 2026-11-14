import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CustomUpdateError } from './custom-update-errors'
import { diskNeededFor } from './custom-update-extract'
import { parseCustomUpdateManifest } from './custom-update-manifest'
import {
  signingRequirement,
  verifyUpdateBundle,
  type CommandResult,
  type CommandRunner
} from './custom-update-verifier'
import { sampleManifest } from './testing/custom-update-sample-release'

const VERSION = '1.4.258+custom.5'
const SPCTL_ACCEPTED = '/x/Orca.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID'
const DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer'
const STAPLER = `${DEVELOPER_DIR}/usr/bin/stapler`
const KNOWN_STAPLER = '/Applications/Xcode.app/Contents/Developer/usr/bin/stapler'
const ZIPINFO = (entries: number, bytes: number): string =>
  `${entries} files, ${bytes} bytes uncompressed, 1000 bytes compressed:  50.0%`

const ok = (stdout = '', stderr = ''): CommandResult => ({ code: 0, stdout, stderr })
const failed = (stderr = ''): CommandResult => ({ code: 1, stdout: '', stderr })

type Outcome = { checks?: string[]; error?: unknown }

type Scenario = {
  plist?: Record<string, string | undefined>
  zipinfo?: CommandResult
  codesign?: CommandResult
  spctl?: CommandResult
  /** `xcode-select -p` fails: no developer directory is selected. */
  developerTools?: boolean
  /** `xcrun --find stapler` fails although a developer directory is selected. */
  stapler?: CommandResult
  xcrunFindsStapler?: boolean
  /** stapler exists at its usual place inside Xcode even though `xcrun` cannot say so. */
  staplerAtKnownPath?: boolean
  /** A command that throws instead of answering, as a runner can when its process cannot start. */
  throwFrom?: string
  /** A command that is stopped for running past its time limit. */
  timeoutFrom?: string
  /** A command whose process could not be started (the real runner turns EAGAIN, ENOMEM and EMFILE into code 1). */
  spawnFailedFrom?: string
  /** A command that something else killed with a signal. */
  signalFrom?: string
  /** The error code the size walk fails with. */
  extractionMeasure?: string
  extracted?: string[]
  ditto?: CommandResult
  freeBytes?: number
  manifestSize?: number
  /** What the fake `ditto` writes into the extraction directory, and whether it then waits to be stopped. */
  dittoWrites?: { bytes: number; waitForAbort: boolean }
}

function scenarioRunner(scenario: Scenario): { run: CommandRunner; calls: [string, string[]][] } {
  const calls: [string, string[]][] = []
  const plist = {
    CFBundleIdentifier: 'com.stablyai.orca',
    CFBundleShortVersionString: VERSION,
    ...scenario.plist
  }
  const run: CommandRunner = async (file, args, options) => {
    calls.push([file, args])
    if (file === scenario.throwFrom) {
      throw new Error('spawn failed')
    }
    if (file === scenario.timeoutFrom) {
      return { code: 1, stdout: '', stderr: '', timedOut: true }
    }
    if (file === scenario.spawnFailedFrom) {
      return { code: 1, stdout: '', stderr: '', timedOut: false, interrupted: 'spawn-failed' }
    }
    if (file === scenario.signalFrom) {
      return { code: 1, stdout: '', stderr: '', timedOut: false, interrupted: 'signal' }
    }
    if (file === '/usr/bin/zipinfo') {
      return scenario.zipinfo ?? ok(ZIPINFO(12, 1000))
    }
    if (file === '/usr/bin/ditto') {
      for (const name of scenario.extracted ?? ['Orca.app']) {
        await mkdir(join(args[3], name), { recursive: true })
      }
      if (scenario.dittoWrites) {
        await writeFile(join(args[3], 'payload'), Buffer.alloc(scenario.dittoWrites.bytes))
        if (scenario.dittoWrites.waitForAbort) {
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener('abort', () => resolve(), { once: true })
          )
          return { ...failed('interrupted'), interrupted: 'aborted' }
        }
      }
      return scenario.ditto ?? ok()
    }
    if (file === '/usr/libexec/PlistBuddy') {
      const value = plist[args[1].replace('Print :', '') as keyof typeof plist]
      return value === undefined ? failed('Does Not Exist') : ok(`${value}\n`)
    }
    if (file === '/usr/bin/codesign') {
      return scenario.codesign ?? ok()
    }
    if (file === '/usr/sbin/spctl') {
      return scenario.spctl ?? ok('', SPCTL_ACCEPTED)
    }
    if (file === '/usr/bin/xcode-select') {
      return scenario.developerTools === false ? failed() : ok(`${DEVELOPER_DIR}\n`)
    }
    if (file === '/usr/bin/xcrun') {
      return scenario.xcrunFindsStapler === false ? failed() : ok(`${STAPLER}\n`)
    }
    if (file === '/bin/test') {
      return scenario.staplerAtKnownPath && args[1] === KNOWN_STAPLER ? ok() : failed()
    }
    if (file === STAPLER || file === KNOWN_STAPLER) {
      return scenario.stapler ?? ok('The validate action worked!')
    }
    throw new Error(`unexpected command ${file}`)
  }
  return { run, calls }
}

describe('verifying a downloaded update bundle', () => {
  let root: string

  beforeEach(async () => {
    // A space in the path, like "Application Support": it must reach each tool as one argument.
    root = await mkdtemp(join(tmpdir(), 'orca verify '))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function sampleManifestOf(size = 1_000_000) {
    const parsed = parseCustomUpdateManifest(sampleManifest(VERSION, { size }), `v${VERSION}`)
    if (!parsed.ok) {
      throw new Error(parsed.reason)
    }
    return parsed.manifest
  }

  async function verify(scenario: Scenario = {}) {
    const manifest = sampleManifestOf(scenario.manifestSize)
    const { run, calls } = scenarioRunner(scenario)
    const outcome = await verifyUpdateBundle({
      zipPath: join(root, 'update.zip'),
      workDir: join(root, 'work'),
      manifest,
      run,
      extraction: {
        getFreeBytes: async () => scenario.freeBytes ?? 10 ** 12,
        monitorIntervalMs: 10,
        ...(scenario.extractionMeasure
          ? {
              measure: async () => {
                throw Object.assign(new Error(scenario.extractionMeasure), {
                  code: scenario.extractionMeasure
                })
              }
            }
          : {})
      }
    }).then(
      (checks): Outcome => ({ checks }),
      (error: unknown): Outcome => ({ error })
    )
    return { ...outcome, calls }
  }

  it('passes a bundle that satisfies every check and removes the extracted copy', async () => {
    const result = await verify()

    expect(result.error).toBeUndefined()
    expect(result.checks).toEqual([
      'extract-size',
      'archive-layout',
      'signing-requirement',
      'bundle-identifier',
      'bundle-version',
      'spctl-notarized',
      'stapler'
    ])
    expect(existsSync(join(root, 'work', 'extracted'))).toBe(false)
  })

  it('passes every path to the tools as a single argument', async () => {
    const { calls } = await verify()

    const extract = calls.find(([file]) => file === '/usr/bin/ditto')
    expect(extract?.[1]).toEqual([
      '-x',
      '-k',
      join(root, 'update.zip'),
      join(root, 'work', 'extracted')
    ])
    const listing = calls.find(([file]) => file === '/usr/bin/zipinfo')
    expect(listing?.[1]).toEqual(['-t', join(root, 'update.zip')])
  })

  describe('the signature is judged by codesign itself', () => {
    it('asks for our Developer ID signature with one requirement and decides from the exit code', async () => {
      const { calls } = await verify()

      const signing = calls.filter(([file]) => file === '/usr/bin/codesign')
      expect(signing).toHaveLength(1)
      expect(signing[0][1]).toEqual([
        '--verify',
        '--deep',
        '--strict',
        `-R=${signingRequirement()}`,
        join(root, 'work', 'extracted', 'Orca.app')
      ])
      expect(signingRequirement()).toBe(
        'anchor apple generic and identifier "com.stablyai.orca" and ' +
          'certificate 1[field.1.2.840.113635.100.6.2.6] exists and ' +
          'certificate leaf[field.1.2.840.113635.100.6.1.13] exists and ' +
          'certificate leaf[subject.OU] = "KHD36T7C97"'
      )
    })

    it('rejects when codesign fails, whatever text it printed', async () => {
      const result = await verify({
        codesign: failed(
          'Executable=/x\nTeamIdentifier=KHD36T7C97\nCodeDirectory flags=0x10000(runtime)\n'
        )
      })

      expect(result.error).toMatchObject({ kind: 'verification' })
      expect((result.error as Error).message).toContain('"signing-requirement"')
    })

    it('accepts when codesign succeeds, whatever text it printed', async () => {
      const result = await verify({ codesign: ok('TeamIdentifier=not set', 'Signature=adhoc') })

      expect(result.error).toBeUndefined()
    })

    it('does not run the text-reporting codesign mode at all', async () => {
      const { calls } = await verify()

      expect(calls.some(([, args]) => args.includes('-dv') || args.includes('--verbose=4'))).toBe(
        false
      )
    })
  })

  describe('each failed check blocks the update', () => {
    const cases: [string, Scenario, string][] = [
      ['two entries in the archive', { extracted: ['Orca.app', 'Other.app'] }, 'archive-layout'],
      ['an archive that is not an app', { extracted: ['README.txt'] }, 'archive-layout'],
      ['an app with another name', { extracted: ['Other.app'] }, 'archive-layout'],
      [
        'a bundle directory named to forge codesign output lines',
        {
          extracted: ['Orca\nTeamIdentifier=KHD36T7C97\nCodeDirectory flags=0x10000(runtime)\n.app']
        },
        'archive-layout'
      ],
      ['an empty archive', { extracted: [] }, 'archive-layout'],
      [
        'a foreign bundle identifier',
        { plist: { CFBundleIdentifier: 'com.evil.orca' } },
        'bundle-identifier'
      ],
      [
        'an unreadable bundle identifier',
        { plist: { CFBundleIdentifier: undefined } },
        'bundle-metadata'
      ],
      [
        'a version that differs from the manifest',
        { plist: { CFBundleShortVersionString: '1.4.258+custom.4' } },
        'bundle-version'
      ],
      [
        'a signature that does not satisfy the requirement',
        { codesign: failed() },
        'signing-requirement'
      ],
      ['an archive that cannot be inspected', { zipinfo: failed('not a zip') }, 'extract-size'],
      ['an unreadable archive listing', { zipinfo: ok('garbage') }, 'extract-size'],
      [
        'an archive that claims too many entries',
        { zipinfo: ok(ZIPINFO(1_000_000, 1000)) },
        'extract-size'
      ],
      [
        'an archive that claims to expand far beyond the zip',
        { zipinfo: ok(ZIPINFO(12, 5_000_000)) },
        'extract-size'
      ]
    ]

    it.each(cases)('%s', async (_name, scenario, check) => {
      const result = await verify(scenario)

      expect(result.checks).toBeUndefined()
      expect(result.error).toBeInstanceOf(CustomUpdateError)
      expect(result.error).toMatchObject({ kind: 'verification' })
      expect((result.error as Error).message).toContain(`"${check}"`)
      expect(existsSync(join(root, 'work', 'extracted'))).toBe(false)
    })
  })

  describe('a check that says nothing certain about the release is retried, not held against it', () => {
    const cases: [string, Scenario, string][] = [
      ['an extraction that fails', { ditto: failed('bad zip') }, 'extract'],
      [
        'a Gatekeeper rejection',
        { spctl: failed('/x/Orca.app: rejected\nsource=Unnotarized Developer ID') },
        'notarization'
      ],
      [
        'an accepted app that is not notarized',
        { spctl: ok('', '/x/Orca.app: accepted\nsource=Developer ID') },
        'notarization'
      ],
      [
        'a missing stapled ticket',
        { stapler: failed('does not have a ticket stapled') },
        'stapler'
      ],
      [
        'a ditto that blames the disk while the free space is fine',
        { ditto: failed('ditto: No space left on device') },
        'extract'
      ]
    ]

    it.each(cases)('%s is a retryable check-error', async (_name, scenario, check) => {
      const result = await verify(scenario)

      expect(result.checks).toBeUndefined()
      expect(result.error).toMatchObject({ kind: 'check-error', retryable: true })
      expect((result.error as Error).message).toContain(`"${check}"`)
      expect(existsSync(join(root, 'work', 'extracted'))).toBe(false)
    })

    it.each([
      '/usr/bin/zipinfo',
      '/usr/bin/ditto',
      '/usr/bin/codesign',
      '/usr/sbin/spctl',
      '/usr/libexec/PlistBuddy'
    ])(
      'a start failure of %s (fork or exec refused, no exit code of its own) is a retryable check-error',
      async (spawnFailedFrom) => {
        const result = await verify({ spawnFailedFrom })

        expect(result.checks).toBeUndefined()
        expect(result.error).toMatchObject({ kind: 'check-error', retryable: true })
        expect(existsSync(join(root, 'work', 'extracted'))).toBe(false)
      }
    )

    it.each(['/usr/bin/zipinfo', '/usr/bin/ditto', '/usr/bin/codesign', '/usr/sbin/spctl'])(
      'a signal that killed %s, which our own abort did not send, is a retryable check-error',
      async (signalFrom) => {
        const result = await verify({ signalFrom })

        expect(result.error).toMatchObject({ kind: 'check-error', retryable: true })
        expect(existsSync(join(root, 'work', 'extracted'))).toBe(false)
      }
    )

    it('is still a check that failed when stapler is absent and Gatekeeper rejects', async () => {
      const result = await verify({ developerTools: false, spctl: failed('rejected') })

      expect(result.error).toMatchObject({ kind: 'check-error' })
      expect((result.error as Error).message).toContain('"notarization"')
    })
  })

  describe('the size of the extracted copy', () => {
    it('allows an archive that expands to a few times its zip', async () => {
      const result = await verify({ manifestSize: 1_000_000, zipinfo: ok(ZIPINFO(500, 3_000_000)) })

      expect(result.error).toBeUndefined()
    })

    it('stops before extracting when the free space cannot hold the expanded archive', async () => {
      const result = await verify({ freeBytes: 1_000_000, zipinfo: ok(ZIPINFO(12, 3_000_000)) })

      expect(result.error).toMatchObject({ kind: 'disk-space' })
      expect(result.calls.some(([file]) => file === '/usr/bin/ditto')).toBe(false)
    })

    it('stops extraction that grows past the cap although the archive claimed less', async () => {
      const result = await verify({
        manifestSize: 1000,
        zipinfo: ok(ZIPINFO(3, 1000)),
        dittoWrites: { bytes: 50_000, waitForAbort: true }
      })

      expect(result.error).toMatchObject({ kind: 'verification' })
      expect((result.error as Error).message).toContain('"extract-size"')
      expect(existsSync(join(root, 'work', 'extracted'))).toBe(false)
    })

    it('notices growth that the monitor missed once extraction ends', async () => {
      const result = await verify({
        manifestSize: 1000,
        zipinfo: ok(ZIPINFO(3, 1000)),
        dittoWrites: { bytes: 50_000, waitForAbort: false }
      })

      expect((result.error as Error).message).toContain('"extract-size"')
    })
  })

  describe('the notarization ticket', () => {
    it('runs the stapler that xcrun finds, by its own path', async () => {
      const { calls, checks } = await verify()

      expect(checks).toContain('stapler')
      expect(calls).toContainEqual([
        STAPLER,
        ['validate', join(root, 'work', 'extracted', 'Orca.app')]
      ])
    })

    it('runs stapler from Xcode when no developer directory is selected but Xcode is installed', async () => {
      const { calls, checks } = await verify({ developerTools: false, staplerAtKnownPath: true })

      expect(calls.some(([file]) => file === '/usr/bin/xcrun')).toBe(false)
      expect(checks).toContain('stapler')
      expect(checks).not.toContain('stapler-skipped-not-installed')
    })

    it('still requires a valid ticket from the stapler it found on its own', async () => {
      const result = await verify({
        developerTools: false,
        staplerAtKnownPath: true,
        stapler: failed('does not have a ticket stapled')
      })

      expect(result.error).toMatchObject({ kind: 'check-error' })
      expect((result.error as Error).message).toContain('"stapler"')
    })

    it('runs stapler when a developer directory is selected but xcrun cannot say where it is, if Xcode has it', async () => {
      const { checks } = await verify({ xcrunFindsStapler: false, staplerAtKnownPath: true })

      expect(checks).toContain('stapler')
    })

    it('never calls xcrun on a Mac with no developer directory, which would open an install dialog', async () => {
      const { calls } = await verify({ developerTools: false })

      expect(calls.some(([file]) => file === '/usr/bin/xcrun')).toBe(false)
    })

    it('skips stapler, and says so, only when it is nowhere to be found; Gatekeeper still has to accept', async () => {
      const { checks } = await verify({ developerTools: false })

      expect(checks).toContain('spctl-notarized')
      expect(checks).toContain('stapler-skipped-not-installed')
      expect(checks).not.toContain('stapler')
    })
  })

  describe('the order of the checks', () => {
    it('stops at the first failed check', async () => {
      const { calls } = await verify({ codesign: failed() })

      expect(calls.some(([file]) => file === '/usr/sbin/spctl')).toBe(false)
    })

    it('does not read the Info.plist of a bundle that fails the signing requirement', async () => {
      const { calls } = await verify({ codesign: failed() })

      expect(calls.some(([file]) => file === '/usr/libexec/PlistBuddy')).toBe(false)
    })

    it('reads the Info.plist only after the signature has held', async () => {
      const { calls } = await verify()

      const files = calls.map(([file]) => file)
      expect(files.indexOf('/usr/bin/codesign')).toBeGreaterThan(-1)
      expect(files.indexOf('/usr/libexec/PlistBuddy')).toBeGreaterThan(
        files.indexOf('/usr/bin/codesign')
      )
    })

    it('stops before Gatekeeper when the identifier is foreign', async () => {
      const { calls } = await verify({ plist: { CFBundleIdentifier: 'com.evil.orca' } })

      expect(calls.some(([file]) => file === '/usr/bin/codesign')).toBe(true)
      expect(calls.some(([file]) => file === '/usr/sbin/spctl')).toBe(false)
    })
  })

  describe('an unexpected failure is not a verdict on the download', () => {
    it.each([
      '/usr/bin/codesign',
      '/usr/bin/zipinfo',
      '/usr/libexec/PlistBuddy',
      '/usr/sbin/spctl'
    ])(
      'maps an unexpected failure of %s to a retryable check-error and removes the extracted copy',
      async (throwFrom) => {
        const result = await verify({ throwFrom })

        expect(result.error).toBeInstanceOf(CustomUpdateError)
        expect(result.error).toMatchObject({ kind: 'check-error', retryable: true })
        expect(existsSync(join(root, 'work', 'extracted'))).toBe(false)
      }
    )

    it.each(['/usr/bin/zipinfo', '/usr/bin/ditto', '/usr/bin/codesign', '/usr/sbin/spctl'])(
      'a time limit hit by %s is a retryable check-timeout, not a verdict on the bundle',
      async (timeoutFrom) => {
        const result = await verify({ timeoutFrom })

        expect(result.error).toMatchObject({ kind: 'check-timeout', retryable: true })
        expect(existsSync(join(root, 'work', 'extracted'))).toBe(false)
      }
    )

    it('keeps the original cause for the log but not its text in the message', async () => {
      const result = await verify({ throwFrom: '/usr/bin/codesign' })

      expect((result.error as Error).message).not.toContain('spawn failed')
      expect((result.error as Error).cause).toBeInstanceOf(Error)
    })

    /** A tool that fails with ENOSPC while the file system reports `free` bytes (or cannot be asked). */
    async function noSpaceLeft(free: number | 'unreadable'): Promise<unknown> {
      return verifyUpdateBundle({
        zipPath: join(root, 'update.zip'),
        workDir: join(root, 'work'),
        manifest: sampleManifestOf(),
        run: async () => {
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        },
        extraction: {
          getFreeBytes: async () => {
            if (free === 'unreadable') {
              throw new Error('statfs failed')
            }
            return free
          },
          monitorIntervalMs: 10
        }
      }).catch((error: unknown) => error)
    }

    it('reports a full disk as a disk-space problem that may clear up, and says how much room there was and is needed', async () => {
      // The file system agrees: 100 MB is below the margin the update must leave free.
      const outcome = await noSpaceLeft(100_000_000)

      expect(outcome).toMatchObject({
        kind: 'disk-space',
        retryable: true,
        freeBytes: 100_000_000,
        neededBytes: diskNeededFor(sampleManifestOf().size)
      })
    })

    it.each([
      ['the file system shows room again', 10 ** 12],
      ['the file system cannot be asked', 'unreadable' as const]
    ])('does not call it a disk problem on the error code alone when %s', async (_name, free) => {
      const outcome = await noSpaceLeft(free)

      expect(outcome).toMatchObject({ kind: 'check-error', retryable: true })
    })

    it('treats a tree that nobody may list as over the cap', async () => {
      const result = await verify({ extractionMeasure: 'EACCES' })

      expect(result.error).toMatchObject({ kind: 'verification' })
      expect((result.error as Error).message).toContain('"extract-size"')
      expect(existsSync(join(root, 'work', 'extracted'))).toBe(false)
    })

    it.each(['EMFILE', 'EIO'])(
      'does not treat a tree that could not be read because of %s as a verdict',
      async (extractionMeasure) => {
        const result = await verify({ extractionMeasure })

        expect(result.error).toMatchObject({ kind: 'check-error', retryable: true })
        expect(existsSync(join(root, 'work', 'extracted'))).toBe(false)
      }
    )

    it('treats a work directory that cannot be made as a retryable error, not a bad build', async () => {
      await writeFile(join(root, 'work'), 'a file where the directory should be')

      const result = await verify()

      expect(result.error).toMatchObject({ kind: 'check-error', retryable: true })
    })
  })

  it('removes the extracted copy even when the original failure came from somewhere else', async () => {
    const { error } = await verify({ extracted: ['Orca.app', 'Other.app'] })

    expect(error).toMatchObject({ kind: 'verification' })
    expect((error as Error).message).toContain('"archive-layout"')
    expect(existsSync(join(root, 'work', 'extracted'))).toBe(false)
  })
})
