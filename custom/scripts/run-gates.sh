#!/usr/bin/env bash
# Run the quality gates against the checked-out candidate and record REAL exit codes and output tails.
# Used by both custom-sync.yml (candidate = the sync merge) and custom-pr-gates.yml (candidate = a PR).
#
# Usage (from the repository root of the candidate):
#   run-gates.sh --out DIR --mode sync|pr --changed-base SHA --our-files FILE [--only a,b] [--skip a,b] [--exit-zero]
#
#   --changed-base  pr mode: the commit the PR is measured against (lint/format/tests cover files changed since it).
#                   sync mode: ignored for target selection (the target set is "our files").
#   --our-files     newline list of paths our customization touches (diff of the old BASE tag against the base branch).
#   --exit-zero     always exit 0 (failures are only recorded in gates.json); the sync workflow uses it so that a
#                   failed gate becomes a draft PR instead of a red run.
#
# Gate ids: hygiene lint-caps install typecheck lint format unit unit-related localization e2e-ratchet e2e
# Output: DIR/gates.json (schema 1), DIR/logs/<id>.log (full output). Gates are scripts: no model is involved.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="" MODE="" CHANGED_BASE="" OUR_FILES="" ONLY="" SKIP="" EXIT_ZERO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --changed-base) CHANGED_BASE="$2"; shift 2 ;;
    --our-files) OUR_FILES="$2"; shift 2 ;;
    --only) ONLY=",$2,"; shift 2 ;;
    --skip) SKIP=",$2,"; shift 2 ;;
    --exit-zero) EXIT_ZERO=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$OUT" ] && [ -n "$MODE" ] || die "--out and --mode are required"
case "$MODE" in sync|pr) ;; *) die "--mode must be sync or pr" ;; esac
[ -n "$OUR_FILES" ] && [ -f "$OUR_FILES" ] || die "--our-files must name an existing file"
[ "$MODE" = sync ] || [ -n "$CHANGED_BASE" ] || die "pr mode needs --changed-base"

# Hermetic: the maintainer's shell may carry ORCA_* variables that point at a live Orca.
for v in $(env | cut -d= -f1 | grep '^ORCA_' || true); do unset "$v"; done

OUT="$(mkdir -p "$OUT" && cd "$OUT" && pwd)"
mkdir -p "$OUT/logs" "$OUT/notes"
: > "$OUT/results.jsonl"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_S="$(date +%s)"

selected() { # id
  [ -z "$ONLY" ] || case "$ONLY" in *",$1,"*) ;; *) return 1 ;; esac
  case "$SKIP" in *",$1,"*) return 1 ;; esac
  return 0
}

# ------------------------------------------------------------------------------------------------ target sets
# ALL_TARGETS: every existing file in scope. sync: our files. pr: files changed since the base.
ALL_TARGETS="$OUT/targets-all.txt"
if [ "$MODE" = sync ]; then
  while IFS= read -r p; do [ -f "$p" ] && printf '%s\n' "$p"; done < "$OUR_FILES" | sort -u > "$ALL_TARGETS" || true
else
  git diff --name-only --diff-filter=d "$CHANGED_BASE" HEAD | sort -u > "$ALL_TARGETS"
fi
CODE_TARGETS="$OUT/targets-code.txt"
grep -E '\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$' "$ALL_TARGETS" > "$CODE_TARGETS" || true
# Tests and specs: on a PR also our own, so a contributor cannot silently break our customization.
TEST_SCOPE="$OUT/targets-test-scope.txt"
cp "$ALL_TARGETS" "$TEST_SCOPE"
if [ "$MODE" = pr ]; then
  { cat "$ALL_TARGETS"; while IFS= read -r p; do [ -f "$p" ] && printf '%s\n' "$p"; done < "$OUR_FILES"; } | sort -u > "$TEST_SCOPE" || true
fi
TEST_TARGETS="$OUT/targets-tests.txt" # unit tests only; Playwright specs under tests/e2e are the e2e gate's
grep -E '\.(test|spec)\.(ts|tsx|mts|cts|mjs)$' "$TEST_SCOPE" | grep -v '^tests/e2e/' > "$TEST_TARGETS" || true
E2E_SPECS="$OUT/targets-e2e.txt"
grep -E '^tests/e2e/.*\.spec\.ts$' "$TEST_SCOPE" > "$E2E_SPECS" || true

note() { printf '%s\n' "$*" >> "$OUT/notes/$CURRENT_GATE.txt"; }
warn_note() { printf '%s\n' "$*" >> "$OUT/notes/$CURRENT_GATE.warn"; }
skip_gate() { note "$*"; return 77; }
with_timeout() { # SECONDS CMD...
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"
  else "$@"; fi
}
strip_ansi() { perl -pe 's/\e\[[0-9;?]*[A-Za-z]//g'; }
CURRENT_GATE=""

