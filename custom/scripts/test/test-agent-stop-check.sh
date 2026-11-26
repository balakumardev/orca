#!/usr/bin/env bash
# Test for agent-stop-check.sh, the Stop hook of the sync's model rounds, installed the way agent-sandbox.sh installs it (the real installer,
# with the privilege changes switched off): what each red group says, that a green run is silent, every bound (block cap, time budget, per-check
# timeout, no progress), that it fails open on any internal error and NEVER exits 2 (which would block), and what the installer registers.
# Run: bash custom/scripts/test/test-agent-stop-check.sh   (needs git, jq, node, perl; a stub pnpm; no network; macOS or Linux)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="${SCRIPTS_DIR:-$(cd "$here/.." && pwd)}"
for tool in git jq node perl; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY AGENT_STOP_MAX_BLOCKS AGENT_STOP_BUDGET_SECONDS AGENT_STOP_CHECK_TIMEOUT
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

repo="$tmp/repo"; out="$tmp/out"; stubs="$tmp/stubs"; tc="$tmp/tc"
mkdir -p "$repo/src" "$out" "$stubs" "$tc"
(
  cd "$repo"
  git init -q -b main .
  printf 'export const a = 1\n' > src/a.ts
  printf 'export const b = 1\n' > src/b.ts
  printf '{"name":"x"}\n' > .oxlintrc.json
  git add -A && git commit -q -m upstream
)
up="$(git -C "$repo" rev-parse HEAD)"

# The stub pnpm: `pnpm tc` behaves as $tc/mode says and counts its calls.
cat > "$stubs/pnpm" <<'S'
#!/usr/bin/env bash
echo x >> "$TC_DIR/calls"
n="$(wc -l < "$TC_DIR/calls" | tr -d ' ')"
case "$(cat "$TC_DIR/mode")" in
  green) exit 0 ;;
  red-in) printf 'src/a.ts(3,5): error TS2322: Type string is not assignable to type number (call %s).\n' "$n"; exit 2 ;;
  red-same) printf 'src/a.ts(3,5): error TS2322: Type string is not assignable to type number.\n'; exit 2 ;;
  red-out) printf 'src/other.ts(1,1): error TS2304: Cannot find name foo.\n'; exit 2 ;;
  red-none) echo "build-workspace-packages failed"; exit 1 ;;
  huge) i=0; while [ "$i" -lt 20000 ]; do i=$((i + 1)); printf 'src/a.ts(%s,1): error TS2322: a long and verbose message that goes on and on and on and on (%s)\n' "$i" "$i"; done; exit 2 ;;
  slow) exec sleep 30 ;;
  slow-red) sleep 2; printf 'src/a.ts(3,5): error TS2322: slow (call %s).\n' "$n"; exit 2 ;;
esac
S
chmod +x "$stubs/pnpm"
export TC_DIR="$tc"
set_tc() { printf '%s' "$1" > "$tc/mode"; : > "$tc/calls"; }
tc_calls() { wc -l < "$tc/calls" | tr -d ' '; }

hook="$tmp/tools/stop-hook/agent-stop-check.sh"; state="$tmp/sb/stop-hook-state"
TAB="$(printf '\t')"
# install_hook DEPS FILES_TSV_BODY: the real installer, with no privilege change (AGENT_SANDBOX_SUDO=none) and every directory in the temp dir.
install_hook() {
  rm -rf "${tmp:?}/tools" "${tmp:?}/sb" "${tmp:?}/etc"
  printf '%b' "$2" > "$out/stop-check-files.tsv"
  jq -n -c --arg u "$up" '{upstream_sha: $u}' > "$out/sync-facts.json"
  AGENT_SANDBOX_SUDO=none AGENT_TOOLS_DIR="$tmp/tools" AGENT_SANDBOX_DIR="$tmp/sb" AGENT_CLAUDE_MANAGED_DIR="$tmp/etc" SYNC_OUT="$out" \
    bash "$scripts/agent-sandbox.sh" install-stop-hook "$1" > "$tmp/install.json" 2> "$tmp/install.err"
}
# run_hook [ENV=VALUE...]: one stop attempt, as Claude Code makes it (JSON on stdin, cwd = the repo). Sets h_rc and h_out (also in $tmp/h.out).
run_hook() {
  h_rc=0
  h_out="$(printf '{"cwd":"%s","hook_event_name":"Stop","stop_hook_active":false}' "$repo" | env PATH="$stubs:$PATH" "$@" bash "$hook" 2> "$tmp/hook.err")" || h_rc=$?
  printf '%s' "$h_out" > "$tmp/h.out"
}
blocked() { [ "$h_rc" = 0 ] && jq -e '.decision == "block"' "$tmp/h.out" >/dev/null 2>&1; }
silent() { [ "$h_rc" = 0 ] && [ -z "$h_out" ]; }
reason_has() { local p; for p in "$@"; do jq -e --arg p "$p" '.reason | contains($p)' "$tmp/h.out" >/dev/null || return 1; done; }
reason_bytes() { jq -r '.reason' "$tmp/h.out" | wc -c | tr -d ' '; }
st() { jq -r "$1" "$state/state.json"; }
log_has() { grep -q -- "$1" "$state/stop-hook.log"; }

