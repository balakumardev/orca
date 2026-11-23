#!/usr/bin/env bash
# Test for the unit-gate baseline (custom/scripts/unit-baseline.sh and gate_unit in run-gates.sh).
# Run: bash custom/scripts/test/test-unit-gate-baseline.sh      (needs git, jq, perl; no vitest, no pnpm, no network)
#
# Part 1 feeds unit_baseline_decide the REAL log of the red unit gate of the v1.4.269 sync (fixtures/unit-baseline-real.txt: an upstream
# test of the URL parser that the runner's Node release fails, 1 failed test of 4434) and synthetic variants of it.
# Part 2 runs the real run-gates.sh (`--only unit`) in a scratch git repository that has an upstream release tag, with a stub `pnpm`: the
# stub replays the log of the first run, and for the run on the pristine release (a git worktree of the tag) it writes a vitest json report
# from $UP_FAILED. That proves the wiring: the gate passes only when every failed test is outside our scope and fails the same way on the
# pristine release; everything else stays red; the worktree is gone afterwards.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
real="$here/fixtures/unit-baseline-real.txt"
combined="$here/fixtures/unit-failed-plus-unhandled-real.txt"
ORIGIN="src/shared/git/branches/git-branch-cleanup-real-git.test.ts"
for tool in git jq perl; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY

# shellcheck source=../lib.sh
. "$scripts/lib.sh"
# shellcheck source=../unit-baseline.sh
. "$scripts/unit-baseline.sh"

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

FILE='src/shared/bots/bot-mcp-apps.test.ts'
NAME='botMcpAppHost refuses userinfo, other schemes, bad IDNA, bad ports and non-hosts'
: > "$tmp/scope-empty.txt"
printf 'src/mine/mine.test.ts\n' > "$tmp/scope-ours.txt"

# decide NAME LOG WANT [SCOPE_FILE...]: WANT is "check" (then the one failed test of the real log) or "keep-red: <reason substring>"
decide() {
  local name="$1" log="$2" want="$3" out; shift 3
  out="$(unit_baseline_decide "$log" "$@")"
  case "$want" in
    check) if [ "$out" = "$(printf 'check\n%s\t%s' "$FILE" "$NAME")" ]; then ok "$name"; else bad "$name: got [$out]"; fi ;;
    check\ *) if [ "$out" = "$(printf 'check\n%s' "${want#check }")" ]; then ok "$name"; else bad "$name: got [$out], want [$want]"; fi ;;
    *) if [[ "$out" == "keep-red: "*"${want#keep-red: }"* ]]; then ok "$name"; else bad "$name: got [$out], want [$want]"; fi ;;
  esac
}

# ---- part 1: the decision ------------------------------------------------------------------------------------------
decide "the real log, the file is not ours: check that one test on upstream" "$real" check "$tmp/scope-empty.txt" "$tmp/scope-ours.txt"
decide "no scope file at all is the same" "$real" check

printf '%s\n' "$FILE" > "$tmp/scope-has.txt"
decide "the failing file is one of ours: red" "$real" "keep-red: $FILE is in the scope" "$tmp/scope-has.txt"
decide "listed only in the second scope file: red" "$real" "keep-red: $FILE is in the scope" "$tmp/scope-ours.txt" "$tmp/scope-has.txt"

sed -E 's/^ FAIL   node-shared  / FAIL  /' "$real" > "$tmp/no-project.txt"
decide "a FAIL line without a project name is read too" "$tmp/no-project.txt" check

