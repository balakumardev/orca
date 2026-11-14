import type { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { CustomUpdateError } from './custom-update-errors'
import type { CustomUpdateFetch } from './custom-update-feed'

const MAX_REDIRECTS = 5

/** The part of Electron's `ClientRequest` this needs; `net.request` satisfies it. */
export type GuardedRequest = EventEmitter & {
  end: () => void
  abort: () => void
  followRedirect: () => void
}
type GuardedResponse = Readable & {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[]>
}
export type RequestFactory = (options: {
  url: string
  method: 'GET'
  redirect: 'manual'
  headers: Record<string, string>
}) => GuardedRequest

function refuse(): CustomUpdateError {
  // The URL came from a server; keep it out of the message.
  return new CustomUpdateError(
    'feed',
    'A request to a host outside the release servers was refused'
  )
}

function toResponseBody(response: Readable): ConstructorParameters<typeof Response>[0] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Readable.toWeb returns the web stream class Response takes; the Node and DOM typings only disagree on its name.
  return Readable.toWeb(response) as unknown as ConstructorParameters<typeof Response>[0]
}

// A Response with one of these statuses must have a null body; `new Response(stream, { status: 304 })` throws.
// 1xx is not listed: Chromium handles informational responses itself and never hands one to `net.request`, and a
// `Response` refuses them anyway, so one that did arrive is rejected below like any other status it cannot hold.
const NULL_BODY_STATUSES = new Set([204, 205, 304])

function toHeaders(source: GuardedResponse['headers']): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(source)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      headers.append(name, entry)
    }
  }
  return headers
}

/**
 * `fetch` that checks every hop. Electron's `net.fetch` cannot: with `redirect: 'manual'` it rejects with
 * "Redirect was cancelled" instead of handing back the redirect (checked on Electron 43.8.6, the version this
 * repo pins, and on 39.8.5), so redirects are handled on `net.request`, whose `redirect` event lets each hop be
 * judged before `followRedirect()`. The returned promise always settles: whatever goes wrong while the response
 * is turned into a `Response` (a status or header the web `Response` refuses) rejects it and aborts the request.
 */
export function createGuardedFetch(options: {
  request: RequestFactory
  isAllowedUrl: (url: string) => boolean
}): CustomUpdateFetch {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined
      if (!options.isAllowedUrl(url)) {
        reject(refuse())
        return
      }
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value
      })
      // The address that was judged, as the parser reads it, is the one that is requested.
      const request = options.request({
        url: new URL(url).href,
        method: 'GET',
        redirect: 'manual',
        headers
      })
      let redirects = 0
      let settled = false
      const detach = (): void => signal?.removeEventListener('abort', onAbort)
      // A caller's abort also cuts a body that is still being read, so the listener lives as long as the response.
      const fail = (error: CustomUpdateError): void => {
        detach()
        request.abort()
        if (!settled) {
          settled = true
          reject(error)
        }
      }
      function onAbort(): void {
        fail(new CustomUpdateError('network', 'The request was cancelled'))
      }
      if (signal?.aborted) {
        fail(new CustomUpdateError('network', 'The request was cancelled'))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      request.on('redirect', (_status: number, _method: string, redirectUrl: string) => {
        redirects += 1
        if (redirects > MAX_REDIRECTS || !options.isAllowedUrl(redirectUrl)) {
          fail(
            redirects > MAX_REDIRECTS
              ? new CustomUpdateError('feed', 'Too many redirects')
              : refuse()
          )
          return
        }
        // Electron cancels the redirect unless this is called synchronously from the event.
        request.followRedirect()
      })
      request.on('response', (response: GuardedResponse) => {
        // Nothing may escape this listener: Electron calls it from its loader callback and would never hear of it.
        try {
          // Nobody reads an error on a response we never wrapped; it must not become an uncaught exception.
          response.on('error', () => undefined)
          const nullBody = NULL_BODY_STATUSES.has(response.statusCode)
          if (nullBody) {
            response.resume()
          }
          const reply = new Response(nullBody ? null : toResponseBody(response), {
            status: response.statusCode,
            statusText: response.statusMessage,
            headers: toHeaders(response.headers)
          })
          settled = true
          if (nullBody) {
            detach()
          } else {
            response.once('close', detach)
          }
          resolve(reply)
        } catch (error) {
          fail(new CustomUpdateError('network', 'The response could not be read', { cause: error }))
        }
      })
      request.on('error', (error: Error) =>
        fail(new CustomUpdateError('network', error.message, { cause: error }))
      )
      request.end()
    })
}
