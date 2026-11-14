#!/usr/bin/env bash
# Local test for the key-leak guard of the cloud agent (custom/scripts/agent-round.sh run + sync-merge.sh finish).
# Run: bash custom/scripts/test/test-key-leak.sh      (needs git, jq, node; no network, no GitHub, no pnpm)
#
# A stub `claude` on PATH plays a prompt-injected model: it writes a FAKE key, its base64 and the fake key minus its
# first 8 characters, each into a different conflicted file, plus new untracked files and its own output. The real
# scripts then run exactly as in the workflow: prepare, run, finish. The test proves that
#   - the leak is found and counted, with file NAMES only,
#   - the round's edits are gone: no candidate object, no artifact file and no work-tree file carries any form of the key,
#   - the round is unresolved, so the PR is a draft [needs manual merge] with the conflict markers,
#   - the later agent rounds are gated off, and the PR body opens with the loud caveat,
#   - the same holds for a repair round, and a key-free round is NOT flagged (no false positive).
# Every key in this file is fake.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
root="$(cd "$scripts/../.." && pwd)"
for tool in git jq node base64 od rev openssl awk; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Keep the user's git configuration (signing, hooks, pull.rebase) out of the picture.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset GITHUB_OUTPUT

FAKE_KEY="fake-key-0123456789abcdefghijklmnopqrstuvwxyz"
B64="$(printf '%s' "$FAKE_KEY" | base64 | tr -d '\n')"
TAIL8="${FAKE_KEY:8}"
HEX="$(printf '%s' "$FAKE_KEY" | od -An -v -tx1 | tr -d ' \n')"
REV="$(printf '%s' "$FAKE_KEY" | rev)"
needles() { printf '%s\n' "$FAKE_KEY" "$B64" "$TAIL8" "$HEX" "$REV"; }

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { # NAME CMD...: passes when the command succeeds
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi
}

# ---- scanners (and their positive controls, so a pass is never vacuous) -----------------------------------------------
files_with_needle() { ( cd "$1" && grep -r -a -l -F -f <(needles) --exclude-dir=.git -- . 2>/dev/null ) || true; }
objects_with_needle() { # REPO NEW_COMMIT [EXCLUDED_COMMIT...]: how many NEW objects (as in the bundle) carry a needle
  local repo="$1" new="$2"; shift 2
  local args=("$new") x
  for x in "$@"; do args+=("^$x"); done
  git -C "$repo" rev-list --objects "${args[@]}" | cut -d' ' -f1 | git -C "$repo" cat-file --batch | grep -a -c -F -f <(needles) || true
}

mkdir "$tmp/control"
printf 'x %s y\n' "$B64" > "$tmp/control/hit.txt"
printf 'clean\n' > "$tmp/control/clean.txt"
check "scanner finds a needle in a file (positive control)" test "$(files_with_needle "$tmp/control")" = "./hit.txt"
git init -q "$tmp/control.repo"
printf '%s\n' "$FAKE_KEY" > "$tmp/control.repo/f" && git -C "$tmp/control.repo" add f && git -C "$tmp/control.repo" commit -q -m control
check "scanner finds a needle in git objects (positive control)" test "$(objects_with_needle "$tmp/control.repo" HEAD)" -gt 0

# ---- the synthetic repository: three files that upstream and the fork both changed on line 5 -------------------------
src="$tmp/source"
git init -q -b main "$src"
(
  cd "$src"
  mkdir src
  for f in alpha beta gamma; do seq 1 12 | sed "s/^/$f line /" > "src/$f.ts"; done
  git add -A && git commit -q -m "upstream 1.0.0" && git tag v1.0.0
  git branch custom
  for f in alpha beta gamma; do awk -v t="$f UPSTREAM five" 'NR == 5 { print t; next } { print }' "src/$f.ts" > "src/$f.new" && mv "src/$f.new" "src/$f.ts"; done
  echo "new upstream file" > src/delta.ts
  git add -A && git commit -q -m "upstream 1.0.1" && git tag v1.0.1
  git checkout -q custom
  for f in alpha beta gamma; do awk -v t="$f CUSTOM five" 'NR == 5 { print t; next } { print }' "src/$f.ts" > "src/$f.new" && mv "src/$f.new" "src/$f.ts"; done
  mkdir custom && echo v1.0.0 > custom/BASE
  git add -A && git commit -q -m "our change

Orca-Custom-Patch: test"
)
BASE_SHA="$(git -C "$src" rev-parse custom)"
UPSTREAM_SHA="$(git -C "$src" rev-parse 'v1.0.1^{commit}')"

