#!/usr/bin/env bash
# Test: the fork-scaffolding list in lib.sh has ONE source, and its two uses agree.
# Run: bash custom/scripts/test/test-scaffolding-paths.sh      (needs git; no network)
#
# OUR_WINS_PATTERNS is matched against a file path by our_wins_path (a `case` glob) and turned into git pathspecs by
# customization_log_pathspecs (they keep fork scaffolding out of the customization log the model reads). Bash `case` and git
# pathspecs are two glob dialects, so this test commits one customization commit per sample path and checks that
#   a commit is HIDDEN from customization_log  <=>  our_wins_path says "ours" OR the path is under .github/
# for every sample (.github/ as a whole is left out of the log: it is fork CI plus upstream CI the fork drops, none of it product
# code). It also pins the wanted answers for a few paths, so that a change to the list cannot silently flip a case.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="${SCRIPTS_DIR:-$(cd "$here/.." && pwd)}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# shellcheck source=../lib.sh
. "$scripts/lib.sh"

# path : wanted verdict (scaffolding = ours, hidden from the log;  product = shown in the log)
samples=(
  'custom/scripts/lib.sh:scaffolding' 'custom/BASE:scaffolding' 'custom/agent/prompt.txt:scaffolding'
  '.github/pull_request_template.md:scaffolding' '.github/workflows/custom-gates.yml:scaffolding'
  '.github/workflows/ci.yml:upstream-ci' '.github/dependabot.yml:upstream-ci' '.github/ISSUE_TEMPLATE/bug.md:upstream-ci'
  'CUSTOM.md:scaffolding' 'CLAUDE.md:scaffolding'
  '.claude/skills/fork-release-and-sync/SKILL.md:scaffolding' '.claude/skills/fork-release-and-sync/references/a.md:scaffolding' '.claude/skills/fork-x/y/z.md:scaffolding'
  '.claude/skills/other/SKILL.md:product' '.claude/settings.json:product'
  'src/CLAUDE.md:product' 'docs/custom/x.md:product' 'customer/x.ts:product' 'CUSTOM.md.bak:product' 'src/main/index.ts:product' 'README.md:product'
)

# one commit per sample, each with the trailer and a subject that is the path
src="$tmp/repo"
git init -q -b main "$src"
(
  cd "$src"
  git commit -q --allow-empty -m "base"
  git tag base
  for s in "${samples[@]}"; do
    p="${s%%:*}"
    mkdir -p "$(dirname "$p")"; echo "$p" > "$p"; git add -f -- "$p"
    git commit -q -m "touch $p" -m "Orca-Custom-Patch: test"
  done
)
log="$(cd "$src" && customization_log HEAD)"
base_sha="$(git -C "$src" rev-parse base)"

# shown SUBJECT: is a commit with exactly this subject in the log? (a whole-line match: "touch CUSTOM.md" must not match "touch CUSTOM.md.bak")
shown() { awk -v want="$1" '{ sub(/^- [0-9a-f]+: /, "") } $0 == want { found = 1 } END { exit !found }' <<<"$log"; }

