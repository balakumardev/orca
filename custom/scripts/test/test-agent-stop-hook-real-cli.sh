#!/usr/bin/env bash
# MANUAL test (not run by CI): proves, with the REAL pinned Claude Code binary and no model and no key, how the CLI treats a Stop hook, and that
# our stop check (agent-stop-check.sh) behaves inside that. The CLI runs `-p` with the production flag set (read out of agent-round.sh) against
# a tiny local fake of the Messages API (agent-stop-hook-fake-model.mjs, a canned end_turn reply) with a dummy token, so the number of
# requests the fake sees is the number of model turns the CLI took, and a hook's effect is visible in what it sent.
#
# What it shows (each is a check below, with the observed numbers printed as `info` lines):
#   1  a hook from `--settings` is NOT run under --safe-mode (the production flag): why the stop check is registered in the managed settings
#   2  without --safe-mode a hook from `--settings` runs: allow = 1 request; block = a 2nd request that carries the block reason; the
#      hook's own failure (exit 1, exit 127, kill -9, a missing command) does not fail the run
#   3  exit code 2 DOES block: why agent-stop-check.sh never exits 2
#   4  the CLI's own override: a hook that always blocks is run 9 times (8 blocks), then the CLI stops anyway; our default cap (6) is below it
#   5  agent-stop-check.sh, installed by the real installer: a red typecheck is refused up to the cap and the 7th attempt goes through
#      (6 blocks, 7 hook calls, 7 requests) before the CLI's own override; a typecheck that turns green ends the refusals
#
# Needs: node, npm, jq, git, perl, network for `npm install` of the pinned CLI (or AGENT_TEST_CLAUDE_DIR=<dir with node_modules/.bin/claude>),
# about 1 to 3 minutes. Works on macOS and Linux. It writes only to a temp dir. The managed settings registration (the one the sandbox uses, with --safe-mode)
# is shown as the sandbox user by sections F and G of test-agent-sandbox-linux.sh. No secret: the token is a dummy and the fake server checks nothing.
# Run: bash custom/scripts/test/test-agent-stop-hook-real-cli.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
repo_root="$(cd "$scripts/../.." && pwd)"
for tool in node npm jq git perl; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
info() { printf 'info %s\n' "$1"; }
section() { printf '\n== %s\n' "$1"; }

pin="$(sed -n "s/^  CLAUDE_CODE_VERSION: '\\([^']*\\)'.*/\\1/p" "$repo_root/.github/workflows/custom-agent.yml")"
[ -n "$pin" ] || { echo "no CLAUDE_CODE_VERSION in custom-agent.yml"; exit 2; }
if [ -n "${AGENT_TEST_CLAUDE_DIR:-}" ]; then ccdir="$AGENT_TEST_CLAUDE_DIR"
else
  ccdir="$tmp/cc"; mkdir -p "$ccdir"
  echo "installing @anthropic-ai/claude-code@$pin ..."
  npm install --prefix "$ccdir" --no-audit --no-fund "@anthropic-ai/claude-code@$pin" > "$tmp/npm.log" 2>&1 || { tail -n 5 "$tmp/npm.log"; exit 2; }
fi
claude_bin="$ccdir/node_modules/.bin/claude"
version="$("$claude_bin" --version)"
[ "$version" = "$pin (Claude Code)" ] || { echo "unexpected CLI version: $version (pinned $pin)"; exit 2; }
echo "CLI: $version"

# The production flag set: the literal array of agent-round.sh, plus the tools the sandbox variant adds.
decl="$(awk '/local -a claude_args=\(/ { f = 1 } f { print } f && /\)$/ { exit }' "$scripts/agent-round.sh")"
[ -n "$decl" ] || { echo "cannot read claude_args out of agent-round.sh"; exit 2; }
decl="${decl#*local -a claude_args=(}"; decl="${decl%)}"
eval "prod_args=( $decl )"
prod_args+=(--tools "Read,Edit,Write,Grep,Glob,Bash" --allowedTools "Read,Edit,Write,Grep,Glob,Bash")
case " ${prod_args[*]} " in *" --safe-mode "*) ;; *) echo "agent-round.sh does not use --safe-mode any more: re-read check 1"; exit 2 ;; esac
info "production flags: ${prod_args[*]}"

