#!/usr/bin/env bash
# Sourced by run-gates.sh and by custom/scripts/test/test-unit-gate-baseline.sh; never run it.
#
# Why: the unit gate runs every test under the directories of our own test files, so upstream tests that have nothing to do with our
# customizations run too. When one of them fails because of the environment (the runner's Node release parses a URL differently than the
# one upstream last ran on) it fails on the pristine upstream release as well, and every sync went red for a reason no merge decision
# can fix: the model was asked to repair it, and a model that "fixes" an upstream test or source file is exactly what a hands-off sync must
# not land. The rule below keeps every failure that is ours or that this merge caused red, and passes the gate only when each failed test
# is outside our scope AND fails the same way on the untouched upstream release the sync merges, measured now, in this environment.
#
# unit_baseline_decide LOG SCOPE_FILE...
#   LOG         the full output of the failed `vitest run` (ANSI colour codes are stripped here)
#   SCOPE_FILE  newline lists of repo-relative paths that belong to this change (run-gates.sh passes $TEST_SCOPE and $ALL_TARGETS)
# stdout: first line `check`, then one `<test file><TAB><test name>` per failed test (the name is the describe chain and the test title
# joined by single spaces, as vitest's json reporter spells fullName), or one line `keep-red: <reason>`. Always returns 0.
#
# `check` only when ALL of these hold; any doubt keeps the gate red:
#   a. the last summary reports failed tests and failed test files, and the log has no Unhandled Errors, Failed Suites or Type Errors;
#   b. the `Failed Tests N` section holds exactly N ` FAIL ` lines, N equals the failed-tests count of the summary, every line has the
#      shape `FAIL [project] <file> > <name>`, and the distinct files are as many as the summary's failed test files;
#   c. every file is a plain repo path with a unit-test suffix outside tests/e2e, and none is listed in a SCOPE_FILE.

