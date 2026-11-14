#!/usr/bin/env bash
# Test for the round modes of agent-round.sh with a stub model: hunk counts, repair scope and prompt, turn caps, the job summary
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
resolve() { seq 1 60 | sed "s/^/$1 merged line /" > "src/$1.ts"; }
case "$mode" in
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
  (
    cd "$repo"
    env "${env_[@]}" bash "$scripts/agent-round.sh" prepare > "$tmp/$name.prepare.log" 2>&1
    env "${env_[@]}" DEEPINFRA_API_KEY="$FAKE_KEY" bash "$scripts/agent-round.sh" run > "$tmp/$name.run.log" 2>&1
    env "${env_[@]}" GITHUB_STEP_SUMMARY="$tmp/$name.summary" bash "$scripts/agent-round.sh" finish > "$tmp/$name.finish.log" 2>&1
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
check "first: turn cap = 24 + 10 per file" test "$(jq -r .max_turns "$tmp/r1.out/agent-plan.json")" = 54
check "round 1 resolved everything" test "$(facts r1 .unresolved)" = false
check "a successful round says ok in the job summary" grep -q 'Result: ok\.' "$tmp/r1.summary"
check "no repair edits are recorded for a first round" test "$(facts r1 '.repair_edits // [] | length')" = 0

echo "round 2 (repair, pro): wider scope, 80 turns, ran out of turns"
round r2 repair repair-max-turns 2 pro r1
check "repair: turn cap is 80" test "$(jq -r .max_turns "$tmp/r2.out/agent-plan.json")" = 80
check "repair: Pro keeps its longer wall clock" test "$(jq -r .wall_seconds "$tmp/r2.out/agent-plan.json")" = 1800
check "repair prompt: the conflicted files are not given a hunk count" test -z "$(grep -F 'conflict hunk(s)' "$tmp/r2.out/agent-prompt.txt" || true)"
check "repair prompt: the conflicted files are listed as conflicted in the merge" grep -q 'src/beta.ts (content, conflicted in the merge' "$tmp/r2.out/agent-prompt.txt"
check "repair prompt: the owned, non-conflicted file is editable" grep -q '^- src/epsilon.ts (owned by a customization)' "$tmp/r2.out/agent-prompt.txt"
check "allowed-edit-files: conflicted files plus owned files" test "$(tr '\n' ' ' < "$tmp/r2.out/allowed-edit-files.txt")" = "src/alpha.ts src/beta.ts src/epsilon.test.ts src/epsilon.ts src/gamma.ts "
check "the round record says why it stopped" test "$(facts r2 '.agent.rounds[-1].stop')" = error_max_turns
check "the round record keeps the CLI's exit code" test "$(facts r2 '.agent.rounds[-1].exit_code')" = 1
check "its edits were kept (not reverted)" grep -q 'epsilon repaired' <(git -C "$tmp/r2.repo" show "$(facts r2 .merge_sha):src/epsilon.ts")
check "the job summary explains the stop" grep -q 'Agent round 2 (repair, pro): 81 of at most 80 turns, exit code 1.*Result: ran out of turns; edits kept; gates decide\.' "$tmp/r2.summary"
check "facts.repair_edits lists the non-conflicted files the repair changed" test "$(facts r2 '.repair_edits | join(",")')" = "src/epsilon.test.ts,src/epsilon.ts"
check "the earlier round's record is still in the facts" test "$(facts r2 '.agent.rounds | map(.round) | join(",")')" = "1,2"

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
