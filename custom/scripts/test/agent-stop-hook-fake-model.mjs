// A minimal fake of the Anthropic Messages API, for test-agent-stop-hook-real-cli.sh: it answers every /v1/messages call with a canned
// end_turn text reply (streamed as server-sent events when the CLI asks for a stream, as one JSON object otherwise) and writes the body of
// each such request to LOG_DIR/req-<n>.json, so a test can see how many times the CLI called the model and what it said. It checks no token and
// knows no model. Usage: LOG_DIR=<dir> node agent-stop-hook-fake-model.mjs   (writes the port it listens on to LOG_DIR/port)
import fs from 'node:fs'
import http from 'node:http'

const logDir = process.env.LOG_DIR
const text = process.env.REPLY || 'done'
let requests = 0

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    fs.appendFileSync(`${logDir}/paths.txt`, `${req.method} ${req.url}\n`)
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 10 }))
      return
    }
    requests += 1
    fs.writeFileSync(`${logDir}/req-${requests}.json`, raw)
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {}
    const message = {
      id: `msg_${requests}`,
      type: 'message',
      role: 'assistant',
      model: body.model || 'fake',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 }
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', { type: 'message_start', message })
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text }
      })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 }
      })
      send('message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ...message,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 }
      })
    )
  })
})
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(`${logDir}/port`, String(server.address().port))
})
