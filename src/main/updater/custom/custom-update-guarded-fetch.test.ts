import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  CUSTOM_UPDATE_FEED_URL_ENV,
  isAllowedFeedUrl,
  resolveCustomUpdateFeedOrigin
} from './custom-update-feed-origin'
import { CustomUpdateFeed } from './custom-update-feed'
import {
  createGuardedFetch,
  type GuardedRequest,
  type RequestFactory
} from './custom-update-guarded-fetch'
import { parseCustomBuildVersion } from './custom-update-version'
import {
  SAMPLE_ASSET_PREFIX,
  sampleManifest,
  sampleRelease
} from './testing/custom-update-sample-release'

class FakeRequest extends EventEmitter implements GuardedRequest {
  end = vi.fn()
  abort = vi.fn()
  followRedirect = vi.fn()
}

const production = resolveCustomUpdateFeedOrigin({}, true)
const allowed = (url: string): boolean => isAllowedFeedUrl(production, url)

function setup() {
  const requests: FakeRequest[] = []
  const urls: string[] = []
  const request: RequestFactory = (options) => {
    urls.push(options.url)
    const fake = new FakeRequest()
    requests.push(fake)
    return fake
  }
  return { fetch: createGuardedFetch({ request, isAllowedUrl: allowed }), requests, urls }
}

function respond(request: FakeRequest, status: number, body: string, headers = {}): void {
  const response = Object.assign(Readable.from([Buffer.from(body)]), {
    statusCode: status,
    statusMessage: 'OK',
    headers: { 'content-type': 'text/plain', ...headers }
  })
  request.emit('response', response)
}

/** What Chromium hands over for a 304 or a 204: a response with no data that closes at once. */
function respondEmpty(request: FakeRequest, status: number, headers = {}): void {
  const response = Object.assign(Readable.from([]), {
    statusCode: status,
    statusMessage: status === 304 ? 'Not Modified' : 'No Content',
    headers
  })
  request.emit('response', response)
}

const RELEASES = 'https://api.github.com/repos/balakumardev/orca/releases?per_page=10'
const ASSET =
  'https://github.com/balakumardev/orca/releases/download/v1.4.258%2Bcustom.5/manifest.json'

describe('the guarded fetch', () => {
  it('returns the response body, status and headers', async () => {
    const t = setup()
    const pending = t.fetch(RELEASES, { headers: { Accept: 'application/json' } })
    respond(t.requests[0], 200, 'hello', { etag: '"abc"' })

    const response = await pending
    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe('"abc"')
    expect(await response.text()).toBe('hello')
    expect(t.requests[0].end).toHaveBeenCalled()
  })

  it('follows a redirect to an allowed host, and only from inside the redirect event', async () => {
    const t = setup()
    const pending = t.fetch(ASSET)

    t.requests[0].emit(
      'redirect',
      302,
      'GET',
      'https://release-assets.githubusercontent.com/github-production-release-asset/1?x=y'
    )
    expect(t.requests[0].followRedirect).toHaveBeenCalledTimes(1)
    respond(t.requests[0], 200, 'ok')

    expect((await pending).status).toBe(200)
  })

  it.each([
    ['another host', 'https://evil.example/x'],
    ['plain http', 'http://github.com/x'],
    ['userinfo that disguises the host', 'https://github.com@evil.example/x'],
    ['a look-alike host', 'https://github.com.evil.example/x'],
    ['a different port', 'https://github.com:8443/x'],
    ['a loopback address', 'https://127.0.0.1/x'],
    ['a non-URL', 'not a url']
  ])('refuses a redirect to %s without following it', async (_label, target) => {
    const t = setup()
    const pending = t.fetch(ASSET)
    const rejection = expect(pending).rejects.toMatchObject({ kind: 'feed' })

    t.requests[0].emit('redirect', 302, 'GET', target)

    await rejection
    expect(t.requests[0].followRedirect).not.toHaveBeenCalled()
    expect(t.requests[0].abort).toHaveBeenCalled()
  })

  it('stops after five redirects', async () => {
    const t = setup()
    const pending = t.fetch(ASSET)
    const rejection = expect(pending).rejects.toMatchObject({ kind: 'feed' })

    for (let hop = 0; hop < 6; hop += 1) {
      t.requests[0].emit('redirect', 302, 'GET', `https://github.com/hop/${hop}`)
    }

    await rejection
    expect(t.requests[0].followRedirect).toHaveBeenCalledTimes(5)
  })

  it('refuses a first URL outside the allowlist before any request is made', async () => {
    const t = setup()

    await expect(t.fetch('https://evil.example/releases')).rejects.toMatchObject({ kind: 'feed' })
    expect(t.urls).toEqual([])
  })

  it('does not put the refused URL in the error', async () => {
    const t = setup()

    await expect(t.fetch('https://evil.example/secret-path')).rejects.toSatisfy(
      (error: Error) => !error.message.includes('secret-path')
    )
  })

  it('aborts the request when the caller cancels', async () => {
    const t = setup()
    const controller = new AbortController()
    const pending = t.fetch(RELEASES, { signal: controller.signal })
    const rejection = expect(pending).rejects.toMatchObject({ kind: 'network' })

    controller.abort()

    await rejection
    expect(t.requests[0].abort).toHaveBeenCalled()
  })

  it('does not even send the request when the signal is already aborted', async () => {
    const t = setup()
    const controller = new AbortController()
    controller.abort()

    await expect(t.fetch(RELEASES, { signal: controller.signal })).rejects.toMatchObject({
      kind: 'network'
    })
    expect(t.requests[0].end).not.toHaveBeenCalled()
  })

  it('maps a transport error to a network failure', async () => {
    const t = setup()
    const pending = t.fetch(RELEASES)
    const rejection = expect(pending).rejects.toMatchObject({ kind: 'network' })

    t.requests[0].emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))

    await rejection
  })
})

