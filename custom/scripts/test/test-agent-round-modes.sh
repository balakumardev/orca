#!/usr/bin/env bash
# Test for the round modes of agent-round.sh with a stub model: hunk counts, repair scope and prompt, no turn cap, the job summary
# line and the record of what a repair edited. Run: bash custom/scripts/test/test-agent-round-modes.sh   (needs git, jq, node, awk;
# no network, no pnpm). Every key here is fake. The key-leak guard itself is test-key-leak.sh.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
for tool in git jq node awk base64 od rev openssl; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
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

# Source: three files that upstream and the fork both changed (alpha: 1 hunk, beta: 3 far-apart hunks, gamma: 1 hunk), plus a
# file only the fork changed (epsilon: owned by a customization, not conflicted) and its test.
src="$tmp/source"
git init -q -b main "$src"
(
  cd "$src"
  mkdir src
  for f in alpha beta gamma epsilon; do seq 1 60 | sed "s/^/$f line /" > "src/$f.ts"; done
  echo 'test("e", () => {})' > src/epsilon.test.ts
  git add -A && git commit -q -m "upstream 1.0.0" && git tag v1.0.0
  git branch custom
  edit() { awk -v t="$2" -v n="$3" 'NR == n { print t; next } { print }' "src/$1.ts" > "src/$1.new" && mv "src/$1.new" "src/$1.ts"; }
  edit alpha "alpha UPSTREAM" 5; edit gamma "gamma UPSTREAM" 5
  for n in 5 30 55; do edit beta "beta UPSTREAM $n" "$n"; done
  echo "new upstream file" > src/delta.ts
  git add -A && git commit -q -m "upstream 1.0.1" && git tag v1.0.1
  git checkout -q custom
  edit alpha "alpha CUSTOM" 5; edit gamma "gamma CUSTOM" 5; edit epsilon "epsilon CUSTOM" 7
  echo 'test("e", () => { /* ours */ })' > src/epsilon.test.ts
  for n in 5 30 55; do edit beta "beta CUSTOM $n" "$n"; done
  mkdir custom && echo v1.0.0 > custom/BASE
  git add -A && git commit -q -m "our change

Orca-Custom-Patch: test"
)
BASE_SHA="$(git -C "$src" rev-parse custom)"
UPSTREAM_SHA="$(git -C "$src" rev-parse 'v1.0.1^{commit}')"

mkdir "$tmp/bin"
cat > "$tmp/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
mode="$(cat "$(dirname "$0")/mode")"
cat > /dev/null
echo "$mode" >> "$(dirname "$0")/calls"
echo "$*" >> "$(dirname "$0")/args"
resolve() { seq 1 60 | sed "s/^/$1 merged line /" > "src/$1.ts"; }
case "$mode" in
  hang) # resolves one file, then never finishes: the wall clock has to stop it (no JSON is written, like a killed CLI)
    resolve alpha
    exec sleep 60 ;;
  drop-gone) # asks for the one modify/delete file to be removed
    printf 'DELETE-THIS-FILE\n' > src/gone.ts
    printf '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"dropped","usage":{"input_tokens":10,"output_tokens":5}}\n' ;;
  sentinel-content) # writes the delete line into a file that upstream still has, resolves the others
    printf 'DELETE-THIS-FILE\n' > src/alpha.ts
    for f in beta gamma; do resolve "$f"; done
    printf '{"type":"result","subtype":"success","is_error":false,"num_turns":4,"result":"resolved","usage":{"input_tokens":10,"output_tokens":5}}\n' ;;
  noop) # edits nothing
    printf '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"","usage":{"input_tokens":10,"output_tokens":5}}\n' ;;
  partial) # resolves one of the three files, then runs out of turns (exit 1, like the real CLI)
    resolve alpha
    printf '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":71,"result":"","usage":{"input_tokens":1000000,"output_tokens":20000}}\n'
    exit 1 ;;
  rest) # resolves the two files `partial` left
    for f in beta gamma; do resolve "$f"; done
    printf '{"type":"result","subtype":"success","is_error":false,"num_turns":9,"result":"resolved","usage":{"input_tokens":10,"output_tokens":5}}\n' ;;
  resolve) # resolves the three conflicted files
    for f in alpha beta gamma; do resolve "$f"; done
    printf '{"type":"result","subtype":"success","is_error":false,"num_turns":5,"result":"resolved","usage":{"input_tokens":10,"output_tokens":5}}\n' ;;
  repair-max-turns) # edits two files that were not conflicted, then runs out of turns (exit 1, like the real CLI)
    echo "epsilon repaired" >> src/epsilon.ts
    echo 'test("weakened", () => {})' > src/epsilon.test.ts
    printf '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":81,"result":"","usage":{"input_tokens":1000000,"output_tokens":20000}}\n'
    exit 1 ;;