unit_baseline_decide() {
  local log="$1"; shift
  local LC_ALL=C
  local txt reason="" tf ts n_fail_tests n_fail_files sec n_sec line f name sf
  local -a rows=() files=()
  txt="$(mktemp)"
  strip_ansi < "$log" > "$txt"

  tf="$(grep -E '^[[:space:]]*Test Files[[:space:]]' "$txt" | tail -n 1 || true)"
  ts="$(grep -E '^[[:space:]]*Tests[[:space:]]' "$txt" | tail -n 1 || true)"
  n_fail_files="$(sed -n -E 's/^[[:space:]]*Test Files[[:space:]]+([0-9]+) failed.*/\1/p' <<<"$tf")"
  n_fail_tests="$(sed -n -E 's/^[[:space:]]*Tests[[:space:]]+([0-9]+) failed.*/\1/p' <<<"$ts")"
  if [ -z "$tf" ] || [ -z "$ts" ]; then reason="the log has no Test Files / Tests summary (the run did not finish)"
  elif [ -z "$n_fail_tests" ] || [ -z "$n_fail_files" ]; then reason="the summary reports no failed tests"
  elif grep -q -E 'Unhandled Errors|Failed Suites|^[[:space:]]*Type Errors[[:space:]]+[0-9]+' "$txt"; then reason="the log has unhandled errors, failed suites or type errors"
  fi

  if [ -z "$reason" ]; then
    sec="$(grep -n -E 'Failed Tests[[:space:]]+[0-9]+' "$txt" | tail -n 1 || true)"
    n_sec="$(sed -n -E 's/.*Failed Tests[[:space:]]+([0-9]+).*/\1/p' <<<"$sec")"
    if [ -z "$sec" ] || [ -z "$n_sec" ]; then reason="the log has no Failed Tests section"
    elif [ "$n_sec" != "$n_fail_tests" ]; then reason="the Failed Tests section says $n_sec but the summary says $n_fail_tests"
    fi
  fi

  if [ -z "$reason" ]; then
    # Only the lines after the section header count: test output earlier in the log cannot name a failure.
    while IFS= read -r line; do
      [[ "$line" == " FAIL "* ]] || continue
      if [[ "$line" =~ ^\ FAIL\ +(.+\ +)?([^\ ]+\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs))\ \>\ (.+)$ ]]; then
        f="${BASH_REMATCH[2]}"; name="${BASH_REMATCH[5]}"
        if [[ "$name" == *[[:cntrl:]]* ]]; then reason="a test name holds a tab or control character"; break; fi
        name="${name// > / }"
        rows+=("$f"$'\t'"$name"); files+=("$f")
      else
        reason="a FAIL line has a shape this check does not read: ${line:0:120}"; break
      fi
    done < <(tail -n +"${sec%%:*}" "$txt")
  fi
  if [ -z "$reason" ] && [ "${#rows[@]}" -ne "$n_fail_tests" ]; then reason="${#rows[@]} FAIL line(s) read, the summary says $n_fail_tests failed test(s)"; fi
  if [ -z "$reason" ] && [ "${#rows[@]}" -eq 0 ]; then reason="no failed test was read"; fi # also keeps the empty array out of the expansions below (bash 3.2)
  if [ -z "$reason" ]; then
    local distinct
    distinct="$(printf '%s\n' "${files[@]}" | sort -u | wc -l | tr -d ' ')"
    if [ "$distinct" != "$n_fail_files" ]; then reason="$distinct failing file(s) read, the summary says $n_fail_files"; fi
  fi

  if [ -z "$reason" ]; then
    while IFS= read -r f; do
      if ! [[ "$f" =~ ^[A-Za-z0-9_@+][A-Za-z0-9_@+./-]*$ ]] || [[ "$f" == *..* ]]; then reason="a failing path is not a plain repo path"; break; fi
      if [[ "$f" == tests/e2e/* ]]; then reason="$f is an e2e spec"; break; fi
      for sf in "$@"; do
        if [ -f "$sf" ] && grep -q -x -F -- "$f" "$sf"; then reason="$f is in the scope of this change"; break 2; fi
      done
    done < <(printf '%s\n' "${files[@]}" | sort -u)
  fi

  rm -f "$txt"
  if [ -n "$reason" ]; then printf 'keep-red: %s\n' "$reason"; return 0; fi
  printf 'check\n'
  printf '%s\n' "${rows[@]}"
  return 0
}

# unit_baseline_failures RESULT_JSON TREE: the failed tests of a vitest json report as `<file relative to TREE><TAB><fullName>` lines.
# Returns 1 (and prints nothing) when the report is missing, is not JSON or ran no test at all.
unit_baseline_failures() {
  local json="$1" tree="$2"
  [ -s "$json" ] || return 1
  jq -e '(.numTotalTests // 0) > 0' "$json" >/dev/null 2>&1 || return 1
  jq -r --arg root "${tree%/}/" '.testResults[]? | (.name | ltrimstr($root)) as $f | .assertionResults[]? | select(.status == "failed") | [$f, .fullName] | join("\t")' "$json"
}

# unit_baseline_gate LOG SCOPE_FILE...: returns 0 when every failed test of LOG is outside our scope and fails the same way on the pristine
# upstream release this change merges (custom/BASE), measured here and now; anything else, or any doubt, returns 1 and the gate stays red.
# Needs from run-gates.sh: MODE, SYNC_PR, with_timeout, note, warn_note. Only a sync has a release to compare with.
unit_baseline_gate() {
  local log="$1"; shift
  if [ "${MODE:-}" != sync ] && [ "${SYNC_PR:-}" != 1 ]; then echo "unit baseline: not a sync, there is no pristine upstream release to compare with"; return 1; fi
  local decision tag dir tree json cand up uncovered n_files rc=0
  decision="$(unit_baseline_decide "$log" "$@")"
  if [ "$(head -n 1 <<<"$decision")" != check ]; then echo "unit baseline: the gate stays red (${decision#keep-red: })"; return 1; fi
  cand="$(tail -n +2 <<<"$decision")"
  tag="$(tr -d '[:space:]' < custom/BASE 2>/dev/null || true)"
  if ! [[ "$tag" =~ $TAG_RE ]]; then echo "unit baseline: custom/BASE is not a release tag, the gate stays red"; return 1; fi
  if ! git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null; then
    fetch_upstream "+refs/tags/$tag:refs/tags/$tag" || { echo "unit baseline: could not fetch upstream $tag, the gate stays red"; return 1; }
  fi
  local -a files=()
  while IFS= read -r f; do files+=("$f"); done < <(cut -f1 <<<"$cand" | sort -u)
  n_files="${#files[@]}"
  dir="$(mktemp -d)"; tree="$dir/tree"; json="$dir/result.json"
  echo "unit baseline: $(wc -l <<<"$cand" | tr -d ' ') failed test(s) in $n_files file(s) outside this change; running those files on the pristine upstream release $tag"
  if git worktree add --detach --quiet "$tree" "refs/tags/$tag" >"$dir/worktree.log" 2>&1; then
    tree="$(cd "$tree" && pwd -P)" # vitest reports real paths
    ( cd "$tree" && with_timeout 900 pnpm install --frozen-lockfile \
      && with_timeout 900 pnpm exec vitest run --config config/vitest.config.ts --reporter=json --outputFile="$json" "${files[@]}" ) >"$dir/run.log" 2>&1 || rc=$?
  else
    tail -n 5 "$dir/worktree.log"; rc=99
  fi
  if up="$(unit_baseline_failures "$json" "$tree")"; then
    uncovered="$(comm -23 <(sort -u <<<"$cand") <(sort -u <<<"$up"))"
    if [ -n "$uncovered" ]; then
      echo "unit baseline: these tests pass on upstream $tag, so this change broke them, and the gate stays red:"
      sed 's/^/  /' <<<"$uncovered" | tr '\t' ' '
      rc=1
    else
      rc=0
      echo "unit baseline: every one of them fails on upstream $tag as well; they are not counted:"
      sed 's/^/  /' <<<"$cand" | tr '\t' ' '
      note "$(wc -l <<<"$cand" | tr -d ' ') failed unit test(s) outside this change also fail on pristine upstream $tag in this environment and were not counted"
      warn_note "Not counted: $(wc -l <<<"$cand" | tr -d ' ') unit test(s) that fail on pristine upstream $tag in this environment too (the runner, not this merge): $(cut -f1 <<<"$cand" | sort -u | tr '\n' ' ')"
    fi
  else
    echo "unit baseline: the upstream run produced no usable result (exit $rc); the gate stays red. Last lines:"
    tail -n 8 "$dir/run.log" 2>/dev/null | sed 's/^/  /' || true
    rc=1
  fi
  git worktree remove --force "$tree" >/dev/null 2>&1 || true
  git worktree prune >/dev/null 2>&1 || true
  rm -rf "${dir:?}"
  return "$rc"
}
