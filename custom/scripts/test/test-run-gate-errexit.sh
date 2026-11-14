#!/usr/bin/env bash
# Regression test: a gate must go red when ANY command inside it fails, not only when its last command fails.
# Run: bash custom/scripts/test/test-run-gate-errexit.sh      (needs git, jq; no pnpm, no network)
#
# The bug it pins: run_gate ran `( set -e; "$fn" ) > log || rc=$?`. Bash ignores `set -e` inside a command that is part
# of an `||` list, so a gate function's status was the status of its LAST command. gate_lint and gate_format end in
# `note`, which always succeeds, so they could never fail and every earlier PR passed them without being linted.
#
# Part 1 pulls the real run_gate / in_gate_shell / skip_gate / gate_lint / gate_format out of the script under test and
#        runs them with stub gate functions and a stub `pnpm`: (a) a failing middle command is red, (b) the old lint and
#        format shape (a failing xargs, then `note`) is red, (c) a skip (77) still skips, (d) a passing function passes.
# Part 2 runs the whole script (`--only lint,format`) in a scratch repository with a stub `pnpm` and reads gates.json.
#
# Prove the test bites: run it against the pre-fix script, it must FAIL there.
#   d="$(mktemp -d)"; cp -R custom/scripts/. "$d"/; git show fork/custom:custom/scripts/run-gates.sh > "$d/run-gates.sh"
#   RUN_GATES="$d/run-gates.sh" bash custom/scripts/test/test-run-gate-errexit.sh     # exits 1
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
RUN_GATES="${RUN_GATES:-$scripts/run-gates.sh}"
for tool in git jq; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
[ -f "$RUN_GATES" ] || { echo "no such script: $RUN_GATES"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# ---- part 1: the harness functions, taken from the script under test -----------------------------------------------
# extract NAME FILE: the top-level function NAME, as a one-liner or up to its closing brace at column 0
extract() {
  awk -v n="$1" '
    p == 0 && index($0, n "() {") == 1 { p = 1; print; if ($0 ~ /}[ \t]*$/) exit; next }
    p == 1 { print; if ($0 ~ /^}$/) exit }' "$2"
}

mkdir -p "$tmp/bin" "$tmp/h-out/logs"
cat > "$tmp/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
# Stub pnpm: `pnpm exec oxlint ...` exits $LINT_RC, `pnpm exec oxfmt ...` exits $FMT_RC; anything else succeeds.
case "$*" in
  *oxlint*) exit "${LINT_RC:-0}" ;;
  *oxfmt*) exit "${FMT_RC:-0}" ;;
esac
exit 0
STUB
chmod +x "$tmp/bin/pnpm"

{
  cat <<'STUBS'
set -euo pipefail
INSTALL_FAILED=0
CURRENT_GATE=""
selected() { return 0; }
needs_install() { return 1; }
note() { printf '%s\n' "$*" >> "$OUT/notes.txt"; }
log() { printf '%s\n' "$*" >&2; }
die() { printf '::error::%s\n' "$*" >&2; exit 1; }
record() { printf '%s %s\n' "$3" "$4" > "$RESULT_FILE"; } # id name status exit seconds
STUBS
  grep -x 'GATE_RC=0' "$RUN_GATES" || true # the pre-fix script has no such variable
  for n in skip_gate in_gate_shell errexit_canary check_errexit run_gate gate_lint gate_format; do
    extract "$n" "$RUN_GATES"
  done
  cat <<'GATES'
gate_mid_fail() { false; echo still-running; }
gate_last_fail() { echo hi; false; }
gate_pipe_fail() { false | cat; echo after-the-pipe; }
gate_pass() { true; }
gate_guarded() { false || true; echo ok; }
gate_skip() { skip_gate "nothing to do" || return $?; echo unreachable; }
gate_skip_last() { skip_gate "nothing to do"; }
# the shape gate_lint and gate_format had before the fix: the checker, then an always-successful note
gate_old_shape() { xargs -r -0 sh -c 'exit 1' < <(printf 'a\0'); note "1 files"; }
# a command that fails inside an `if` condition or on the left of `||` is a test, not a failure
gate_tests_only() { if grep -q zzz /dev/null; then echo found; fi; grep -q zzz /dev/null || echo none; }
# the harness as it was before the fix: gate_lint and gate_format must not depend on the harness's errexit handling
run_gate_old_shape() {
  local rc=0 status=pass
  ( set -euo pipefail; "$1" ) > /dev/null 2>&1 || rc=$?
  case "$rc" in 0) ;; 77) status=skip; rc=0 ;; *) status=fail ;; esac
  record t t "$status" "$rc" 0
}
if [ "${OLD_HARNESS:-0}" = 1 ]; then run_gate_old_shape "$1"
elif [ "${RUN_IN_OR:-0}" = 1 ]; then run_gate t "test gate" "$1" || true # the misuse the header of in_gate_shell warns about
else run_gate t "test gate" "$1"; fi
GATES
} > "$tmp/h.sh"
for n in run_gate gate_lint gate_format skip_gate; do
  grep -q "^$n() {" "$tmp/h.sh" || { echo "could not extract $n from $RUN_GATES"; exit 2; }
