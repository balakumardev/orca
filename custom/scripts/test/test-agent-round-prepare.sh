#!/usr/bin/env bash
# Regression test: `agent-round.sh prepare` must survive a long customization log and a long check output under
# `set -euo pipefail`, and must not hand fork scaffolding to the model.
# Run: bash custom/scripts/test/test-agent-round-prepare.sh      (needs git, jq, node, awk; no network, no pnpm; every key is fake)
#
# The bug: the prompt-building part of prepare ran `git log ... | head -c 6000` and `jq ... | head -c 7000`. When the producer
# writes more than the consumer reads, `head` exits, the producer dies of SIGPIPE, pipefail makes the substitution exit 141 and
# `set -e` ends prepare: the paid sync run died right after "merge outcome: conflicts" and never reached the model. The log grew
# past 6000 bytes once commits with long bodies that touch CLAUDE.md and .claude/skills (which the log did not exclude) landed.
#
# Needs a LARGE input to be deterministic: git (or jq) must still be writing when head exits, so the logs here are far bigger
# than a pipe buffer (about 200 KB). Real inputs are smaller; the failure there depends on timing, the fix does not.
#
# Prove the test bites: run it against the pre-fix agent-round.sh, it must FAIL there.
#   d="$(mktemp -d)"; mkdir -p "$d/custom"; cp -R custom/scripts custom/agent "$d/custom/"     # agent/ holds the prompt template
#   git show fork/custom:custom/scripts/agent-round.sh > "$d/custom/scripts/agent-round.sh"
#   SCRIPTS_DIR="$d/custom/scripts" bash custom/scripts/test/test-agent-round-prepare.sh        # exits 1
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
new_scripts="$(cd "$here/.." && pwd)"
scripts="${SCRIPTS_DIR:-$new_scripts}" # the scripts under test; a copy with the pre-fix agent-round.sh shows the test bites
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

# ---- a fork history shaped like the real one -------------------------------------------------------------------------------
# upstream: src/alpha.ts, src/epsilon.ts, CLAUDE.md. The fork adds, one commit each and every one with the trailer and a body
# about as long as a real pull request's (2.7 KB): 60 commits that only touch CLAUDE.md and our skill, 20 that only touch
# custom/** and .github/workflows/custom-*, 9 that change product files, and one that changes a product file AND CLAUDE.md.
body() { awk -v n="$1" 'BEGIN { for (i = 1; i <= n; i++) print "Line " i ": the stacked sidebar layout and the activity agent cycle shortcut keep working after a sync." }'; }
src="$tmp/source"
git init -q -b main "$src"
(
  cd "$src"
  mkdir src
  for f in alpha epsilon; do seq 1 60 | sed "s/^/$f line /" > "src/$f.ts"; done
  echo '# notes' > CLAUDE.md
  git add -A && git commit -q -m "upstream 1.0.0" && git tag v1.0.0
  git branch custom
  awk 'NR == 5 { print "alpha UPSTREAM"; next } { print }' src/alpha.ts > src/alpha.new && mv src/alpha.new src/alpha.ts
  git add -A && git commit -q -m "upstream 1.0.1" && git tag v1.0.1
  git checkout -q custom
  mkdir -p custom/scripts .claude/skills/fork-x .github/workflows
  echo v1.0.0 > custom/BASE
  git add -A && git commit -q -m "fork base" -m "Orca-Custom-Patch: fork-base"
  patch() { git commit -q -m "$1" -m "$(body 24)" -m "Orca-Custom-Patch: test"; } # SUBJECT; the files are already staged
  for i in $(seq 1 60); do
    echo "note $i" >> CLAUDE.md; echo "skill $i" >> .claude/skills/fork-x/SKILL.md
    git add -A; patch "docs: scaffold-notes-$i"
  done
  for i in $(seq 1 20); do
    echo "pipeline $i" >> custom/scripts/x.sh; echo "# $i" >> .github/workflows/custom-x.yml
    git add -A; patch "fix(sync): pipeline-$i"
  done
  awk 'NR == 5 { print "alpha CUSTOM"; next } { print }' src/alpha.ts > src/alpha.new && mv src/alpha.new src/alpha.ts
  git add -A; patch "feat: product-0"
  for i in $(seq 1 8); do
    awk -v t="epsilon CUSTOM $i" -v n="$((i * 5))" 'NR == n { print t; next } { print }' src/epsilon.ts > src/epsilon.new && mv src/epsilon.new src/epsilon.ts
    git add -A; patch "feat: product-$i"
  done
  echo 'export const zeta = 1' > src/zeta.ts; echo "zeta note" >> CLAUDE.md
  git add -A; patch "feat: zeta-with-notes"
)
BASE_SHA="$(git -C "$src" rev-parse custom)"
UPSTREAM_SHA="$(git -C "$src" rev-parse 'v1.0.1^{commit}')"
old_log_bytes="$(git -C "$src" log --no-merges --grep='^Orca-Custom-Patch:' --format='- %h: %s%n%b' "$BASE_SHA" -- . ':(exclude)custom' ':(exclude).github' ':(exclude)CUSTOM.md' | wc -c | tr -d ' ')"
echo "fixture: the pre-fix log (excludes only custom, .github, CUSTOM.md) is $old_log_bytes bytes; the limit is 6000"
check "fixture: the pre-fix log is far over the 6000-byte limit and over a pipe buffer" test "$old_log_bytes" -gt 150000