esac
STUB
chmod +x "$tmp/bin/claude"
export PATH="$tmp/bin:$PATH"

# round NAME MODE STUB ROUND TIER [PREV_NAME]
round() {
  local name="$1" mode="$2" stub="$3" n="$4" tier="$5" prev="${6:-}" repo="$tmp/$1.repo"
  git clone -q --no-hardlinks "$src" "$repo"; git -C "$repo" checkout -q custom
  printf '%s' "$stub" > "$tmp/bin/mode"
  local env_=(SYNC_OUT="$tmp/$name.out" TOOLS_DIR="$scripts" ROUND="$n" MODE="$mode" TIER="$tier" RUNNER_TEMP="$tmp/$name.runner"
    UPSTREAM_SHA="$UPSTREAM_SHA" BASE_SHA="$BASE_SHA" BASE_BRANCH=custom BRANCH="sync/test-$name" LABEL=test TAG=v1.0.1 IS_TEST=true TAG_IS_RELEASE=false)
  [ -z "$prev" ] || env_+=(PREV_DIR="$tmp/$prev.out")
  mkdir -p "$tmp/$name.runner"; : > "$tmp/$name.summary"
  # An && chain: this subshell sits in an `||` list, where `set -e` is off, so a step that died would not stop the next one.
  ( cd "$repo" \
    && env "${env_[@]}" bash "$scripts/agent-round.sh" prepare > "$tmp/$name.prepare.log" 2>&1 \
    && env "${env_[@]}" DEEPINFRA_API_KEY="$FAKE_KEY" bash "$scripts/agent-round.sh" run > "$tmp/$name.run.log" 2>&1 \
    && env "${env_[@]}" GITHUB_STEP_SUMMARY="$tmp/$name.summary" bash "$scripts/agent-round.sh" finish > "$tmp/$name.finish.log" 2>&1
  ) || { bad "round $name ran to the end"; sed 's/^/    /' "$tmp/$name".*.log | tail -n 30; return 1; }
  ok "round $name ran to the end"
}
facts() { jq -r "$2" "$tmp/$1.out/sync-facts.json"; }

echo "round 1 (first, flash): the hunk counts are hunks, not marker lines"
round r1 first resolve 1 flash
check "conflicts.tsv: alpha 1 hunk" grep -E -q "^src/alpha.ts[[:space:]]content[[:space:]]1[[:space:]]" "$tmp/r1.out/conflicts.tsv"
check "conflicts.tsv: beta 3 hunks" grep -E -q "^src/beta.ts[[:space:]]content[[:space:]]3[[:space:]]" "$tmp/r1.out/conflicts.tsv"
check "conflicts.tsv: gamma 1 hunk" grep -E -q "^src/gamma.ts[[:space:]]content[[:space:]]1[[:space:]]" "$tmp/r1.out/conflicts.tsv"
check "facts carry the same counts" test "$(facts r1 '[.conflicts[] | select(.path | startswith("src/")) | .hunks] | join(",")')" = "1,3,1"
check "the prompt tells the model the real counts" grep -q 'src/beta.ts (content, 3 conflict hunk(s))' "$tmp/r1.out/agent-prompt.txt"
check "the prompt does not double them" test -z "$(grep -F 'src/beta.ts (content, 6' "$tmp/r1.out/agent-prompt.txt" || true)"
check "no turn cap: the plan has no turn count" jq -e 'has("max_turns") | not' "$tmp/r1.out/agent-plan.json"
check "no turn cap: the CLI is started without --max-turns" test -z "$(grep -F -e '--max-turns' "$tmp/bin/args" || true)"
check "the only cap is the 30 minute wall clock" test "$(jq -r .wall_seconds "$tmp/r1.out/agent-plan.json")" = 1800
check "round 1 resolved everything" test "$(facts r1 .unresolved)" = false
check "a successful round says ok in the job summary" grep -q 'Result: ok\.' "$tmp/r1.summary"
check "no repair edits are recorded for a first round" test "$(facts r1 '.repair_edits // [] | length')" = 0