sed -E 's/^( +Tests +)1 failed/\12 failed/' "$real" > "$tmp/count-summary.txt"
decide "the summary says 2 failed tests, the section 1: red" "$tmp/count-summary.txt" "keep-red: the Failed Tests section says 1 but the summary says 2"
sed -E 's/^( Test Files +)1 failed/\13 failed/' "$real" > "$tmp/count-files.txt"
decide "the summary says 3 failed files, one was read: red" "$tmp/count-files.txt" "keep-red: 1 failing file(s) read, the summary says 3"
grep -v -E '^ +Tests +' "$real" > "$tmp/no-tests-line.txt"
decide "no Tests line: red" "$tmp/no-tests-line.txt" "keep-red: the log has no Test Files / Tests summary"
grep -v -E 'Failed Tests' "$real" > "$tmp/no-section.txt"
decide "no Failed Tests section: red" "$tmp/no-section.txt" "keep-red: the log has no Failed Tests section"
{ cat "$real"; printf ' Unhandled Errors \n Vitest caught 1 unhandled error during the test run.\n'; } > "$tmp/unhandled.txt"
decide "an unhandled error next to the failure is not judged here (the flake re-run does that): check" "$tmp/unhandled.txt" check
{ cat "$real"; printf ' Failed Suites 1\n'; } > "$tmp/suites.txt"
decide "a failed suite: red" "$tmp/suites.txt" "keep-red: the log has failed suites or type errors"
sed -E 's#src/shared/bots/bot-mcp-apps.test.ts > .*#src/shared/bots/bot-mcp-apps.test.ts [ src/shared/bots/bot-mcp-apps.test.ts ]#' "$real" > "$tmp/suite-shape.txt"
decide "a FAIL line of another shape (a suite that did not load): red" "$tmp/suite-shape.txt" "keep-red: a FAIL line has a shape this check does not read"
sed -E 's#src/shared/bots/bot-mcp-apps.test.ts#tests/e2e/some.test.ts#' "$real" > "$tmp/e2e.txt"
decide "an e2e path is never checked this way: red" "$tmp/e2e.txt" "keep-red: tests/e2e/some.test.ts is an e2e spec"
sed -E 's#src/shared/bots/bot-mcp-apps.test.ts#src/shared/../../etc/x.test.ts#' "$real" > "$tmp/dotdot.txt"
decide "a path with .. is refused: red" "$tmp/dotdot.txt" "keep-red: a failing path is not a plain repo path"
sed -E 's#refuses userinfo,#refuses\tuserinfo,#' "$real" > "$tmp/tab.txt"
decide "a test name with a tab is refused: red" "$tmp/tab.txt" "keep-red: a test name holds a tab or control character"
: > "$tmp/empty.txt"
decide "an empty log: red" "$tmp/empty.txt" "keep-red: the log has no Test Files / Tests summary"

# two failed tests in two files (one in a describe chain, one at top level)
perl -0pe 's/ Test Files  1 failed/ Test Files  2 failed/; s/ Tests  1 failed/ Tests  2 failed/; s/Failed Tests 1/Failed Tests 2/; s/(\n FAIL   node-shared  src\/shared\/bots\/bot-mcp-apps.test.ts > [^\n]*\n)/$1AssertionError: x\n\n FAIL   node-shared  src\/shared\/other\/thing.test.ts > top level test\n/' "$real" > "$tmp/two.txt"
decide "the real log with a failed test AND an EPIPE unhandled error (run 45004282909): check the failed test" "$combined" check
decide "two failed tests in two files are both listed" "$tmp/two.txt" "check $(printf '%s\t%s\n%s\t%s' "$FILE" "$NAME" 'src/shared/other/thing.test.ts' 'top level test')"

# ---- part 2: the gate itself, with a stub pnpm --------------------------------------------------------------------
repo="$tmp/repo"
mkdir -p "$repo/src/mine" "$repo/src/shared/git/branches" "$repo/bin" "$repo/custom"
git -C "$repo" init -q
printf 'v1.0.0\n' > "$repo/custom/BASE"
: > "$repo/src/upstream-only.txt"
: > "$repo/$ORIGIN"
git -C "$repo" add -A && git -C "$repo" commit -q -m "upstream release"
git -C "$repo" tag v1.0.0
: > "$repo/src/mine/mine.test.ts"
git -C "$repo" add -A && git -C "$repo" commit -q -m "our customization"
printf 'src/mine/mine.test.ts\n' > "$tmp/our-files.txt"

