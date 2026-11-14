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
#      passed work and zero failed test files and zero failed tests, and there is no `Type Errors` line;
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
      if grep -q -E '[0-9]+ failed' <<<"$f"; then reason="the summary reports failures: $(tr -s ' ' <<<"$f")"; break; fi
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
