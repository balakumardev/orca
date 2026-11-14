import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Transform, type TransformCallback } from 'node:stream'

// Same contract as electron-updater's MacUpdater proxy, which feeds Orca's regular Squirrel.Mac updates:
// Basic auth on "/" returns {"url": <zip url>}, and the zip lives at an unguessable one-time path.
const BASIC_USER = 'autoupdater'
const SERVER_LIFETIME_MS = 10 * 60_000

export type SquirrelFeed = {
  /** The feed URL to hand to Electron's native autoUpdater. */
  url: string
  headers: Record<string, string>
  close: () => Promise<void>
}

type FeedRequest = { zipPath: string; size: number; sha256: string }

// The tail of the zip is held back until the whole file has matched its digest. Squirrel reads the body in one
// request, and a body shorter than its Content-Length is a failed download, never an update.
const HELD_BACK_BYTES = 64 * 1024

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1' || address === '::1'
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Passes the file through while hashing it, and releases the last bytes only once the whole file matches the
 * digest that was verified earlier. A file swapped between that check and this read ends the response early, so
 * the client never receives a complete body that differs from what was verified.
 */
class DigestGate extends Transform {
  private readonly hash = createHash('sha256')
  private held = Buffer.alloc(0)
  private total = 0

  constructor(
    private readonly expectedSha256: string,
    private readonly expectedSize: number
  ) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.hash.update(chunk)
    this.total += chunk.length
    if (this.total > this.expectedSize) {
      done(new Error('The update is larger than it was when it was verified'))
      return
    }
    this.held = Buffer.concat([this.held, chunk])
    const releasable = this.held.length - HELD_BACK_BYTES
    if (releasable > 0) {
      this.push(this.held.subarray(0, releasable))
      this.held = this.held.subarray(releasable)
    }
    done()
  }

  override _flush(done: TransformCallback): void {
    if (this.total !== this.expectedSize || this.hash.digest('hex') !== this.expectedSha256) {
      done(new Error('The update changed on disk after it was verified'))
      return
    }
    this.push(this.held)
    done()
  }
}

function reply(response: ServerResponse, status: number): void {
  response.writeHead(status)
  response.end()
}

/** Serves one verified zip to Squirrel.Mac on a random loopback port, then goes away. */
export async function startSquirrelFeed({
  zipPath,
  size,
  sha256
}: FeedRequest): Promise<SquirrelFeed> {
  const password = randomBytes(32).toString('base64url')
  const zipRoute = `/${randomBytes(32).toString('hex')}.zip`
  const authorization = `Basic ${Buffer.from(`${BASIC_USER}:${password}`).toString('base64')}`
  let host = ''
  let served = false
  const server = createServer()

  const serveZip = (response: ServerResponse): void => {
    if (served) {
      reply(response, 410)
      return
    }
    served = true
    const stream = createReadStream(zipPath)
    const gate = new DigestGate(sha256, size)
    // A file that no longer matches its digest stays spent: the same file would fail again.
    let rejectedFile = false
    stream.on('error', () => {
      served = false
      response.destroy()
    })
    gate.on('error', () => {
      rejectedFile = true
      response.destroy()
    })
    response.on('finish', () => server.close())
    // A transfer cut short (Squirrel hung up) must not leave the one delivery spent or the file open.
    response.on('close', () => {
      if (!response.writableFinished) {
        served = rejectedFile
        stream.destroy()
        gate.destroy()
      }
    })
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size })
    stream.pipe(gate).pipe(response)
  }

  const serveManifest = (request: IncomingMessage, response: ServerResponse): void => {
    if (!constantTimeEquals(request.headers.authorization ?? '', authorization)) {
      reply(response, 401)
      return
    }
    const body = Buffer.from(JSON.stringify({ url: `http://${host}${zipRoute}` }))
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length })
    response.end(body)
  }

  server.on('request', (request, response) => {
    // Refuse anything that is not Squirrel talking to this exact socket: other hosts, DNS rebinding, other verbs.
    if (
      request.method !== 'GET' ||
      !isLoopback(request.socket.remoteAddress) ||
      request.headers.host !== host
    ) {
      reply(response, 404)
    } else if (request.url === '/') {
      serveManifest(request, response)
    } else if (request.url === zipRoute) {
      serveZip(response)
    } else {
      reply(response, 404)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('The update feed has no TCP address')
  }
  host = `127.0.0.1:${address.port}`

  const lifetime = setTimeout(() => void close(), SERVER_LIFETIME_MS)
  lifetime.unref()
  function close(): Promise<void> {
    return new Promise((resolve) => {
      clearTimeout(lifetime)
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  return {
    url: `http://${host}`,
    headers: { 'Cache-Control': 'no-cache', Authorization: authorization },
    close
  }
}