echo "the installer"
install_hook 1 "content${TAB}src/a.ts\nowned${TAB}src/b.ts\n"
check "it installs the script, its helpers and its inputs" bash -c "cd '$tmp/tools/stop-hook' && test -x agent-stop-check.sh && test -f lib.sh && test -f gate-details.sh && test -f lint-caps.mjs && test -s files.tsv && test -s hook.conf"
check "the registration is a managed settings file with one Stop command hook pointing at the script" jq -e --arg c "$hook" '.hooks.Stop[0].hooks[0] | .type == "command" and .command == $c and .timeout >= 1300' "$tmp/etc/managed-settings.json"
check "the managed directory holds only that file (no --settings file: --safe-mode would ignore it)" test "$(ls "$tmp/etc")" = managed-settings.json
check "the hook directory and the registration are not writable by group or others" test -z "$(find "$tmp/tools/stop-hook" "$tmp/etc/managed-settings.json" \( -perm -g+w -o -perm -o+w \))"
check "the state directory exists and is the agent's to write" test -d "$state" -a -w "$state"
check "the installer reports itself" jq -e --arg h "$hook" '.installed == true and .hook == $h' "$tmp/install.json"
check "hook.conf names the state directory, the dependency flag and the upstream commit" bash -c "grep -qx 'STATE_DIR=$state' '$tmp/tools/stop-hook/hook.conf' && grep -qx 'DEPS=1' '$tmp/tools/stop-hook/hook.conf' && grep -qx 'UPSTREAM=$up' '$tmp/tools/stop-hook/hook.conf'"
mkdir -p "$tmp/etc2"; printf '{"mine":true}\n' > "$tmp/etc2/managed-settings.json"
rc=0; AGENT_SANDBOX_SUDO=none AGENT_TOOLS_DIR="$tmp/tools2" AGENT_SANDBOX_DIR="$tmp/sb2" AGENT_CLAUDE_MANAGED_DIR="$tmp/etc2" SYNC_OUT="$out" bash "$scripts/agent-sandbox.sh" install-stop-hook 1 > "$tmp/install2.json" 2>/dev/null || rc=$?
check "an existing managed settings file is never overwritten: the stop check is reported as not installed" bash -c "test '$rc' = 0 && jq -e '.installed == false and (.why | test(\"already exists\"))' '$tmp/install2.json' && grep -q mine '$tmp/etc2/managed-settings.json' && test ! -e '$tmp/tools2'"

echo "a green run"
install_hook 1 "content${TAB}src/a.ts\nowned${TAB}src/b.ts\n"; set_tc green
run_hook
if silent && [ "$(tc_calls)" = 1 ]; then ok "it is silent, exits 0 and runs pnpm tc once"; else bad "green run: rc=$h_rc out=[$h_out] tc calls $(tc_calls)"; fi
check "state: green after 1 call and 0 blocks" test "$(st '[.outcome, .calls, .blocks] | join(" ")')" = "green 1 0"
check "the round log says why it let go" log_has 'allow (green)'

echo "group 1: conflict markers"
install_hook 1 "content${TAB}src/a.ts\nowned${TAB}src/b.ts\n"; set_tc green
printf 'export const a = 1\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> theirs\n' > "$repo/src/a.ts"
run_hook
check "markers in a file the round may edit block the stop with a JSON decision" blocked
check "the reason names the file and the check" reason_has src/a.ts conflict-markers
check "and is short" test "$(reason_bytes)" -lt 1500
check "it stops at the first red group: pnpm tc was not run" test "$(tc_calls)" = 0
check "state: one block, the group is recorded, the outcome is block" test "$(st '[.outcome, .blocks, (.groups | join(","))] | join(" ")')" = "block 1 conflict-markers"
printf 'export const a = 1\n' > "$repo/src/a.ts"
run_hook
check "after the fix the next attempt is allowed (silent)" silent
printf 'title\n=======\ntext\n' > "$repo/src/a.ts"
install_hook 1 "content${TAB}src/a.ts\n"; run_hook
check "a bare ======= line blocks in a content conflict" blocked
install_hook 1 "owned${TAB}src/a.ts\n"; run_hook
check "but not in a file that was never conflicted" silent
printf 'export const a = 1\n' > "$repo/src/a.ts"
printf 'DELETE-THIS-FILE\n' > "$repo/src/gone.ts"
install_hook 1 "content${TAB}src/gone.ts\n"; run_hook
check "the delete marker in a content conflict blocks (the file cannot be deleted)" blocked
install_hook 1 "deleted-by-them${TAB}src/gone.ts\n"; run_hook
check "the delete marker in a modify/delete conflict is the agent's decision and passes" silent
install_hook 1 "owned${TAB}src/b.ts\n"; printf 'DELETE-THIS-FILE\n' > "$repo/src/b.ts"; run_hook
check "the delete marker in a file upstream has blocks (finish would revert it)" blocked
printf 'DELETE-THIS-FILE\n' > "$repo/src/ours-only.ts"
install_hook 1 "owned${TAB}src/ours-only.ts\n"; run_hook
check "the delete marker in a file only our branch has passes" silent
rm -f "${repo:?}/src/gone.ts" "$repo/src/ours-only.ts"; printf 'export const b = 1\n' > "$repo/src/b.ts"

