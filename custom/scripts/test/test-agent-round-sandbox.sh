#!/usr/bin/env bash
# Test for the sandbox variant of `agent-round.sh run` with a stub model and a fake sudo (it only drops the sudo options): the agent runs
# in the scratch copy with a dummy token, never sees the key, and the real tree is untouched; the proxy is up while it runs and gone
# after; asking for a sandbox that was not set up stops the step. The OS-user separation itself is covered by the container test.
# Run: bash custom/scripts/test/test-agent-round-sandbox.sh   (needs git, jq, node, curl; every key here is fake)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
for tool in git jq node curl; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY

FAKE_KEY="fake-key-0123456789abcdefghijklmnopqrstuvwxyz"
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

real="$tmp/real"; sb="$tmp/sandbox/repo"; out="$tmp/out"; bin="$tmp/bin"
mkdir -p "$real/src" "$out" "$bin"
(cd "$real" && git init -q -b main . && printf 'original\n' > src/a.ts && git add -A && git commit -q -m base)
mkdir -p "$tmp/sandbox" && cp -a "$real" "$sb"
jq -n -c --arg repo "$sb" --arg path "$bin:$PATH" '{user: "agentrun", repo: $repo, path: $path, dependencies_installed: true}' > "$out/sandbox.json"
jq -n -c '{model: "m", tier: "flash", mode: "first", round: 1, wall_seconds: 30, files: 1, skip: false}' > "$out/agent-plan.json"
printf 'the prompt\n' > "$out/agent-prompt.txt"

# A fake sudo that only drops its own options, a fake timeout (macOS has none), and a stub model that records what it sees.
cat > "$bin/sudo" <<'S'
#!/usr/bin/env bash
echo "$*" >> "$(dirname "$0")/sudo.calls"
while [ $# -gt 0 ]; do case "$1" in -n|-H) shift ;; -u) shift 2 ;; pkill|kill) exit 0 ;; *) break ;; esac; done
exec "$@"
S
cat > "$bin/timeout" <<'S'
#!/usr/bin/env bash
if [ "$1" = -k ]; then shift 2; fi
shift
exec "$@"
S
cat > "$bin/claude" <<'S'
#!/usr/bin/env bash
set -euo pipefail
d="$(dirname "$0")"
cat > /dev/null
pwd -P > "$d/seen.pwd"; env > "$d/seen.env"; printf '%s\n' "$*" > "$d/seen.args"
# The proxy must be reachable while the model runs.
curl -s "$ANTHROPIC_BASE_URL/__health" > "$d/seen.health"
printf 'changed by the agent\n' > src/a.ts
printf '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"ok","usage":{"input_tokens":10,"output_tokens":5}}\n'
S
chmod +x "$bin/sudo" "$bin/timeout" "$bin/claude"

cd "$real"
rc=0
PATH="$bin:$PATH" SYNC_OUT="$out" TOOLS_DIR="$scripts" ROUND=1 MODE=first TIER=flash RUNNER_TEMP="$tmp/runner" AGENT_SANDBOX=1 DEEPINFRA_API_KEY="$FAKE_KEY" \
  bash "$scripts/agent-round.sh" run > "$tmp/run.log" 2>&1 || rc=$?
[ "$rc" = 0 ] || sed 's/^/    /' "$tmp/run.log" | tail -n 20

echo "sandbox run"
check "the step exits 0" test "$rc" = 0
check "the agent ran in the scratch copy" test "$(cat "$bin/seen.pwd")" = "$(cd "$sb" && pwd -P)"
check "the agent's edit landed in the copy" test "$(cat "$sb/src/a.ts")" = "changed by the agent"
check "the real tree is untouched" test "$(cat "$real/src/a.ts")" = original
check "it ran through sudo as the sandbox user" grep -q -- '-u agentrun' "$bin/sudo.calls"
check "the agent's environment holds no real key" bash -c "! grep -qF '$FAKE_KEY' '$bin/seen.env'"
check "the agent's token is the dummy" grep -q '^ANTHROPIC_AUTH_TOKEN=local-proxy-no-key$' "$bin/seen.env"
check "the agent talks to the local proxy" grep -q '^ANTHROPIC_BASE_URL=http://127.0.0.1:[0-9]*$' "$bin/seen.env"
check "the proxy answered while the agent ran" test "$(cat "$bin/seen.health")" = ok
check "the agent's environment carries no DEEPINFRA variable" bash -c "! grep -q '^DEEPINFRA' '$bin/seen.env'"
check "the agent has Bash without a command list" bash -c "grep -q -- '--allowedTools Read,Edit,Write,Grep,Glob,Bash\$' '$bin/seen.args' || grep -q -- '--allowedTools Read,Edit,Write,Grep,Glob,Bash ' '$bin/seen.args'"
check "no read-only command list in sandbox mode" bash -c "! grep -q 'Bash(git' '$bin/seen.args'"
check "the key is in no argv the sudo shim saw" bash -c "! grep -qF '$FAKE_KEY' '$bin/sudo.calls'"
check "the agent's processes are stopped with one atomic kill, not a looping pkill" grep -q -- '-u agentrun kill -KILL -1' "$bin/sudo.calls"
check "the model is started with a kill grace period" grep -q -- 'timeout -k 30' "$bin/sudo.calls"
check "the proxy is stopped after the run" bash -c "! curl -s --max-time 2 \"\$(sed -n 's/^ANTHROPIC_BASE_URL=//p' '$bin/seen.env')/__health\""
check "no key anywhere in the output directory" bash -c "! grep -rqF '$FAKE_KEY' '$out' '$tmp/runner'"
check "the run record says no leak" jq -e '.key_leaks == 0 and .exit_code == 0' "$out/agent-run.json"

echo "a sandbox that was not set up"
rm -f "$out/sandbox.json"
rc=0
PATH="$bin:$PATH" SYNC_OUT="$out" TOOLS_DIR="$scripts" ROUND=1 MODE=first TIER=flash RUNNER_TEMP="$tmp/runner2" AGENT_SANDBOX=1 DEEPINFRA_API_KEY="$FAKE_KEY" \
  bash "$scripts/agent-round.sh" run > "$tmp/run2.log" 2>&1 || rc=$?
check "AGENT_SANDBOX=1 without sandbox.json stops the step" test "$rc" != 0
check "and says why" grep -q 'refusing to run commands outside it' "$tmp/run2.log"

echo
if [ "$fails" -eq 0 ]; then echo "all checks passed"; else echo "$fails check(s) FAILED"; exit 1; fi