# ---- the stub model ---------------------------------------------------------------------------------------------------
mkdir "$tmp/bin"
cat > "$tmp/bin/claude" <<'STUB'
#!/usr/bin/env bash
# Fake Claude Code CLI. Behaviour comes from the file `mode` beside this script, because the real call is made with `env -i`.
set -euo pipefail
mode="$(cat "$(dirname "$0")/mode")"
key="$ANTHROPIC_AUTH_TOKEN"
cat > /dev/null                                   # the prompt
printenv | cut -d= -f1 | sort > "$CLAUDE_CONFIG_DIR/env-names.txt"
b64="$(printf '%s' "$key" | base64 | tr -d '\n')"
hex="$(printf '%s' "$key" | od -An -v -tx1 | tr -d ' \n')"
rev="$(printf '%s' "$key" | rev)"
resolve() { seq 1 12 | sed "s/^/$1 merged line /" > "src/$1.ts"; }
case "$mode" in
  leak)   # each leaked form in a different file; none of them has conflict markers, so only the guard can stop them
    printf 'const token = "%s"\n' "$key" > src/alpha.ts
    printf 'const token = "%s"\n' "$b64" > src/beta.ts
    printf 'const token = "%s"\n' "${key:8}" > src/gamma.ts
    printf '%s\n' "$key" > src/new-leak.txt
    mkdir -p notes/deep && printf '%s\n%s\n' "$hex" "$rev" > notes/deep/hex-and-rev.txt
    printf '%s\n' "${key:8}" >&2
    printf '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"done %s","usage":{"input_tokens":10,"output_tokens":5}}\n' "$b64"
    ;;
  clean)  # a well-behaved model: resolves the three files, writes no secret
    for f in alpha beta gamma; do resolve "$f"; done
    printf '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"resolved all three","usage":{"input_tokens":10,"output_tokens":5}}\n'
    ;;
  noop)   # does nothing
    printf '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"nothing to do","usage":{"input_tokens":1,"output_tokens":1}}\n'
    ;;
esac
STUB
chmod +x "$tmp/bin/claude"
export PATH="$tmp/bin:$PATH"

# ---- one agent round, run exactly as the workflow does ------------------------------------------------------------------
# agent_env NAME MODE ROUND [PREV_NAME]: the step environment of the workflow, in the global array AGENT_ENV
agent_env() {
  AGENT_ENV=(SYNC_OUT="$tmp/$1.out" TOOLS_DIR="$scripts" ROUND="$3" MODE="$2" TIER=flash RUNNER_TEMP="$tmp/$1.runner"
    UPSTREAM_SHA="$UPSTREAM_SHA" BASE_SHA="$BASE_SHA" BASE_BRANCH=custom BRANCH="sync/test-$1" LABEL=test TAG=v1.0.1
    IS_TEST=true TAG_IS_RELEASE=false PROBE_SECRET=should-not-reach-the-model)
  if [ -n "${4:-}" ]; then AGENT_ENV+=(PREV_DIR="$tmp/$4.out"); fi
  mkdir -p "$tmp/$1.runner"
}