echo "round 2 (repair, pro): wider scope, stops early with edits kept"
round r2 repair repair-max-turns 2 pro r1
check "repair on Pro: the same 30 minute wall clock" test "$(jq -r .wall_seconds "$tmp/r2.out/agent-plan.json")" = 1800
check "repair prompt: the conflicted files are not given a hunk count" test -z "$(grep -F 'conflict hunk(s)' "$tmp/r2.out/agent-prompt.txt" || true)"
check "repair prompt: the conflicted files are listed as conflicted in the merge" grep -q 'src/beta.ts (content, conflicted in the merge' "$tmp/r2.out/agent-prompt.txt"
check "repair prompt: the owned, non-conflicted file is editable" grep -q '^- src/epsilon.ts (owned by a customization)' "$tmp/r2.out/agent-prompt.txt"
check "allowed-edit-files: conflicted files plus owned files" test "$(tr '\n' ' ' < "$tmp/r2.out/allowed-edit-files.txt")" = "src/alpha.ts src/beta.ts src/epsilon.test.ts src/epsilon.ts src/gamma.ts "
check "the round record says why it stopped" test "$(facts r2 '.agent.rounds[-1].stop')" = error_max_turns
check "the round record keeps the CLI's exit code" test "$(facts r2 '.agent.rounds[-1].exit_code')" = 1
check "its edits were kept (not reverted)" grep -q 'epsilon repaired' <(git -C "$tmp/r2.repo" show "$(facts r2 .merge_sha):src/epsilon.ts")
check "the job summary explains the stop" grep -q 'Agent round 2 (repair, pro): 81 turns, exit code 1.*Result: ran out of turns; edits kept; gates decide\.' "$tmp/r2.summary"
check "facts.repair_edits lists the non-conflicted files the repair changed" test "$(facts r2 '.repair_edits | join(",")')" = "src/epsilon.test.ts,src/epsilon.ts"
check "the earlier round's record is still in the facts" test "$(facts r2 '.agent.rounds | map(.round) | join(",")')" = "1,2"

echo "every mode and tier gets the same wall clock and no turn count"
round r2f repair repair-max-turns 2 flash r1
check "repair on Flash: 30 minutes" test "$(jq -r .wall_seconds "$tmp/r2f.out/agent-plan.json")" = 1800
round r3r retry resolve 3 pro r2
check "retry on Pro: 30 minutes, no turn count" bash -c "test \"\$(jq -r .wall_seconds '$tmp/r3r.out/agent-plan.json')\" = 1800 && jq -e 'has(\"max_turns\") | not' '$tmp/r3r.out/agent-plan.json'"

echo "round 1 stops early with two of three files left: round 2 CONTINUES that candidate, it does not start the merge again"
round p1 first partial 1 flash
check "the partly resolved round names the two files left" test "$(facts p1 '.unresolved_files | join(",")')" = "src/beta.ts,src/gamma.ts"
check "and is unresolved" test "$(facts p1 .unresolved)" = true
round p2 repair rest 2 flash p1
check "continue: the prompt offers the two files that still hold markers" bash -c "grep -q 'src/beta.ts (content, still holds conflict markers)' '$tmp/p2.out/agent-prompt.txt' && grep -q 'src/gamma.ts (content, still holds conflict markers)' '$tmp/p2.out/agent-prompt.txt'"
check "continue: the prompt does not offer the resolved file or the owned ones" test -z "$(grep -E 'src/alpha.ts|src/epsilon|owned by a customization' "$tmp/p2.out/agent-prompt.txt" || true)"
check "continue: the prompt is the resume situation, not the 'no markers' repair one" bash -c "grep -q 'stopped before it finished: some conflicted files are resolved' '$tmp/p2.out/agent-prompt.txt' && ! grep -q 'there are no conflict markers to find' '$tmp/p2.out/agent-prompt.txt'"
check "continue: it finished the merge" test "$(facts p2 .unresolved)" = false
check "continue: round 1's resolution of alpha survived" grep -q 'alpha merged line 7' <(git -C "$tmp/p2.repo" show "$(facts p2 .merge_sha):src/alpha.ts")
check "continue: the UNRESOLVED-MERGE.txt of the earlier candidate is gone" test -z "$(git -C "$tmp/p2.repo" ls-tree --name-only "$(facts p2 .merge_sha)" -- custom/UNRESOLVED-MERGE.txt)"
check "continue: both rounds are in the record" test "$(facts p2 '.agent.rounds | map(.round) | join(",")')" = "1,2"
round p3 repair rest 3 pro p1