echo "group 2: lint caps"
awk 'BEGIN { for (i = 1; i <= 301; i++) printf "export const v%d = %d\n", i, i }' > "$repo/src/big.ts"
install_hook 1 "owned${TAB}src/big.ts\n"; set_tc green; run_hook
check "a .ts file over 300 lines blocks, naming the file, both numbers and the check" reason_has "src/big.ts: 301 lines, the cap is 300" lint-caps
check "pnpm tc was not run behind it" test "$(tc_calls)" = 0
awk 'BEGIN { for (i = 1; i <= 300; i++) printf "export const v%d = %d\n", i, i }' > "$repo/src/big.ts"; run_hook
check "at the cap it passes" silent
rm -f "${repo:?}/src/big.ts"

echo "group 3: typecheck"
install_hook 1 "content${TAB}src/a.ts\nowned${TAB}src/b.ts\n"; set_tc red-in; run_hook
check "tsc errors in a file the round may edit block, with the error text" reason_has "error TS2322" src/a.ts typecheck
set_tc huge; install_hook 1 "content${TAB}src/a.ts\n"; run_hook
check "a huge tsc log is cut: the whole reason stays under 5000 bytes" test "$(reason_bytes)" -lt 5000
set_tc red-out; install_hook 1 "content${TAB}src/a.ts\n"; run_hook
check "errors only in files the round may not edit do not block" silent
check "and the outcome says so" test "$(st .outcome)" = out-of-scope
set_tc red-none; install_hook 1 "content${TAB}src/a.ts\n"; run_hook
check "a tool failure with no TypeScript error line does not block" silent
set_tc red-in; install_hook 0 "content${TAB}src/a.ts\n"; run_hook
if silent && [ "$(tc_calls)" = 0 ]; then ok "without installed dependencies pnpm tc is not run and nothing blocks"; else bad "deps=0: rc=$h_rc out=[$h_out] calls $(tc_calls)"; fi

echo "bounds"
set_tc red-in; install_hook 1 "content${TAB}src/a.ts\n"
run_hook AGENT_STOP_MAX_BLOCKS=2; b1=0; blocked || b1=1
run_hook AGENT_STOP_MAX_BLOCKS=2; b2=0; blocked || b2=1
check "with a limit of 2 the first two attempts are blocked" test "$b1$b2" = 00
before="$(tc_calls)"
run_hook AGENT_STOP_MAX_BLOCKS=2
check "the third is allowed, silently" silent
check "the checks are not run once the limit is reached" test "$(tc_calls)" = "$before"
check "state: outcome block-cap with 2 blocks over 3 calls" test "$(st '[.outcome, .blocks, .calls] | join(" ")')" = "block-cap 2 3"
check "the round log says the limit was the reason" log_has 'allow (block-cap).*limit of 2 blocks'
install_hook 1 "content${TAB}src/a.ts\n"; set_tc red-in
run_hook AGENT_STOP_MAX_BLOCKS=banana
check "a limit that is not a number falls back to the default and blocks" blocked
install_hook 1 "content${TAB}src/a.ts\n"; set_tc red-in
printf '{"calls":4,"blocks":1,"spent_s":1200,"groups":[],"waived":[],"sigs":{}}\n' > "$state/state.json"; run_hook
if silent && [ "$(tc_calls)" = 0 ] && [ "$(st .outcome)" = time-budget ]; then ok "a used-up time budget allows the stop without running a check"; else bad "time budget: rc=$h_rc out=[$h_out] calls $(tc_calls) outcome $(st .outcome)"; fi
check "and the log line names the budget" log_has 'allow (time-budget).*budget of 1200s'
printf '{"calls":4,"blocks":1,"spent_s":8,"groups":[],"waived":[],"sigs":{}}\n' > "$state/state.json"; run_hook AGENT_STOP_BUDGET_SECONDS=12
if silent && [ "$(tc_calls)" = 0 ] && [ "$(st .outcome)" = time-budget ]; then ok "with under 10 seconds left pnpm tc is not started: time-budget"; else bad "budget tail: rc=$h_rc out=[$h_out] calls $(tc_calls) outcome $(st .outcome)"; fi
install_hook 1 "content${TAB}src/a.ts\n"; set_tc slow-red; run_hook
check "the time a run takes is added to the budget" test "$(st '.spent_s >= 2')" = true
if command -v timeout >/dev/null 2>&1; then
  install_hook 1 "content${TAB}src/a.ts\n"; set_tc slow
  t0="$(date +%s)"; run_hook AGENT_STOP_CHECK_TIMEOUT=2; t1="$(date +%s)"
  if silent && [ $((t1 - t0)) -lt 12 ]; then ok "a pnpm tc that does not finish is cut at its limit ($((t1 - t0))s) and the stop is allowed"; else bad "timeout: rc=$h_rc out=[$h_out] took $((t1 - t0))s"; fi
  check "state: check-timeout, and the log line says so" bash -c "[ \"\$(jq -r .outcome '$state/state.json')\" = check-timeout ] && grep -q 'allow (check-timeout)' '$state/stop-hook.log'"