describe('the address that is requested', () => {
  it('is the one the URL parser reads, the same one that was judged', async () => {
    const t = setup()
    const pending = t.fetch(
      'HTTPS://API.GitHub.com:443/repos/balakumardev/orca/releases?per_page=10'
    )
    respond(t.requests[0], 200, 'x')
    await pending

    expect(t.urls).toEqual([RELEASES])
  })
})

describe('responses that carry no body', () => {
  it.each([
    [304, 'Not Modified'],
    [204, 'No Content'],
    [205, 'Reset Content']
  ])('settles on a %s instead of hanging', async (status) => {
    const t = setup()
    const pending = t.fetch(RELEASES, { signal: AbortSignal.timeout(5_000) })
    respondEmpty(t.requests[0], status, { etag: '"abc"' })

    const response = await pending
    expect(response.status).toBe(status)
    expect(response.body).toBeNull()
    expect(response.headers.get('etag')).toBe('"abc"')
  })

  it('lets go of the caller signal once a bodiless response has settled', async () => {
    const t = setup()
    const controller = new AbortController()
    const pending = t.fetch(RELEASES, { signal: controller.signal })
    respondEmpty(t.requests[0], 304)
    await pending

    controller.abort()

    expect(t.requests[0].abort).not.toHaveBeenCalled()
  })

  it('keeps the caller signal wired to a body that is still being read', async () => {
    const t = setup()
    const controller = new AbortController()
    const pending = t.fetch(RELEASES, { signal: controller.signal })
    respond(t.requests[0], 200, 'x'.repeat(10))
    await pending

    controller.abort()

    expect(t.requests[0].abort).toHaveBeenCalled()
  })

  it('rejects, and aborts the request, when the response cannot be turned into a Response', async () => {
    const t = setup()
    const pending = t.fetch(RELEASES, { signal: AbortSignal.timeout(5_000) })
    const rejection = expect(pending).rejects.toMatchObject({ kind: 'network' })

    // A header name no Headers object accepts: building the Response throws inside the listener.
    respond(t.requests[0], 200, 'x', { 'bad name': 'x' })

    await rejection
    expect(t.requests[0].abort).toHaveBeenCalled()
  })

  it.each([
    ['an out-of-range status', 600],
    ['an informational status', 101]
  ])(
    'rejects on %s instead of throwing into the caller of the listener',
    async (_label, status) => {
      const t = setup()
      const pending = t.fetch(RELEASES, { signal: AbortSignal.timeout(5_000) })
      const rejection = expect(pending).rejects.toMatchObject({ kind: 'network' })

      expect(() => respondEmpty(t.requests[0], status)).not.toThrow()

      await rejection
      expect(t.requests[0].abort).toHaveBeenCalled()
    }
  )

  it('does not raise an unhandled error when a response that was never read errors', async () => {
    const t = setup()
    const pending = t.fetch(RELEASES)
    const response = Object.assign(Readable.from([]), {
      statusCode: 304,
      statusMessage: 'Not Modified',
      headers: {}
    })
    t.requests[0].emit('response', response)
    await pending

    expect(() => response.destroy(new Error('socket hang up'))).not.toThrow()
    await new Promise((resolve) => setImmediate(resolve))
  })
})

