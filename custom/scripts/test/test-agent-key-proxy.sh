#!/usr/bin/env bash
# Test for agent-key-proxy.mjs against a fake upstream: the key is added, a client's own credentials are dropped, only /v1/ is
# forwarded, a streamed reply arrives in pieces, and the key is not in argv, the environment or any output.
# Run: bash custom/scripts/test/test-agent-key-proxy.sh   (needs node; no network, every key here is fake)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "missing tool: node"; exit 2; }
tmp="$(mktemp -d)"
cleanup() { [ -z "${proxy_pid:-}" ] || kill "$proxy_pid" 2>/dev/null || true; [ -z "${fake_pid:-}" ] || kill "$fake_pid" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT

FAKE_KEY="fake-key-0123456789abcdefghijklmnopqrstuvwxyz"
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

# The fake upstream records the headers of the last request in a file and answers /anthropic/v1/messages with a stream.
cat > "$tmp/fake-upstream.mjs" <<'JS'
import fs from 'node:fs'
import http from 'node:http'
const [, , recordFile, portFile] = process.argv
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    fs.writeFileSync(recordFile, JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }))
    if (req.url.startsWith('/anthropic/v1/messages')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'yes', 'set-cookie': 'a=b' })
      res.write('data: one\n\n')
      setTimeout(() => { res.write('data: two\n\n'); res.end() }, 400)
    } else {
      res.writeHead(404)
      res.end('nope')
    }
  })
})
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)))
JS
node "$tmp/fake-upstream.mjs" "$tmp/record.json" "$tmp/fake.port" & fake_pid=$!
for _ in $(seq 1 50); do [ -s "$tmp/fake.port" ] && break; sleep 0.1; done
fake_port="$(cat "$tmp/fake.port")"

printf '%s\n' "$FAKE_KEY" | node "$scripts/agent-key-proxy.mjs" --upstream "http://127.0.0.1:$fake_port/anthropic" --listening-file "$tmp/proxy.port" > "$tmp/proxy.out" 2> "$tmp/proxy.err" & proxy_pid=$!
for _ in $(seq 1 50); do [ -s "$tmp/proxy.port" ] && break; sleep 0.1; done
port="$(cat "$tmp/proxy.port")"

echo "proxy"
check "health answers without touching the upstream" test "$(curl -s "http://127.0.0.1:$port/__health")" = ok
body="$(curl -s -N -X POST "http://127.0.0.1:$port/v1/messages?beta=true" -H 'authorization: Bearer attacker-token' -H 'x-api-key: attacker-key' -H 'content-type: application/json' -H 'x-keep: me' -d '{"hello":"world"}' -D "$tmp/resp.headers")"
check "the streamed reply arrives whole" test "$(printf '%s' "$body" | tr -d '\n')" = "data: onedata: two"
check "the upstream got the real key as a bearer token" jq -e --arg k "Bearer $FAKE_KEY" '.headers.authorization == $k' "$tmp/record.json"
check "the client's x-api-key never reached the upstream" jq -e '.headers | has("x-api-key") | not' "$tmp/record.json"
check "the client's own authorization was replaced" bash -c "! grep -q attacker '$tmp/record.json'"
check "other headers and the body pass through" jq -e '.headers["x-keep"] == "me" and .body == "{\"hello\":\"world\"}" and .method == "POST"' "$tmp/record.json"
check "the path and query are the upstream base plus the request" jq -e '.url == "/anthropic/v1/messages?beta=true"' "$tmp/record.json"
check "upstream response headers pass through, cookies do not" bash -c "grep -qi '^x-upstream: yes' '$tmp/resp.headers' && ! grep -qi '^set-cookie' '$tmp/resp.headers'"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v2/anything")"
check "a path outside /v1/ is refused with 404" test "$code" = 404
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")"
check "the root path is refused with 404" test "$code" = 404
ttfb="$(curl -s -o /dev/null -w '%{time_starttransfer}' -X POST "http://127.0.0.1:$port/v1/messages" -d '{}')"
total="$(curl -s -o /dev/null -w '%{time_total}' -X POST "http://127.0.0.1:$port/v1/messages" -d '{}')"
check "the first piece of a stream is not held back until the end" awk -v a="$ttfb" -v b="$total" 'BEGIN { exit !(a < 0.3 && b >= 0.4) }'

echo "the key is not exposed"
check "not in the proxy's argv" bash -c "! ps -o command= -p $proxy_pid | grep -qF '$FAKE_KEY'"
if [ -r "/proc/$proxy_pid/environ" ]; then
  check "not in the proxy's environment" bash -c "! tr '\\0' '\\n' < /proc/$proxy_pid/environ | grep -qF '$FAKE_KEY'"
else
  check "not in the proxy's environment (ps eww)" bash -c "! ps eww -p $proxy_pid | grep -qF '$FAKE_KEY'"
fi
check "not in the proxy's output" bash -c "! grep -qF '$FAKE_KEY' '$tmp/proxy.out' '$tmp/proxy.err'"
check "the log has method, path and status only" bash -c "grep -q '^POST /v1/messages 200$' '$tmp/proxy.err' && ! grep -qiE 'bearer|authorization|hello' '$tmp/proxy.err'"

echo "start-up errors"
rc=0; printf '' | node "$scripts/agent-key-proxy.mjs" >/dev/null 2>"$tmp/e1" || rc=$?
check "an empty stdin is refused (exit 2)" test "$rc" = 2
rc=0; printf 'k\n' | node "$scripts/agent-key-proxy.mjs" --bogus 1 >/dev/null 2>"$tmp/e2" || rc=$?
check "an unknown argument is refused (exit 2)" test "$rc" = 2

echo
if [ "$fails" -eq 0 ]; then echo "all checks passed"; else echo "$fails check(s) FAILED"; exit 1; fi
