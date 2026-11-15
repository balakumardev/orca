import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LID_HELPER_SOURCE } from './lid-awake-helper-source'

// Why: each case runs the real bash helper, and its heartbeat and signal paths wait on real seconds.
const HELPER_PROCESS_TEST_TIMEOUT_MS = 15_000

type Hold = {
  child: ChildProcessWithoutNullStreams
  firstLine: Promise<string>
  exited: Promise<number | null>
}

describe.skipIf(process.platform === 'win32')('orca-lid-hold helper script', () => {
  let dir: string
  let flagFile: string
  let held: Hold[]

  const flag = (): string => readFileSync(flagFile, 'utf8').trim()

  function install(heartbeatTimeout: number): string {
    const script = join(dir, 'orca-lid-hold')
    const source = LID_HELPER_SOURCE.replace(
      'STATE_DIR=/var/db/orca-lid-hold',
      `STATE_DIR=${dir}/state`
    )
      .replace('PMSET=/usr/bin/pmset', `PMSET=${dir}/pmset`)
      .replace('HEARTBEAT_TIMEOUT=45', `HEARTBEAT_TIMEOUT=${heartbeatTimeout}`)
    writeFileSync(script, source)
    chmodSync(script, 0o755)
    return script
  }

  function startHold(script: string): Hold {
    const child = spawn('/bin/bash', [script, 'hold'], {
      env: { ...process.env, FAKE_PMSET_FLAG: flagFile },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const firstLine = new Promise<string>((resolve) =>
      child.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString().trim()))
    )
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
    const entry: Hold = { child, firstLine, exited }
    held.push(entry)
    return entry
  }

  function run(script: string, ...args: string[]): { stdout: string; status: number | null } {
    const result = spawnSync('/bin/bash', [script, ...args], {
      env: { ...process.env, FAKE_PMSET_FLAG: flagFile },
      encoding: 'utf8'
    })
    return { stdout: result.stdout.trim(), status: result.status }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-lid-hold-test-'))
    flagFile = join(dir, 'flag')
    writeFileSync(flagFile, '0\n')
    writeFileSync(
      join(dir, 'pmset'),
      '#!/bin/bash\ncase "$1" in\n  -g) printf " SleepDisabled\\t\\t%s\\n" "$(cat "$FAKE_PMSET_FLAG")" ;;\n  -a) echo "$3" > "$FAKE_PMSET_FLAG" ;;\nesac\n'
    )
    chmodSync(join(dir, 'pmset'), 0o755)
    held = []
  })

  afterEach(() => {
    for (const entry of held) {
      entry.child.kill('SIGKILL')
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it(
    'sets the flag on hold and clears it when stdin closes',
    async () => {
      const hold = startHold(install(30))
      expect(await hold.firstLine).toBe('held')
      expect(flag()).toBe('1')
      hold.child.stdin.end()
      await hold.exited
      expect(flag()).toBe('0')
      expect(existsSync(join(dir, 'state', 'marker'))).toBe(false)
      expect(existsSync(join(dir, 'state', 'lock'))).toBe(false)
    },
    // Why: runs the real bash helper and waits for it to exit after stdin closes.
    HELPER_PROCESS_TEST_TIMEOUT_MS
  )

  it(
    'clears the flag when the heartbeat stops',
    async () => {
      const hold = startHold(install(1))
      expect(await hold.firstLine).toBe('held')
      await hold.exited
      expect(flag()).toBe('0')
    },
    // Why: waits out the real helper's own heartbeat timeout.
    HELPER_PROCESS_TEST_TIMEOUT_MS
  )

  it(
    'clears the flag on SIGTERM',
    async () => {
      const hold = startHold(install(30))
      expect(await hold.firstLine).toBe('held')
      hold.child.kill('SIGTERM')
      await hold.exited
      expect(flag()).toBe('0')
    },
    // Why: runs the real bash helper and waits for it to exit after the signal.
    HELPER_PROCESS_TEST_TIMEOUT_MS
  )

  it(
    'leaves a flag it did not set alone',
    async () => {
      writeFileSync(flagFile, '1\n')
      const hold = startHold(install(30))
      expect(await hold.firstLine).toBe('foreign')
      await hold.exited
      expect(flag()).toBe('1')
    },
    // Why: runs the real bash helper against a flag it did not set.
    HELPER_PROCESS_TEST_TIMEOUT_MS
  )

  it(
    'refuses a second holder and keeps the first holder in charge',
    async () => {
      const script = install(30)
      const first = startHold(script)
      expect(await first.firstLine).toBe('held')
      const second = startHold(script)
      expect(await second.firstLine).toBe('busy')
      await second.exited
      expect(flag()).toBe('1')
      first.child.stdin.end()
      await first.exited
      expect(flag()).toBe('0')
    },
    // Why: runs two real helper processes at once.
    HELPER_PROCESS_TEST_TIMEOUT_MS
  )

  it(
    'resets only its own marker and never while a holder is alive',
    async () => {
      const script = install(30)
      expect(run(script, 'reset')).toEqual({ stdout: 'clean', status: 0 })
      const hold = startHold(script)
      expect(await hold.firstLine).toBe('held')
      expect(run(script, 'reset').stdout).toBe('busy')
      expect(flag()).toBe('1')
      hold.child.kill('SIGKILL')
      await hold.exited
      // A killed holder cannot clean up: the leftover marker is what reset is for.
      expect(flag()).toBe('1')
      expect(run(script, 'reset').stdout).toBe('reset')
      expect(flag()).toBe('0')
    },
    // Why: runs the real helper's reset beside a live holder.
    HELPER_PROCESS_TEST_TIMEOUT_MS
  )

  it('answers version and rejects unknown verbs or extra arguments', () => {
    const script = install(30)
    expect(run(script, 'version')).toEqual({ stdout: 'orca-lid-hold 1', status: 0 })
    expect(run(script, 'rm').status).toBe(64)
    expect(run(script, 'reset', 'now').status).toBe(64)
    expect(run(script).status).toBe(64)
  })
})
