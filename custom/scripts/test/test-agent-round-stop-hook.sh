#!/usr/bin/env bash
# Test for how agent-round.sh wires the stop check (agent-stop-check.sh) into a model round: prepare writes the list of files the round may
# edit, the sandbox installs the hook, `run` starts the CLI in every mode (first, repair, continue, retry) without --settings and with --safe-mode
# unchanged, the stop check blocks and lets go inside a real prepare > run > collect > finish round with a stub model that calls the registered
# hook the way the CLI does, and what the hook left behind is read back, normalised and recorded (facts, job summary), whatever the sandbox
# user wrote into it. The real CLI is test-agent-stop-hook-real-cli.sh. Run: bash custom/scripts/test/test-agent-round-stop-hook.sh
# (needs git, jq, node, awk, base64, od, rev, openssl; no network, no pnpm; every key here is fake)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="${SCRIPTS_DIR:-$(cd "$here/.." && pwd)}"
for tool in git jq node awk base64 od rev openssl perl; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export DEEPINFRA_MODELS_URL="file:///nonexistent"
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY AGENT_STOP_MAX_BLOCKS AGENT_STOP_BUDGET_SECONDS AGENT_STOP_CHECK_TIMEOUT
FAKE_KEY="fake-key-0123456789abcdefghijklmnopqrstuvwxyz"
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

# Source: three files both sides changed (alpha, beta, gamma), a file only the fork changed (epsilon).
src="$tmp/source"
git init -q -b main "$src"
(
  cd "$src"
  mkdir src
  for f in alpha beta gamma epsilon; do seq 1 60 | sed "s/^/$f line /" > "src/$f.ts"; done
  git add -A && git commit -q -m "upstream 1.0.0" && git tag v1.0.0
  git branch custom
  edit() { awk -v t="$2" -v n="$3" 'NR == n { print t; next } { print }' "src/$1.ts" > "src/$1.new" && mv "src/$1.new" "src/$1.ts"; }
  edit alpha "alpha UPSTREAM" 5; edit beta "beta UPSTREAM" 5; edit gamma "gamma UPSTREAM" 5
  git add -A && git commit -q -m "upstream 1.0.1" && git tag v1.0.1
  git checkout -q custom
  edit alpha "alpha CUSTOM" 5; edit beta "beta CUSTOM" 5; edit gamma "gamma CUSTOM" 5; edit epsilon "epsilon CUSTOM" 7
  mkdir custom && echo v1.0.0 > custom/BASE
  git add -A && git commit -q -m "our change

Orca-Custom-Patch: test"
)
BASE_SHA="$(git -C "$src" rev-parse custom)"
UPSTREAM_SHA="$(git -C "$src" rev-parse 'v1.0.1^{commit}')"

bin="$tmp/bin"; mkdir -p "$bin"
# A fake sudo that only drops its own options (the privilege separation is the Linux container test's job).
cat > "$bin/sudo" <<'S'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -n|-H) shift ;; -u) shift 2 ;; kill) exit 0 ;; *) break ;; esac; done
exec "$@"
S
chmod +x "$bin/sudo"
command -v timeout >/dev/null 2>&1 || printf '#!/usr/bin/env bash\nif [ "$1" = -k ]; then shift 2; fi\nshift\nexec "$@"\n' > "$bin/timeout"
[ ! -f "$bin/timeout" ] || chmod +x "$bin/timeout"
# The stub model. It does what the real CLI does with a Stop hook: when it wants to finish it runs the command registered in the managed
# settings, with the hook's JSON on stdin, and goes on working when the answer is a block.
cat > "$bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
d="$(dirname "$0")"
mode="$(cat "$d/mode")"
cat > /dev/null
printf '%s\n' "$*" > "$d/args-last"; env > "$d/env-last"
resolve() { seq 1 60 | sed "s/^/$1 merged line /" > "src/$1.ts"; }
mark() { printf '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> t\n' >> "src/$1.ts"; }
hookcmd="$(jq -r '.hooks.Stop[0].hooks[0].command // empty' "$(cat "$d/managed-path" 2>/dev/null || echo /dev/null)" 2>/dev/null || true)"
try_stop() { # N: one attempt to finish; the answer is left in hook-out.N
  [ -n "$hookcmd" ] || { : > "$d/hook-out.$1"; return 0; }
  printf '{"cwd":"%s","hook_event_name":"Stop"}' "$(pwd -P)" | "$hookcmd" > "$d/hook-out.$1" 2>/dev/null || true
}
blocked() { jq -e '.decision == "block"' "$d/hook-out.$1" >/dev/null 2>&1; }
result() { printf '{"type":"result","subtype":"success","is_error":false,"num_turns":4,"result":"done","usage":{"input_tokens":10,"output_tokens":5}}\n'; }
rm -f "$d"/hook-out.*
case "$mode" in
  stophook) # first / retry: leaves a marker in alpha, is refused, fixes it, finishes
    resolve beta; resolve gamma; resolve alpha; mark alpha
    try_stop 1; if blocked 1; then resolve alpha; fi; try_stop 2; result ;;
  stophook-repair) # repair: breaks an owned file, is refused, fixes it, finishes
    cp src/epsilon.ts "$d/epsilon.keep"; mark epsilon
    try_stop 1; if blocked 1; then cp "$d/epsilon.keep" src/epsilon.ts; fi; try_stop 2; result ;;
  stophook-rest) # continue: resolves the files an earlier round left, one with a marker first
    resolve gamma; resolve beta; mark beta
    try_stop 1; if blocked 1; then resolve beta; fi; try_stop 2; result ;;
  stubborn) # breaks one more file before every attempt to finish, so the failure never repeats, and keeps trying
    resolve beta; resolve gamma; resolve alpha; mark alpha
    try_stop 1; mark beta; try_stop 2; mark gamma; try_stop 3; try_stop 4; result ;;
  partial) # resolves one file and runs out of turns, never tries to finish through the hook
    resolve alpha
    printf '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":71,"result":"","usage":{"input_tokens":10,"output_tokens":5}}\n'; exit 1 ;;
  noop) result ;;
  hostile) # the sandbox user may write anything into the state and the log
    resolve alpha; resolve beta; resolve gamma
    sd="$(jq -r '.stop_hook.state_dir' "$(cat "$d/sandbox-json-path-target")")"
    printf '{"calls":2,"blocks":"many","spent_s":-5,"outcome":"::error::pwned\\nx","groups":["conflict-markers","::set-output name=x::y","has space",7,"typecheck"],"waived":"no"}\n' > "$sd/state.json"
    printf '::error title=pwned::from the sandbox\nsecond line\n' > "$sd/stop-hook.log"
    result ;;