# round NAME MODE STUB_MODE ROUND [PREV_NAME]: clone the source, run prepare, run, finish; logs go to $tmp/NAME.*.log
round() {
  local name="$1" mode="$2" stub="$3" n="$4" prev="${5:-}"
  local repo="$tmp/$name.repo"
  git clone -q --no-hardlinks "$src" "$repo"
  git -C "$repo" checkout -q custom
  printf '%s' "$stub" > "$tmp/bin/mode"
  agent_env "$name" "$mode" "$n" "$prev"
  (
    cd "$repo"
    env "${AGENT_ENV[@]}" bash "$scripts/agent-round.sh" prepare > "$tmp/$name.prepare.log" 2>&1
    env "${AGENT_ENV[@]}" DEEPINFRA_API_KEY="$FAKE_KEY" bash "$scripts/agent-round.sh" run > "$tmp/$name.run.log" 2>&1
    env "${AGENT_ENV[@]}" bash "$scripts/agent-round.sh" finish > "$tmp/$name.finish.log" 2>&1
  ) || { bad "round $name ran to the end"; sed 's/^/    /' "$tmp/$name".*.log | tail -n 40; return 1; }
  ok "round $name ran to the end"
}

facts() { jq -r "$2" "$tmp/$1.out/sync-facts.json"; }
merge_sha() { facts "$1" .merge_sha; }
show() { git -C "$tmp/$1.repo" show "$(merge_sha "$1"):$2"; }
norm() { sed -E 's/^(<<<<<<<|>>>>>>>|\|\|\|\|\|\|\|) .*/\1/'; } # marker labels differ between git merge and git checkout -m

# =============================================================================================================== A. leak
echo "A. a first round that leaks the key"
round leak first leak 1
log="$tmp/leak.run.log"
check "run printed an error annotation titled Key leak" grep -q '^::error title=Key leak::Round 1:' "$log"
check "the annotation names the leaked files" grep -q 'src/alpha.ts' "$log"
check "the annotation never carries a form of the key" test -z "$(grep -a -F -f <(needles) "$log" || true)"
leaks="$(sed -n 's/^OUTPUT key_leaks=//p' "$log")"
check "run exported key_leaks > 0 (got ${leaks:-none})" test "${leaks:-0}" -gt 0
run_json="$tmp/leak.out/agent-run.json"
check "agent-run.json counts the leak" test "$(jq '.key_leaks' "$run_json")" -gt 0
for f in src/alpha.ts src/beta.ts src/gamma.ts src/new-leak.txt notes/deep/hex-and-rev.txt; do
  # shellcheck disable=SC2016 # $f is a jq variable
  check "leaked file named: $f" jq -e --arg f "$f" '.key_leak_files | index($f) != null' "$run_json"
done
check "the leaked stdout and stderr of the CLI are named too" jq -e '[.key_leak_files[] | select(startswith("CLI output: "))] | length == 2' "$run_json"
check "the model never saw the runner's environment" test -z "$(grep -E '^(PROBE_SECRET|RUNNER_TEMP|GITHUB_)' "$tmp/leak.runner/claude-config-round-1/env-names.txt" || true)"
check "the model got the key through ANTHROPIC_AUTH_TOKEN only" grep -qx ANTHROPIC_AUTH_TOKEN "$tmp/leak.runner/claude-config-round-1/env-names.txt"

echo "A. the candidate holds none of the agent's edits"
check "facts: unresolved" test "$(facts leak .unresolved)" = true
check "facts: key_leak" test "$(facts leak .key_leak)" = true
check "facts: all three conflicted files unresolved" test "$(facts leak '[.conflicts[] | select(.resolution == "unresolved")] | length')" = 3
check "facts: round record counts the leak" test "$(facts leak '.agent.rounds[0].key_leaks')" -gt 0
check "facts: the model's report is withheld" test "$(facts leak '.agent.rounds[0].report')" = "[report withheld: this round's output contained the API key]"
check "no new object of the candidate holds a form of the key" test "$(objects_with_needle "$tmp/leak.repo" "$(merge_sha leak)" "$BASE_SHA" "$UPSTREAM_SHA")" = 0
check "the artifact directory holds no form of the key" test -z "$(files_with_needle "$tmp/leak.out")"
check "the work tree holds no form of the key" test -z "$(files_with_needle "$tmp/leak.repo")"
shipped_objects() { # NAME: objects that the shipped merge.bundle adds to a fresh clone (which already has base and upstream)
  git clone -q --no-hardlinks "$src" "$tmp/ship-$1.repo"
  git -C "$tmp/ship-$1.repo" fetch -q "$tmp/$1.out/merge.bundle" "$(facts "$1" .branch):refs/heads/shipped"
  objects_with_needle "$tmp/ship-$1.repo" shipped "$BASE_SHA" "$UPSTREAM_SHA"
}
check "the SHIPPED bundle adds no object with a form of the key" test "$(shipped_objects leak)" = 0
check "the shipped bundle adds objects at all (the check is not vacuous)" test "$(git -C "$tmp/ship-leak.repo" rev-list --count shipped "^$BASE_SHA" "^$UPSTREAM_SHA")" -ge 1
check "the CLI's raw output file was removed" test ! -e "$tmp/leak.out/agent-out.json.err"
check "candidate: untracked file is not in the merge" test -z "$(git -C "$tmp/leak.repo" ls-tree -r --name-only "$(merge_sha leak)" | grep -E 'new-leak|notes/' || true)"
check "candidate: sentinel is committed" test -n "$(show leak custom/UNRESOLVED-MERGE.txt)"
check "candidate: bundle verifies" git -C "$tmp/leak.repo" bundle verify "$tmp/leak.out/merge.bundle"
check "candidate: commit subject says unresolved" test -n "$(git -C "$tmp/leak.repo" log -1 --format=%s "$(merge_sha leak)" | grep 'UNRESOLVED conflicts, do not merge' || true)"

