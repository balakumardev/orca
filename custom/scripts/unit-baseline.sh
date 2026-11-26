#!/usr/bin/env bash
# Sourced by run-gates.sh and by custom/scripts/test/test-unit-gate-baseline.sh; never run it.
#
# Why: the unit gate runs every test under the directories of our own test files, so upstream tests that have nothing to do with our
# customizations run too. When one of them fails because of the environment (the runner's Node release parses a URL differently than the
# one upstream last ran on) it fails on the pristine upstream release as well, and every sync went red for a reason no merge decision
# can fix: the model was asked to repair it, and a model that "fixes" an upstream test or source file is exactly what a hands-off sync must
# not land. The rule below keeps every failure that is ours or that this merge caused red, and passes the gate only when each failed test
# is outside our scope AND fails the same way on the untouched upstream release the sync merges, measured now, in this environment.
# unit_unhandled_baseline_gate (below) does the same for an unhandled error that an upstream test file raises again on its re-run.
#
# unit_baseline_decide LOG SCOPE_FILE...
#   LOG         the full output of the failed `vitest run` (ANSI colour codes are stripped here)
#   SCOPE_FILE  newline lists of repo-relative paths that belong to this change (run-gates.sh passes $TEST_SCOPE and $ALL_TARGETS)
# stdout: first line `check`, then one `<test file><TAB><test name>` per failed test (the name is the describe chain and the test title
# joined by single spaces, as vitest's json reporter spells fullName), or one line `keep-red: <reason>`. Always returns 0.
#
# `check` only when ALL of these hold; any doubt keeps the gate red:
#   a. the last summary reports failed tests and failed test files, and the log has no Failed Suites (unless the caller covered them, see
#      UNIT_SUITES_COVERED below) or Type Errors. An Unhandled Errors
#      section is NOT judged here: gate_unit (run-gates.sh) gives each unhandled error its own check, the flake re-run, and the gate passes
#      only when both checks pass;
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
  elif grep -q -E '^[[:space:]]*Type Errors[[:space:]]+[0-9]+' "$txt"; then reason="the log has failed suites or type errors"
  elif [ "${UNIT_SUITES_COVERED:-0}" -eq 0 ] && grep -q 'Failed Suites' "$txt"; then reason="the log has failed suites or type errors"
  fi
  # UNIT_SUITES_COVERED=N: the caller re-ran the N failed suites (test files that did not load) alone and they passed (unit_suite_decide in
  # unit-flake.sh), so they are not this check's business; the summary counts each of them as a failed test file.
  if [ -n "$n_fail_files" ]; then n_fail_files=$((n_fail_files - ${UNIT_SUITES_COVERED:-0})); fi

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

# unit_log_has_failed_tests LOG: returns 0 when the last `Tests` line of the log reports failed tests.
unit_log_has_failed_tests() {
  local line
  line="$(strip_ansi < "$1" | grep -E '^[[:space:]]*Tests[[:space:]]' | tail -n 1 || true)"
  [[ "$line" =~ [0-9]+\ failed ]]
}

# unit_baseline_failures RESULT_JSON TREE: the failed tests of a vitest json report as `<file relative to TREE><TAB><fullName>` lines.
# Returns 1 (and prints nothing) when the report is missing, is not JSON or ran no test at all.
unit_baseline_failures() {
  local json="$1" tree="$2"
  [ -s "$json" ] || return 1
  jq -e '(.numTotalTests // 0) > 0' "$json" >/dev/null 2>&1 || return 1
  jq -r --arg root "${tree%/}/" '.testResults[]? | (.name | ltrimstr($root)) as $f | .assertionResults[]? | select(.status == "failed") | [$f, .fullName] | join("\t")' "$json"
}