for s in "${samples[@]}"; do
  p="${s%%:*}"; want="${s#*:}"
  in_log=no; shown "touch $p" && in_log=yes
  ours=no; our_wins_path "$p" && ours=yes
  under_github=no; case "$p" in .github/*) under_github=yes ;; esac
  # the agreement
  hidden=yes; [ "$in_log" = yes ] && hidden=no
  expect_hidden=no; if [ "$ours" = yes ] || [ "$under_github" = yes ]; then expect_hidden=yes; fi
  if [ "$hidden" = "$expect_hidden" ]; then ok "the log and our_wins_path agree on $p (hidden from the log: $hidden)"
  else bad "the log hides $p: $hidden, but our_wins_path=$ours and under .github=$under_github"; fi
  # the pinned answers
  case "$want" in
    scaffolding) if [ "$ours" = yes ] && [ "$hidden" = yes ]; then ok "$p is ours and hidden"; else bad "$p should be ours and hidden (ours=$ours hidden=$hidden)"; fi ;;
    upstream-ci) if [ "$ours" = no ] && [ "$hidden" = yes ]; then ok "$p is not ours (upstream CI, dropped) and hidden"; else bad "$p should be hidden but not ours (ours=$ours hidden=$hidden)"; fi ;;
    product) if [ "$ours" = no ] && [ "$hidden" = no ]; then ok "$p is product code: not ours, shown in the log"; else bad "$p should be shown and not ours (ours=$ours hidden=$hidden)"; fi ;;
  esac
done

# a commit that touches product AND scaffolding stays in the log (git shows a commit while any of its paths survives)
(
  cd "$src"
  echo more >> src/main/index.ts; echo more >> CLAUDE.md; git add -f -A
  git commit -q -m "mixed product and notes" -m "Orca-Custom-Patch: test"
)
log="$(cd "$src" && customization_log HEAD)"
if shown "mixed product and notes"; then ok "a commit touching product code and CLAUDE.md stays in the log"; else bad "mixed commit was hidden"; fi

# the pathspec list: one line per pattern, plus .github/*; and no pattern is listed twice
specs="$(customization_log_pathspecs)"
n_expected=$(( ${#OUR_WINS_PATTERNS[@]} + 1 ))
if [ "$(printf '%s\n' "$specs" | wc -l | tr -d ' ')" = "$n_expected" ]; then ok "customization_log_pathspecs prints one pathspec per pattern plus .github/*"; else bad "pathspec count: $(printf '%s\n' "$specs" | wc -l)"; fi
if [ -z "$(printf '%s\n' "$specs" | sort | uniq -d)" ]; then ok "no pathspec is listed twice"; else bad "duplicate pathspecs"; fi
# ---- the gates' scope (run-gates.sh) -----------------------------------------------------------------------------------------
# Sync mode builds its targets from our-files.txt, which is a plain diff and so lists CLAUDE.md and our skills. They belong in
# the HYGIENE scope (a conflict marker in CLAUDE.md must still fail the merge), but nothing may lint, format or type-check
# them: the lint, format and typecheck gates read targets-code.txt, which is cut by extension to JS/TS files. Our own
# custom/scripts/*.mjs ARE code on purpose (they must pass oxlint and oxfmt like product code).
gate_repo="$tmp/gate-repo"
mkdir -p "$gate_repo/src" "$gate_repo/custom/scripts" "$gate_repo/.claude/skills/fork-x" "$gate_repo/.github/workflows"
printf 'v1.0.0\n' > "$gate_repo/custom/BASE"
printf 'export const a = 1\n' > "$gate_repo/src/a.ts"
printf 'export const b = 1\n' > "$gate_repo/custom/scripts/tool.mjs"
printf '# notes\n' > "$gate_repo/CLAUDE.md"
printf '# skill\n' > "$gate_repo/.claude/skills/fork-x/SKILL.md"
printf 'name: custom-x\n' > "$gate_repo/.github/workflows/custom-x.yml"
git -C "$gate_repo" init -q && git -C "$gate_repo" add -f -A && git -C "$gate_repo" commit -q -m init
printf '%s\n' src/a.ts custom/scripts/tool.mjs CLAUDE.md .claude/skills/fork-x/SKILL.md .github/workflows/custom-x.yml > "$tmp/gate-our-files.txt"
gate_out="$tmp/gate-out"
( cd "$gate_repo" && bash "$scripts/run-gates.sh" --out "$gate_out" --mode sync --our-files "$tmp/gate-our-files.txt" --only hygiene ) > "$tmp/gate-run.log" 2>&1 \
  || { bad "run-gates.sh --only hygiene ran to the end"; tail -n 8 "$tmp/gate-run.log" | sed 's/^/    /'; }
if [ -s "$gate_out/targets-all.txt" ]; then
  if grep -q -x 'CLAUDE.md' "$gate_out/targets-all.txt" && grep -q -x '.claude/skills/fork-x/SKILL.md' "$gate_out/targets-all.txt"; then ok "gate scope: CLAUDE.md and our skill are in the hygiene scope (a conflict marker there still fails)"
  else bad "gate scope: CLAUDE.md or the skill is missing from the hygiene scope"; fi
  code="$(cat "$gate_out/targets-code.txt")"
  if [ "$(printf '%s\n' "$code" | sort | tr '\n' ' ')" = "custom/scripts/tool.mjs src/a.ts " ]; then ok "gate scope: lint, format and typecheck get only the JS/TS files (our .mjs scripts and product code), not CLAUDE.md, our skills or workflow YAML"
  else bad "gate scope: targets-code.txt is [$(printf '%s' "$code" | tr '\n' ' ')]"; fi
else
  bad "gate scope: run-gates.sh wrote no targets-all.txt"
fi

# base_sha unused here on purpose: customization_log takes any revision (the sync passes the base commit)
[ -n "$base_sha" ] || bad "fixture has no base"

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