echo "A. identical to the merge the scripts made before any model ran"
round noop first noop 1
for f in alpha beta gamma; do
  check "src/$f.ts: leaked round == untouched merge (conflict markers back)" \
    test "$(show leak "src/$f.ts" | norm)" = "$(show noop "src/$f.ts" | norm)"
  check "src/$f.ts: markers are present" test -n "$(show leak "src/$f.ts" | grep -E '^<<<<<<< ' || true)"
done
check "the rest of the tree is identical (names)" \
  test "$(git -C "$tmp/leak.repo" ls-tree -r --name-only "$(merge_sha leak)")" = "$(git -C "$tmp/noop.repo" ls-tree -r --name-only "$(merge_sha noop)")"

echo "A. nothing later may start"
sync_yml="$root/.github/workflows/custom-sync.yml"
agent_yml="$root/.github/workflows/custom-agent.yml"
job_block() { awk -v job="  $2:" '$0 == job { on = 1; next } on && /^  [a-z0-9_-]+:/ { exit } on { print }' "$1"; }
# shellcheck disable=SC2016 # a literal workflow expression
check "custom-agent exports key_leaks from the run step" grep -q 'key_leaks: ${{ steps.run.outputs.key_leaks' "$agent_yml"
check "custom-agent: the run step has an id" test -n "$(job_block "$agent_yml" agent | grep -F 'id: run' || true)"
check "agent2 is conditional on key_leaks == '0'" test -n "$(job_block "$sync_yml" agent2 | grep "agent1.outputs.key_leaks == '0'" || true)"
# Round 3 is gated in two steps: the pick3 job (which chooses the round 3 base) carries the leak conditions, and agent3 only runs
# when pick3 succeeded, so a leak in round 1 or 2 still keeps every later model round from starting.
check "pick3 is conditional on agent1 key_leaks == '0'" test -n "$(job_block "$sync_yml" pick3 | grep "agent1.outputs.key_leaks == '0'" || true)"
check "pick3 is conditional on agent2 key_leaks == '0' (or agent2 skipped)" test -n "$(job_block "$sync_yml" pick3 | grep "agent2.outputs.key_leaks == '0'" || true)"
# shellcheck disable=SC2016 # a literal workflow expression
check "agent3 only runs when pick3 succeeded" test -n "$(job_block "$sync_yml" agent3 | grep -F "needs.pick3.result == 'success'" || true)"
check "agent3 does not start on its own conditions (needs pick3 only, no model round)" test -z "$(job_block "$sync_yml" agent3 | grep -E '^    needs:.*agent[12]' || true)"
check "gates1 does not run on an unresolved round" test -n "$(job_block "$sync_yml" gates1 | grep "outputs.unresolved == 'false'" || true)"

