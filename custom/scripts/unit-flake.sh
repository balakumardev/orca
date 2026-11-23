#!/usr/bin/env bash
# Sourced by run-gates.sh and by custom/scripts/test/test-unit-gate-flake.sh; never run it.
#
# Why: vitest exits 1 when it caught an "Unhandled Error" (for example `write EPIPE` from a child process that a test
# started and did not wait for) even though every test passed. That is a timing flake of one upstream test file, not a
# verdict on this change, and it made the unit gate red on every sync. The rule below keeps every real failure red and
# lets the gate give such a run exactly ONE chance: re-run only the test file(s) the error came from.
#
# unit_flake_decide LOG SCOPE_FILE...
#   LOG         the full output of the failed `vitest run` (ANSI colour codes are stripped here)
#   SCOPE_FILE  newline lists of repo-relative paths that belong to this change (run-gates.sh passes $TEST_SCOPE and
#               $ALL_TARGETS: the files our customizations own, plus the files a pull request touches)
# stdout: first line `rerun` followed by one test file per line, or one line `keep-red: <reason>`. Always returns 0.
#
# `rerun` only when ALL of these hold; any doubt keeps the gate red:
#   a. the LAST summary of the log (`Test Files` and `Tests`, both printed after the unhandled-error section) reports
#      passed work and zero failed test files and zero failed tests (unless the caller sets UNIT_FLAKE_FAILED_COVERED=1, see
#      below), and there is no `Type Errors` line;
#   b. an "Unhandled Errors" section exists and says how many errors it caught (N >= 1);
#   c. it names exactly N originating test files (`This error originated in "<file>" test file`), every one is a
#      well-formed repo path with a test-file suffix outside tests/e2e, and none of them is listed in a SCOPE_FILE.
# The caller must also have seen exit code 1 (not a timeout, not a crash) and must check the files exist.