stubs="$tmp/stubs"; mkdir -p "$stubs"
# The stub pnpm: `pnpm tc` is red with an error that changes every call (so the stop check sees progress, not a repeat), or green when the file
# $TC_DIR/green exists, or red the first time and green after (mode red-then-green).
cat > "$stubs/pnpm" <<'S'
#!/usr/bin/env bash
echo x >> "$TC_DIR/calls"
n="$(wc -l < "$TC_DIR/calls" | tr -d ' ')"
case "$(cat "$TC_DIR/mode")" in
  green) exit 0 ;;
  red) printf 'src/a.ts(3,5): error TS2322: Type string is not assignable to type number (call %s).\n' "$n"; exit 2 ;;
  red-then-green) if [ "$n" -le 1 ]; then printf 'src/a.ts(3,5): error TS2322: first call.\n'; exit 2; fi; exit 0 ;;
esac
S
chmod +x "$stubs/pnpm"

# case_dir NAME: a fresh world for one CLI run: work dir with a file the stop check watches, config dir, request log, hook dir.
case_dir() {
  c="$tmp/cases/$1"; rm -rf "${c:?}"; mkdir -p "$c/work/src" "$c/cfg" "$c/logs" "$c/hook" "$c/home" "$c/tc"
  printf 'export const a = 1\n' > "$c/work/src/a.ts"
  (cd "$c/work" && git init -q -b main . && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m base)
  printf 'green' > "$c/tc/mode"; : > "$c/tc/calls"
}
# raw_hook NAME BODY: a hook script that counts its calls (hook/count) and then does BODY; settings.json registers it.
raw_hook() {
  printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; cat > /dev/null\nn=0; [ -f "$d/count" ] && n="$(cat "$d/count")"; n=$((n + 1)); echo "$n" > "$d/count"\n%s\n' "$2" > "$c/hook/hook.sh"
  chmod +x "$c/hook/hook.sh"
  jq -n -c --arg cmd "$c/hook/hook.sh" '{hooks: {Stop: [{hooks: [{type: "command", command: $cmd, timeout: 60}]}]}}' > "$c/settings.json"
}
# run_cli SAFE(1|0) SETTINGS(file or "") [ENV=VALUE...]: one `claude -p` run against the fake model; sets rc, calls (hook runs), reqs (model requests).
run_cli() {
  local safe="$1" settings="$2"; shift 2
  local -a args=() a
  for a in "${prod_args[@]}"; do if [ "$a" = --safe-mode ] && [ "$safe" = 0 ]; then continue; fi; args+=("$a"); done
  [ -z "$settings" ] || args+=(--settings "$settings")
  LOG_DIR="$c/logs" node "$here/agent-stop-hook-fake-model.mjs" &
  local spid=$!
  for _ in $(seq 1 100); do [ -s "$c/logs/port" ] && break; sleep 0.1; done
  [ -s "$c/logs/port" ] || { kill "$spid" 2>/dev/null || true; echo "the fake model did not start"; exit 2; }
  rc=0
  ( cd "$c/work" && printf 'finish the task\n' | env -i PATH="$stubs:$PATH" HOME="$c/home" LANG=C.UTF-8 TMPDIR="$c" CI=true TC_DIR="$c/tc" \
      ANTHROPIC_BASE_URL="http://127.0.0.1:$(cat "$c/logs/port")" ANTHROPIC_AUTH_TOKEN=local-proxy-no-key CLAUDE_CONFIG_DIR="$c/cfg" \
      ANTHROPIC_API_KEY="" ANTHROPIC_MODEL=fake-model ANTHROPIC_DEFAULT_SONNET_MODEL=fake-model ANTHROPIC_DEFAULT_OPUS_MODEL=fake-model ANTHROPIC_DEFAULT_HAIKU_MODEL=fake-model \
      CLAUDE_CODE_MAX_CONTEXT_TOKENS=131072 CLAUDE_CODE_MAX_OUTPUT_TOKENS=16384 CLAUDE_CODE_SUBAGENT_MODEL=inherit \
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 ${1+"$@"} \
      "$claude_bin" "${args[@]}" > "$c/out.json" 2> "$c/err.txt" ) || rc=$?
  kill "$spid" 2>/dev/null || true; wait "$spid" 2>/dev/null || true
  calls="$(cat "$c/hook/count" 2>/dev/null || echo 0)"
  reqs="$(find "$c/logs" -name 'req-*.json' | wc -l | tr -d ' ')"
  info "$name: CLI exit $rc, hook ran $calls time(s), the model was called $reqs time(s)"
}
expect() { # NAME WANT_RC WANT_CALLS WANT_REQS
  if [ "$rc" = "$2" ] && [ "$calls" = "$3" ] && [ "$reqs" = "$4" ]; then ok "$1"; else bad "$1 (wanted exit $2, $3 hook call(s), $4 request(s); got $rc, $calls, $reqs; stderr: $(head -c 300 "$c/err.txt" | tr '\n' ' '))"; fi
}