echo "A. the PR is a draft [needs manual merge] and opens with the loud caveat"
mkdir -p "$tmp/pr-leak" "$tmp/raw"
jq '.agent.rounds' "$tmp/leak.out/sync-facts.json" > "$tmp/pr-leak/rounds.json"
PR_TITLE="Sync upstream v1.0.1" AGENT_RESULTS="1=success 2=skipped 3=skipped" \
  node "$scripts/make-pr-body.mjs" --facts "$tmp/leak.out/sync-facts.json" --raw "$tmp/raw" --out "$tmp/pr-leak" --agent-rounds "$tmp/pr-leak/rounds.json" 2> "$tmp/pr-leak/err.log" \
  || { bad "make-pr-body ran"; cat "$tmp/pr-leak/err.log"; }
body="$tmp/pr-leak/pr-body.md"
check "body: the caveat is the first block" test "$(head -n 1 "$body")" = "> [!CAUTION]"
check "body: exact caveat sentence" grep -qF "The agent's output contained the API key; its edits were discarded. Rotate DEEPINFRA_API_KEY." "$body"
check "body: round number" grep -q '^> - Round 1: ' "$body"
# shellcheck disable=SC2016 # literal backticks
check "body: file names" grep -q '`src/alpha.ts`' "$body"
check "body: no form of the key anywhere" test -z "$(grep -a -F -f <(needles) "$body" || true)"
check "title: [needs manual merge]" test "$(head -n 1 "$tmp/pr-leak/pr-title.txt")" = "[needs manual merge] Sync upstream v1.0.1"
check "meta: manual, draft, gates failure" jq -e '.state == "manual" and .draft == true and .gates_status == "failure"' "$tmp/pr-leak/pr-meta.json"
check "body: carries the conflict markers recipe" grep -q 'custom/UNRESOLVED-MERGE.txt' "$body"

echo "A. the path that publishes: pick-round, then the PR body for the round it picked"
mkdir -p "$tmp/all-a"
cp -R "$tmp/noop.out" "$tmp/all-a/round-0"
jq 'del(.agent)' "$tmp/noop.out/sync-facts.json" > "$tmp/all-a/round-0/sync-facts.json"   # the merge job's own candidate has no agent record
cp -R "$tmp/leak.out" "$tmp/all-a/round-1"
picked_a="$(bash "$scripts/pick-round.sh" "$tmp/all-a" 2>/dev/null | sed -n 's/^OUTPUT round=//p')"
check "round 0 (no model) beats the leaked round 1" test "$picked_a" = 0
mkdir -p "$tmp/pr-a"
PR_TITLE="Sync upstream v1.0.1" AGENT_RESULTS="1=success 2=skipped 3=skipped" AGENT_KEY_LEAKS="1=$leaks 2= 3=" \
  node "$scripts/make-pr-body.mjs" --facts "$tmp/all-a/round-0/sync-facts.json" --raw "$tmp/raw" --out "$tmp/pr-a" --agent-rounds "$tmp/all-a/agent-rounds.json" 2> /dev/null \
  || bad "make-pr-body ran (published path)"
check "published path: the body opens with the caveat" test "$(head -n 1 "$tmp/pr-a/pr-body.md")" = "> [!CAUTION]"
check "published path: names the round and the files" grep -q '^> - Round 1: .*src/alpha.ts' "$tmp/pr-a/pr-body.md"
check "published path: [needs manual merge]" test "$(head -n 1 "$tmp/pr-a/pr-title.txt")" = "[needs manual merge] Sync upstream v1.0.1"
check "published path: the body carries no form of the key" test -z "$(grep -a -F -f <(needles) "$tmp/pr-a/pr-body.md" || true)"