cat > "$repo/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
# Stub. `install` is logged with its directory. A vitest call with --reporter=json is the run on the pristine release: it writes a json
# report whose failed tests come from $UP_FAILED (lines "<file><TAB><name>"). Any other vitest call is the first run: it replays $FIRST_LOG.
echo "$* [in $PWD]" >> "$STUB_CALLS"
[ "$1" != install ] || exit "${INSTALL_RC:-0}"
if [[ " $* " == *" --reporter=json "* ]]; then
  out=""
  for a in "$@"; do case "$a" in --outputFile=*) out="${a#--outputFile=}" ;; esac; done
  [ "${UP_NO_JSON:-}" != 1 ] || exit 2
  jq -n --arg root "$PWD" --arg spec "${UP_FAILED:-}" \
    '{numTotalTests: 5, testResults: [($spec | split("\n") | map(select(length > 0) | split("\t")) | group_by(.[0])[] | {name: ($root + "/" + .[0][0]), assertionResults: map({fullName: .[1], status: "failed"})})]}' > "$out"
  [ -z "${UP_FAILED:-}" ] || exit 1
  exit 0
fi
for a in "$@"; do case "$a" in *.test.ts) echo "[stub] re-run of $a"; exit "${RERUN_RC:-0}" ;; esac; done
cat "$FIRST_LOG"
exit "${FIRST_RC:-1}"
STUB
chmod +x "$repo/bin/pnpm"

UP_SAME="$(printf '%s\t%s' "$FILE" "$NAME")"
run_gate() { # NAME FIRST_LOG [MODE] [OUR_FILES] [CHANGED_BASE] -> g_status g_calls g_note g_warn g_log (env UP_FAILED, UP_NO_JSON, INSTALL_RC pass through)
  local name="$1" out="$tmp/out-$1" mode="${3:-sync}" ours="${4:-$tmp/our-files.txt}" cbase="${5:-v1.0.0}"
  rm -rf "$out"; : > "$tmp/calls.txt"
  ( cd "$repo" && env PATH="$repo/bin:$PATH" STUB_CALLS="$tmp/calls.txt" FIRST_LOG="$2" FIRST_RC=1 \
      UP_FAILED="${UP_FAILED:-}" UP_NO_JSON="${UP_NO_JSON:-}" INSTALL_RC="${INSTALL_RC:-0}" RERUN_RC="${RERUN_RC:-0}" \
      bash "$scripts/run-gates.sh" --out "$out" --mode "$mode" --changed-base "$cbase" --our-files "$ours" --only unit ) > "$tmp/gate-$name.out" 2>&1 || true
  g_status="$(jq -r '.gates[] | select(.id == "unit") | .status' "$out/gates.json")"
  g_calls="$(wc -l < "$tmp/calls.txt" | tr -d ' ')"
  g_note="$(jq -r '.gates[] | select(.id == "unit") | .note' "$out/gates.json")"
  g_warn="$(jq -r '.gates[] | select(.id == "unit") | .warnings | join(" / ")' "$out/gates.json")"
  g_log="$out/logs/unit.log"
}
worktrees() { git -C "$repo" worktree list | wc -l | tr -d ' '; }

UP_FAILED="$UP_SAME" run_gate same "$real"
if [ "$g_status" = pass ] && grep -q "also fail on pristine upstream v1.0.0" <<<"$g_note" && grep -q "$FILE" <<<"$g_warn" && grep -q 'not counted\|Not counted' <<<"$g_warn"; then
  ok "gate: the same test fails on the pristine release = pass, with the test named in the note and the warning"
else bad "gate same: status=$g_status note=[$g_note] warn=[$g_warn]"; fi
if grep -q -E '^install --frozen-lockfile \[in .*/tree\]$' "$tmp/calls.txt" && grep -q -- "--reporter=json" "$tmp/calls.txt" && grep -q -- "$FILE" <<<"$(grep -- '--reporter=json' "$tmp/calls.txt")"; then
  ok "gate: dependencies are installed in the worktree of the release, and only the failed test file is run there"