section "1  --settings hooks are switched off by --safe-mode (the production flag)"
name="safe-settings"; case_dir $name; raw_hook $name 'printf "{\"decision\":\"block\",\"reason\":\"REASON-MARKER-42\"}"'
run_cli 1 "$c/settings.json"
expect "with --safe-mode a hook from --settings is never run: no hook call, one request" 0 0 1

section "2  without --safe-mode a hook from --settings runs"
name=allow; case_dir $name; raw_hook $name 'exit 0'
run_cli 0 "$c/settings.json"
expect "a hook that allows: one hook call, one request" 0 1 1
name=block-once; case_dir $name
raw_hook $name 'if [ "$n" -eq 1 ]; then printf "{\"decision\":\"block\",\"reason\":\"REASON-MARKER-42 the typecheck is red\"}"; fi'
run_cli 0 "$c/settings.json"
expect "a hook that blocks once: two hook calls, two requests" 0 2 2
if [ -f "$c/logs/req-2.json" ] && grep -q 'REASON-MARKER-42' "$c/logs/req-2.json" && ! grep -q 'REASON-MARKER-42' "$c/logs/req-1.json"; then ok "the second request carries the block reason; the first does not"; else bad "the block reason did not reach the model"; fi
check_json="$(jq -r '[.messages[-1] | .role, (.content | if type == "string" then . else map(.text? // "") | join(" ") end)] | join(": ")' "$c/logs/req-2.json" 2>/dev/null | head -c 160 || true)"
info "the last message of request 2: $check_json"
if [ "$(jq -r '.result' "$c/out.json" 2>/dev/null)" = "done" ] && [ "$(jq -r '.is_error' "$c/out.json" 2>/dev/null)" = false ]; then ok "the run ends normally with the canned reply"; else bad "the run did not end normally: $(head -c 200 "$c/out.json")"; fi
for failure in 'exit 1' 'exit 127' 'kill -9 $$'; do
  name="fail-open-$(printf '%s' "$failure" | tr -c 'a-z0-9' '-')"; case_dir $name; raw_hook $name "$failure"
  run_cli 0 "$c/settings.json"
  expect "a hook that fails with \`$failure\` does not fail the run (fail open): one hook call, one request, CLI exit 0" 0 1 1
done
name=fail-open-missing; case_dir $name; raw_hook $name 'exit 0'; rm -f "${c:?}/hook/hook.sh"
run_cli 0 "$c/settings.json"
expect "a hook command that does not exist does not fail the run: CLI exit 0, one request" 0 0 1

section "3  exit code 2 blocks (so the stop check must never exit 2)"
name=exit2; case_dir $name; raw_hook $name 'if [ "$n" -eq 1 ]; then echo "REASON-MARKER-43 from stderr" >&2; exit 2; fi'
run_cli 0 "$c/settings.json"
expect "a hook that exits 2 once: it blocked (two hook calls, two requests)" 0 2 2

section "4  the CLI's own override of a hook that always blocks"
name=always; case_dir $name; raw_hook $name 'printf "{\"decision\":\"block\",\"reason\":\"always blocked, call %s\"}" "$n"'
run_cli 0 "$c/settings.json"
if [ "$rc" = 0 ] && [ "$calls" -ge 8 ] && [ "$calls" -le 10 ] && [ "$reqs" = "$calls" ]; then ok "after 8 blocks in a row the CLI stops anyway and exits 0 ($calls hook calls, $reqs requests): our cap of 6 comes first"; else bad "the CLI's override was not as measured on 2.1.325: exit $rc, $calls hook calls, $reqs requests"; fi