# ============================================================================================ B. a key-free round is fine
echo "B. a model that behaves is not flagged"
round clean first clean 1
check "key_leaks is 0" test "$(sed -n 's/^OUTPUT key_leaks=//p' "$tmp/clean.run.log")" = 0
check "no error annotation" test -z "$(grep -a '::error' "$tmp/clean.run.log" || true)"
check "the three files are resolved by the agent" test "$(facts clean '[.conflicts[] | select(.resolution == "agent")] | length')" = 3
check "not unresolved" test "$(facts clean .unresolved)" = false
check "the agent's edit is in the candidate" test "$(show clean src/alpha.ts | head -n 1)" = "alpha merged line 1"
check "no markers in the candidate" test -z "$(show clean src/alpha.ts | grep -E '^(<<<<<<<|>>>>>>>)' || true)"
mkdir -p "$tmp/pr-clean"
jq '.agent.rounds' "$tmp/clean.out/sync-facts.json" > "$tmp/pr-clean/rounds.json"
PR_TITLE="Sync upstream v1.0.1" node "$scripts/make-pr-body.mjs" --facts "$tmp/clean.out/sync-facts.json" --raw "$tmp/raw" --out "$tmp/pr-clean" --agent-rounds "$tmp/pr-clean/rounds.json" 2> /dev/null || bad "make-pr-body ran (clean)"
check "body: no key-leak caveat" test -z "$(grep -c 'contained the API key' "$tmp/pr-clean/pr-body.md" | grep -v '^0$' || true)"

# ===================================================================================== C. a repair round that leaks
echo "C. a repair round (round 2) that leaks"
round repairleak repair leak 2 clean
check "repair: key_leaks > 0" test "$(sed -n 's/^OUTPUT key_leaks=//p' "$tmp/repairleak.run.log")" -gt 0
check "repair: unresolved" test "$(facts repairleak .unresolved)" = true
check "repair: no new object holds a form of the key" test "$(objects_with_needle "$tmp/repairleak.repo" "$(merge_sha repairleak)" "$BASE_SHA" "$UPSTREAM_SHA")" = 0
check "repair: the artifact directory holds no form of the key" test -z "$(files_with_needle "$tmp/repairleak.out")"
check "repair: the work tree holds no form of the key" test -z "$(files_with_needle "$tmp/repairleak.repo")"
check "repair: the candidate is the previous candidate plus the sentinel only" \
  test "$(git -C "$tmp/repairleak.repo" diff --name-only "$(merge_sha clean)" "$(merge_sha repairleak)")" = "custom/UNRESOLVED-MERGE.txt"
check "repair: round records keep round 1 and add round 2" test "$(facts repairleak '[.agent.rounds[].round] | join(",")')" = "1,2"
mkdir -p "$tmp/all-c/gates-1-static"
cp -R "$tmp/noop.out" "$tmp/all-c/round-0"
jq 'del(.agent)' "$tmp/noop.out/sync-facts.json" > "$tmp/all-c/round-0/sync-facts.json"
cp -R "$tmp/clean.out" "$tmp/all-c/round-1"
cp -R "$tmp/repairleak.out" "$tmp/all-c/round-2"
printf '{"gates":[{"id":"lint","name":"Lint","status":"fail","seconds":1,"exit_code":1,"output_tail":"1 error"},{"id":"unit","name":"Unit","status":"pass","seconds":1}]}\n' > "$tmp/all-c/gates-1-static/gates.json"
picked="$(bash "$scripts/pick-round.sh" "$tmp/all-c" 2>/dev/null | sed -n 's/^OUTPUT round=//p')"
check "pick-round keeps the honest round 1 over the leaked round 2" test "$picked" = 1
mkdir -p "$tmp/pr-c"
PR_TITLE="Sync upstream v1.0.1" AGENT_RESULTS="1=success 2=success 3=skipped" \
  node "$scripts/make-pr-body.mjs" --facts "$tmp/all-c/round-1/sync-facts.json" --raw "$tmp/raw" --out "$tmp/pr-c" --agent-rounds "$tmp/all-c/agent-rounds.json" --gates "$tmp/all-c/gates-1-static/gates.json" 2> /dev/null \
  || bad "make-pr-body ran (repair)"
check "repair: the body for round 1 still opens with the caveat for round 2" grep -q '^> - Round 2: ' "$tmp/pr-c/pr-body.md"