unit_flake_decide() {
  local log="$1"; shift
  local LC_ALL=C # a log can hold bytes that are not valid UTF-8; parse it bytewise
  local txt reason="" unh tf ts n_err n_origin f sf in_scope line
  local -a files=()
  txt="$(mktemp)"
  strip_ansi < "$log" > "$txt"

  # last line number of a pattern ("" when absent)
  last_line() { grep -n -E "$1" "$txt" | tail -n 1 | cut -d: -f1 || true; }

  unh="$(last_line 'Unhandled Errors')"
  tf="$(last_line '^[[:space:]]*Test Files[[:space:]]')"
  ts="$(last_line '^[[:space:]]*Tests[[:space:]]')"
  if [ -z "$unh" ]; then reason="the log has no Unhandled Errors section"
  elif [ -z "$tf" ] || [ -z "$ts" ]; then reason="the log has no Test Files / Tests summary (the run did not finish)"
  elif [ "$tf" -le "$unh" ] || [ "$ts" -le "$unh" ]; then reason="the test summary is not the last thing in the log"
  fi

  if [ -z "$reason" ]; then
    for line in "$tf" "$ts"; do
      f="$(sed -n "${line}p" "$txt")"
      # UNIT_FLAKE_FAILED_COVERED=1: the caller already showed every failed test fails on the pristine upstream release (unit-baseline.sh),
      # so the failures in the summary are not this check's business; only the unhandled errors are.
      if [ "${UNIT_FLAKE_FAILED_COVERED:-0}" != 1 ] && grep -q -E '[0-9]+ failed' <<<"$f"; then reason="the summary reports failures: $(tr -s ' ' <<<"$f")"; break; fi
      if ! grep -q -E '[0-9]+ passed' <<<"$f"; then reason="the summary reports no passed work: $(tr -s ' ' <<<"$f")"; break; fi
    done
  fi
  if [ -z "$reason" ] && grep -q -E '^[[:space:]]*Type Errors[[:space:]]+[0-9]+' "$txt"; then reason="the log reports type errors"; fi

  if [ -z "$reason" ]; then
    n_err="$(sed -n -E 's/.*Vitest caught ([0-9]+) unhandled errors?.*/\1/p' "$txt" | tail -n 1)"
    if [ -z "$n_err" ] || [ "$n_err" -lt 1 ]; then reason="the unhandled-error section does not say how many errors it caught"; fi
  fi

  if [ -z "$reason" ]; then
    # Only lines after the section header count: test output earlier in the log cannot name a file.
    while IFS= read -r f; do files+=("$f"); done < <(tail -n +"$unh" "$txt" | sed -n -E 's/^This error originated in "([^"]+)" test file.*/\1/p')
    n_origin="${#files[@]}"
    if [ "$n_origin" -ne "$n_err" ]; then reason="$n_err unhandled error(s) but $n_origin originating test file(s) named"; fi
  fi

  if [ -z "$reason" ]; then
    local names=()
    while IFS= read -r f; do names+=("$f"); done < <(printf '%s\n' "${files[@]}" | sort -u)
    for f in "${names[@]}"; do
      if ! [[ "$f" =~ ^[A-Za-z0-9_@+][A-Za-z0-9_@+./-]*$ ]] || [[ "$f" == *..* ]]; then reason="an originating path is not a plain repo path"; break; fi
      if ! [[ "$f" =~ \.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$ ]] || [[ "$f" == tests/e2e/* ]]; then reason="$f is not a unit test file"; break; fi
      in_scope=0
      for sf in "$@"; do
        if [ -f "$sf" ] && grep -q -x -F -- "$f" "$sf"; then in_scope=1; break; fi
      done
      if [ "$in_scope" -eq 1 ]; then reason="$f is in the scope of this change"; break; fi
    done
    [ -n "$reason" ] || files=("${names[@]}")
  fi

  rm -f "$txt"
  if [ -n "$reason" ]; then printf 'keep-red: %s\n' "$reason"; return 0; fi
  printf 'rerun\n'
  printf '%s\n' "${files[@]}"
}

# unit_suite_decide LOG SCOPE_FILE...
# Why: with the shared worker pool one test file can leave a module half-loaded for the next ones in its worker (a lazy import that ran while
# a test had stubbed `window` stays failed in the module cache), so a file this change never touches fails to LOAD with a TypeError and
# vitest reports it under `Failed Suites`. Which files it hits depends on how the pool splits the files, so it comes and goes between runs of
# the same code (pull request 45: three such files in one run, one in the re-run of the same commit). The rule below gives every such file
# one re-run on its own, where nothing is left over from another file: a file that fails alone is broken by this change and keeps the gate red.
# stdout: `none` when the log has no failed suite, first line `rerun` + one test file per line, or one line `keep-red: <reason>`. Returns 0.
#
# `rerun` only when ALL of these hold; any doubt keeps the gate red:
#   a. the log has the usual summary, no `Type Errors` line, and `Failed Suites N` is followed by exactly N ` FAIL ` lines, each of the
#      shape `FAIL [project] <file> [ <file> ]` (what vitest prints for a file that did not load), before the next section;
#   b. every file is a plain repo path with a unit-test suffix outside tests/e2e, none is listed in a SCOPE_FILE, and the summary counts
#      at least N failed test files.
unit_suite_decide() {
  local log="$1"; shift
  local LC_ALL=C
  local txt reason="" sec n_sec tf n_fail_files line f sf in_section=0 seen=0 start
  local -a files=()
  txt="$(mktemp)"
  strip_ansi < "$log" > "$txt"
  sec="$(grep -n -E 'Failed Suites[[:space:]]+[0-9]+' "$txt" | tail -n 1 || true)"
  if [ -z "$sec" ]; then rm -f "$txt"; echo none; return 0; fi
  start="${sec%%:*}"
  n_sec="$(sed -n -E 's/.*Failed Suites[[:space:]]+([0-9]+).*/\1/p' <<<"$sec")"
  tf="$(grep -E '^[[:space:]]*Test Files[[:space:]]' "$txt" | tail -n 1 || true)"
  n_fail_files="$(sed -n -E 's/^[[:space:]]*Test Files[[:space:]]+([0-9]+) failed.*/\1/p' <<<"$tf")"
  if [ -z "$n_sec" ] || [ "$n_sec" -lt 1 ]; then reason="the Failed Suites header carries no count"
  elif [ -z "$tf" ] || [ -z "$n_fail_files" ]; then reason="the log has no Test Files summary with failed files"
  elif [ "$n_fail_files" -lt "$n_sec" ]; then reason="the summary counts $n_fail_files failed file(s), fewer than the $n_sec failed suite(s)"
  elif grep -q -E '^[[:space:]]*Type Errors[[:space:]]+[0-9]+' "$txt"; then reason="the log reports type errors"
  fi

  if [ -z "$reason" ]; then
    # Only the lines of this section count: they end at the Failed Tests section or at the summary.
    while IFS= read -r line; do
      if [ "$in_section" -eq 0 ]; then in_section=1; continue; fi # the header line itself
      if [[ "$line" =~ Failed\ Tests[[:space:]]+[0-9]+ ]] || [[ "$line" =~ ^[[:space:]]*Test\ Files[[:space:]] ]]; then break; fi
      [[ "$line" == " FAIL "* ]] || continue
      if [[ "$line" =~ ^\ FAIL\ +(.+\ +)?([^\ ]+\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs))\ \[\ ([^\ ]+)\ \]$ ]] && [ "${BASH_REMATCH[2]}" = "${BASH_REMATCH[5]}" ]; then
        files+=("${BASH_REMATCH[2]}"); seen=$((seen + 1))
      else
        reason="a FAIL line of the Failed Suites section has a shape this check does not read: ${line:0:120}"; break
      fi
    done < <(sed -n "${start},\$p" "$txt")
  fi
  if [ -z "$reason" ] && [ "$seen" -ne "$n_sec" ]; then reason="$seen FAIL line(s) read, the header says $n_sec failed suite(s)"; fi

  if [ -z "$reason" ]; then
    local names=()
    while IFS= read -r f; do names+=("$f"); done < <(printf '%s\n' "${files[@]}" | sort -u)
    for f in "${names[@]}"; do
      if ! [[ "$f" =~ ^[A-Za-z0-9_@+][A-Za-z0-9_@+./-]*$ ]] || [[ "$f" == *..* ]]; then reason="a failed suite's path is not a plain repo path"; break; fi
      if [[ "$f" == tests/e2e/* ]]; then reason="$f is an e2e spec"; break; fi
      for sf in "$@"; do
        if [ -f "$sf" ] && grep -q -x -F -- "$f" "$sf"; then reason="$f is in the scope of this change"; break 2; fi
      done
    done
    [ -n "$reason" ] || files=("${names[@]}")
  fi

  rm -f "$txt"
  if [ -n "$reason" ]; then printf 'keep-red: %s\n' "$reason"; return 0; fi
  printf 'rerun\n'
  printf '%s\n' "${files[@]}"
}