# The pristine release, checked out and installed at most once per gate: the failed-test check and the unhandled-error check below share it.
# unit_baseline_open sets UB_TAG, UB_DIR and UB_TREE and arms an EXIT trap of the gate shell (run-gates.sh runs every gate in its own subshell)
# that removes the worktree on every way out; a second call returns the first call's result without trying again.
# Needs from run-gates.sh: MODE, SYNC_PR, CHANGED_BASE, with_timeout. A sync compares with the release it merges (custom/BASE of the merge).
# An ordinary pull request compares with the release its base commit is built on: that tag is read from the base commit, never from the change
# under test, so a change cannot name an older release to get a failure excused.
UB_TAG="" UB_DIR="" UB_TREE="" UB_OPEN_RC=""
unit_baseline_open() {
  if [ -n "$UB_OPEN_RC" ]; then return "$UB_OPEN_RC"; fi
  UB_OPEN_RC=1
  local tag=""
  if [ "${MODE:-}" = sync ] || [ "${SYNC_PR:-}" = 1 ]; then tag="$(tr -d '[:space:]' < custom/BASE 2>/dev/null || true)"
  elif [ "${MODE:-}" = pr ] && [ -n "${CHANGED_BASE:-}" ]; then tag="$(git show "$CHANGED_BASE:custom/BASE" 2>/dev/null | tr -d '[:space:]' || true)"
  else echo "unit baseline: neither a sync nor a pull request with a base commit, there is no pristine upstream release to compare with"; return 1; fi
  if ! [[ "$tag" =~ $TAG_RE ]]; then echo "unit baseline: custom/BASE is not a release tag, the gate stays red"; return 1; fi
  if ! git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null; then
    fetch_upstream "+refs/tags/$tag:refs/tags/$tag" || { echo "unit baseline: could not fetch upstream $tag, the gate stays red"; return 1; }
  fi
  UB_TAG="$tag"; UB_DIR="$(mktemp -d)"
  trap unit_baseline_close EXIT
  if ! git worktree add --detach --quiet "$UB_DIR/tree" "refs/tags/$tag" >"$UB_DIR/worktree.log" 2>&1; then
    echo "unit baseline: could not check out upstream $tag, the gate stays red:"; tail -n 5 "$UB_DIR/worktree.log"; return 1
  fi
  UB_TREE="$(cd "$UB_DIR/tree" && pwd -P)" # vitest reports real paths
  if ! ( cd "$UB_TREE" && with_timeout 900 pnpm install --frozen-lockfile ) >"$UB_DIR/install.log" 2>&1; then
    echo "unit baseline: pnpm install failed on upstream $tag, the gate stays red. Last lines:"; tail -n 8 "$UB_DIR/install.log" | sed 's/^/  /'; return 1
  fi
  UB_OPEN_RC=0
}
unit_baseline_close() {
  unit_load_stop
  [ -n "$UB_DIR" ] || return 0
  git worktree remove --force "$UB_DIR/tree" >/dev/null 2>&1 || true
  git worktree prune >/dev/null 2>&1 || true
  rm -rf "${UB_DIR:?}"
  UB_DIR="" UB_TREE=""
}

# unit_baseline_gate LOG SCOPE_FILE...: returns 0 when every failed test of LOG is outside our scope and fails the same way on the pristine
# upstream release this branch is built on (custom/BASE), measured here and now; anything else, or any doubt, returns 1 and the gate stays red.
# Needs from run-gates.sh: what unit_baseline_open needs, plus note and warn_note. Added 2026-11-22: the v1.4.269 sync merged an upstream test
# that fails on the runner's Node 24.22 (bot-mcp-apps), which turned every later pull request red although none touched it.
unit_baseline_gate() {
  local log="$1"; shift
  local decision tag json cand up uncovered n_files rc=0
  decision="$(unit_baseline_decide "$log" "$@")"
  if [ "$(head -n 1 <<<"$decision")" != check ]; then echo "unit baseline: the gate stays red (${decision#keep-red: })"; return 1; fi
  cand="$(tail -n +2 <<<"$decision")"
  local -a files=()
  while IFS= read -r f; do files+=("$f"); done < <(cut -f1 <<<"$cand" | sort -u)
  n_files="${#files[@]}"
  unit_baseline_open || return 1
  tag="$UB_TAG"; json="$UB_DIR/result.json"
  echo "unit baseline: $(wc -l <<<"$cand" | tr -d ' ') failed test(s) in $n_files file(s) outside this change; running those files on the pristine upstream release $tag"
  ( cd "$UB_TREE" && with_timeout 900 pnpm exec vitest run --config config/vitest.config.ts --reporter=json --outputFile="$json" "${files[@]}" ) >"$UB_DIR/run.log" 2>&1 || rc=$?
  if up="$(unit_baseline_failures "$json" "$UB_TREE")"; then
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
      warn_note "Not counted: $(wc -l <<<"$cand" | tr -d ' ') unit test(s) that fail on pristine upstream $tag in this environment too (the runner, not this change): $(cut -f1 <<<"$cand" | sort -u | tr '\n' ' ')"
    fi
  else
    echo "unit baseline: the upstream run produced no usable result (exit $rc); the gate stays red. Last lines:"
    tail -n 8 "$UB_DIR/run.log" 2>/dev/null | sed 's/^/  /' || true
    rc=1
  fi
  return "$rc"
}