# ------------------------------------------------------------------------------------------------ gates
gate_hygiene() {
  local bad=0 p
  if [ -e custom/UNRESOLVED-MERGE.txt ]; then
    echo "custom/UNRESOLVED-MERGE.txt exists: this branch still has unresolved merge conflicts"
    bad=1
  fi
  # Conflict markers in the files this change touches. Needs both an opening and a closing marker line.
  while IFS= read -r p; do
    [ -f "$p" ] || continue
    if grep -a -q -E '^<<<<<<< ' "$p" && grep -a -q -E '^>>>>>>> ' "$p"; then
      echo "conflict markers in $p"
      bad=1
    fi
  done < "$ALL_TARGETS"
  # The fork carries no upstream CI: only workflows named custom-*, no dependabot config.
  while IFS= read -r p; do
    if foreign_ci_path "$p"; then echo "upstream CI file present: $p"; bad=1; fi
  done < <(git ls-files -- .github/workflows .github/dependabot.yml .github/dependabot.yaml)
  if ! [[ "$(tr -d '[:space:]' < custom/BASE 2>/dev/null)" =~ $TAG_RE ]]; then
    echo "custom/BASE is missing or does not hold a release tag"
    bad=1
  fi
  [ "$bad" -eq 0 ] || return 1
  note "no conflict markers, no unresolved sentinel, no upstream CI, custom/BASE valid ($(wc -l < "$ALL_TARGETS" | tr -d ' ') files checked)"
}

gate_lint_caps() {
  local json
  json="$(xargs -r -0 node "$TOOLS_DIR/lint-caps.mjs" < <(tr '\n' '\0' < "$ALL_TARGETS") | jq -s -c '{checked: (map(.checked) | add // 0), near: (map(.near) | add // []), over: (map(.over) | add // [])}')"
  echo "$json"
  jq -r '.near[] | "\(.path): \(.lines)/\(.cap) lines (within 10 of the cap)"' <<<"$json" | while IFS= read -r l; do warn_note "$l"; done
  note "$(jq -r '.checked' <<<"$json") files checked; $(jq -r '.near | length' <<<"$json") near a cap; estimate, oxlint is the judge"
  [ "$(jq -r '.over | length' <<<"$json")" -eq 0 ] || { jq -r '.over[] | "OVER CAP \(.path): \(.lines)/\(.cap)"' <<<"$json"; return 1; }
}

gate_install() { pnpm install --frozen-lockfile; }
gate_typecheck() { pnpm tc; }

gate_lint() {
  [ -s "$CODE_TARGETS" ] || skip_gate "no JS/TS files in scope" || return $?
  xargs -r -0 pnpm exec oxlint < <(tr '\n' '\0' < "$CODE_TARGETS")
  note "$(wc -l < "$CODE_TARGETS" | tr -d ' ') files"
}

gate_format() {
  [ -s "$CODE_TARGETS" ] || skip_gate "no JS/TS files in scope" || return $?
  xargs -r -0 pnpm exec oxfmt --check < <(tr '\n' '\0' < "$CODE_TARGETS")
  note "$(wc -l < "$CODE_TARGETS" | tr -d ' ') files"
}

gate_unit() {
  [ -s "$TEST_TARGETS" ] || skip_gate "no unit test files in scope" || return $?
  local dirs
  dirs="$(while IFS= read -r p; do dirname "$p"; done < "$TEST_TARGETS" | sort -u)"
  note "test directories: $(printf '%s' "$dirs" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  with_timeout 1500 pnpm exec vitest run --config config/vitest.config.ts $dirs
}

gate_unit_related() { # pr mode only: tests that import the changed source files
  [ "$MODE" = pr ] || skip_gate "only runs on pull requests" || return $?
  local src
  src="$(grep -v -E '\.(test|spec)\.' "$CODE_TARGETS" | grep -E '^(src|config/scripts)/' || true)"
  [ -n "$src" ] || skip_gate "no changed source files" || return $?
  [ "$(printf '%s\n' "$src" | wc -l)" -le 150 ] || skip_gate "more than 150 changed source files; run the full suite locally" || return $?
  # shellcheck disable=SC2086
  with_timeout 1500 pnpm exec vitest related --run --passWithNoTests --config config/vitest.config.ts $src
}

gate_localization() { pnpm run verify:localization-coverage; }
gate_e2e_ratchet() { pnpm check:e2e-typecheck-ratchet; }

gate_e2e() {
  [ -s "$E2E_SPECS" ] || skip_gate "no Playwright specs in scope" || return $?
  local specs runner=()
  specs="$(tr '\n' ' ' < "$E2E_SPECS")"
  note "specs: $specs"
  if [ "$(uname -s)" = Linux ]; then
    command -v xvfb-run >/dev/null 2>&1 || { sudo apt-get update -q && sudo apt-get install -y -q xvfb; }
    runner=(xvfb-run --auto-servernum)
  fi
  [ -d node_modules ] || pnpm install --frozen-lockfile
  pnpm run ensure:electron-runtime
  env VITE_EXPOSE_STORE=true npx electron-vite build --mode e2e
  # shellcheck disable=SC2086
  env ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 ${runner[@]+"${runner[@]}"} \
    npx playwright test $specs --config tests/playwright.config.ts --project=electron-headless --workers=1 --trace=off
}