esac
STUB
chmod +x "$bin/claude"
export PATH="$bin:$PATH"

# round NAME MODE STUB ROUND TIER [PREV_NAME]   env: HOOK=0 (the sandbox says the stop check is not installed), NOSANDBOX=1, STOP_ENV="A=1 B=2" (runner env)
round() {
  local name="$1" mode="$2" stub="$3" n="$4" tier="$5" prev="${6:-}" repo="$tmp/$1.repo" out="$tmp/$1.out" sbx="$tmp/$1.sbx" etc="$tmp/$1.etc"
  git clone -q --no-hardlinks "$src" "$repo"; git -C "$repo" checkout -q custom
  printf '%s' "$stub" > "$bin/mode"; rm -f "$bin/args-last" "$bin/env-last"
  local env_=(SYNC_OUT="$out" TOOLS_DIR="$scripts" ROUND="$n" MODE="$mode" TIER="$tier" RUNNER_TEMP="$tmp/$name.runner"
    UPSTREAM_SHA="$UPSTREAM_SHA" BASE_SHA="$BASE_SHA" BASE_BRANCH=custom BRANCH="sync/test-$name" LABEL=test TAG=v1.0.1 IS_TEST=true TAG_IS_RELEASE=false)
  [ -z "$prev" ] || env_+=(PREV_DIR="$tmp/$prev.out")
  [ -n "${NOSANDBOX:-}" ] || env_+=(AGENT_SANDBOX=1)
  mkdir -p "$tmp/$name.runner"; : > "$tmp/$name.summary"
  ( cd "$repo" \
    && env "${env_[@]}" bash "$scripts/agent-round.sh" prepare > "$tmp/$name.prepare.log" 2>&1 \
    && { [ -n "${NOSANDBOX:-}" ] || {
         # The sandbox step, minus the privileges and the dependency install: a copy of the tree, the stop check installed by the real
         # installer, and the sandbox.json that `run` reads.
         mkdir -p "$sbx" && cp -a "$repo" "$sbx/repo" \
         && stop="$(AGENT_SANDBOX_SUDO=none AGENT_TOOLS_DIR="$tmp/$name.tools" AGENT_SANDBOX_DIR="$sbx" AGENT_CLAUDE_MANAGED_DIR="$etc" SYNC_OUT="$out" bash "$scripts/agent-sandbox.sh" install-stop-hook 0)" \
         && { [ "${HOOK:-1}" = 1 ] || stop='{"installed":false,"why":"the test turned it off"}'; } \
         && jq -n -c --arg repo "$sbx/repo" --arg path "$bin:$PATH" --argjson stop "$stop" '{user: "agentrun", repo: $repo, path: $path, dependencies_installed: false, stop_hook: $stop}' > "$out/sandbox.json" \
         && printf '%s' "$etc/managed-settings.json" > "$bin/managed-path" && printf '%s' "$out/sandbox.json" > "$bin/sandbox-json-path-target"; }; } \
    && env "${env_[@]}" DEEPINFRA_API_KEY="$FAKE_KEY" ${STOP_ENV:-} bash "$scripts/agent-round.sh" run > "$tmp/$name.run.log" 2>&1 \
    && { [ -n "${NOSANDBOX:-}" ] || AGENT_SANDBOX_SUDO=none AGENT_SANDBOX_DIR="$sbx" SYNC_OUT="$out" bash "$scripts/agent-sandbox.sh" collect > "$tmp/$name.collect.log" 2>&1; } \
    && env "${env_[@]}" GITHUB_STEP_SUMMARY="$tmp/$name.summary" bash "$scripts/agent-round.sh" finish > "$tmp/$name.finish.log" 2>&1
  ) || { bad "round $name ran to the end"; sed 's/^/    /' "$tmp/$name".*.log | tail -n 30; return 1; }
  ok "round $name ran to the end"
}
facts() { jq -r "$2" "$tmp/$1.out/sync-facts.json"; }
rec() { facts "$1" ".agent.rounds[-1].stop_hook | $2"; }
args_ok() { grep -q -- '--safe-mode' "$bin/args-last" && ! grep -q -- '--settings' "$bin/args-last" && grep -q -- '--restricted' "$bin/args-last"; }

