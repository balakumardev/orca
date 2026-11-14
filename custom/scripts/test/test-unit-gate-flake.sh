#!/usr/bin/env bash
# Test for the unit-gate flake rule (custom/scripts/unit-flake.sh and gate_unit in run-gates.sh).
# Run: bash custom/scripts/test/test-unit-gate-flake.sh      (needs git, jq, perl; no vitest, no pnpm, no network)
#
# Part 1 feeds unit_flake_decide the REAL log of a red unit gate (fixtures/unit-flake-real.txt: 5010 tests passed, 2
# "Unhandled Errors" from one test file, vitest exit 1) and synthetic variants of it, and asserts the decision.
# Part 2 runs the real run-gates.sh (`--only unit`) in a scratch repository with a stub `pnpm` that replays a log and
# exit codes, to prove the wiring: a flaky unhandled error gets exactly one re-run, everything else stays red.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
real="$here/fixtures/unit-flake-real.txt"
for tool in git jq perl; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY

# shellcheck source=../lib.sh
. "$scripts/lib.sh"
# shellcheck source=../unit-flake.sh
. "$scripts/unit-flake.sh"

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

ORIGIN='src/shared/git/branches/git-branch-cleanup-real-git.test.ts'
strip_ansi < "$real" > "$tmp/plain.txt"
: > "$tmp/scope-empty.txt"
printf 'src/renderer/src/components/sidebar/sidebar-stacked-layout-math.test.ts\nsrc/main/updater/updater.custom-build.test.ts\n' > "$tmp/scope-ours.txt"

# decide NAME LOG WANT [SCOPE_FILE...]: WANT is "rerun FILE..." or "keep-red: <reason substring>"
decide() {
  local name="$1" log="$2" want="$3" out; shift 3
  out="$(unit_flake_decide "$log" "$@")"
  case "$want" in
    rerun*)
      if [ "$out" = "$(printf 'rerun\n%s' "${want#rerun }")" ]; then ok "$name"; else bad "$name: got [$out], want [$want]"; fi ;;
    *)
      if [[ "$out" == "keep-red: "*"${want#keep-red: }"* ]]; then ok "$name"; else bad "$name: got [$out], want [$want]"; fi ;;
  esac
}

# ---- part 1: the parsing decision --------------------------------------------------------------------------------
decide "real log (with colour codes), origin outside the scope: one re-run of that one file" "$real" "rerun $ORIGIN" "$tmp/scope-empty.txt" "$tmp/scope-ours.txt"
decide "no scope file at all still re-runs a clean flake" "$real" "rerun $ORIGIN"

printf '%s\n' "$ORIGIN" > "$tmp/scope-pr.txt"
decide "origin listed in the first scope file stays red" "$real" "keep-red: $ORIGIN is in the scope" "$tmp/scope-pr.txt" "$tmp/scope-ours.txt"
decide "origin listed only in the second scope file stays red" "$real" "keep-red: $ORIGIN is in the scope" "$tmp/scope-ours.txt" "$tmp/scope-pr.txt"

sed -E 's/^( Test Files +)977 passed/\1976 passed | 1 failed/' "$tmp/plain.txt" > "$tmp/failed-file.txt"
decide "a failed test file stays red" "$tmp/failed-file.txt" "keep-red: the summary reports failures" "$tmp/scope-ours.txt"
sed -E 's/^( +Tests +)5010 passed/\15009 passed | 1 failed/' "$tmp/plain.txt" > "$tmp/failed-test.txt"
decide "a failed test stays red" "$tmp/failed-test.txt" "keep-red: the summary reports failures" "$tmp/scope-ours.txt"
sed -E 's/^( +Tests +)5010 passed/\13 failed | 5007 passed/' "$tmp/plain.txt" > "$tmp/failed-many.txt"
decide "three failed tests stay red" "$tmp/failed-many.txt" "keep-red: the summary reports failures" "$tmp/scope-ours.txt"

# zero unhandled errors: the section and its summary line are gone (a plain failure of some other kind)
awk '/Unhandled Errors/ {skip = 1} skip && /Test Files/ {skip = 0} !skip {print}' "$tmp/plain.txt" | grep -v '^ *Errors ' > "$tmp/no-section.txt"
decide "no Unhandled Errors section stays red" "$tmp/no-section.txt" "keep-red: no Unhandled Errors section" "$tmp/scope-ours.txt"