done

printf 'src/a.ts\n' > "$tmp/targets.txt"
: > "$tmp/targets-empty.txt"
outcome() { # GATE_FUNCTION [TARGETS_FILE] -> "status rc" recorded by run_gate
  rm -f "$tmp/res"
  env PATH="$tmp/bin:$PATH" OUT="$tmp/h-out" RESULT_FILE="$tmp/res" CODE_TARGETS="${2:-$tmp/targets.txt}" \
    LINT_RC="${LINT_RC:-0}" FMT_RC="${FMT_RC:-0}" OLD_HARNESS="${OLD_HARNESS:-0}" RUN_IN_OR="${RUN_IN_OR:-0}" bash "$tmp/h.sh" "$1" > /dev/null 2>&1 || true
  cat "$tmp/res" 2> /dev/null || echo "none"
}
expect() { # NAME GATE_FUNCTION WANT_STATUS [TARGETS_FILE]
  local got
  got="$(outcome "$2" "${4:-}")"
  if [ "${got%% *}" = "$3" ]; then ok "$1"; else bad "$1: want status $3, got [$got]"; fi
}

expect "(a) a failing middle command makes the gate fail" gate_mid_fail fail
expect "a failing last command makes the gate fail" gate_last_fail fail
expect "a failing stage inside a pipeline makes the gate fail" gate_pipe_fail fail
expect "(b) the old lint/format shape (failing xargs, then note) fails" gate_old_shape fail
LINT_RC=1 expect "(b) the real gate_lint fails when oxlint fails" gate_lint fail
FMT_RC=1 expect "(b) the real gate_format fails when oxfmt --check fails" gate_format fail
LINT_RC=1 OLD_HARNESS=1 expect "(b) the real gate_lint fails even under the pre-fix harness shape (no reliance on errexit)" gate_lint fail
FMT_RC=1 OLD_HARNESS=1 expect "(b) the real gate_format fails even under the pre-fix harness shape" gate_format fail
OLD_HARNESS=1 expect "control: the pre-fix harness shape hides a failing middle command" gate_mid_fail pass
# run_gate inside an `||` list loses errexit in the gate shell on some bash versions: the canary must stop the run (no record)
# or the gate must still fail; the one forbidden outcome is a pass
got="$(RUN_IN_OR=1 outcome gate_mid_fail)"
if [ "${got%% *}" != pass ]; then ok "run_gate called from an || list never reports a failing gate as pass (got: $got)"; else bad "run_gate in an || list passed a failing gate: [$got]"; fi
got="$(env PATH="$tmp/bin:$PATH" OUT="$tmp/h-out" RESULT_FILE="$tmp/res" CODE_TARGETS="$tmp/targets.txt" RUN_IN_OR=1 bash "$tmp/h.sh" gate_mid_fail 2>&1 >/dev/null || true)"
if [ "$(outcome gate_pass)" = "pass 0" ] && { grep -q 'set -e is not effective' <<<"$got" || [ "$(RUN_IN_OR=1 outcome gate_mid_fail | cut -d' ' -f1)" = fail ]; }; then ok "the errexit canary names the problem (or errexit survived the || list)"; else bad "canary message: [$got]"; fi
expect "the real gate_lint passes when oxlint passes" gate_lint pass
expect "the real gate_format passes when oxfmt passes" gate_format pass
LINT_RC=1 expect "the real gate_lint skips (not fails) with no JS/TS files in scope" gate_lint skip "$tmp/targets-empty.txt"
FMT_RC=1 expect "the real gate_format skips (not fails) with no JS/TS files in scope" gate_format skip "$tmp/targets-empty.txt"
expect "(c) skip_gate followed by return still skips" gate_skip skip
expect "(c) skip_gate as the last command still skips" gate_skip_last skip
expect "(d) a passing function passes" gate_pass pass
expect "a failure guarded by || true does not fail the gate" gate_guarded pass
expect "a failing test in an if condition or an || list does not fail the gate" gate_tests_only pass
got="$(outcome gate_skip)"
if [ "$got" = "skip 0" ]; then ok "a skip is recorded with exit code 0"; else bad "skip exit code: [$got]"; fi