# ============================================================================== D. the scanners reach every kind of place
echo "D. places a leak can hide in"
d="$tmp/where"
git clone -q --no-hardlinks "$src" "$d.repo" && git -C "$d.repo" checkout -q custom
agent_env where first 1
(cd "$d.repo" && env "${AGENT_ENV[@]}" bash "$scripts/agent-round.sh" prepare > "$d.prepare.log" 2>&1) || { bad "where: prepare ran"; tail -n 20 "$d.prepare.log"; }
cat > "$tmp/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
key="$ANTHROPIC_AUTH_TOKEN"
cat > /dev/null
printf 'ignored\n' > src/delta-ignored.log                  # matches nothing: a control that no false positive appears
printf '%s\n' "$key" > .git/info/exclude                    # inside .git (not objects)
mkdir -p ".cache" && printf 'x\n' > ".cache/$key"           # in a file NAME
ln -s "/tmp/$key" src/link-to-key                           # in a symlink target
printf '{"result":"ok","usage":{"input_tokens":1,"output_tokens":1}}\n'
STUB
(cd "$d.repo" && env "${AGENT_ENV[@]}" DEEPINFRA_API_KEY="$FAKE_KEY" bash "$scripts/agent-round.sh" run > "$d.run.log" 2>&1)
names="$(jq -r '.key_leak_files | join("\n")' "$d.out/agent-run.json")"
check "a hit inside .git (outside objects) is named" test -n "$(printf '%s\n' "$names" | grep -F '.git/info/exclude' || true)"
check "a hit in a file name or a symlink target is counted" test -n "$(printf '%s\n' "$names" | grep -F 'file name(s) or link target(s)' || true)"
check "the name that carries the key is never printed" test -z "$(grep -a -F -f <(needles) "$d.run.log" "$d.out/agent-run.json" || true)"
check "an innocent new file is not flagged" test -z "$(printf '%s\n' "$names" | grep -F 'delta-ignored' || true)"

# ====================================================================================== E. the guard itself fails closed
echo "E. the leak check dies half way: the raw CLI output must not survive"
e="$tmp/crash"
git clone -q --no-hardlinks "$src" "$e.repo" && git -C "$e.repo" checkout -q custom
agent_env crash first 1
(cd "$e.repo" && env "${AGENT_ENV[@]}" bash "$scripts/agent-round.sh" prepare > "$e.prepare.log" 2>&1) || bad "crash: prepare ran"
cat > "$tmp/bin/claude" <<'STUB'
#!/usr/bin/env bash
# Prints a result that carries the key, then breaks jq for everything that runs after it (the scan needs jq).
set -euo pipefail
cat > /dev/null
printf '#!/bin/sh\nexit 1\n' > "$(dirname "$0")/jq" && chmod +x "$(dirname "$0")/jq"
printf '{"result":"token %s","usage":{"input_tokens":1,"output_tokens":1}}\n' "$ANTHROPIC_AUTH_TOKEN"
STUB
crash_rc=0
(cd "$e.repo" && env "${AGENT_ENV[@]}" DEEPINFRA_API_KEY="$FAKE_KEY" bash "$scripts/agent-round.sh" run > "$e.run.log" 2>&1) || crash_rc=$?
rm -f "$tmp/bin/jq"
check "the run step failed (rc $crash_rc), as it should when its own check cannot finish" test "$crash_rc" -ne 0
check "the raw CLI output was deleted" test ! -e "$e.out/agent-out.json"
check "nothing in the artifact directory carries the key" test -z "$(files_with_needle "$e.out")"

