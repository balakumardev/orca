import { describe, expect, it, vi } from 'vitest'
import { CustomUpdateError } from './custom-update-errors'
import { CustomUpdateFeed } from './custom-update-feed'
import {
  CUSTOM_UPDATE_FEED_URL_ENV,
  CUSTOM_UPDATE_TEST_MODE_ENV,
  resolveCustomUpdateFeedOrigin
} from './custom-update-feed-origin'
import { parseCustomBuildVersion } from './custom-update-version'
import {
  SAMPLE_ASSET_PREFIX,
  sampleManifest,
  sampleRelease
} from './testing/custom-update-sample-release'

const RELEASES_URL = 'https://api.github.com/repos/balakumardev/orca/releases?per_page=10'
const MINUTE = 60_000

type Reply = {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** A ready-made response, for a body that is not JSON: oversized or streamed. */
  response?: () => Response
}

function json(reply: Reply): Response {
  if (reply.response) {
    return reply.response()
  }
  return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
    status: reply.status ?? 200,
    headers: reply.headers
  })
}

function manifestUrl(version: string): string {
  return `${SAMPLE_ASSET_PREFIX}v${version}/manifest.json`
}

function createFeed(runningVersion = '1.4.258+custom.4') {
  const running = parseCustomBuildVersion(runningVersion)
  if (!running) {
    throw new Error('bad running version')
  }
  let now = 1_000_000
  const replies = new Map<string, Reply[]>()
  const requests: { url: string; headers: Headers; signal?: AbortSignal | null }[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: new Headers(init?.headers), signal: init?.signal })
    const queue = replies.get(url)
    const reply = queue && queue.length > 1 ? queue.shift() : queue?.[0]
    if (!reply) {
      throw new TypeError(`unexpected request ${url}`)
    }
    return json(reply)
  })
  const feed = new CustomUpdateFeed({
    fetch,
    now: () => now,
    origin: resolveCustomUpdateFeedOrigin({}, true),
    running
  })
  return {
    feed,
    fetch,
    requests,
    advance: (ms: number) => {
      now += ms
    },
    reply: (url: string, ...next: Reply[]) => replies.set(url, next),
    publish: (releases: unknown[], headers: Record<string, string> = { etag: '"v1"' }) =>
      replies.set(RELEASES_URL, [{ body: releases, headers }]),
    manifest: (version: string, overrides: Record<string, unknown> = {}) =>
      replies.set(manifestUrl(version), [{ body: sampleManifest(version, overrides) }])
  }
}