# install_stop_check NAME MANAGED_DIR: the real installer for this case; the files the round may edit: src/a.ts as a content conflict.
install_stop_check() {
  printf 'content\tsrc/a.ts\n' > "$c/stop-check-files.tsv"
  jq -n -c --arg u "$(git -C "$c/work" rev-parse HEAD)" '{upstream_sha: $u}' > "$c/sync-facts.json"
  AGENT_SANDBOX_SUDO=none AGENT_TOOLS_DIR="$c/tools" AGENT_SANDBOX_DIR="$c/sb" AGENT_CLAUDE_MANAGED_DIR="$1" SYNC_OUT="$c" \
    bash "$scripts/agent-sandbox.sh" install-stop-hook 1 > "$c/install.json" 2> "$c/install.err"
  jq -e '.installed == true' "$c/install.json" >/dev/null || { cat "$c/install.err"; echo "the installer failed"; exit 2; }
  state="$c/sb/stop-hook-state"
  # A counting wrapper in front of the real hook (the installed managed file is what check 6 uses; here --settings is the carrier).
  printf '#!/usr/bin/env bash\nd="%s"; n=0; [ -f "$d/count" ] && n="$(cat "$d/count")"; echo $((n + 1)) > "$d/count"\nexec "%s"\n' "$c/hook" "$c/tools/stop-hook/agent-stop-check.sh" > "$c/hook/wrap.sh"
  chmod +x "$c/hook/wrap.sh"
  jq -n -c --arg cmd "$c/hook/wrap.sh" '{hooks: {Stop: [{hooks: [{type: "command", command: $cmd, timeout: 1500}]}]}}' > "$c/settings.json"
}

section "5  agent-stop-check.sh inside the real CLI"
name=real-cap; case_dir $name; install_stop_check "$c/etc"; printf 'red' > "$c/tc/mode"
run_cli 0 "$c/settings.json"
expect "a typecheck that stays red: 6 blocks, the 7th attempt is allowed by our cap: 7 hook calls, 7 requests, before the CLI's own override" 0 7 7
if [ "$(jq -r '[.outcome, .blocks, .calls] | join(" ")' "$state/state.json")" = "block-cap 6 7" ]; then ok "state.json: block-cap after 6 blocks and 7 calls"; else bad "state.json: $(cat "$state/state.json")"; fi
if [ "$(find "$c/logs" -name 'req-*.json' -exec grep -l 'STOP CHECK (block 6 of 6)' {} + | wc -l | tr -d ' ')" -ge 1 ]; then ok "the model was shown 'STOP CHECK (block 6 of 6)'"; else bad "the 6th block reason never reached the model"; fi
if [ "$(jq -r '.reason' <<<"$(grep -h -o 'STOP CHECK (block 1 of 6)[^"]*' "$c/logs/req-2.json" | head -n 1 | jq -R '{reason: .}')" 2>/dev/null | wc -c | tr -d ' ')" -gt 40 ]; then ok "request 2 holds the first block's text"; else bad "request 2 lacks the first block's text"; fi
name=real-green; case_dir $name; install_stop_check "$c/etc"; printf 'red-then-green' > "$c/tc/mode"
run_cli 0 "$c/settings.json"
expect "a typecheck that turns green after the first block: 2 hook calls, 2 requests" 0 2 2
if [ "$(jq -r '[.outcome, .blocks, .calls] | join(" ")' "$state/state.json")" = "green 1 2" ]; then ok "state.json: green after 1 block and 2 calls"; else bad "state.json: $(cat "$state/state.json")"; fi
name=real-clean; case_dir $name; install_stop_check "$c/etc"; printf 'green' > "$c/tc/mode"
run_cli 0 "$c/settings.json"
expect "a green round: the stop check runs once, silently, and the CLI makes one request" 0 1 1
name=real-failopen; case_dir $name; install_stop_check "$c/etc"; rm -f "${c:?}/tools/stop-hook/lib.sh"
run_cli 0 "$c/settings.json"
expect "a broken install of the stop check (a helper script missing) ends the run normally: one request, CLI exit 0" 0 1 1

echo
if [ "$fails" -eq 0 ]; then echo "all required checks passed"; else echo "$fails check(s) FAILED"; exit 1; fi