# unit_load_start / unit_load_stop: keep every CPU busy (one `yes` per CPU) while a pristine run of a racy file goes on, as the shared run of
# the whole scope does with its workers; unit_baseline_close stops them too, so the EXIT trap never leaves one behind.
UB_LOAD_PIDS=()
unit_load_start() {
  local n i
  n="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
  for ((i = 0; i < n; i++)); do yes > /dev/null & UB_LOAD_PIDS+=("$!"); done
}
unit_load_stop() {
  local p
  for p in ${UB_LOAD_PIDS[@]+"${UB_LOAD_PIDS[@]}"}; do kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done
  UB_LOAD_PIDS=()
}

# unit_unhandled_signatures LOG: one `<originating test file><TAB><first line of the error>` per error of the log's Unhandled Errors section,
# sorted and unique (`src/shared/x.test.ts<TAB>Error: write EPIPE`). An error whose first line was not read gets an empty second field.
unit_unhandled_signatures() {
  strip_ansi < "$1" | LC_ALL=C awk '
    /Unhandled Errors/ { in_sec = 1; head = ""; want = 0; next }
    !in_sec { next }
    / (Uncaught Exception|Unhandled Rejection|Unhandled Error) / { want = 1; head = ""; next }
    want && NF { head = $0; sub(/^[[:space:]]+/, "", head); sub(/[[:space:]]+$/, "", head); want = 0; next }
    /^This error originated in "[^"]+" test file/ { f = $0; sub(/^This error originated in "/, "", f); sub(/".*/, "", f); print f "\t" head; head = "" }
  ' | LC_ALL=C sort -u
}