# ------------------------------------------------------------------------------------------------ harness
INSTALL_FAILED=0
needs_install() { case "$1" in typecheck|lint|format|unit|unit-related|localization|e2e-ratchet) return 0 ;; esac; return 1; }

record() { # id name status exit seconds
  local id="$1" name="$2" status="$3" rc="$4" secs="$5" tail_text="" notes="" warns="[]"
  [ -s "$OUT/logs/$id.log" ] && tail_text="$(strip_ansi < "$OUT/logs/$id.log" | tail -n 40 | tail -c 3500)"
  [ -s "$OUT/notes/$id.txt" ] && notes="$(paste -sd' ' "$OUT/notes/$id.txt")"
  [ -s "$OUT/notes/$id.warn" ] && warns="$(jq -R -s -c 'split("\n") | map(select(length > 0))' "$OUT/notes/$id.warn")"
  jq -n -c --arg id "$id" --arg name "$name" --arg status "$status" --argjson rc "$rc" --argjson secs "$secs" \
    --arg note "$notes" --arg tail "$tail_text" --argjson warns "$warns" \
    '{id: $id, name: $name, status: $status, exit_code: $rc, seconds: $secs, note: $note, warnings: $warns, output_tail: $tail}' \
    >> "$OUT/results.jsonl"
}

run_gate() { # id name function
  local id="$1" name="$2" fn="$3" rc=0 t0 status
  selected "$id" || return 0
  CURRENT_GATE="$id"
  if [ "$INSTALL_FAILED" -eq 1 ] && needs_install "$id"; then
    note "skipped: dependency install failed"
    record "$id" "$name" skip 0 0
    return 0
  fi
  log "=== gate: $id ($name)"
  t0="$(date +%s)"
  (
    set -euo pipefail
    "$fn"
  ) > "$OUT/logs/$id.log" 2>&1 || rc=$?
  tail -n 15 "$OUT/logs/$id.log" >&2 || true
  case "$rc" in
    0) status=pass ;;
    77) status=skip; rc=0 ;;
    *) status=fail ;;
  esac
  [ "$id" != install ] || [ "$status" != fail ] || INSTALL_FAILED=1
  record "$id" "$name" "$status" "$rc" "$(( $(date +%s) - t0 ))"
  log "=== $id: $status in $(( $(date +%s) - t0 ))s"
}

run_gate hygiene "Merge hygiene (markers, upstream CI, BASE)" gate_hygiene
run_gate lint-caps "Lint line caps on files we touch" gate_lint_caps
run_gate install "Install dependencies (frozen lockfile)" gate_install
run_gate typecheck "Typecheck (pnpm tc)" gate_typecheck
run_gate lint "oxlint on files in scope" gate_lint
run_gate format "oxfmt --check on files in scope" gate_format
run_gate unit "Unit tests for the directories in scope" gate_unit
run_gate unit-related "Unit tests related to changed sources" gate_unit_related
run_gate localization "Localization coverage" gate_localization
run_gate e2e-ratchet "E2E typecheck ratchet" gate_e2e_ratchet
run_gate e2e "Playwright e2e specs in scope" gate_e2e

# ------------------------------------------------------------------------------------------------ report
jq -s -c --arg mode "$MODE" --arg started "$STARTED_AT" --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson secs "$(( $(date +%s) - START_S ))" --arg sha "$(git rev-parse HEAD)" \
  --arg os "${RUNNER_OS:-$(uname -s)}" --arg arch "${RUNNER_ARCH:-$(uname -m)}" --arg node "$(node -v 2>/dev/null || true)" \
  '{schema: 1, mode: $mode, candidate: $sha, started_at: $started, finished_at: $finished, seconds: $secs,
    runner: {os: $os, arch: $arch, node: $node}, gates: .}' "$OUT/results.jsonl" > "$OUT/gates.json"

failed="$(jq '[.gates[] | select(.status == "fail")] | length' "$OUT/gates.json")"
{
  echo "### Gates ($MODE, ${RUNNER_OS:-local})"
  echo
  echo "| Gate | Result | Seconds | Note |"
  echo "| --- | --- | --- | --- |"
  jq -r '.gates[] | "| \(.name) | \(if .status == "pass" then "pass" elif .status == "fail" then "FAIL" else "skipped" end) | \(.seconds) | \(.note) |"' "$OUT/gates.json"
} > "$OUT/summary.md"
cat "$OUT/summary.md" >&2
[ -z "${GITHUB_STEP_SUMMARY:-}" ] || cat "$OUT/summary.md" >> "$GITHUB_STEP_SUMMARY"

gh_out failed "$failed"
if [ "$failed" -gt 0 ] && [ "$EXIT_ZERO" -eq 0 ]; then exit 1; fi
exit 0