# ============================================================== F. the step is cancelled while the CLI is still running
echo "F. a cancelled run step (the artifact upload still runs): no unscanned model output in the uploaded directory"
f="$tmp/cancel"
git clone -q --no-hardlinks "$src" "$f.repo" && git -C "$f.repo" checkout -q custom
agent_env cancel first 1
(cd "$f.repo" && env "${AGENT_ENV[@]}" bash "$scripts/agent-round.sh" prepare > "$f.prepare.log" 2>&1) || bad "cancel: prepare ran"
cat > "$tmp/bin/claude" <<STUB
#!/usr/bin/env bash
# Prints the key on stdout and stderr, tells the test it is running, then waits to be killed.
cat > /dev/null
printf 'result with %s\n' "\$ANTHROPIC_AUTH_TOKEN"
printf 'error with %s\n' "\$ANTHROPIC_AUTH_TOKEN" >&2
echo \$\$ > "$tmp/cancel.stub.pid"
sleep 60
STUB
chmod +x "$tmp/bin/claude"
( cd "$f.repo" && exec env "${AGENT_ENV[@]}" DEEPINFRA_API_KEY="$FAKE_KEY" bash "$scripts/agent-round.sh" run > "$f.run.log" 2>&1 ) &
run_pid=$!
disown "$run_pid"
for _ in $(seq 1 100); do [ -s "$tmp/cancel.stub.pid" ] && break; sleep 0.1; done
check "the stub model is running" test -s "$tmp/cancel.stub.pid"
kill -9 "$run_pid" 2>/dev/null || true       # what a cancel does to the step: no trap runs
kill -9 "$(cat "$tmp/cancel.stub.pid")" 2>/dev/null || true
sleep 0.3
check "uploaded directory holds no form of the key" test -z "$(files_with_needle "$f.out")"
check "uploaded directory holds no CLI output" test ! -e "$f.out/agent-out.json" -a ! -e "$f.out/agent-out.json.err"
check "the unscanned output is only in the config directory (not uploaded)" test -s "$f.runner/claude-config-round-1/agent-out.json"

# ======================================================== G. the PR warns even when the agent job left no round record
echo "G. no round record at all: the job outputs alone must raise the warning"
mkdir -p "$tmp/pr-g1" "$tmp/pr-g2"
printf '[]\n' > "$tmp/empty-rounds.json"
PR_TITLE="Sync upstream v1.0.1" AGENT_RESULTS="1=failure 2=skipped 3=skipped" AGENT_KEY_LEAKS="1=unknown 2= 3=" \
  node "$scripts/make-pr-body.mjs" --facts "$tmp/noop.out/sync-facts.json" --raw "$tmp/raw" --out "$tmp/pr-g1" --agent-rounds "$tmp/empty-rounds.json" 2> /dev/null || bad "make-pr-body ran (unknown)"
check "unknown: opens with the caution block" test "$(head -n 1 "$tmp/pr-g1/pr-body.md")" = "> [!CAUTION]"
check "unknown: says the check did not complete and to rotate" grep -q "key-leak check did not complete.*Treat DEEPINFRA_API_KEY as exposed and rotate it" "$tmp/pr-g1/pr-body.md"
check "unknown: names the round" grep -q '^> - Round 1: the leak check did not complete' "$tmp/pr-g1/pr-body.md"
PR_TITLE="Sync upstream v1.0.1" AGENT_RESULTS="1=failure 2=skipped 3=skipped" AGENT_KEY_LEAKS="1=4 2= 3=" \
  node "$scripts/make-pr-body.mjs" --facts "$tmp/noop.out/sync-facts.json" --raw "$tmp/raw" --out "$tmp/pr-g2" --agent-rounds "$tmp/empty-rounds.json" 2> /dev/null || bad "make-pr-body ran (count only)"
check "count only: the exact caveat sentence" grep -qF "The agent's output contained the API key; its edits were discarded. Rotate DEEPINFRA_API_KEY." "$tmp/pr-g2/pr-body.md"
check "count only: round 1 listed" grep -q '^> - Round 1: (no file names recorded)' "$tmp/pr-g2/pr-body.md"
PR_TITLE="Sync upstream v1.0.1" AGENT_RESULTS="1=success 2=skipped 3=skipped" AGENT_KEY_LEAKS="1=0 2= 3=" \
  node "$scripts/make-pr-body.mjs" --facts "$tmp/noop.out/sync-facts.json" --raw "$tmp/raw" --out "$tmp/pr-g2" --agent-rounds "$tmp/empty-rounds.json" 2> /dev/null || bad "make-pr-body ran (zero)"
check "zero leaks: no caution block" test "$(grep -c 'CAUTION' "$tmp/pr-g2/pr-body.md" || true)" = 0

echo
if [ "$fails" -eq 0 ]; then echo "all key-leak checks passed"; else echo "$fails check(s) FAILED"; exit 1; fi