echo "a release that conflicts in many files gets room for them (a cap of 70 turns stopped v1.4.261 at 16 of its 22 model files)"
many="$tmp/many"
git init -q -b main "$many"
(
  cd "$many"
  mkdir src
  for i in $(seq 1 14); do seq 1 20 | sed "s/^/f$i line /" > "src/f$i.ts"; done
  git add -A && git commit -q -m "upstream 1.0.0" && git tag v1.0.0
  git branch custom
  edit() { awk -v t="$2" -v n="$3" 'NR == n { print t; next } { print }' "src/$1.ts" > "src/$1.new" && mv "src/$1.new" "src/$1.ts"; }
  for i in $(seq 1 14); do edit "f$i" "f$i UPSTREAM" 5; done
  git add -A && git commit -q -m "upstream 1.0.1" && git tag v1.0.1
  git checkout -q custom
  for i in $(seq 1 14); do edit "f$i" "f$i CUSTOM" 5; done
  mkdir custom && echo v1.0.0 > custom/BASE
  git add -A && git commit -q -m "our change

Orca-Custom-Patch: test"
)
src_saved="$src"; base_saved="$BASE_SHA"; up_saved="$UPSTREAM_SHA"
src="$many"; BASE_SHA="$(git -C "$many" rev-parse custom)"; UPSTREAM_SHA="$(git -C "$many" rev-parse 'v1.0.1^{commit}')"
round m1 first noop 1 flash
check "14 conflicted files: still no turn count, still 30 minutes" bash -c "jq -e 'has(\"max_turns\") | not' '$tmp/m1.out/agent-plan.json' && test \"\$(jq -r .wall_seconds '$tmp/m1.out/agent-plan.json')\" = 1800"
check "14 conflicted files: all 14 are offered to the model" test "$(jq -r .files "$tmp/m1.out/agent-plan.json")" = 14