describe('the release feed over the guarded fetch', () => {
  const RELEASE_LIST = 'https://api.github.com/repos/balakumardev/orca/releases?per_page=10'
  const MANIFEST = `${SAMPLE_ASSET_PREFIX}v1.4.258+custom.6/manifest.json`
  type Script = (request: FakeRequest) => void
  const json =
    (body: unknown, headers = {}): Script =>
    (request) => {
      const response = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
        statusCode: 200,
        statusMessage: 'OK',
        headers
      })
      request.emit('response', response)
    }

  function wire(scripts: Record<string, Script[]>) {
    let now = 1_000_000
    const seen: { url: string; headers: Record<string, string> }[] = []
    const request: RequestFactory = (options) => {
      seen.push({ url: options.url, headers: options.headers })
      const fake = new FakeRequest()
      const script = scripts[options.url]?.shift()
      // Chromium answers from its loader callback, after the request was ended.
      setImmediate(() => (script ? script(fake) : fake.emit('error', new Error('unscripted'))))
      return fake
    }
    const running = parseCustomBuildVersion('1.4.258+custom.4')
    if (!running) {
      throw new Error('bad running version')
    }
    const feed = new CustomUpdateFeed({
      fetch: createGuardedFetch({ request, isAllowedUrl: allowed }),
      now: () => now,
      origin: production,
      running
    })
    return { feed, seen, advance: (ms: number) => (now += ms) }
  }

  it('reuses its release list when GitHub answers 304, the normal second check', async () => {
    const t = wire({
      [RELEASE_LIST]: [
        json([sampleRelease('1.4.258+custom.6')], { etag: '"abc"' }),
        (request) => respondEmpty(request, 304, { etag: '"abc"' })
      ],
      [MANIFEST]: [json(sampleManifest('1.4.258+custom.6'))]
    })
    const first = await t.feed.check()

    t.advance(2 * 60_000)
    const second = await t.feed.check()

    expect(second).toBe(first)
    expect(t.seen.filter((entry) => entry.url === RELEASE_LIST)[1].headers['if-none-match']).toBe(
      '"abc"'
    )
  }, 5_000)

  it('rejects a release list that answers 204 instead of waiting for it', async () => {
    const t = wire({ [RELEASE_LIST]: [(request) => respondEmpty(request, 204)] })

    await expect(t.feed.check()).rejects.toMatchObject({ kind: 'feed' })
  }, 5_000)

  it('skips a release whose manifest answers 204', async () => {
    const t = wire({
      [RELEASE_LIST]: [json([sampleRelease('1.4.258+custom.6')])],
      [MANIFEST]: [(request) => respondEmpty(request, 204)]
    })

    expect(await t.feed.check()).toBeNull()
  }, 5_000)
})

describe('which URLs a release request may use', () => {
  it.each([
    'https://github.com/balakumardev/orca/releases/download/v1/x',
    'https://api.github.com/repos/balakumardev/orca/releases',
    'https://objects.githubusercontent.com/a/b',
    'https://release-assets.githubusercontent.com/a/b'
  ])('allows %s', (url) => {
    expect(allowed(url)).toBe(true)
  })

  it.each([
    'http://github.com/x',
    'https://raw.githubusercontent.com/x',
    'https://github.io/x',
    'https://user:pass@github.com/x',
    'https://github.com:444/x'
  ])('refuses %s', (url) => {
    expect(allowed(url)).toBe(false)
  })

  it('allows only the loopback origin of a test feed override', () => {
    const origin = resolveCustomUpdateFeedOrigin(
      { [CUSTOM_UPDATE_FEED_URL_ENV]: 'http://127.0.0.1:4455' },
      false
    )

    expect(origin.overridden).toBe(true)
    expect(isAllowedFeedUrl(origin, 'http://127.0.0.1:4455/repos/x')).toBe(true)
    expect(isAllowedFeedUrl(origin, 'http://127.0.0.1:4456/repos/x')).toBe(false)
    expect(isAllowedFeedUrl(origin, 'https://github.com/x')).toBe(false)
  })
})