describe('custom update feed', () => {
  describe('choosing a build', () => {
    it('offers the newest build, base first and counter second', async () => {
      const t = createFeed()
      t.publish([
        sampleRelease('1.4.258+custom.6'),
        sampleRelease('1.4.259+custom.5'),
        sampleRelease('1.4.258+custom.4')
      ])
      t.manifest('1.4.259+custom.5')
      t.manifest('1.4.258+custom.6')

      const candidate = await t.feed.check()

      expect(candidate?.manifest.version).toBe('1.4.259+custom.5')
      expect(candidate?.zipUrl).toBe(
        `${SAMPLE_ASSET_PREFIX}v1.4.259+custom.5/Orca-1.4.259+custom.5-arm64-mac.zip`
      )
      expect(candidate?.releaseUrl).toBe(
        'https://github.com/balakumardev/orca/releases/tag/v1.4.259%2Bcustom.5'
      )
    })

    it('never offers the running build, an older counter, or an older base', async () => {
      const t = createFeed()
      t.publish([
        sampleRelease('1.4.258+custom.4'),
        sampleRelease('1.4.258+custom.3'),
        sampleRelease('1.4.257+custom.9')
      ])

      expect(await t.feed.check()).toBeNull()
      // Only the release list was read: no manifest of an ineligible build is fetched.
      expect(t.fetch).toHaveBeenCalledTimes(1)
    })

    it('ignores drafts, prereleases and releases without a manifest asset', async () => {
      const t = createFeed()
      t.publish([
        sampleRelease('1.4.258+custom.9', { draft: true }),
        sampleRelease('1.4.258+custom.8', { prerelease: true }),
        sampleRelease('1.4.258+custom.7', { assets: [] }),
        sampleRelease('1.4.258+custom.5')
      ])
      t.manifest('1.4.258+custom.5')

      expect((await t.feed.check())?.manifest.version).toBe('1.4.258+custom.5')
      expect(t.fetch).toHaveBeenCalledTimes(2)
    })

    it('falls back to the next build when the newest manifest is malformed', async () => {
      const t = createFeed()
      t.publish([sampleRelease('1.4.258+custom.6'), sampleRelease('1.4.258+custom.5')])
      t.reply(manifestUrl('1.4.258+custom.6'), { body: { version: 'nonsense' } })
      t.manifest('1.4.258+custom.5')

      expect((await t.feed.check())?.manifest.version).toBe('1.4.258+custom.5')
    })

    it('skips a manifest that is not valid JSON', async () => {
      const t = createFeed()
      t.publish([sampleRelease('1.4.258+custom.6')])
      t.reply(manifestUrl('1.4.258+custom.6'), { body: undefined })

      expect(await t.feed.check()).toBeNull()
    })

    it.each([
      [
        'its manifest names a different version',
        { version: '1.4.258+custom.7', tag: 'v1.4.258+custom.7' }
      ],
      ['its manifest names an asset the release does not carry', { asset: 'Orca-other.zip' }],
      ['its manifest size disagrees with the uploaded asset', { size: 123 }]
    ])('skips a release when %s', async (_name, overrides) => {
      const t = createFeed()
      t.publish([sampleRelease('1.4.258+custom.6')])
      t.manifest('1.4.258+custom.6', overrides)

      expect(await t.feed.check()).toBeNull()
    })

    it('refuses assets that are not served from the fork release downloads', async () => {
      const t = createFeed()
      const release = sampleRelease('1.4.258+custom.6')
      const elsewhere = (release.assets as Record<string, unknown>[]).map((asset) => ({
        ...asset,
        browser_download_url: `https://example.com/${String(asset.name)}`
      }))
      t.publish([sampleRelease('1.4.258+custom.6', { assets: elsewhere })])

      expect(await t.feed.check()).toBeNull()
      expect(t.fetch).toHaveBeenCalledTimes(1)
    })

    it('fails the whole check when the newest manifest cannot be fetched', async () => {
      const t = createFeed()
      t.publish([sampleRelease('1.4.258+custom.6'), sampleRelease('1.4.258+custom.5')])
      t.reply(manifestUrl('1.4.258+custom.6'), { status: 502 })
      t.manifest('1.4.258+custom.5')

      // An older build must not quietly replace the newest one for as long as the cache lives.
      await expect(t.feed.check()).rejects.toMatchObject({ kind: 'feed' })
    })
  })

  describe('falling through to lower releases', () => {
    it('passes over excluded versions and offers the next lower eligible release', async () => {
      const t = createFeed()
      t.publish([sampleRelease('1.4.258+custom.7'), sampleRelease('1.4.258+custom.6')])
      t.manifest('1.4.258+custom.7')
      t.manifest('1.4.258+custom.6')

      const candidate = await t.feed.check({ exclude: new Set(['1.4.258+custom.7']) })

      expect(candidate?.manifest.version).toBe('1.4.258+custom.6')
    })

    it('offers nothing when every eligible release is excluded', async () => {
      const t = createFeed()
      t.publish([sampleRelease('1.4.258+custom.7')])

      expect(await t.feed.check({ exclude: new Set(['1.4.258+custom.7']) })).toBeNull()
    })

    it('does not fetch the manifest of an excluded release, and reuses fetched manifests', async () => {
      const t = createFeed()
      t.publish([sampleRelease('1.4.258+custom.7'), sampleRelease('1.4.258+custom.6')])
      t.manifest('1.4.258+custom.6')

      await t.feed.check({ exclude: new Set(['1.4.258+custom.7']) })
      await t.feed.check({ exclude: new Set(['1.4.258+custom.7']) })

      expect(t.requests.filter((request) => request.url.endsWith('manifest.json'))).toEqual([
        expect.objectContaining({ url: manifestUrl('1.4.258+custom.6') })
      ])
    })

    it('skips a release whose manifest was deleted instead of failing the check', async () => {
      const t = createFeed()
      t.publish([sampleRelease('1.4.258+custom.7'), sampleRelease('1.4.258+custom.6')])
      t.reply(manifestUrl('1.4.258+custom.7'), { status: 404 })
      t.manifest('1.4.258+custom.6')

      expect((await t.feed.check())?.manifest.version).toBe('1.4.258+custom.6')
    })
  })

  describe('asset URLs', () => {
    const release = (urlFor: (name: string) => string) => {
      const base = sampleRelease('1.4.258+custom.6')
      const assets = (base.assets as Record<string, unknown>[]).map((asset) => ({
        ...asset,
        browser_download_url: urlFor(String(asset.name))
      }))
      return sampleRelease('1.4.258+custom.6', { assets })
    }
    const good = (name: string) => `${SAMPLE_ASSET_PREFIX}v1.4.258+custom.6/${name}`

    it('accepts the exact download URL, with the plus sign written either way', async () => {
      for (const urlFor of [good, (name: string) => good(name).replaceAll('+', '%2B')]) {
        const t = createFeed()
        t.publish([release(urlFor)])
        t.reply(urlFor('manifest.json'), { body: sampleManifest('1.4.258+custom.6') })

        expect((await t.feed.check())?.manifest.version).toBe('1.4.258+custom.6')
      }
    })

    it.each([
      [
        'dot-dot segments that climb out of the downloads path',
        (n: string) => `${SAMPLE_ASSET_PREFIX}../../x/${n}`
      ],
      ['encoded dot-dot segments', (n: string) => `${SAMPLE_ASSET_PREFIX}%2e%2e/%2e%2e/x/${n}`],
      ['another tag', (n: string) => `${SAMPLE_ASSET_PREFIX}v1.4.258+custom.9/${n}`],
      ['a nested path', (n: string) => `${SAMPLE_ASSET_PREFIX}v1.4.258+custom.6/extra/${n}`],
      [
        'userinfo in front of the host',
        (n: string) =>
          `https://github.com@evil.example/balakumardev/orca/releases/download/v1.4.258+custom.6/${n}`
      ],
      ['a query string', (n: string) => `${good(n)}?x=1`],
      ['a fragment', (n: string) => `${good(n)}#x`],
      [
        'another host',
        (n: string) =>
          `https://evil.example/balakumardev/orca/releases/download/v1.4.258+custom.6/${n}`
      ],
      ['plain http', (n: string) => good(n).replace('https:', 'http:')]
    ])('refuses %s', async (_label, urlFor) => {
      const t = createFeed()
      t.publish([release(urlFor)])

      expect(await t.feed.check()).toBeNull()
      expect(t.fetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('conditional requests and the request budget', () => {
    it('sends the ETag back and reuses the answer on 304 without reading manifests again', async () => {
      const t = createFeed()
      t.publish([sampleRelease('1.4.258+custom.6')], { etag: '"abc"' })
      t.manifest('1.4.258+custom.6')
      const first = await t.feed.check()

      t.advance(2 * MINUTE)
      t.reply(RELEASES_URL, { status: 304 })
      const second = await t.feed.check()

      expect(second).toBe(first)
      const releaseRequests = t.requests.filter((request) => request.url === RELEASES_URL)
      expect(releaseRequests.map((request) => request.headers.get('if-none-match'))).toEqual([
        null,
        '"abc"'
      ])
      expect(t.requests.filter((request) => request.url.endsWith('manifest.json'))).toHaveLength(1)
    })

    it('answers from memory when asked again within a minute', async () => {
      const t = createFeed()
      t.publish([sampleRelease('1.4.258+custom.6')])
      t.manifest('1.4.258+custom.6')
      await t.feed.check()
      t.advance(30_000)
      await t.feed.check()

      expect(t.requests.filter((request) => request.url === RELEASES_URL)).toHaveLength(1)
    })

    it('asks for the GitHub JSON media type and no credentials', async () => {
      const t = createFeed()
      t.publish([])
      await t.feed.check()

      expect(t.requests[0].headers.get('accept')).toBe('application/vnd.github+json')
      expect(t.requests[0].headers.get('authorization')).toBeNull()
    })
  })

  describe('rate limits and failures', () => {
    it('pauses until the reset time after the primary rate limit', async () => {
      const t = createFeed()
      const resetAtSeconds = (1_000_000 + 20 * MINUTE) / 1000
      t.reply(RELEASES_URL, {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAtSeconds) }
      })

      await expect(t.feed.check()).rejects.toMatchObject({ kind: 'rate-limited' })
      expect(t.feed.retryDelayMs).toBe(20 * MINUTE)

      t.advance(10 * MINUTE)
      await expect(t.feed.check()).rejects.toMatchObject({ kind: 'rate-limited' })
      expect(t.fetch).toHaveBeenCalledTimes(1)

      t.advance(10 * MINUTE)
      t.publish([])
      expect(await t.feed.check()).toBeNull()
      expect(t.fetch).toHaveBeenCalledTimes(2)
    })

    it('honors Retry-After on 429', async () => {
      const t = createFeed()
      t.reply(RELEASES_URL, { status: 429, headers: { 'retry-after': '3600' } })

      await expect(t.feed.check()).rejects.toBeInstanceOf(CustomUpdateError)
      expect(t.feed.retryDelayMs).toBe(3600 * 1000)
    })

    it('backs off exponentially on server errors and recovers on success', async () => {
      const t = createFeed()
      t.reply(RELEASES_URL, { status: 500 })
      await expect(t.feed.check()).rejects.toMatchObject({ kind: 'feed' })
      expect(t.feed.retryDelayMs).toBe(15 * MINUTE)

      t.advance(15 * MINUTE)
      await expect(t.feed.check()).rejects.toMatchObject({ kind: 'feed' })
      expect(t.feed.retryDelayMs).toBe(30 * MINUTE)

      t.advance(30 * MINUTE)
      t.publish([])
      await t.feed.check()
      expect(t.feed.retryDelayMs).toBe(0)
    })

    it('reports being offline as a network error without pausing later checks', async () => {
      const t = createFeed()
      // No reply registered: the fake fetch rejects like a dead connection.
      await expect(t.feed.check()).rejects.toMatchObject({ kind: 'network' })
      expect(t.feed.retryDelayMs).toBe(0)

      t.publish([sampleRelease('1.4.258+custom.6')])
      t.manifest('1.4.258+custom.6')
      expect((await t.feed.check())?.manifest.version).toBe('1.4.258+custom.6')
    })

    it('lets a person bypass a pause that background checks honor', async () => {
      const t = createFeed()
      t.reply(RELEASES_URL, { status: 500 })
      await expect(t.feed.check()).rejects.toMatchObject({ kind: 'feed' })
      expect(t.feed.retryDelayMs).toBe(15 * MINUTE)

      await expect(t.feed.check()).rejects.toMatchObject({ kind: 'rate-limited' })
      t.advance(2 * MINUTE)
      t.publish([sampleRelease('1.4.258+custom.6')])
      t.manifest('1.4.258+custom.6')

      expect((await t.feed.check({ force: true }))?.manifest.version).toBe('1.4.258+custom.6')
      expect(t.feed.retryDelayMs).toBe(0)
    })

    it('does not pause checks for a client error other than a rate limit', async () => {
      const t = createFeed()
      t.reply(RELEASES_URL, { status: 404 })

      await expect(t.feed.check()).rejects.toMatchObject({ kind: 'feed' })
      expect(t.feed.retryDelayMs).toBe(0)
    })

    it('rejects an answer that is not a release list', async () => {
      const t = createFeed()
      t.reply(RELEASES_URL, { body: { message: 'nope' } })

      await expect(t.feed.check()).rejects.toMatchObject({ kind: 'feed' })
    })
  })
})

describe('custom update feed body limits', () => {
  /** A body that hands out `chunks` chunks of `size` bytes, counting how many were actually pulled. */
  function streamed(chunks: number, size: number, headers: Record<string, string> = {}) {
    const state = { pulled: 0, cancelled: false }
    const response = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (state.pulled >= chunks) {
              controller.close()
              return
            }
            state.pulled += 1
            controller.enqueue(new Uint8Array(size).fill(32))
          },
          cancel() {
            state.cancelled = true
          }
        }),
        { status: 200, headers }
      )
    return { state, response }
  }

  const VERSION = '1.4.258+custom.6'

  it('stops reading a manifest that has no length header once it passes 16 KiB, and aborts the request', async () => {
    const t = createFeed()
    t.publish([sampleRelease(VERSION)])
    const body = streamed(100_000, 64 * 1024)
    t.reply(manifestUrl(VERSION), { response: body.response })

    expect(await t.feed.check()).toBeNull()

    // 400 MB offered, a few chunks read: the body is never held whole.
    expect(body.state.pulled).toBeLessThan(10)
    expect(body.state.cancelled).toBe(true)
    expect(
      t.requests.find((request) => request.url === manifestUrl(VERSION))?.signal?.aborted
    ).toBe(true)
  })

  it('refuses a manifest by its Content-Length without reading any of it', async () => {
    const t = createFeed()
    t.publish([sampleRelease(VERSION)])
    const body = streamed(10, 1024, { 'content-length': String(400 * 1024 * 1024) })
    t.reply(manifestUrl(VERSION), { response: body.response })

    expect(await t.feed.check()).toBeNull()

    // A stream primes itself with one pull before anyone reads; the feed read nothing and cancelled it.
    expect(body.state.pulled).toBeLessThanOrEqual(1)
    expect(body.state.cancelled).toBe(true)
    expect(
      t.requests.find((request) => request.url === manifestUrl(VERSION))?.signal?.aborted
    ).toBe(true)
  })

  it('still reads a manifest of ordinary size', async () => {
    const t = createFeed()
    t.publish([sampleRelease(VERSION)])
    t.manifest(VERSION)

    expect((await t.feed.check())?.manifest.version).toBe(VERSION)
  })

  it('reads a manifest split across many small chunks', async () => {
    const t = createFeed()
    t.publish([sampleRelease(VERSION)])
    const text = JSON.stringify(sampleManifest(VERSION))
    const pieces = text.match(/.{1,7}/gs) ?? []
    t.reply(manifestUrl(VERSION), {
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const piece of pieces) {
                controller.enqueue(new TextEncoder().encode(piece))
              }
              controller.close()
            }
          }),
          { status: 200 }
        )
    })

    expect((await t.feed.check())?.manifest.version).toBe(VERSION)
  })

  it('refuses a release list larger than expected instead of buffering it', async () => {
    const t = createFeed()
    const body = streamed(100_000, 64 * 1024)
    t.reply(RELEASES_URL, { response: body.response })

    await expect(t.feed.check()).rejects.toMatchObject({ kind: 'feed' })

    expect(body.state.pulled).toBeLessThan(100)
    expect(t.requests[0].signal?.aborted).toBe(true)
  })

  it('aborts the request of an answer it will not use', async () => {
    const t = createFeed()
    t.reply(RELEASES_URL, { status: 500 })

    await expect(t.feed.check()).rejects.toMatchObject({ kind: 'feed' })

    expect(t.requests[0].signal?.aborted).toBe(true)
  })

  it('returns the asset URL in its normalized form', async () => {
    const t = createFeed()
    t.publish([sampleRelease(VERSION)])
    t.manifest(VERSION)

    const candidate = await t.feed.check()

    expect(candidate?.zipUrl).toBe(new URL(candidate?.zipUrl ?? '').href)
  })
})