# ---- a stub model ----------------------------------------------------------------------------------------------------------
mkdir "$tmp/bin"
cat > "$tmp/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
mode="$(cat "$(dirname "$0")/mode")"
cat > /dev/null
case "$mode" in
  resolve) seq 1 60 | sed "s/^/alpha merged line /" > src/alpha.ts ;;
  noop) : ;;
esac
printf '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"done","usage":{"input_tokens":10,"output_tokens":5}}\n'
STUB
chmod +x "$tmp/bin/claude"
export PATH="$tmp/bin:$PATH"

# round NAME MODE STUB ROUND TIER [PREV_NAME [PREV_GATES_DIR]]   (RS=DIR in front of the call: run it with another scripts dir)
round() {
  local name="$1" mode="$2" stub="$3" n="$4" tier="$5" prev="${6:-}" gates="${7:-}" repo="$tmp/$1.repo" sd="${RS:-$scripts}"
  git clone -q --no-hardlinks "$src" "$repo"; git -C "$repo" checkout -q custom
  printf '%s' "$stub" > "$tmp/bin/mode"
  local env_=(SYNC_OUT="$tmp/$name.out" TOOLS_DIR="$sd" ROUND="$n" MODE="$mode" TIER="$tier" RUNNER_TEMP="$tmp/$name.runner"
    UPSTREAM_SHA="$UPSTREAM_SHA" BASE_SHA="$BASE_SHA" BASE_BRANCH=custom BRANCH="sync/test-$name" LABEL=test TAG=v1.0.1 IS_TEST=true TAG_IS_RELEASE=false)
  [ -z "$prev" ] || env_+=(PREV_DIR="$tmp/$prev.out")
  [ -z "$gates" ] || env_+=(PREV_GATES="$gates")
  mkdir -p "$tmp/$name.runner"; : > "$tmp/$name.summary"
  # An && chain: this subshell sits in an `||` list, where `set -e` is off, so every step must be chained to stop the next one.
  ( cd "$repo" \
    && env "${env_[@]}" bash "$sd/agent-round.sh" prepare > "$tmp/$name.prepare.log" 2>&1 \
    && env "${env_[@]}" DEEPINFRA_API_KEY="$FAKE_KEY" bash "$sd/agent-round.sh" run > "$tmp/$name.run.log" 2>&1 \
    && env "${env_[@]}" GITHUB_STEP_SUMMARY="$tmp/$name.summary" bash "$sd/agent-round.sh" finish > "$tmp/$name.finish.log" 2>&1
  ) || { bad "round $name ran to the end"; sed 's/^/    /' "$tmp/$name".*.log | tail -n 8; return 1; }
  ok "round $name ran to the end"
}
# block_bytes FILE START_REGEX END_REGEX: bytes of the lines strictly between the two matching lines
block_bytes() { awk -v s="$2" -v e="$3" '$0 ~ e { on = 0 } on { print } $0 ~ s { on = 1 }' "$1" | wc -c | tr -d ' '; }

# ---- (a) a customization log far over 6000 bytes ---------------------------------------------------------------------------
echo "round 1 (first): the customization log is over 6000 bytes and over a pipe buffer"
round r1 first resolve 1 flash || true
prompt="$tmp/r1.out/agent-prompt.txt"
if [ -s "$prompt" ]; then
  start='^OUR CUSTOMIZATIONS'; end='^If upstream already implements'
  n="$(block_bytes "$prompt" "$start" "$end")"
  check "prepare exited 0 and wrote a prompt" test -s "$prompt"
  check "the customization block is at most the intended 6000 bytes (plus its line breaks)" test "$n" -le 6003
  check "the customization block is not empty" test "$n" -gt 1000
  check "the scaffolding-only commits (CLAUDE.md and our skill) are not in the prompt" test -z "$(grep -F 'scaffold-notes' "$prompt" || true)"
  check "the pipeline-only commits (custom/**, custom workflows) are not in the prompt" test -z "$(grep -F 'pipeline-' "$prompt" || true)"
  check "the newest product commit that also touched CLAUDE.md IS in the prompt" grep -q -F 'zeta-with-notes' "$prompt"
  check "a product commit is in the prompt" grep -q -F 'feat: product-' "$prompt"
