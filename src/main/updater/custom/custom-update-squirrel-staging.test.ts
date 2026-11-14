import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SquirrelFeed } from './custom-update-squirrel-feed'
import { stageUpdateWithSquirrel, type NativeUpdaterPort } from './custom-update-squirrel-staging'

const ZIP = Buffer.from('staged zip')
const ZIP_SHA256 = createHash('sha256').update(ZIP).digest('hex')

function createNativeUpdater(onCheck: (emitter: EventEmitter) => void) {
  const emitter = new EventEmitter()
  const setFeedURL = vi.fn()
  const checkForUpdates = vi.fn(() => onCheck(emitter))
  const quitAndInstall = vi.fn()
  const updater: NativeUpdaterPort = Object.assign(emitter, {
    setFeedURL,
    checkForUpdates,
    quitAndInstall
  })
  return { updater, emitter, setFeedURL, checkForUpdates }
}

describe('staging an update with Squirrel.Mac', () => {
  let directory: string
  let zipPath: string
  const order: string[] = []
  const closeFeed = vi.fn(async () => {
    order.push('feed-closed')
  })
  const feed: SquirrelFeed = {
    url: 'http://127.0.0.1:5555',
    headers: { Authorization: 'Basic x' },
    close: closeFeed
  }
  const startFeed = vi.fn(async () => {
    order.push('feed-started')
    return feed
  })

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-staging-'))
    zipPath = join(directory, 'update.zip')
    await writeFile(zipPath, ZIP)
    order.length = 0
    startFeed.mockClear()
    closeFeed.mockClear()
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  function stage(
    native: NativeUpdaterPort,
    overrides: Partial<Parameters<typeof stageUpdateWithSquirrel>[0]> = {}
  ) {
    return stageUpdateWithSquirrel({
      nativeUpdater: native,
      zipPath,
      size: ZIP.length,
      expectedSha256: ZIP_SHA256,
      prepareStaging: () => {
        order.push('prepared')
        return Promise.resolve()
      },
      startFeed,
      ...overrides
    })
  }

  it('prepares ShipIt, feeds the zip, waits for the native update-downloaded event, then closes the feed', async () => {
    const { updater, setFeedURL, checkForUpdates, emitter } = createNativeUpdater((native) => {
      order.push('check')
      queueMicrotask(() => native.emit('update-downloaded'))
    })

    await stage(updater)

    expect(order).toEqual(['prepared', 'feed-started', 'check', 'feed-closed'])
    expect(setFeedURL).toHaveBeenCalledWith({ url: feed.url, headers: feed.headers })
    expect(checkForUpdates).toHaveBeenCalledOnce()
    expect(emitter.listenerCount('update-downloaded')).toBe(0)
    expect(emitter.listenerCount('error')).toBe(0)
  })

  it('works when ShipIt preparation does not apply', async () => {
    const { updater } = createNativeUpdater((native) =>
      queueMicrotask(() => native.emit('update-downloaded'))
    )

    await stage(updater, { prepareStaging: () => null })

    expect(order).toEqual(['feed-started', 'feed-closed'])
  })

  it('fails when macOS reports an error, and still closes the feed', async () => {
    const { updater, emitter } = createNativeUpdater((native) =>
      queueMicrotask(() => native.emit('error', new Error('code signature rejected')))
    )

    await expect(stage(updater)).rejects.toMatchObject({
      kind: 'staging',
      message: expect.stringContaining('code signature rejected')
    })
    expect(closeFeed).toHaveBeenCalledOnce()
    expect(emitter.listenerCount('update-downloaded')).toBe(0)
  })

  it('fails when macOS finds nothing to stage', async () => {
    const { updater } = createNativeUpdater((native) =>
      queueMicrotask(() => native.emit('update-not-available'))
    )

    await expect(stage(updater)).rejects.toMatchObject({ kind: 'staging' })
  })

  it('fails when macOS never answers', async () => {
    const { updater } = createNativeUpdater(() => undefined)

    await expect(stage(updater, { timeoutMs: 30 })).rejects.toMatchObject({
      kind: 'staging-timeout'
    })
    expect(closeFeed).toHaveBeenCalledOnce()
  })

  it('fails when the native updater throws while starting', async () => {
    const { updater } = createNativeUpdater(() => {
      throw new Error('not signed')
    })

    await expect(stage(updater)).rejects.toMatchObject({ kind: 'staging' })
    expect(closeFeed).toHaveBeenCalledOnce()
  })

  it('serves nothing when the zip changed on disk after verification, and does not call that a verdict on the release', async () => {
    await writeFile(zipPath, Buffer.from('swapped'))
    const { updater, checkForUpdates } = createNativeUpdater(() => undefined)

    await expect(stage(updater)).rejects.toMatchObject({ kind: 'staging', retryable: true })
    expect(startFeed).not.toHaveBeenCalled()
    expect(checkForUpdates).not.toHaveBeenCalled()
  })
})