else bad "gate calls: $(cat "$tmp/calls.txt")"; fi
if [ "$(worktrees)" = 1 ]; then ok "gate: the worktree of the release is gone afterwards"; else bad "worktrees left: $(git -C "$repo" worktree list)"; fi
if grep -q 'unit baseline: every one of them fails on upstream v1.0.0 as well' "$g_log"; then ok "gate: the decision is printed in the gate log"; else bad "gate log: $(grep 'unit baseline' "$g_log" || echo none)"; fi

UP_FAILED="" run_gate passes-upstream "$real"
if [ "$g_status" = fail ] && grep -q 'pass on upstream v1.0.0, so this change broke them' "$g_log"; then ok "gate: the test passes on the pristine release = this change broke it = red"; else bad "gate passes-upstream: status=$g_status"; fi

UP_FAILED="$(printf '%s\t%s' "$FILE" 'another test name')" run_gate other-name "$real"
if [ "$g_status" = fail ]; then ok "gate: upstream fails a different test of that file = red"; else bad "gate other-name: status=$g_status"; fi

UP_NO_JSON=1 UP_FAILED="$UP_SAME" run_gate no-json "$real"
if [ "$g_status" = fail ] && grep -q 'produced no usable result' "$g_log"; then ok "gate: the run on the release left no report = red"; else bad "gate no-json: status=$g_status"; fi
if [ "$(worktrees)" = 1 ]; then ok "gate: and the worktree is still removed"; else bad "worktrees left after a failed run"; fi

INSTALL_RC=1 UP_FAILED="$UP_SAME" run_gate install-fails "$real"
if [ "$g_status" = fail ]; then ok "gate: the install on the release fails = red"; else bad "gate install-fails: status=$g_status"; fi

printf 'src/mine/mine.test.ts\n%s\n' "$FILE" > "$tmp/our-files-incl.txt"
mkdir -p "$repo/$(dirname "$FILE")"; : > "$repo/$FILE" # the gate's scope holds only files that exist in the checkout
UP_FAILED="$UP_SAME" run_gate ours "$real" sync "$tmp/our-files-incl.txt"
rm -f "$repo/$FILE"
if [ "$g_status" = fail ] && [ "$g_calls" = 1 ]; then ok "gate: the failing file is one of ours = red, the release is not even run"; else bad "gate ours: status=$g_status calls=$g_calls"; fi

# An ordinary pull request is measured against the release its BASE COMMIT is built on (custom/BASE read from that commit).
UP_FAILED="$UP_SAME" run_gate pr "$real" pr
if [ "$g_status" = pass ] && grep -q "also fail on pristine upstream v1.0.0" <<<"$g_note" && grep -q "$FILE" <<<"$g_warn" && grep -q 'the runner, not this change' <<<"$g_warn"; then
  ok "gate: an ordinary pull request whose failed test fails on the pristine release too = pass, the warning names the test"
else bad "gate pr: status=$g_status note=[$g_note] warn=[$g_warn]"; fi
if grep -q -E '^install --frozen-lockfile \[in .*/tree\]$' "$tmp/calls.txt" && [ "$(worktrees)" = 1 ]; then ok "gate: pull request: the release is installed in a worktree that is removed afterwards"; else bad "gate pr calls: $(cat "$tmp/calls.txt")"; fi

UP_FAILED="" run_gate pr-passes-upstream "$real" pr
if [ "$g_status" = fail ] && grep -q 'pass on upstream v1.0.0, so this change broke them' "$g_log"; then ok "gate: pull request: the test passes on the pristine release = this change broke it = red"; else bad "gate pr-passes-upstream: status=$g_status"; fi

