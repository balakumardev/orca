import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadUpdateZip, sha256OfFile } from './custom-update-download'
import { diskNeededFor } from './custom-update-extract'

const PAYLOAD = Buffer.from('orca update payload '.repeat(500))
const PAYLOAD_SHA256 = createHash('sha256').update(PAYLOAD).digest('hex')

function chunked(data: Buffer, size = 1000): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.length) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(data.subarray(offset, offset + size)))
      offset += size
    }
  })
}

function respond(data: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(chunked(data), { status: 200, headers })
}

describe('downloading the update zip', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-update-dl-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  function request(overrides: Partial<Parameters<typeof downloadUpdateZip>[0]> = {}) {
    const onProgress = vi.fn<(percent: number) => void>()
    return {
      url: 'https://example.invalid/update.zip',
      destination: join(directory, 'work', 'update.zip'),
      expectedSize: PAYLOAD.length,
      expectedSha256: PAYLOAD_SHA256,
      fetch: vi.fn(async () => respond(PAYLOAD)),
      onProgress,
      getFreeBytes: async () => diskNeededFor(PAYLOAD.length) * 2,
      ...overrides,
      progress: onProgress
    }
  }

  async function leftovers(): Promise<string[]> {
    return existsSync(join(directory, 'work')) ? readdir(join(directory, 'work')) : []
  }

  it('stores the zip when size and checksum match, and reports progress below 100', async () => {
    const download = request()
    await downloadUpdateZip(download)

    expect(await readFile(download.destination)).toEqual(PAYLOAD)
    expect(await leftovers()).toEqual(['update.zip'])
    const percents = download.progress.mock.calls.map(([percent]) => percent)
    expect(percents.at(-1)).toBe(99)
    expect(percents).toEqual([...percents].sort((a, b) => a - b))
  })

  it('refuses a body of the right size that differs from the manifest checksum, leaves nothing behind, and does not call it a verdict on the release (a proxy or a CDN can do it)', async () => {
    const tampered = Buffer.from(PAYLOAD)
    tampered[10] ^= 0xff
    await expect(
      downloadUpdateZip(request({ fetch: vi.fn(async () => respond(tampered)) }))
    ).rejects.toMatchObject({ kind: 'check-error', retryable: true })
    expect(await leftovers()).toEqual([])
  })

  it('refuses a body shorter than the manifest size', async () => {
    const short = PAYLOAD.subarray(0, -1)
    await expect(
      downloadUpdateZip(request({ fetch: vi.fn(async () => respond(short)) }))
    ).rejects.toMatchObject({ kind: 'download' })
    expect(await leftovers()).toEqual([])
  })

  it('stops reading a body longer than the manifest size', async () => {
    const long = Buffer.concat([PAYLOAD, Buffer.from('extra')])
    await expect(
      downloadUpdateZip(request({ fetch: vi.fn(async () => respond(long)) }))
    ).rejects.toMatchObject({ kind: 'download' })
    expect(await leftovers()).toEqual([])
  })

  it('refuses a declared content length that differs from the manifest before writing', async () => {
    await expect(
      downloadUpdateZip(
        request({
          fetch: vi.fn(async () =>
            respond(PAYLOAD, { 'content-length': String(PAYLOAD.length + 1) })
          )
        })
      )
    ).rejects.toMatchObject({ kind: 'download' })
    expect(await leftovers()).toEqual([])
  })

  it('refuses to start without room for the zip, its extracted copy and the safety margin, and says how much room there was', async () => {
    const needed = diskNeededFor(PAYLOAD.length)
    const download = request({ getFreeBytes: async () => needed - 1 })

    await expect(downloadUpdateZip(download)).rejects.toMatchObject({
      kind: 'disk-space',
      freeBytes: needed - 1,
      neededBytes: needed
    })
    expect(download.fetch).not.toHaveBeenCalled()
  })

  it('starts with exactly that much room', async () => {
    const download = request({
      getFreeBytes: async () => diskNeededFor(PAYLOAD.length)
    })

    await expect(downloadUpdateZip(download)).resolves.toBeUndefined()
  })

  it('reports a failing HTTP status as a download failure', async () => {
    await expect(
      downloadUpdateZip(
        request({ fetch: vi.fn(async () => new Response('gone', { status: 404 })) })
      )
    ).rejects.toMatchObject({ kind: 'download' })
  })

  it('gives up on a stalled body', async () => {
    const stalled = new Response(new ReadableStream({ pull: () => new Promise(() => undefined) }), {
      status: 200
    })
    await expect(
      downloadUpdateZip(request({ fetch: vi.fn(async () => stalled), idleTimeoutMs: 20 }))
    ).rejects.toMatchObject({ kind: 'network' })
    expect(await leftovers()).toEqual([])
  })

  it('gives up when the server never sends response headers, and does not hang the caller', async () => {
    const hung = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new Error('aborted'))
          }
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )

    await expect(
      downloadUpdateZip(request({ fetch: hung, headerTimeoutMs: 20 }))
    ).rejects.toMatchObject({
      kind: 'network'
    })
    expect(await leftovers()).toEqual([])
  })

  it('still lets a caller cancel while waiting for headers', async () => {
    const controller = new AbortController()
    const hung = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new Error('aborted'))
          }
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )

    const download = downloadUpdateZip(
      request({ fetch: hung, signal: controller.signal, headerTimeoutMs: 60_000 })
    )
    controller.abort()

    await expect(download).rejects.toThrow('aborted')
  })

  it('does not apply the header timeout to a slow body that keeps moving', async () => {
    let offset = 0
    const trickle = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 15))
        if (offset >= PAYLOAD.length) {
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array(PAYLOAD.subarray(offset, offset + 2000)))
        offset += 2000
      }
    })
    const slow = vi.fn(async () => new Response(trickle, { status: 200 }))

    await downloadUpdateZip(request({ fetch: slow, headerTimeoutMs: 40 }))

    expect(await readFile(join(directory, 'work', 'update.zip'))).toEqual(PAYLOAD)
  })

  describe('how long a transfer may take', () => {
    /** A body that hands over one chunk just inside the idle timeout, for ever. */
    function trickling(): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 15))
          controller.enqueue(new Uint8Array([1]))
        }
      })
    }

    it('gives up on a body that keeps trickling past the overall deadline', async () => {
      const trickle = vi.fn(async () => new Response(trickling(), { status: 200 }))

      await expect(
        downloadUpdateZip(
          request({
            fetch: trickle,
            idleTimeoutMs: 1_000,
            deadlineMs: 120,
            expectedSize: 10 ** 9,
            getFreeBytes: async () => 10 ** 13
          })
        )
      ).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('too long') })
      expect(await leftovers()).toEqual([])
    })

    it('aborts the request itself, not only the reader, when the deadline passes', async () => {
      let signal: AbortSignal | undefined
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return new Response(trickling(), { status: 200 })
      })

      await expect(
        downloadUpdateZip(
          request({
            fetch,
            idleTimeoutMs: 1_000,
            deadlineMs: 60,
            expectedSize: 10 ** 9,
            getFreeBytes: async () => 10 ** 13
          })
        )
      ).rejects.toMatchObject({ kind: 'network' })
      expect(signal?.aborted).toBe(true)
    })

    it.each([
      ['a checksum mismatch', () => Buffer.from(PAYLOAD).fill(1)],
      ['a body that ends short', () => PAYLOAD.subarray(0, -1)]
    ])('aborts the request after %s', async (_label, body) => {
      let signal: AbortSignal | undefined
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return respond(body())
      })

      await expect(downloadUpdateZip(request({ fetch }))).rejects.toBeInstanceOf(Error)
      expect(signal?.aborted).toBe(true)
    })

    it('does not abort a request that finished', async () => {
      let signal: AbortSignal | undefined
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return respond(PAYLOAD)
      })

      await downloadUpdateZip(request({ fetch }))

      expect(signal?.aborted).toBe(false)
    })
  })

  it('hashes a file on disk', async () => {
    const download = request()
    await downloadUpdateZip(download)

    expect(await sha256OfFile(download.destination)).toBe(PAYLOAD_SHA256)
  })
})