else
  bad "prepare produced no prompt (it died before the model step)"
fi

# ---- (b) a check output far over the 28000 byte budget, and item 2: what a repair round may edit --------------------------------------
echo "round 2 (repair): the check output is far over the budget and over a pipe buffer"
# Round 2 repairs a candidate round 1 made. Make that candidate with the FIXED scripts, so that this part is judged on its own
# even when the scripts under test are the pre-fix ones (round 1 above would have died there).
RS="$new_scripts" round r1b first resolve 1 flash || true
mkdir -p "$tmp/gates/gates-1-static"
node -e '
  const gates = []
  for (let i = 1; i <= 60; i++) {
    const tail = (i === 1 ? "FIRST-GATE-MARK\n" : "") + (i === 60 ? "LAST-GATE-MARK\n" : "") + Array.from({ length: 70 }, (_, k) => `gate ${i} output line ${k} ${"x".repeat(30)}`).join("\n")
    gates.push({ id: `g${i}`, name: `Gate ${i}`, status: "fail", exit_code: 1, seconds: 1, note: "", warnings: [], output_tail: tail })
  }
  process.stdout.write(JSON.stringify({ schema: 1, mode: "sync", gates }))
' > "$tmp/gates/gates-1-static/gates.json"
gates_bytes="$(jq -r '.gates[] | select(.status == "fail") | "### \(.name) (exit \(.exit_code))\n\(.output_tail)"' "$tmp/gates/gates-1-static/gates.json" | wc -c | tr -d ' ')"
check "fixture: the failing gates' output is far over the budget and over a pipe buffer" test "$gates_bytes" -gt 150000
if [ -s "$tmp/r1b.out/merge.bundle" ] && round r2 repair noop 2 pro r1b "$tmp/gates"; then
  prompt2="$tmp/r2.out/agent-prompt.txt"
  n="$(block_bytes "$prompt2" '^CHECK OUTPUT' '^FINISH by printing')"
  check "prepare exited 0 for a repair round with a huge check output" test -s "$prompt2"
  check "the check block is truncated to about 28000 bytes, not empty" test "$n" -gt 1000 -a "$n" -le 28300
  check "the check block keeps the start of the gate output" grep -q -F 'FIRST-GATE-MARK' "$prompt2"
  check "the check block drops the end of the gate output" test -z "$(grep -F 'LAST-GATE-MARK' "$prompt2" || true)"
  check "the repair prompt's customization block is also bounded" test "$(block_bytes "$prompt2" '^OUR CUSTOMIZATIONS' '^If upstream already implements')" -le 6003
  # item 2: our-files.txt is the plain diff of our commits, so it lists CLAUDE.md and the skill; nothing may EDIT them.
  check "our-files.txt lists the scaffolding (it is a plain diff)" grep -q -x 'CLAUDE.md' "$tmp/r2.out/our-files.txt"
  check "the repair prompt offers the product files we own for editing" grep -q -F -- '- src/epsilon.ts (owned by a customization)' "$prompt2"
  check "the repair prompt does not offer CLAUDE.md for editing" test -z "$(grep -F 'CLAUDE.md' <(sed -n '/^FILES YOU MAY EDIT/,/^FINISH by printing/p' "$prompt2") || true)"
  check "the repair prompt does not offer our skill for editing" test -z "$(grep -F '.claude/skills' <(sed -n '/^FILES YOU MAY EDIT/,/^FINISH by printing/p' "$prompt2") || true)"
  check "the repair prompt does not offer custom/** or .github for editing" test -z "$(grep -E -- '^- (custom/|\.github/)' "$prompt2" || true)"
  allowed="$tmp/r2.out/allowed-edit-files.txt"
  check "allowed-edit-files: the conflicted and the owned product files" test "$(tr '\n' ' ' < "$allowed")" = "src/alpha.ts src/epsilon.ts src/zeta.ts "
  check "allowed-edit-files: no CLAUDE.md, no skill, no custom/**, no workflow" test -z "$(grep -E -- '^(CLAUDE.md|\.claude/|custom/|\.github/)' "$allowed" || true)"
fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
