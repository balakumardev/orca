import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSquirrelFeed, type SquirrelFeed } from './custom-update-squirrel-feed'

type Reply = { status: number; body: Buffer }

const sha256Of = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** Like `get`, but reports a body that ends before its Content-Length instead of rejecting. */
function getAll(url: string): Promise<{ status: number; body: Buffer; complete: boolean }> {
  return new Promise((resolve) => {
    const req = httpRequest(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      const finish = (complete: boolean): void =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), complete })
      res.on('end', () => finish(true))
      res.on('error', () => finish(false))
      res.on('aborted', () => finish(false))
    })
    req.on('error', () => resolve({ status: 0, body: Buffer.alloc(0), complete: false }))
    req.end()
  })
}

function get(
  url: string,
  options: { headers?: Record<string, string>; method?: string } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('localhost feed for Squirrel.Mac', () => {
  const zip = Buffer.from('zip bytes '.repeat(1000))
  let directory: string
  let feed: SquirrelFeed | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-squirrel-feed-'))
    await writeFile(join(directory, 'update.zip'), zip)
  })
  afterEach(async () => {
    await feed?.close()
    feed = null
    await rm(directory, { recursive: true, force: true })
  })

  async function start(): Promise<SquirrelFeed> {
    feed = await startSquirrelFeed({
      zipPath: join(directory, 'update.zip'),
      size: zip.length,
      sha256: sha256Of(zip)
    })
    return feed
  }

  async function zipUrl(running: SquirrelFeed): Promise<string> {
    const manifest = await get(running.url, { headers: running.headers })
    return (JSON.parse(manifest.body.toString()) as { url: string }).url
  }

  it('listens on the IPv4 loopback address only', async () => {
    const running = await start()

    expect(new URL(running.url).hostname).toBe('127.0.0.1')
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('answers the feed request with the zip location, using the contract of electron-updater', async () => {
    const running = await start()
    const reply = await get(running.url, { headers: running.headers })

    expect(reply.status).toBe(200)
    const body = JSON.parse(reply.body.toString()) as { url: string }
    expect(Object.keys(body)).toEqual(['url'])
    expect(body.url).toMatch(new RegExp(`^${running.url}/[0-9a-f]{64}\\.zip$`))
    expect(running.headers.Authorization).toMatch(/^Basic /)
  })

  it('refuses the feed request without the credentials', async () => {
    const running = await start()

    expect((await get(running.url)).status).toBe(401)
    expect(
      (await get(running.url, { headers: { Authorization: 'Basic d3Jvbmc6Y3JlZHM=' } })).status
    ).toBe(401)
  })

  it('serves the zip once and then closes', async () => {
    const running = await start()
    const url = await zipUrl(running)

    const first = await get(url)
    expect(first.status).toBe(200)
    expect(first.body).toEqual(zip)

    await vi.waitFor(async () => {
      await expect(get(url)).rejects.toThrow()
    })
  })

  it('serves the zip again when the first transfer is cut short', async () => {
    const big = Buffer.alloc(64 * 1024 * 1024, 7)
    await writeFile(join(directory, 'update.zip'), big)
    feed = await startSquirrelFeed({
      zipPath: join(directory, 'update.zip'),
      size: big.length,
      sha256: sha256Of(big)
    })
    const url = await zipUrl(feed)
    await new Promise<void>((resolve, reject) => {
      const interrupted = httpRequest(url, (res) => {
        res.once('data', () => {
          interrupted.destroy()
          resolve()
        })
      })
      interrupted.on('error', () => undefined)
      interrupted.on('close', () => resolve())
      interrupted.setTimeout(10_000, () => reject(new Error('no first chunk')))
      interrupted.end()
    })

    await vi.waitFor(async () => {
      const retry = await get(url)
      expect(retry.status).toBe(200)
      expect(retry.body.length).toBe(big.length)
    })
  })

  it('reports the real listening address, not a literal', async () => {
    const running = await start()

    expect(new URL(running.url).port).not.toBe('0')
    expect((await get(running.url, { headers: running.headers })).status).toBe(200)
  })

  it('answers 410 to a second request that arrives on the same connection window', async () => {
    const running = await start()
    const url = await zipUrl(running)

    const [first, second] = await Promise.all([get(url), get(url)])
    expect([first.status, second.status].sort()).toEqual([200, 410])
  })

  describe('a file that no longer matches what was verified', () => {
    // Bigger than the held-back tail, so the file really does stream in several chunks.
    const real = Buffer.from(Array.from({ length: 400_000 }, (_, index) => index % 251))

    async function startFor(onDisk: Buffer): Promise<SquirrelFeed> {
      await writeFile(join(directory, 'update.zip'), onDisk)
      feed = await startSquirrelFeed({
        zipPath: join(directory, 'update.zip'),
        size: real.length,
        sha256: sha256Of(real)
      })
      return feed
    }

    it('serves a file that still matches, complete', async () => {
      const running = await startFor(real)

      const reply = await getAll(await zipUrl(running))

      expect(reply).toMatchObject({ status: 200, complete: true })
      expect(reply.body.equals(real)).toBe(true)
    })

    it('never completes a body from a file swapped for another of the same size', async () => {
      const swapped = Buffer.from(real)
      swapped[1000] ^= 0xff
      const running = await startFor(swapped)

      const reply = await getAll(await zipUrl(running))

      expect(reply.complete).toBe(false)
      expect(reply.body.length).toBeLessThan(real.length)
      expect(reply.body.equals(swapped.subarray(0, reply.body.length))).toBe(true)
    })

    it('withholds the end of the file until the whole file has matched', async () => {
      const swapped = Buffer.from(real)
      swapped[swapped.length - 1] ^= 0xff
      const running = await startFor(swapped)

      const reply = await getAll(await zipUrl(running))

      expect(reply.complete).toBe(false)
      expect(reply.body.length).toBeLessThanOrEqual(real.length - 64 * 1024)
    })

    it('never completes a body from a file that grew', async () => {
      const running = await startFor(Buffer.concat([real, Buffer.from('appended')]))

      const reply = await getAll(await zipUrl(running))

      expect(reply.complete).toBe(false)
    })

    it('never completes a body from a file that shrank', async () => {
      const running = await startFor(real.subarray(0, -10))

      const reply = await getAll(await zipUrl(running))

      expect(reply.complete).toBe(false)
    })

    it('does not offer the rejected file a second time', async () => {
      const swapped = Buffer.from(real)
      swapped[5] ^= 0xff
      const running = await startFor(swapped)
      const url = await zipUrl(running)
      await getAll(url)

      expect((await getAll(url)).status).toBe(410)
    })
  })

  it('does not serve the zip to a guessed path', async () => {
    const running = await start()
    const guess = `${running.url}/${'0'.repeat(64)}.zip`

    expect((await get(guess)).status).toBe(404)
    expect((await get(`${running.url}/update.zip`)).status).toBe(404)
  })

  it('refuses a request that names another host, as in DNS rebinding', async () => {
    const running = await start()
    const url = new URL(await zipUrl(running))

    const reply = await get(url.href, { headers: { Host: `evil.example:${url.port}` } })
    expect(reply.status).toBe(404)
  })

  it('refuses verbs other than GET', async () => {
    const running = await start()

    const reply = await get(running.url, { method: 'POST', headers: running.headers })
    expect(reply.status).toBe(404)
  })

  it('stops listening when closed, even before the zip was fetched', async () => {
    const running = await start()
    await running.close()

    await expect(get(running.url, { headers: running.headers })).rejects.toThrow()
  })
})
