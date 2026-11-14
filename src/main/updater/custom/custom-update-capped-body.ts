/**
 * Reads a response body as text and gives up as soon as it passes `maxBytes`, instead of buffering whatever the
 * server sends. `abort` cuts the request itself; cancelling the stream alone may leave the transfer running.
 * Returns null when the body is larger than allowed.
 */
export async function readCappedText(
  response: Response,
  maxBytes: number,
  abort: () => void
): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    abort()
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  const reader = response.body?.getReader()
  if (!reader) {
    return ''
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > maxBytes) {
        abort()
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