echo "prepare writes the files the round may edit, with their kinds"
round r1 first stophook 1 flash
check "first: the three conflicted files, as content conflicts" test "$(tr '\t' ':' < "$tmp/r1.out/stop-check-files.tsv" | paste -sd, -)" = "content:src/alpha.ts,content:src/beta.ts,content:src/gamma.ts"
check "the installed hook got that very list" cmp -s "$tmp/r1.out/stop-check-files.tsv" "$tmp/r1.tools/stop-hook/files.tsv"
check "sync-merge.sh finish enforces the same paths (allowed-edit-files.txt)" test "$(cut -f2 "$tmp/r1.out/stop-check-files.tsv" | paste -sd, -)" = "$(sort -u "$tmp/r1.out/allowed-edit-files.txt" | paste -sd, -)"

echo "first: the stop check refuses once, the model fixes the file, the second attempt is allowed"
check "the CLI is started with the same flags as before: --safe-mode, --restricted, and no --settings" args_ok
check "the managed settings, not the command line, register the hook" jq -e '.hooks.Stop[0].hooks[0].command | endswith("/stop-hook/agent-stop-check.sh")' "$tmp/r1.etc/managed-settings.json"
check "the first attempt was blocked, with a reason that names the file" bash -c "jq -e '.decision == \"block\" and (.reason | contains(\"src/alpha.ts\"))' '$bin/hook-out.1'"
check "the second attempt was allowed (no output)" test ! -s "$bin/hook-out.2"
check "the round record: installed, 1 block in 2 calls, ended green, the group named" test "$(rec r1 '[.installed, .blocks, .calls, .outcome, (.groups | join(","))] | map(tostring) | join(" ")')" = "true 1 2 green conflict-markers"
check "the job summary says so" grep -q 'Stop check: 1 block(s) in 2 call(s), ended: green\.' "$tmp/r1.summary"
check "the stop check's log lines are in the step log, behind a prefix" grep -q '^stop check: .*allow (green)' "$tmp/r1.run.log"
check "the file the model fixed reached the candidate (collect, then finish)" test "$(facts r1 .unresolved)" = false
check "the key is nowhere in the stop check's files" bash -c "! grep -rqF '$FAKE_KEY' '$tmp/r1.tools' '$tmp/r1.etc' '$tmp/r1.sbx/stop-hook-state'"
check "the stop check inherited no key: its environment is the agent's (dummy token)" bash -c "grep -q '^ANTHROPIC_AUTH_TOKEN=local-proxy-no-key\$' '$bin/env-last' && ! grep -qF '$FAKE_KEY' '$bin/env-last'"

echo "repair: the scope grows to the files our customizations own, and the check follows it"
round r2 repair stophook-repair 2 pro r1
check "the owned file is in the list, as owned" grep -q "^owned$(printf '\t')src/epsilon.ts\$" "$tmp/r2.out/stop-check-files.tsv"
check "repair: the CLI flags are the same" args_ok
check "repair: the break in the owned file was refused and the fix allowed" test "$(rec r2 '[.blocks, .calls, .outcome] | map(tostring) | join(" ")')" = "1 2 green"

echo "retry: a fresh merge again, the same wiring"
round r3 retry stophook 3 pro r2
check "retry: the CLI flags are the same" args_ok
check "retry: 1 block in 2 calls, green" test "$(rec r3 '[.blocks, .calls, .outcome] | map(tostring) | join(" ")')" = "1 2 green"