sed -E 's/Vitest caught 2 unhandled errors/Vitest caught 3 unhandled errors/' "$tmp/plain.txt" > "$tmp/count-mismatch.txt"
decide "an error without a named test file stays red" "$tmp/count-mismatch.txt" "keep-red: 3 unhandled error(s) but 2 originating" "$tmp/scope-ours.txt"

grep -v '^This error originated in' "$tmp/plain.txt" > "$tmp/no-origin.txt"
decide "no originating file named stays red" "$tmp/no-origin.txt" "keep-red: 2 unhandled error(s) but 0 originating" "$tmp/scope-ours.txt"

sed -E 's#"src/shared/git/branches/git-branch-cleanup-real-git.test.ts" test file#"src/shared/git/branches/git-branch-cleanup.ts" test file#' "$tmp/plain.txt" > "$tmp/not-test.txt"
decide "an origin that is not a test file stays red" "$tmp/not-test.txt" "keep-red: src/shared/git/branches/git-branch-cleanup.ts is not a unit test file" "$tmp/scope-ours.txt"

sed -E 's#"src/shared/git/branches/git-branch-cleanup-real-git.test.ts" test file#"tests/e2e/some.spec.ts" test file#' "$tmp/plain.txt" > "$tmp/e2e-origin.txt"
decide "an origin under tests/e2e stays red" "$tmp/e2e-origin.txt" "keep-red: tests/e2e/some.spec.ts is not a unit test file" "$tmp/scope-ours.txt"

sed -E 's#"src/shared/git/branches/git-branch-cleanup-real-git.test.ts" test file#"../outside.test.ts" test file#' "$tmp/plain.txt" > "$tmp/dotdot.txt"
decide "an origin path with .. stays red" "$tmp/dotdot.txt" "keep-red: an originating path is not a plain repo path" "$tmp/scope-ours.txt"
sed -E 's#"src/shared/git/branches/git-branch-cleanup-real-git.test.ts" test file#"-x.test.ts" test file#' "$tmp/plain.txt" > "$tmp/dash.txt"
decide "an origin path that looks like an option stays red" "$tmp/dash.txt" "keep-red: an originating path is not a plain repo path" "$tmp/scope-ours.txt"

awk '/Test Files/ {exit} {print}' "$tmp/plain.txt" > "$tmp/no-summary.txt"
decide "a log with no summary (timeout, crash) stays red" "$tmp/no-summary.txt" "keep-red: the log has no Test Files / Tests summary" "$tmp/scope-ours.txt"

{ grep -E '^ +(Test Files|Tests) ' "$tmp/plain.txt"; cat "$tmp/no-summary.txt"; } > "$tmp/summary-first.txt"
decide "a summary printed before the error section stays red" "$tmp/summary-first.txt" "keep-red: " "$tmp/scope-ours.txt"

{ cat "$tmp/plain.txt"; printf '  Type Errors  1 error\n'; } > "$tmp/type-errors.txt"
decide "type errors stay red" "$tmp/type-errors.txt" "keep-red: " "$tmp/scope-ours.txt"

sed -E 's/^( Test Files +)977 passed \| 19 skipped/\1 19 skipped/' "$tmp/plain.txt" > "$tmp/nothing-passed.txt"
decide "a summary with no passed files stays red" "$tmp/nothing-passed.txt" "keep-red: the summary reports no passed work" "$tmp/scope-ours.txt"

# two different originating files: both are re-run, each once
awk '!done && /git-branch-cleanup-real-git.test.ts" test file/ { sub(/git-branch-cleanup-real-git.test.ts" test file/, "other-flaky.test.ts\" test file"); done = 1 } { print }' "$tmp/plain.txt" > "$tmp/two-files.txt"
decide "two originating files are both re-run" "$tmp/two-files.txt" "rerun $(printf '%s\n%s' "$ORIGIN" 'src/shared/git/branches/other-flaky.test.ts')" "$tmp/scope-ours.txt"

# ---- part 2: the gate itself, with a stub pnpm ---------------------------------------------------------------------
repo="$tmp/repo"
mkdir -p "$repo/src/mine" "$repo/src/shared/git/branches" "$repo/bin" "$repo/custom"
git -C "$repo" init -q
printf 'v1.0.0\n' > "$repo/custom/BASE"
: > "$repo/src/mine/mine.test.ts"
: > "$repo/$ORIGIN"
git -C "$repo" add -A && git -C "$repo" commit -q -m init
printf 'src/mine/mine.test.ts\n' > "$tmp/our-files.txt"

