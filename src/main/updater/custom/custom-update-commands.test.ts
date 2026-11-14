import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommandRunner, failOnInterruption, runSystemCommand } from './custom-update-commands'

describe('running system commands', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('hands the tool a minimal environment, not the app one', async () => {
    process.env.DEVELOPER_DIR = '/tmp/attacker-toolchain'
    process.env.PATH = '/tmp/attacker-bin:/usr/bin'
    process.env.SECRET_FOR_TEST = 'x'

    const result = await runSystemCommand('/usr/bin/env', [])

    expect(result.code).toBe(0)
    const names = result.stdout
      .split('\n')
      .map((line) => line.split('=')[0])
      .filter((name) => /^[A-Z_]+$/.test(name))
      .filter((name) => !['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'].includes(name))
    expect(names).toEqual(['PATH'])
    expect(result.stdout).toContain('PATH=/usr/bin:/bin:/usr/sbin:/sbin')
  })

  it('reports a failing command by its exit code', async () => {
    const result = await runSystemCommand('/usr/bin/false', [])

    expect(result.code).toBe(1)
  })

  it('stops a command when its signal is aborted', async () => {
    const controller = new AbortController()
    const running = runSystemCommand('/bin/sleep', ['30'], { signal: controller.signal })
    controller.abort()

    expect((await running).code).not.toBe(0)
  })

  it('says when a command was stopped for running too long, with the real timeout of execFile', async () => {
    const result = await createCommandRunner(150)('/bin/sleep', ['30'])

    expect(result.timedOut).toBe(true)
    expect(result.code).not.toBe(0)
  })

  it('does not call an aborted or a failing command a timeout', async () => {
    const controller = new AbortController()
    const aborted = createCommandRunner(60_000)('/bin/sleep', ['30'], { signal: controller.signal })
    controller.abort()

    expect((await aborted).timedOut).toBe(false)
    expect((await runSystemCommand('/usr/bin/false', [])).timedOut).toBe(false)
    expect((await runSystemCommand('/usr/bin/true', [])).timedOut).toBe(false)
  })

  it('turns a timeout into a retryable check-timeout failure, and passes everything else through', async () => {
    const slow = failOnInterruption(createCommandRunner(150))

    await expect(slow('/bin/sleep', ['30'])).rejects.toMatchObject({
      kind: 'check-timeout',
      retryable: true
    })
    await expect(slow('/usr/bin/false', [])).resolves.toMatchObject({ code: 1 })
  })

  describe('a tool that did not run to an exit of its own', () => {
    it('says so when the tool could not be started, whatever code the error carries', async () => {
      const result = await runSystemCommand('/nonexistent/tool', [])

      expect(result.interrupted).toBe('spawn-failed')
      expect(result.timedOut).toBe(false)
    })

    it('says so when a signal ended the tool, and not for an exit code of its own', async () => {
      const killed = await runSystemCommand('/bin/sh', ['-c', 'kill -9 $$'])

      expect(killed.interrupted).toBe('signal')
      expect((await runSystemCommand('/usr/bin/false', [])).interrupted).toBeUndefined()
      expect((await runSystemCommand('/usr/bin/true', [])).interrupted).toBeUndefined()
    })

    it('reports its own abort as an abort', async () => {
      const controller = new AbortController()
      const running = runSystemCommand('/bin/sleep', ['30'], { signal: controller.signal })
      controller.abort()

      expect(await running).toMatchObject({ interrupted: 'aborted', timedOut: false })
    })

    it('turns a start failure or a foreign signal into a retryable check-error, and lets an exit code and an abort through', async () => {
      const guarded = failOnInterruption(runSystemCommand)

      await expect(guarded('/nonexistent/tool', [])).rejects.toMatchObject({
        kind: 'check-error',
        retryable: true
      })
      await expect(guarded('/bin/sh', ['-c', 'kill -9 $$'])).rejects.toMatchObject({
        kind: 'check-error'
      })
      await expect(guarded('/usr/bin/false', [])).resolves.toMatchObject({ code: 1 })
      const controller = new AbortController()
      const running = guarded('/bin/sleep', ['30'], { signal: controller.signal })
      controller.abort()
      await expect(running).resolves.toMatchObject({ interrupted: 'aborted' })
    })
  })

  describe('after an abort', () => {
    // The directory is deleted next, so the tool must be gone by the time the runner answers (the reviewer saw it
    // answer 200 ms after the abort while a child that took two seconds to die was still writing).
    it.each([
      ['takes a second to die once asked to', `trap 'sleep 1; exit 0' TERM`],
      ['ignores the request to stop', `trap '' TERM`]
    ])('does not answer before a child that %s has exited', async (_label, trap) => {
      const directory = await mkdtemp(join(tmpdir(), 'orca abort '))
      const pidFile = join(directory, 'pid')
      const controller = new AbortController()
      const running = createCommandRunner(60_000, 400)(
        '/bin/bash',
        ['-c', `${trap}; echo $$ > "${pidFile}"; while :; do sleep 0.05; done`],
        { signal: controller.signal }
      )
      const started = Date.now()
      while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') {
        if (Date.now() - started > 5000) {
          throw new Error('the stand-in tool did not start')
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const pid = Number(readFileSync(pidFile, 'utf8'))
      controller.abort()

      const result = await running

      let alive = true
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
      }
      if (alive) {
        process.kill(pid, 'SIGKILL')
      }
      await rm(directory, { recursive: true, force: true })
      expect(alive).toBe(false)
      expect(result.interrupted).toBe('aborted')
    })
  })
})
