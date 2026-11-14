import { createHash } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { freeBytesOf } from './custom-update-disk'
import { CustomUpdateError } from './custom-update-errors'
import { diskNeededFor } from './custom-update-extract'
import type { CustomUpdateFetch } from './custom-update-feed'

const IDLE_TIMEOUT_MS = 60_000
// Until the response headers arrive, a silent server must not hold the update cycle forever.
const HEADER_TIMEOUT_MS = 30_000
// A server that sends one chunk just inside the idle timeout would hold the cycle for hours: bound the whole
// transfer too. 45 minutes carries a 300 MB build at about 130 KB/s.
const DEADLINE_MS = 45 * 60_000

export type DownloadZipRequest = {
  url: string
  destination: string
  expectedSize: number
  expectedSha256: string
  fetch: CustomUpdateFetch
  onProgress: (percent: number) => void
  signal?: AbortSignal
  idleTimeoutMs?: number
  headerTimeoutMs?: number
  deadlineMs?: number
  getFreeBytes?: (directory: string) => Promise<number>
}

/** One read that ends early when the body stalls or the transfer is cancelled, whatever the body does itself. */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new CustomUpdateError('network', 'The download stalled')),
      idleTimeoutMs
    )
    onAbort = () => reject(new CustomUpdateError('network', 'The download was cancelled'))
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([reader.read(), interrupted])
  } finally {
    clearTimeout(timer)
    if (onAbort) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

async function fetchWithHeaderTimeout(
  request: DownloadZipRequest,
  outer: AbortSignal
): Promise<Response> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), request.headerTimeoutMs ?? HEADER_TIMEOUT_MS)
  const signal = AbortSignal.any([outer, timeout.signal])
  try {
    return await request.fetch(request.url, { signal })
  } catch (error) {
    if (timeout.signal.aborted) {
      throw new CustomUpdateError('network', 'GitHub did not answer the download request')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Streams the zip to disk and keeps it only when its size and sha256 equal the manifest's. */
export async function downloadUpdateZip(request: DownloadZipRequest): Promise<void> {
  const { destination, expectedSize } = request
  const directory = dirname(destination)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const free = await (request.getFreeBytes ?? freeBytesOf)(directory)
  if (free < diskNeededFor(expectedSize)) {
    throw new CustomUpdateError(
      'disk-space',
      'There is not enough free disk space for the update',
      { freeBytes: free, neededBytes: diskNeededFor(expectedSize) }
    )
  }

  // Every way out of this function aborts the request itself, not only the reader on top of it.
  const transfer = new AbortController()
  let deadlineHit = false
  const deadline = setTimeout(() => {
    deadlineHit = true
    transfer.abort()
  }, request.deadlineMs ?? DEADLINE_MS)
  const signal = request.signal
    ? AbortSignal.any([request.signal, transfer.signal])
    : transfer.signal
  try {
    await receiveZip(request, signal, () => transfer.abort())
  } catch (error) {
    transfer.abort()
    if (deadlineHit) {
      throw new CustomUpdateError('network', 'The download took too long')
    }
    throw error
  } finally {
    clearTimeout(deadline)
  }
}

async function receiveZip(
  request: DownloadZipRequest,
  signal: AbortSignal,
  abortTransfer: () => void
): Promise<void> {
  const { destination, expectedSize, expectedSha256 } = request
  const response = await fetchWithHeaderTimeout(request, signal)
  if (!response.ok || !response.body) {
    throw new CustomUpdateError('download', `The update download answered ${response.status}`)
  }
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) !== expectedSize) {
    throw new CustomUpdateError('download', 'The update size differs from its manifest')
  }

  const partial = `${destination}.part`
  const hash = createHash('sha256')
  const reader = response.body.getReader()
  const file = await open(partial, 'w', 0o600)
  let received = 0
  let lastPercent = -1
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout(
        reader,
        request.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
        signal
      )
      if (done) {
        break
      }
      received += value.byteLength
      if (received > expectedSize) {
        throw new CustomUpdateError('download', 'The update is larger than its manifest says')
      }
      hash.update(value)
      await file.write(value)
      // Hold 100 back for verification, which only the caller can complete.
      const percent = Math.min(99, Math.floor((received / expectedSize) * 100))
      if (percent !== lastPercent) {
        lastPercent = percent
        request.onProgress(percent)
      }
    }
    if (received !== expectedSize) {
      throw new CustomUpdateError('download', 'The update ended before its manifest size')
    }
    if (hash.digest('hex') !== expectedSha256) {
      // Right size, wrong bytes: a proxy or a CDN can do that to a good release as easily as a bad build can, so it is
      // retried and counted (`check-error`), not held against the release for good.
      throw new CustomUpdateError('check-error', 'The update does not match its manifest checksum')
    }
    await file.close()
    await rename(partial, destination)
  } catch (error) {
    // Cut the request first: cancelling a reader leaves the transfer running on some stream implementations.
    abortTransfer()
    await reader.cancel().catch(() => undefined)
    await file.close().catch(() => undefined)
    await rm(partial, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Re-reads the zip from disk right before it is served, so only the verified bytes reach macOS. */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const file = await open(path, 'r')
  try {
    for await (const chunk of file.createReadStream({ highWaterMark: 1024 * 1024 })) {
      hash.update(chunk)
    }
  } finally {
    await file.close().catch(() => undefined)
  }
  return hash.digest('hex')
}