# ---- part 2: the whole script, with a stub pnpm --------------------------------------------------------------------
repo="$tmp/repo"
mkdir -p "$repo/src/mine" "$repo/custom"
git -C "$repo" init -q
printf 'v1.0.0\n' > "$repo/custom/BASE"
printf 'export const a = 1\n' > "$repo/src/mine/a.ts"
printf '# notes\n' > "$repo/README.md"
git -C "$repo" add -A && git -C "$repo" commit -q -m init
printf 'src/mine/a.ts\n' > "$tmp/our-code.txt"
printf 'README.md\n' > "$tmp/our-docs.txt"

real_run() { # NAME OUR_FILES LINT_RC FMT_RC [EXTRA_ARG] -> sets r_lint r_fmt r_exit r_rc
  local out="$tmp/out-$1" rc=0
  rm -rf "$out"
  ( cd "$repo" && env PATH="$tmp/bin:$PATH" LINT_RC="$3" FMT_RC="$4" \
      bash "$RUN_GATES" --out "$out" --mode sync --our-files "$2" --only lint,format ${5:+"$5"} ) > "$tmp/real-$1.out" 2>&1 || rc=$?
  r_exit="$rc"
  r_lint="$(jq -r '.gates[] | select(.id == "lint") | .status' "$out/gates.json")"
  r_fmt="$(jq -r '.gates[] | select(.id == "format") | .status' "$out/gates.json")"
  r_rc="$(jq -r '.gates[] | select(.id == "lint") | .exit_code' "$out/gates.json")"
}

real_run lint-red "$tmp/our-code.txt" 1 0
if [ "$r_lint" = fail ] && [ "$r_fmt" = pass ] && [ "$r_exit" = 1 ] && [ "$r_rc" != 0 ]; then ok "script: oxlint fails -> lint gate FAIL, format passes, run exits 1, exit code recorded"
else bad "script lint-red: lint=$r_lint format=$r_fmt exit=$r_exit gate_rc=$r_rc"; fi

real_run format-red "$tmp/our-code.txt" 0 1
if [ "$r_lint" = pass ] && [ "$r_fmt" = fail ] && [ "$r_exit" = 1 ]; then ok "script: oxfmt --check fails -> format gate FAIL, lint passes, run exits 1"
else bad "script format-red: lint=$r_lint format=$r_fmt exit=$r_exit"; fi

real_run green "$tmp/our-code.txt" 0 0
if [ "$r_lint" = pass ] && [ "$r_fmt" = pass ] && [ "$r_exit" = 0 ]; then ok "script: both checkers pass -> both gates pass, run exits 0"
else bad "script green: lint=$r_lint format=$r_fmt exit=$r_exit"; fi

real_run docs-only "$tmp/our-docs.txt" 1 1
if [ "$r_lint" = skip ] && [ "$r_fmt" = skip ] && [ "$r_exit" = 0 ]; then ok "script: no JS/TS files in scope -> both gates skip, run exits 0"
else bad "script docs-only: lint=$r_lint format=$r_fmt exit=$r_exit"; fi

real_run exit-zero "$tmp/our-code.txt" 1 0 --exit-zero
if [ "$r_lint" = fail ] && [ "$r_exit" = 0 ]; then ok "script: --exit-zero still records the failure and exits 0"
else bad "script exit-zero: lint=$r_lint exit=$r_exit"; fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
