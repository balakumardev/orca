import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSystemCommand, type CommandRunner } from './custom-update-commands'
import { FREE_SPACE_MARGIN_BYTES } from './custom-update-disk'
import { parseCustomUpdateManifest } from './custom-update-manifest'
import { signingRequirement, verifyUpdateBundle } from './custom-update-verifier'
import { sampleManifest } from './testing/custom-update-sample-release'
import { buildZip } from './testing/custom-update-zip-builder'

const run = promisify(execFile)
const VERSION = '1.4.258+custom.5'
const REQUIREMENT_UNSATISFIED_EXIT = 3

// These tests drive the real /usr/bin/codesign, ditto and zipinfo and the real /usr/sbin/spctl. They exist only
// on macOS, so everywhere else they are reported as skipped; the CI job that runs them is the macOS one, if any.
const suite = process.platform === 'darwin' ? describe : describe.skip

function infoPlist(bundleId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleShortVersionString</key><string>${VERSION}</string>
<key>CFBundleExecutable</key><string>Orca</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`
}

/** A real, ad-hoc signed bundle: nothing here can satisfy a Developer ID requirement. */
async function buildBundle(
  destination: string,
  options: { plistId?: string; signedId?: string } = {}
): Promise<void> {
  await mkdir(join(destination, 'Contents', 'MacOS'), { recursive: true })
  await cp('/usr/bin/true', join(destination, 'Contents', 'MacOS', 'Orca'))
  await writeFile(
    join(destination, 'Contents', 'Info.plist'),
    infoPlist(options.plistId ?? 'com.stablyai.orca')
  )
  await run('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--identifier',
    options.signedId ?? 'com.stablyai.orca',
    destination
  ])
}

async function zipDirectory(source: string, zipPath: string, keepParent: boolean): Promise<void> {
  await run('/usr/bin/ditto', [
    '-c',
    '-k',
    ...(keepParent ? ['--keepParent'] : []),
    source,
    zipPath
  ])
}

suite('verifying an update bundle with the real macOS tools (skipped when not on macOS)', () => {
  let root: string
  let counter = 0

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca verify real '))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function verifyZip(
    zipPath: string,
    options: {
      requirement?: string
      size?: number
      extraction?: Parameters<typeof verifyUpdateBundle>[0]['extraction']
    } = {}
  ): Promise<{ error?: Error; checks?: string[] }> {
    counter += 1
    const parsed = parseCustomUpdateManifest(
      sampleManifest(VERSION, { size: options.size ?? 1_000_000 }),
      `v${VERSION}`
    )
    if (!parsed.ok) {
      throw new Error(parsed.reason)
    }
    // Ad-hoc bundles cannot satisfy the production requirement, so a test may swap in a weaker one; every other
    // tool runs for real, unchanged.
    const runner: CommandRunner = (file, args, commandOptions) =>
      runSystemCommand(
        file,
        options.requirement && file === '/usr/bin/codesign'
          ? args.map((arg) => (arg.startsWith('-R=') ? `-R=${options.requirement}` : arg))
          : args,
        commandOptions
      )
    return verifyUpdateBundle({
      zipPath,
      workDir: join(root, `work-${counter}`),
      manifest: parsed.manifest,
      run: runner,
      extraction: options.extraction
    }).then(
      (checks) => ({ checks }),
      (error: Error) => ({ error })
    )
  }

  async function zipOfBundle(name: string, options?: Parameters<typeof buildBundle>[1]) {
    counter += 1
    const staging = join(root, `staging-${counter}`)
    await mkdir(staging)
    await buildBundle(join(staging, name), options)
    const zipPath = join(root, `bundle-${counter}.zip`)
    await zipDirectory(staging, zipPath, false)
    return zipPath
  }

  it('the production requirement is valid codesign syntax, and an ad-hoc bundle fails it by exit code', async () => {
    counter += 1
    const bundle = join(root, `plain-${counter}`, 'Orca.app')
    await buildBundle(bundle)
    const command = (requirement: string) =>
      run('/usr/bin/codesign', [
        '--verify',
        '--deep',
        '--strict',
        `-R=${requirement}`,
        bundle
      ]).then(
        () => ({ code: 0, stderr: '' }),
        (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr })
      )

    const production = await command(signingRequirement())
    expect(production.code).toBe(REQUIREMENT_UNSATISFIED_EXIT)
    expect(production.stderr).toContain('failed to satisfy')
    expect(await command('identifier "com.stablyai.orca"')).toMatchObject({ code: 0 })
    expect(await command('identifier "com.evil.orca"')).toMatchObject({
      code: REQUIREMENT_UNSATISFIED_EXIT
    })
    expect(await command('certificate leaf[subject.OU] = "KHD36T7C97"')).toMatchObject({
      code: REQUIREMENT_UNSATISFIED_EXIT
    })
  })

  it('rejects an ad-hoc signed Orca.app under the production requirement', async () => {
    const result = await verifyZip(await zipOfBundle('Orca.app'))

    expect(result.checks).toBeUndefined()
    expect(result.error?.message).toContain('"signing-requirement"')
  })

  it('rejects a bundle directory named to forge codesign output lines', async () => {
    const forged = await zipOfBundle(
      'Orca\nTeamIdentifier=KHD36T7C97\nflags=0x10000(runtime)\n.app'
    )

    const result = await verifyZip(forged, { requirement: 'identifier "com.stablyai.orca"' })

    expect(result.checks).toBeUndefined()
    expect(result.error?.message).toContain('"archive-layout"')
  })

  it('rejects Orca.app that is a symlink', async () => {
    counter += 1
    const outside = join(root, `outside-${counter}`, 'Evil.app')
    await buildBundle(outside)
    const staging = join(root, `staging-link-${counter}`)
    await mkdir(staging)
    await symlink(outside, join(staging, 'Orca.app'))
    const zipPath = join(root, `link-${counter}.zip`)
    await zipDirectory(staging, zipPath, false)

    const result = await verifyZip(zipPath, { requirement: 'identifier "com.stablyai.orca"' })

    expect(result.checks).toBeUndefined()
    expect(result.error?.message).toContain('"archive-layout"')
    expect(result.error?.message).toContain('plain directory')
  })

  it('rejects a bundle whose Info.plist claims the app identifier but whose code is signed as another', async () => {
    const zipPath = await zipOfBundle('Orca.app', { signedId: 'com.evil.orca' })

    const result = await verifyZip(zipPath, { requirement: 'identifier "com.stablyai.orca"' })

    expect(result.error?.message).toContain('"signing-requirement"')
  })

  it('rejects a bundle whose Info.plist names another app', async () => {
    const zipPath = await zipOfBundle('Orca.app', { plistId: 'com.evil.orca' })

    const result = await verifyZip(zipPath, { requirement: 'identifier "com.stablyai.orca"' })

    expect(result.error?.message).toContain('"bundle-identifier"')
  })

  it('rejects a bundle from another team, as a requirement on the team identifier', async () => {
    const zipPath = await zipOfBundle('Orca.app')

    const result = await verifyZip(zipPath, {
      requirement: 'identifier "com.stablyai.orca" and certificate leaf[subject.OU] = "AAAAAAAAAA"'
    })

    expect(result.error?.message).toContain('"signing-requirement"')
  })

  it('goes on to Gatekeeper once the signature requirement is met, which rejects an unnotarized bundle', async () => {
    const zipPath = await zipOfBundle('Orca.app')

    const result = await verifyZip(zipPath, { requirement: 'identifier "com.stablyai.orca"' })

    expect(result.checks).toBeUndefined()
    expect(result.error?.message).toContain('"notarization"')
  })

  it('refuses an archive that expands far beyond its size before extracting anything', async () => {
    counter += 1
    const staging = join(root, `bomb-${counter}`)
    await mkdir(staging)
    await run('/bin/dd', ['if=/dev/zero', `of=${join(staging, 'zeros')}`, 'bs=1m', 'count=200'])
    const zipPath = join(root, `bomb-${counter}.zip`)
    await run('/usr/bin/ditto', ['-c', '-k', staging, zipPath])
    const { size } = await stat(zipPath)

    const result = await verifyZip(zipPath, { size })

    expect(result.error?.message).toContain('"extract-size"')
    expect(existsSync(join(root, `work-${counter}`, 'extracted', 'zeros'))).toBe(false)
  })

  describe('an archive that lies about its size and hides its payload (real zipinfo and ditto)', () => {
    const PAYLOAD_BYTES = 32 * 1024 * 1024

    /**
     * The central directory says 10 bytes, so `zipinfo -t` is satisfied; ditto expands the real stream. The
     * directories are execute-only, so nothing can list them: a size walk that swallows errors reads 0 bytes,
     * and a plain recursive remove fails with EACCES.
     */
    async function hostileZip(): Promise<{ zipPath: string; size: number }> {
      counter += 1
      const zip = buildZip([
        { name: 'Orca.app/', mode: 0o111 },
        { name: 'Orca.app/Contents/', mode: 0o111 },
        {
          name: 'Orca.app/Contents/payload',
          mode: 0o644,
          data: Buffer.alloc(PAYLOAD_BYTES),
          claimedSize: 10
        }
      ])
      const zipPath = join(root, `hostile-${counter}.zip`)
      await writeFile(zipPath, zip)
      return { zipPath, size: zip.length }
    }

    it('is believed by zipinfo, so the pre-check alone cannot stop it', async () => {
      const { zipPath } = await hostileZip()

      const { stdout } = await run('/usr/bin/zipinfo', ['-t', zipPath])

      expect(stdout).toContain('10 bytes uncompressed')
    })

    it('is refused while it extracts: directories nobody may list cannot be measured, and count as too big', async () => {
      const { zipPath, size } = await hostileZip()

      const result = await verifyZip(zipPath, { size })

      expect(result.checks).toBeUndefined()
      expect(result.error?.message).toContain('"extract-size"')
    })

    it('leaves no tree behind: the unreadable directories are opened up and deleted', async () => {
      const { zipPath, size } = await hostileZip()
      const before = counter

      await verifyZip(zipPath, { size })

      expect(existsSync(join(root, `work-${before + 1}`, 'extracted'))).toBe(false)
    })

    it('is not even started when the disk could not hold the cap plus the safety margin', async () => {
      const { zipPath } = await hostileZip()

      const result = await verifyZip(zipPath, {
        // A manifest that allows 4 GB of expansion on a disk with a little more than the margin free.
        size: 1_000_000_000,
        extraction: { getFreeBytes: async () => FREE_SPACE_MARGIN_BYTES + 1024 * 1024 }
      })

      expect(result.checks).toBeUndefined()
      expect(result.error).toMatchObject({ kind: 'disk-space' })
      expect(existsSync(join(root, `work-${counter}`, 'extracted', 'Orca.app'))).toBe(false)
    })

    it('shows that a plain remove of what ditto wrote would have failed', async () => {
      const { zipPath } = await hostileZip()
      const target = join(root, `plain-extract-${counter}`)
      await mkdir(target)
      await run('/usr/bin/ditto', ['-x', '-k', zipPath, target])

      await expect(rm(target, { recursive: true })).rejects.toMatchObject({ code: 'EACCES' })

      await run('/bin/chmod', ['-R', 'u+rwX', target])
      await rm(target, { recursive: true, force: true })
      expect(existsSync(target)).toBe(false)
    })
  })
})
