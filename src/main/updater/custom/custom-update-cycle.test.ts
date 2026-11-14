import { describe, expect, it, vi } from 'vitest'
import { runUpdateCycle } from './custom-update-cycle'
import { CustomUpdateError } from './custom-update-errors'
import type { CustomUpdateCandidate } from './custom-update-feed'
import {
  V6,
  V7,
  candidate,
  setup,
  verificationFailure
} from './testing/custom-update-cycle-harness'

describe('one update cycle', () => {
  it('stages the newest eligible release', async () => {
    const t = setup({ offers: [candidate(V7), candidate(V6)] })

    const result = await runUpdateCycle(t.request)

    expect(result).toMatchObject({ outcome: 'staged' })
    expect(t.downloaded).toHaveLength(1)
    expect(t.downloaded[0]).toContain('custom.7')
  })

  it('reports no update when the feed offers nothing', async () => {
    const result = await runUpdateCycle(setup({ offers: [] }).request)

    expect(result).toEqual({ outcome: 'none' })
  })

  it('falls through to the next lower release when the newest fails verification, and records the bad one', async () => {
    const t = setup({
      offers: [candidate(V7), candidate(V6)],
      failingVersions: { [V7]: verificationFailure() }
    })

    const result = await runUpdateCycle(t.request)

    expect(result).toMatchObject({ outcome: 'staged' })
    expect((result as { candidate: CustomUpdateCandidate }).candidate.manifest.version).toBe(V6)
    expect(t.rejected).toEqual(new Set([V7]))
    expect(t.log).toHaveBeenCalledWith(
      'custom_update_candidate_rejected',
      expect.objectContaining({ version: V7, errorType: 'verification' })
    )
  })

  it('falls through past a release whose manifest claims an untrusted build without downloading it, and remembers nothing about it', async () => {
    const t = setup({ offers: [candidate(V7, { team_id: '6CX3WHS9HZ' }), candidate(V6)] })

    const result = await runUpdateCycle(t.request)

    expect(result).toMatchObject({ outcome: 'staged' })
    expect(t.downloaded).toHaveLength(1)
    expect(t.downloaded[0]).toContain('custom.6')
    expect(t.rejected.size).toBe(0)
  })

  it('reports the failure when every release fails', async () => {
    const t = setup({
      offers: [candidate(V7), candidate(V6)],
      failingVersions: { [V7]: verificationFailure(), [V6]: verificationFailure() }
    })

    const result = await runUpdateCycle(t.request)

    expect(result).toMatchObject({
      outcome: 'failed',
      downloadShown: true,
      failure: { kind: 'verification' }
    })
    expect(t.rejected).toEqual(new Set([V7, V6]))
  })

  it('stops on a failure that may clear up instead of trying older releases', async () => {
    const t = setup({
      offers: [candidate(V7), candidate(V6)],
      failingVersions: { [V7]: new CustomUpdateError('network', 'dropped') }
    })

    const result = await runUpdateCycle(t.request)

    expect(result).toMatchObject({ outcome: 'failed', failure: { kind: 'network' } })
    expect(t.downloaded).toHaveLength(1)
    expect(t.downloaded[0]).toContain('custom.7')
    expect(t.rejected.size).toBe(0)
  })

  it('skips a release that was set aside before, without downloading it, and offers the next lower one', async () => {
    const t = setup({ offers: [candidate(V7), candidate(V6)], rejected: [V7] })

    const result = await runUpdateCycle(t.request)

    expect(result).toMatchObject({ outcome: 'staged' })
    expect(t.check).toHaveBeenNthCalledWith(1, { exclude: new Set(), force: false })
    expect(t.check).toHaveBeenNthCalledWith(2, { exclude: new Set([V7]), force: false })
    expect(t.downloaded).toHaveLength(1)
    expect(t.downloaded[0]).toContain('custom.6')
  })

  it('skips it for a person asking for an update too: the same bytes fail the same way', async () => {
    const t = setup({ offers: [candidate(V7), candidate(V6)], rejected: [V7], userInitiated: true })

    await runUpdateCycle(t.request)

    expect(t.downloaded).toHaveLength(1)
    expect(t.downloaded[0]).toContain('custom.6')
  })

  it('reports no update, not a failure, when every release was set aside before', async () => {
    const t = setup({ offers: [candidate(V7), candidate(V6)], rejected: [V7, V6] })

    expect(await runUpdateCycle(t.request)).toEqual({ outcome: 'none' })
    expect(t.downloaded).toHaveLength(0)
  })

  it('tries the same version again when its bytes changed, because the verdict belongs to the checksum', async () => {
    const t = setup({ offers: [candidate(V7, { sha256: 'c'.repeat(64) })], rejected: [V7] })

    const result = await runUpdateCycle(t.request)

    expect(result).toMatchObject({ outcome: 'staged' })
    expect(t.downloaded).toHaveLength(1)
  })

  it('does not use up a fall-back on a release it only skips', async () => {
    const versions = [9, 8, 7, 6, 5].map((n) => `1.4.258+custom.${n}`)
    const t = setup({ offers: versions.map((v) => candidate(v)), rejected: versions.slice(0, 4) })

    const result = await runUpdateCycle(t.request)

    expect(result).toMatchObject({ outcome: 'staged' })
    expect(t.downloaded[0]).toContain('custom.5')
  })

  it('stops reading manifests of set-aside releases after a few, so a long list stays cheap', async () => {
    const versions = Array.from({ length: 20 }, (_, index) => `1.4.258+custom.${40 - index}`)
    const t = setup({ offers: versions.map((v) => candidate(v)), rejected: versions })

    expect(await runUpdateCycle(t.request)).toEqual({ outcome: 'none' })
    expect(t.check.mock.calls.length).toBeLessThanOrEqual(10)
    expect(t.downloaded).toHaveLength(0)
  })

  it('remembers a rejection across a restart: a fresh cycle on the same state downloads nothing', async () => {
    const first = setup({
      offers: [candidate(V7)],
      failingVersions: { [V7]: verificationFailure() }
    })
    await runUpdateCycle(first.request)

    const afterRestart = setup({ offers: [candidate(V7)], state: first.state })
    const result = await runUpdateCycle(afterRestart.request)

    expect(first.downloaded).toHaveLength(1)
    expect(result).toEqual({ outcome: 'none' })
    expect(afterRestart.downloaded).toHaveLength(0)
  })

  it('gives up after a few fall-throughs instead of downloading without end', async () => {
    const versions = [9, 8, 7, 6, 5].map((n) => `1.4.258+custom.${n}`)
    const failing = Object.fromEntries(versions.map((v) => [v, verificationFailure()]))
    const t = setup({ offers: versions.map((v) => candidate(v)), failingVersions: failing })

    const result = await runUpdateCycle(t.request)

    expect(result).toMatchObject({ outcome: 'failed' })
    expect(t.downloaded).toHaveLength(4)
  })

  it('does not loop when the feed keeps returning a release it was asked to skip', async () => {
    const t = setup({
      offers: [candidate(V7)],
      failingVersions: { [V7]: verificationFailure() },
      ignoreExclude: true
    })

    const result = await runUpdateCycle(t.request)

    expect(result).toMatchObject({ outcome: 'failed' })
    expect(t.downloaded).toHaveLength(1)
  })

  it('reports a failing check as a failure with no download shown', async () => {
    const t = setup({ offers: [] })
    t.request.feed.check = vi
      .fn()
      .mockRejectedValue(new CustomUpdateError('rate-limited', 'paused'))

    const result = await runUpdateCycle(t.request)

    expect(result).toMatchObject({
      outcome: 'failed',
      candidate: null,
      downloadShown: false,
      failure: { kind: 'rate-limited' }
    })
  })

  it('keeps foreign error messages out of the log', async () => {
    const t = setup({
      offers: [candidate(V7)],
      failingVersions: {
        [V7]: new CustomUpdateError('verification', 'x', {
          cause: new Error('/Users/someone/secret/path leaked')
        })
      }
    })

    await runUpdateCycle(t.request)

    const logged = JSON.stringify(t.log.mock.calls)
    expect(logged).not.toContain('/Users/someone')
    expect(logged).toContain('"errorType":"Error"')
  })
})