else echo "skip a per-check timeout test: no timeout command"; fi

echo "no progress"
awk 'BEGIN { for (i = 1; i <= 302; i++) printf "export const v%d = %d\n", i, i }' > "$repo/src/big.ts"
install_hook 1 "owned${TAB}src/big.ts\ncontent${TAB}src/a.ts\n"; set_tc red-same
run_hook; check "attempt 1: the cap is red, blocked" blocked
run_hook
check "attempt 2: the same failure again is waived and does not hide the next group: typecheck blocks" reason_has typecheck
check "state records the waiver" jq -e '.waived | index("lint-caps") != null' "$state/state.json"
set_tc green; run_hook
if silent && [ "$(st .outcome)" = no-progress ]; then ok "attempt 3: with typecheck fixed the stop is allowed, as no-progress (not green)"; else bad "no-progress end: rc=$h_rc out=[$h_out] outcome $(st .outcome)"; fi
rm -f "${repo:?}/src/big.ts"

echo "fail open"
install_hook 1 "content${TAB}src/a.ts\n"; set_tc red-in
rm -f "${tmp:?}/tools/stop-hook/files.tsv"; run_hook
if silent && [ "$(st .outcome)" = hook-error ]; then ok "a missing input file: exit 0, no output, outcome hook-error"; else bad "missing input: rc=$h_rc out=[$h_out] outcome $(st .outcome)"; fi
install_hook 1 "content${TAB}src/a.ts\n"; printf 'not json {' > "$state/state.json"; run_hook
if silent && [ "$(st .outcome)" = hook-error ]; then ok "a corrupt state file: exit 0, no output, outcome hook-error"; else bad "corrupt state: rc=$h_rc out=[$h_out]"; fi
install_hook 1 "content${TAB}src/a.ts\n"; rm -f "${tmp:?}/tools/stop-hook/lib.sh"; run_hook
check "a missing helper script: exit 0, no output" silent
install_hook 1 "content${TAB}src/a.ts\n"; rm -f "${tmp:?}/tools/stop-hook/hook.conf"; run_hook
check "a missing hook.conf: exit 0, no output" silent
install_hook 1 "content${TAB}src/a.ts\n"; rm -rf "${state:?}"; run_hook
check "a missing state directory: exit 0, no output" silent
install_hook 1 "content${TAB}src/a.ts\n"; mkdir -p "$tmp/badjq"
printf '#!/usr/bin/env bash\nexit 2\n' > "$tmp/badjq/jq"; chmod +x "$tmp/badjq/jq"
h_rc=0; h_out="$(printf '{"cwd":"%s"}' "$repo" | env PATH="$tmp/badjq:$stubs:$PATH" bash "$hook" 2>/dev/null)" || h_rc=$?
check "a tool that fails with exit 2 (which would BLOCK if it leaked out) still ends in exit 0 with no output" silent
install_hook 1 "content${TAB}src/a.ts\n"; set_tc red-in
h_rc=0; h_out="$(env PATH="$stubs:$PATH" bash "$hook" < /dev/null 2>/dev/null)" || h_rc=$?
check "empty stdin (no JSON at all): exit 0" test "$h_rc" = 0

echo
if [ "$fails" -eq 0 ]; then echo "all checks passed"; else echo "$fails check(s) FAILED"; exit 1; fi