describe('custom update feed origin', () => {
  const override = { [CUSTOM_UPDATE_FEED_URL_ENV]: 'http://127.0.0.1:4321' }

  it('uses the GitHub API of the fork', () => {
    expect(resolveCustomUpdateFeedOrigin({}, true)).toEqual({
      apiBase: 'https://api.github.com',
      assetUrlPrefix: 'https://github.com/balakumardev/orca/releases/download/',
      overridden: false
    })
  })

  it('honors a loopback override only for an unpackaged app', () => {
    expect(resolveCustomUpdateFeedOrigin(override, false)).toEqual({
      apiBase: 'http://127.0.0.1:4321',
      assetUrlPrefix: 'http://127.0.0.1:4321/',
      overridden: true
    })
  })

  it('ignores the override in a packaged app unless test mode is on', () => {
    expect(resolveCustomUpdateFeedOrigin(override, true).overridden).toBe(false)
    expect(
      resolveCustomUpdateFeedOrigin({ ...override, [CUSTOM_UPDATE_TEST_MODE_ENV]: '1' }, true)
        .overridden
    ).toBe(true)
  })

  it.each([
    'http://localhost:4321',
    'http://127.0.0.1',
    'http://127.0.0.1:4321/releases',
    'https://127.0.0.1:4321',
    'http://user:pw@127.0.0.1:4321',
    'http://127.0.0.1:4321@example.com',
    'http://127.0.0.1.example.com:4321',
    'http://127.0.0.1:4321/?x=1',
    'http://10.0.0.1:4321',
    'not a url'
  ])('rejects %s as an override', (value) => {
    expect(
      resolveCustomUpdateFeedOrigin({ [CUSTOM_UPDATE_FEED_URL_ENV]: value }, false).overridden
    ).toBe(false)
  })
})