echo "continue: a repair of a candidate that still has unresolved files"
round p1 first partial 1 flash
check "the partial round never tried to finish through the hook: the canary says never-ran" test "$(rec p1 '[.installed, .calls, .outcome] | map(tostring) | join(" ")')" = "true 0 never-ran"
check "and the job summary says so" grep -q 'Stop check: 0 block(s) in 0 call(s), ended: never-ran\.' "$tmp/p1.summary"
round p2 repair stophook-rest 2 flash p1
check "continue: the still-unresolved files are in the hook's list, as content conflicts" test "$(grep -c -E "^content$(printf '\t')src/(beta|gamma).ts\$" "$tmp/p2.out/stop-check-files.tsv")" = 2
check "continue: the CLI flags are the same" args_ok
check "continue: 1 block in 2 calls, green" test "$(rec p2 '[.blocks, .calls, .outcome] | map(tostring) | join(" ")')" = "1 2 green"
check "never-ran puts a caveat in the PR body inputs (the record carries it)" test "$(rec p1 .outcome)" = never-ran

echo "the bounds travel with the run; a stop check that never lets go ends at its limit"
round s1 first stubborn 1 flash
check "no AGENT_STOP variable is set in the agent's environment when the runner did not set one" bash -c "! grep -q '^AGENT_STOP_' '$bin/env-last'"
STOP_ENV="AGENT_STOP_MAX_BLOCKS=2 AGENT_STOP_BUDGET_SECONDS=900 AGENT_STOP_CHECK_TIMEOUT=banana" round s2 first stubborn 1 flash
check "the numeric limits reach the agent's environment" bash -c "grep -q '^AGENT_STOP_MAX_BLOCKS=2\$' '$bin/env-last' && grep -q '^AGENT_STOP_BUDGET_SECONDS=900\$' '$bin/env-last'"
check "a value that is not a number is dropped" bash -c "! grep -q 'AGENT_STOP_CHECK_TIMEOUT' '$bin/env-last'"
check "with a limit of 2: two blocks, then the third and fourth attempts are allowed: block-cap" test "$(rec s2 '[.blocks, .calls, .outcome] | map(tostring) | join(" ")')" = "2 4 block-cap"
check "the fourth attempt was allowed too (no more checks, no more blocks)" test ! -s "$bin/hook-out.4"
check "the round's job summary names it" grep -q 'Stop check: 2 block(s) in 4 call(s), ended: block-cap\.' "$tmp/s2.summary"
check "the default limit is 6, below the 8 consecutive blocks after which the CLI overrides a hook itself" grep -q 'MAX_BLOCKS="$(num_or "${AGENT_STOP_MAX_BLOCKS:-}" 6)"' "$scripts/agent-stop-check.sh"

echo "no stop check: the sandbox says it is not installed, or there is no sandbox"
HOOK=0 round n1 first noop 1 flash
check "not installed: recorded as such, with the reason" test "$(rec n1 '[.installed, .why] | map(tostring) | join(" ")')" = "false the test turned it off"
check "not installed: nothing of it in the agent's environment" bash -c "! grep -q '^AGENT_STOP_' '$bin/env-last'"
check "not installed: the job summary says not active" grep -q 'Stop check: not active\.' "$tmp/n1.summary"
check "not installed: the CLI flags are the same" args_ok
NOSANDBOX=1 STOP_ENV="AGENT_STOP_MAX_BLOCKS=3" round n2 first noop 1 flash
check "no sandbox: no stop check (there is no shell to run it in), nothing of it in the environment" bash -c "[ \"\$(jq -r '.agent.rounds[-1].stop_hook.installed' '$tmp/n2.out/sync-facts.json')\" = false ] && ! grep -q '^AGENT_STOP_' '$bin/env-last'"
check "no sandbox: the old read-only tool list, and still no --settings" bash -c "grep -q 'Bash(git status' '$bin/args-last' && ! grep -q -- '--settings' '$bin/args-last'"

echo "the sandbox user can write anything into the state: only numbers and known words come out"
round h1 first hostile 1 flash
check "a bogus outcome becomes unknown" test "$(rec h1 .outcome)" = unknown
check "numbers that are not numbers become 0 and negative ones too" test "$(rec h1 '[.blocks, .spent_s] | map(tostring) | join(" ")')" = "0 0"
check "only well-formed group words survive" test "$(rec h1 '.groups | join(",")')" = "conflict-markers,typecheck"
check "the round record holds no text from the sandbox" bash -c "! grep -q 'pwned' '$tmp/h1.out/sync-facts.json'"
check "the sandbox's log text is printed behind a prefix, so it cannot start a workflow command" bash -c "grep -q '^stop check: ::error title=pwned' '$tmp/h1.run.log' && ! grep -q '^::error title=pwned' '$tmp/h1.run.log'"

echo
if [ "$fails" -eq 0 ]; then echo "all checks passed"; else echo "$fails check(s) FAILED"; exit 1; fi