echo "a modify/delete conflict is the agent's decision: it keeps the file or drops it, nobody has to step in"
gone="$tmp/gone"
git init -q -b main "$gone"
(
  cd "$gone"
  mkdir src
  seq 1 20 | sed "s/^/gone line /" > src/gone.ts
  git add -A && git commit -q -m "upstream 1.0.0" && git tag v1.0.0
  git branch custom
  git rm -q src/gone.ts
  git add -A && git commit -q -m "upstream 1.0.1" && git tag v1.0.1
  git checkout -q custom
  sed -i.bak '5s/.*/gone CUSTOM/' src/gone.ts && rm -f src/gone.ts.bak
  mkdir custom && echo v1.0.0 > custom/BASE
  git add -A && git commit -q -m "our change

Orca-Custom-Patch: test"
)
src="$gone"; BASE_SHA="$(git -C "$gone" rev-parse custom)"; UPSTREAM_SHA="$(git -C "$gone" rev-parse 'v1.0.1^{commit}')"
calls_before="$(wc -l < "$tmp/bin/calls" | tr -d ' ')"
round d1 first noop 1 flash
check "the model is asked to decide (the plan does not skip)" test "$(jq -r .skip "$tmp/d1.out/agent-plan.json")" = false
check "the model was started" test "$(wc -l < "$tmp/bin/calls" | tr -d ' ')" -gt "$calls_before"
check "the prompt lists the file with what each side did" grep -q 'src/gone.ts (deleted-by-them: upstream deleted or moved it' "$tmp/d1.out/agent-prompt.txt"
check "the file is not under 'NOT YOURS'" test -z "$(grep -F 'NOT YOURS' "$tmp/d1.out/agent-prompt.txt" || true)"
check "a file the model left untouched is kept: the merge is resolved" test "$(facts d1 .unresolved)" = false
check "kept: our version is in the merge" grep -q 'gone CUSTOM' <(git -C "$tmp/d1.repo" show "$(facts d1 .merge_sha):src/gone.ts")
check "the decision is recorded" test "$(facts d1 '.conflicts[] | select(.path == "src/gone.ts") | .decision')" = kept
round d2 first drop-gone 1 flash
check "a file the model replaced with the delete line is removed from the merge" test -z "$(git -C "$tmp/d2.repo" ls-tree --name-only "$(facts d2 .merge_sha)" -- src/gone.ts)"
check "dropped: the merge is resolved" test "$(facts d2 .unresolved)" = false
check "dropped: the decision is recorded" test "$(facts d2 '.conflicts[] | select(.path == "src/gone.ts") | .decision')" = deleted
check "dropped: the resolution is the agent's" test "$(facts d2 '.conflicts[] | select(.path == "src/gone.ts") | .resolution')" = agent

echo "only a conflict of an unusual kind is left: the model is not called at all"
cp -R "$tmp/d1.out" "$tmp/d3.out"
jq '.unresolved = true | .unresolved_files = ["src/gone.ts"] | .conflicts |= map(.kind = "other")' "$tmp/d1.out/sync-facts.json" > "$tmp/d3.out/sync-facts.json"
calls_before="$(wc -l < "$tmp/bin/calls" | tr -d ' ')"
round d4 repair noop 2 flash d3
check "a repair with nothing a model may edit: the plan says skip" test "$(jq -r .skip "$tmp/d4.out/agent-plan.json")" = true
check "the model was never started" test "$(wc -l < "$tmp/bin/calls" | tr -d ' ')" = "$calls_before"
check "the round is recorded as skipped" test "$(facts d4 '.agent.rounds[-1].skipped')" = true
check "the job summary says why" grep -q 'Result: skipped; no file was left that a model may resolve\.' "$tmp/d4.summary"
check "the file stays unresolved for a human" test "$(facts d4 '.unresolved_files | join(",")')" = "src/gone.ts"
src="$src_saved"; BASE_SHA="$base_saved"; UPSTREAM_SHA="$up_saved"

echo "the delete line is honoured only for a modify/delete conflict"
round s1 first sentinel-content 1 flash
check "the delete line in a file upstream still has leaves it unresolved" test "$(facts s1 '.unresolved_files | join(",")')" = "src/alpha.ts"
check "the other two files were resolved" test "$(facts s1 '[.conflicts[] | select(.resolution == "agent")] | length')" = 2

echo "the wall clock is the cap: a round that never finishes is killed, keeps its edits, and the next round continues them"
if command -v timeout >/dev/null 2>&1; then
  export AGENT_WALL_SECONDS=2
  round w1 first hang 1 flash
  unset AGENT_WALL_SECONDS
  check "killed by the clock: exit code 124 is recorded" test "$(facts w1 '.agent.rounds[-1].exit_code')" = 124
  check "killed by the clock: the job summary names the wall clock" grep -q 'Result: hit the wall-clock limit; edits kept; gates decide\.' "$tmp/w1.summary"
  check "killed by the clock: the edit it made was kept" grep -q 'alpha merged line 7' <(git -C "$tmp/w1.repo" show "$(facts w1 .merge_sha):src/alpha.ts")
  check "killed by the clock: the merge is unresolved with the two files left" test "$(facts w1 '.unresolved_files | join(",")')" = "src/beta.ts,src/gamma.ts"
  round w2 repair rest 2 flash w1
  check "the round after the clock finished the merge" test "$(facts w2 .unresolved)" = false
else
  echo "skip: no timeout command on this machine, the wall clock test needs it"
fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
