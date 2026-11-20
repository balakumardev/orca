#!/usr/bin/env node
// Key-holding reverse proxy for the cloud agent (agent-round.sh run). The agent's shell commands run as another OS user and
// never see the API key: the CLI talks to this proxy on 127.0.0.1 with a dummy token and the proxy adds the real key.
//
//   printf '%s\n' "$KEY" | node agent-key-proxy.mjs [--upstream URL] [--port N] [--listening-file PATH]
//
// The key is read from stdin, never from argv or the environment, so `ps` and /proc/<pid>/environ do not show it. Only paths
// under /v1/ are forwarded, always to the one upstream URL; any authorization header the client sends is dropped. It prints
// nothing about requests except method, path and status, and never a header or a body.
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'

const DEFAULT_UPSTREAM = 'https://api.deepinfra.com/anthropic'
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade'
])
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'set-cookie'
])

function parseArgs(argv) {
  const out = { upstream: DEFAULT_UPSTREAM, port: 0, listeningFile: '' }
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) {
      throw new Error(`missing value for ${flag}`)
    }
    if (flag === '--upstream') {
      out.upstream = value
    } else if (flag === '--port') {
      out.port = Number(value)
    } else if (flag === '--listening-file') {
      out.listeningFile = value
    } else {
      throw new Error(`unknown argument ${flag}`)
    }
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) {
    throw new Error('bad --port')
  }
  return out
}

function readKey() {
  const first = fs.readFileSync(0, 'utf8').split('\n')[0].trim()
  if (!first) {
    throw new Error('no key on stdin')
  }
  return first
}

function forwardedHeaders(incoming, key, upstreamHost) {
  const headers = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers[name] = value
    }
  }
  headers.host = upstreamHost
  headers.authorization = `Bearer ${key}`
  return headers
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const key = readKey()
  const upstream = new URL(args.upstream)
  const transport = upstream.protocol === 'https:' ? https : http
  const agent = new transport.Agent({ keepAlive: true })
  const basePath = upstream.pathname.replace(/\/$/, '')

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy.invalid')
    if (req.method === 'GET' && url.pathname === '/__health') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    if (!url.pathname.startsWith('/v1/')) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    const target = new URL(basePath + url.pathname + url.search, upstream.origin)
    const proxied = transport.request(
      target,
      { method: req.method, headers: forwardedHeaders(req.headers, key, upstream.host), agent },
      (upstreamRes) => {
        const headers = {}
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
            headers[name] = value
          }
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers)
        upstreamRes.pipe(res)
        process.stderr.write(`${req.method} ${url.pathname} ${upstreamRes.statusCode}\n`)
      }
    )
    proxied.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' })
      }
      res.end('upstream error')
      process.stderr.write(`${req.method} ${url.pathname} upstream error\n`)
    })
    res.on('close', () => proxied.destroy())
    req.pipe(proxied)
  })
  // A model turn can stream for minutes: no request or socket timeout of ours.
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.listen(args.port, '127.0.0.1', () => {
    const { port } = server.address()
    if (args.listeningFile) {
      fs.writeFileSync(args.listeningFile, `${port}\n`)
    }
    process.stderr.write(`listening on 127.0.0.1:${port}\n`)
  })
}

try {
  main()
} catch (error) {
  process.stderr.write(`agent-key-proxy: ${error.message}\n`)
  process.exit(2)
}