# unit_unhandled_baseline_gate RC RERUN_LOG FIRST_LOG FILE...
# Why: an upstream test file can raise an unhandled error by itself, a race in its own code. git-branch-cleanup-real-git.test.ts ends the
# stdin of every git child it starts (`child.stdin?.end(...)`) with no 'error' listener, and that write fails with `write EPIPE` whenever the
# child has already exited; vitest then exits 1 with every test passed (with an 'error' listener added: 0 of 12 runs under CPU load, against 5
# of 12 without, diagnostic run 45784629368). Measured on pristine upstream v1.4.271 (diagnostic run 45778437317, the file alone, 25 runs
# each): 7 on ubuntu-26.04 and 6 on ubuntu-24.04 with Node 24.22.3, 0 and 0 with Node 24.11.1; with every CPU busy 20, 13, 25 and 14. So it is
# upstream's code on every image, not the runner. The one re-run (unit_flake_decide) usually passes, not always (rehearsal 45773947221 threw it
# again), and a model round asked to repair that would have to edit an upstream test. Called after that re-run (RERUN_LOG, exit RC) failed
# too, it returns 0 only when ALL of these hold; anything else, or any doubt, returns 1 and the gate stays red:
#   a. RC is 1 and RERUN_LOG passes unit_flake_decide on its own (a summary with passed work and no failed test, N unhandled errors that
#      name N originating test files, every one outside this change's scope), and every file it names is one of FILE...;
#   b. every error of FIRST_LOG and RERUN_LOG has a readable first line, and its originating file is one of FILE...;
#   c. the pristine upstream release (unit_baseline_open: custom/BASE, installed with the frozen lockfile) raises each of those errors (same
#      originating file, same first line) when FILE... run there with every CPU busy (unit_load_start: the shared run is that busy too), in one
#      of at most UNIT_UNHANDLED_TRIES runs (default 6; about 45 s each, 120 s at most, 360 s in all). A race does not show every time (25 of
#      37 such runs on ubuntu-26.04 with Node 24.22.3: 6 runs then miss it about once in 900; at the lowest rate measured, 5 of 12, about
#      once in 26), but an error this change causes cannot show on the release. A run there that crashes, times out or prints no summary
#      ends the check red at once. (`--repeats 9` without the busy CPUs does not help: 2 of 10 runs, diagnostic run 45784629368.)
# Needs from run-gates.sh: TEST_SCOPE, ALL_TARGETS, what unit_baseline_open needs, note, warn_note.
unit_unhandled_baseline_gate() {
  local rc="$1" rerun_log="$2" first="$3"; shift 3
  local decision want got="" missing f i n_run=0 tries="${UNIT_UNHANDLED_TRIES:-6}" up_log up_rc has_summary t0
  if [ "$rc" -ne 1 ]; then echo "unit unhandled-error baseline: the re-run exited with code $rc, not a test-failure exit code"; return 1; fi
  decision="$(unit_flake_decide "$rerun_log" "$TEST_SCOPE" "$ALL_TARGETS")"
  if [ "$(head -n 1 <<<"$decision")" != rerun ]; then echo "unit unhandled-error baseline: the re-run is not only unhandled errors (${decision#keep-red: })"; return 1; fi
  while IFS= read -r f; do
    [[ " $* " == *" $f "* ]] || { echo "unit unhandled-error baseline: the re-run names $f, which was not re-run"; return 1; }
  done < <(tail -n +2 <<<"$decision")
  want="$( { unit_unhandled_signatures "$first"; unit_unhandled_signatures "$rerun_log"; } | LC_ALL=C sort -u)"
  if [ -z "$want" ]; then echo "unit unhandled-error baseline: no unhandled error could be read from the logs"; return 1; fi
  while IFS=$'\t' read -r f i; do
    if [ -z "$i" ]; then echo "unit unhandled-error baseline: an unhandled error of $f has no readable first line"; return 1; fi
    [[ " $* " == *" $f "* ]] || { echo "unit unhandled-error baseline: an unhandled error originated in $f, which was not re-run"; return 1; }
  done <<<"$want"
  unit_baseline_open || return 1
  echo "unit unhandled-error baseline: running $* on the pristine upstream release $UB_TAG with every CPU busy (up to $tries runs) to see whether it raises the same unhandled error(s):"
  sed 's/^/  /' <<<"$want" | tr '\t' ' '
  missing="$want"; t0="$(date +%s)"
  while [ -n "$missing" ] && [ "$n_run" -lt "$tries" ] && [ $(( $(date +%s) - t0 )) -lt "${UNIT_UNHANDLED_BUDGET_S:-360}" ]; do
    n_run=$((n_run + 1)); up_log="$UB_DIR/unhandled-$n_run.log"; up_rc=0
    unit_load_start
    ( cd "$UB_TREE" && with_timeout 120 pnpm exec vitest run --config config/vitest.config.ts "$@" ) >"$up_log" 2>&1 || up_rc=$?
    unit_load_stop
    got="$( { [ -z "$got" ] || printf '%s\n' "$got"; unit_unhandled_signatures "$up_log"; } | LC_ALL=C sort -u)"
    missing="$(LC_ALL=C comm -23 <(printf '%s\n' "$want") <(printf '%s\n' "$got"))"
    # A run that crashed or timed out is not the race showing or not showing: stop instead of spending the budget on it.
    has_summary="$(strip_ansi < "$up_log" | grep -c -E '^[[:space:]]*Test Files[[:space:]]' || true)"
    if [ -n "$missing" ] && { [ "$up_rc" -gt 1 ] || [ "${has_summary:-0}" -eq 0 ]; }; then
      echo "unit unhandled-error baseline: upstream run $n_run exited with code $up_rc without a test summary it could finish; the gate stays red. Last lines:"
      tail -n 8 "$up_log" 2>/dev/null | sed 's/^/  /' || true
      return 1
    fi
  done
  if [ -n "$missing" ]; then
    echo "unit unhandled-error baseline: upstream $UB_TAG did not raise these in $n_run run(s), so they may come from this change, and the gate stays red:"
    sed 's/^/  /' <<<"$missing" | tr '\t' ' '
    echo "  (last upstream run, last lines:)"; tail -n 8 "$up_log" 2>/dev/null | sed 's/^/    /' || true
    return 1
  fi
  echo "unit unhandled-error baseline: upstream $UB_TAG raises every one of them too (run $n_run of at most $tries); they are not counted"
  note "the unhandled error(s) of $* came back on the re-run and pristine upstream $UB_TAG raises them too in this environment (run $n_run of at most $tries); not counted"
  warn_note "Not counted: unhandled error(s) $(cut -f2 <<<"$want" | LC_ALL=C sort -u | paste -sd';' - | sed 's/;/; /g') raised by $* (a test file this change does not touch), on the first run, on its re-run, and on pristine upstream $UB_TAG in this environment too (upstream's test, not this change)"
}
