import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sign } from '@electron/osx-sign'
import { describe, expect, it } from 'vitest'
import { signMacApp } from './sign-mac-app.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const electronEntitlements = join(root, 'resources/build/entitlements.mac.plist')
const verifier = join(import.meta.dirname, 'verify-macos-helper-entitlements.mjs')

describe.skipIf(process.platform !== 'darwin')('packaged macOS native helper signing', () => {
  it('keeps native helpers minimally entitled while retaining the app and terminal host entitlements', async () => {
    const work = mkdtempSync(join(tmpdir(), 'orca-helper-entitlements-'))
    try {
      const app = join(work, 'Orca.app')
      const executable = createBundle(app, 'Orca', 'com.stablyai.orca')
      execFileSync('/usr/bin/clang', ['-x', 'c', '-', '-o', executable], {
        input: 'int main(void) { return 0; }'
      })
      const helper = join(app, 'Contents', 'Resources', 'Orca Computer Use.app')
      const helperExecutable = createBundle(
        helper,
        'orca-computer-use-macos',
        'com.stablyai.orca.computer-use'
      )
      copyFileSync(executable, helperExecutable)
      const nativeHelpers = [
        'orca-keyboard-layout',
        'orca-process-footprint',
        'orca-notification-status'
      ].map((name) => join(app, 'Contents', 'MacOS', name))
      for (const nativeHelper of nativeHelpers) {
        copyFileSync(executable, nativeHelper)
      }
      const terminalHost = join(app, 'Contents', 'Helpers', 'Orca Terminal Host.app')
      copyFileSync(
        executable,
        createBundle(terminalHost, 'orca-terminal-host', 'com.stablyai.orca')
      )

      // Sign a disposable fixture without executing it or accessing a Developer ID private key.
      await signMacApp(
        {
          app,
          identity: '-',
          identityValidation: false,
          platform: 'darwin',
          hardenedRuntime: true,
          entitlements: electronEntitlements,
          entitlementsInherit: electronEntitlements,
          optionsForFile: () => ({ entitlements: electronEntitlements, hardenedRuntime: true }),
          preAutoEntitlements: false,
          preEmbedProvisioningProfile: false,
          gatekeeperAssess: false
        },
        { sign, retry: (operation) => operation() }
      )

      expect(readEntitlements(helper)).toEqual({})
      expect(readEntitlements(helperExecutable)).toEqual({})
      for (const nativeHelper of nativeHelpers) {
        expect(readEntitlements(nativeHelper), nativeHelper).toEqual({})
      }
      expect(readEntitlements(app)['com.apple.security.cs.allow-jit']).toBe(true)
      expect(readEntitlements(app)['com.apple.security.device.camera']).toBe(true)
      expect(readEntitlements(terminalHost)['com.apple.security.cs.allow-jit']).toBe(true)
      expect(readEntitlements(terminalHost)['com.apple.security.device.camera']).toBe(true)
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
      const accepted = spawnSync(process.execPath, [verifier, app], { encoding: 'utf8' })
      expect(accepted.status, accepted.stderr).toBe(0)

      for (const target of [helper, ...nativeHelpers]) {
        execFileSync('/usr/bin/codesign', [
          '--force',
          '--sign',
          '-',
          '--options',
          'runtime',
          '--entitlements',
          electronEntitlements,
          target
        ])
        const rejected = spawnSync(process.execPath, [verifier, app], { encoding: 'utf8' })
        expect(rejected.status).not.toBe(0)
        expect(rejected.stderr).toContain(
          'Native helper entitlements do not match expected profile'
        )
        expect(rejected.stderr).toContain(target)
        execFileSync('/usr/bin/codesign', [
          '--force',
          '--sign',
          '-',
          '--options',
          'runtime',
          '--entitlements',
          join(root, 'resources/build/entitlements.computer-use.mac.plist'),
          target
        ])
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

function createBundle(app, executableName, bundleId) {
  const contents = join(app, 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  writeFileSync(
    join(contents, 'Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>${bundleId}</string>
    <key>CFBundleExecutable</key><string>${executableName}</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleVersion</key><string>1.0</string>
    </dict></plist>`
  )
  return join(contents, 'MacOS', executableName)
}

function readEntitlements(app) {
  const xml = execFileSync('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', app])
  return JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      input: xml,
      encoding: 'utf8'
    })
  )
}