printf 'v0.0.1\n' > "$repo/custom/BASE"
UP_FAILED="$UP_SAME" run_gate pr-tree-base "$real" pr
if [ "$g_status" = pass ] && grep -q "pristine upstream v1.0.0" <<<"$g_note"; then ok "gate: pull request: the release comes from the base commit, a changed custom/BASE in the checkout is ignored"; else bad "gate pr-tree-base: status=$g_status note=[$g_note]"; fi
printf 'v1.0.0\n' > "$repo/custom/BASE"

empty_tree="$(git -C "$repo" hash-object -t tree /dev/null)"
git -C "$repo" tag nobase "$(git -C "$repo" commit-tree -m 'base without custom/BASE' "$empty_tree")"
UP_FAILED="$UP_SAME" run_gate pr-no-base "$real" pr "$tmp/our-files.txt" nobase
if [ "$g_status" = fail ] && grep -q 'custom/BASE is not a release tag' "$g_log"; then ok "gate: pull request: a base commit without a readable custom/BASE = red"; else bad "gate pr-no-base: status=$g_status"; fi

printf 'not-a-tag\n' > "$repo/custom/BASE"
UP_FAILED="$UP_SAME" run_gate bad-base "$real"
if [ "$g_status" = fail ] && grep -q 'custom/BASE is not a release tag' "$g_log"; then ok "gate: a custom/BASE that is no release tag = red"; else bad "gate bad-base: status=$g_status"; fi
printf 'v1.0.0\n' > "$repo/custom/BASE"

# A failed upstream test AND an unhandled error of an unrelated flaky file in the same run (run 45004282909): each part is checked on its own.
UP_FAILED="$UP_SAME" RERUN_RC=0 run_gate combo "$combined"
if [ "$g_status" = pass ] && [ "$g_calls" = 4 ] && grep -q "also fail on pristine upstream v1.0.0" <<<"$g_note" && grep -q 'did not reproduce' <<<"$g_note"; then
  ok "gate: failed upstream test + unhandled error: both covered (baseline, then one re-run of the flaky file) = pass"
else bad "gate combo: status=$g_status calls=$g_calls note=[$g_note]"; fi
if grep -q -- "$ORIGIN" <<<"$(sed -n '4p' "$tmp/calls.txt")" && ! grep -q -- "$FILE" <<<"$(sed -n '4p' "$tmp/calls.txt")"; then ok "gate: the re-run names only the flaky file, not the failed upstream test"; else bad "combo re-run call: $(sed -n '4p' "$tmp/calls.txt")"; fi

UP_FAILED="$UP_SAME" RERUN_RC=1 run_gate combo-rerun-fails "$combined"
if [ "$g_status" = fail ] && [ "$g_calls" = 4 ]; then ok "gate: the flaky file fails again on its re-run = red"; else bad "gate combo-rerun-fails: status=$g_status calls=$g_calls"; fi

UP_FAILED="" RERUN_RC=0 run_gate combo-passes-upstream "$combined"
if [ "$g_status" = fail ] && [ "$g_calls" = 3 ]; then ok "gate: the failed test passes on upstream = red, and the flaky file is not re-run"; else bad "gate combo-passes-upstream: status=$g_status calls=$g_calls"; fi

printf 'src/mine/mine.test.ts\n%s\n' "$ORIGIN" > "$tmp/our-files-origin.txt"
UP_FAILED="$UP_SAME" RERUN_RC=0 run_gate combo-origin-ours "$combined" sync "$tmp/our-files-origin.txt"
if [ "$g_status" = fail ] && [ "$g_calls" = 3 ]; then ok "gate: the unhandled error comes from a file of ours = red even when the failed test is covered"; else bad "gate combo-origin-ours: status=$g_status calls=$g_calls"; fi

printf '%s\n' ' Test Files  1 passed (1)' '      Tests  3 passed (3)' > "$tmp/green.txt"
run_gate green "$tmp/green.txt"
if [ "$g_status" = fail ]; then ok "gate: a first run that exits red with a green log never passes by the baseline"; else bad "gate green log: status=$g_status"; fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