cat > "$repo/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
# Stub: the first vitest call (directories) replays $FIRST_LOG and exits $FIRST_RC; a call that names a test file is the
# re-run and exits $RERUN_RC.
echo "$*" >> "$STUB_CALLS"
for a in "$@"; do
  case "$a" in *.test.ts) echo "[stub] re-run of $a"; exit "${RERUN_RC:-0}" ;; esac
done
cat "$FIRST_LOG"
exit "${FIRST_RC:-1}"
STUB
chmod +x "$repo/bin/pnpm"

run_gate() { # NAME FIRST_LOG FIRST_RC RERUN_RC -> sets g_status g_calls g_note g_warn
  local name="$1" out="$tmp/out-$1"
  rm -rf "$out"; : > "$tmp/calls.txt"
  ( cd "$repo" && env PATH="$repo/bin:$PATH" STUB_CALLS="$tmp/calls.txt" FIRST_LOG="$2" FIRST_RC="$3" RERUN_RC="$4" \
      bash "$scripts/run-gates.sh" --out "$out" --mode sync --our-files "$tmp/our-files.txt" --only unit ) > "$tmp/gate-$name.out" 2>&1 || true
  g_status="$(jq -r '.gates[] | select(.id == "unit") | .status' "$out/gates.json")"
  g_calls="$(wc -l < "$tmp/calls.txt" | tr -d ' ')"
  g_note="$(jq -r '.gates[] | select(.id == "unit") | .note' "$out/gates.json")"
  g_warn="$(jq -r '.gates[] | select(.id == "unit") | .warnings | join(" / ")' "$out/gates.json")"
  g_log="$out/logs/unit.log"
}

run_gate flake "$real" 1 0
if [ "$g_status" = pass ] && [ "$g_calls" = 2 ] && grep -q 'did not reproduce' <<<"$g_note" && grep -q "$ORIGIN" <<<"$g_warn" && grep -q 'did not reproduce' <<<"$g_warn"; then
  ok "gate: flaky unhandled error + passing re-run = pass, one re-run, file named in the note and the warning"
else bad "gate flake case: status=$g_status calls=$g_calls note=[$g_note] warn=[$g_warn]"; fi
if grep -q -- "$ORIGIN" "$tmp/calls.txt" && ! grep -q 'src/mine' <<<"$(sed -n '2p' "$tmp/calls.txt")"; then ok "gate: the re-run names only the originating file"; else bad "gate re-run arguments: $(cat "$tmp/calls.txt")"; fi
if grep -q 'unit flake check' "$g_log"; then ok "gate: the decision is printed in the gate log"; else bad "gate log lacks the decision line"; fi

run_gate rerun-fails "$real" 1 1
if [ "$g_status" = fail ] && [ "$g_calls" = 2 ]; then ok "gate: the re-run fails again = red"; else bad "gate rerun-fails: status=$g_status calls=$g_calls"; fi

run_gate real-failure "$tmp/failed-test.txt" 1 0
if [ "$g_status" = fail ] && [ "$g_calls" = 1 ]; then ok "gate: a real failed test = red, no re-run"; else bad "gate real-failure: status=$g_status calls=$g_calls"; fi

run_gate timeout "$real" 124 0
if [ "$g_status" = fail ] && [ "$g_calls" = 1 ]; then ok "gate: exit 124 (timeout) = red, no re-run"; else bad "gate timeout: status=$g_status calls=$g_calls"; fi

printf 'src/mine/mine.test.ts\n%s\n' "$ORIGIN" > "$tmp/our-files-incl.txt"
( cd "$repo" && out="$tmp/out-inscope" && rm -rf "$out" && : > "$tmp/calls.txt" \
  && env PATH="$repo/bin:$PATH" STUB_CALLS="$tmp/calls.txt" FIRST_LOG="$real" FIRST_RC=1 RERUN_RC=0 \
     bash "$scripts/run-gates.sh" --out "$out" --mode sync --our-files "$tmp/our-files-incl.txt" --only unit ) > "$tmp/gate-inscope.out" 2>&1 || true
if [ "$(jq -r '.gates[] | select(.id == "unit") | .status' "$tmp/out-inscope/gates.json")" = fail ] && [ "$(wc -l < "$tmp/calls.txt" | tr -d ' ')" = 1 ]; then
  ok "gate: the originating file is one of ours = red, no re-run"
else bad "gate in-scope case"; fi

run_gate green /dev/null 0 0
if [ "$g_status" = pass ] && [ "$g_calls" = 1 ] && [ -z "$g_warn" ]; then ok "gate: a green run is untouched (no re-run, no warning)"; else bad "gate green: status=$g_status calls=$g_calls warn=[$g_warn]"; fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
