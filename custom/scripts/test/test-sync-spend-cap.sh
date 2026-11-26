#!/usr/bin/env bash
# Test for the spend cap of scheduled syncs (custom/scripts/sync-spend-cap.sh, asked by detect-release.sh), with a stub `gh` (no network,
# no token). Run: bash custom/scripts/test/test-sync-spend-cap.sh      (needs bash and jq)
# SCRIPTS_DIR=<dir> points it at another copy of the scripts (used to prove the cases fail against the unmodified ones).
#
# The whole detect-release.sh runs, shaped like a scheduled run (no INPUT_REF: the newest upstream release, v1.4.258, is newer than
# custom/BASE v1.0.0, so without the cap it would sync). The stub serves the runs list of custom-sync.yml page by page from fixture files
# and applies the script's own `--jq` filter with real jq. Cases: 0, 2, 3 and 5 failed runs in 24 h; a failure of THIS run is not
# counted; a dispatch is never capped; an API error, a reply that is not a runs list, a reply that is not JSON and a run without a
# readable creation time all pause (never sync on an unknown count); failures older than 24 h and other conclusions are not counted;
# a second page is read; the page bound pauses; a run with nothing new upstream stays quiet (the cap is checked last).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="${SCRIPTS_DIR:-$(cd "$here/.." && pwd)}"
command -v jq >/dev/null 2>&1 || { echo "missing tool: jq"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY INPUT_REF INPUT_BASE_BRANCH GITHUB_EVENT_NAME GITHUB_RUN_ID SYNC_CAP_MAX_PAGES

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

UP="c91a7a6e2b8f4d0a1c3e5f7091a2b3c4d5e6f708"
TIP="3333333333333333333333333333333333333333"
NOW=1795600000 # a fixed "now" (2026-11-26); the runs' creation times are counted back from it
ME=9000         # this run's id

mkdir "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Stub gh. Every call is logged. Fixture files live in $FIX; --jq filters are applied with real jq.
echo "$*" >> "$GH_LOG"
args=("$@")
jqprog=""
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  if [ "${args[$i]}" = "--jq" ]; then jqprog="${args[$((i + 1))]}"; fi
  i=$((i + 1))
done
emit() {
  [ -f "$1" ] || { echo "stub gh: no fixture $(basename "$1")" >&2; exit 1; }
  if [ -n "$jqprog" ]; then jq -r -c "$jqprog" "$1"; else cat "$1"; fi
}
if [ "$1" = pr ] && [ "$2" = list ]; then echo '[]' | { if [ -n "$jqprog" ]; then jq -r -c "$jqprog"; else cat; fi; }; exit 0; fi
[ "$1" = api ] || { echo "stub gh: unexpected call: $*" >&2; exit 2; }
path="${2%%\?*}" query="${2#*\?}"
case "$path" in
  repos/*/actions/workflows/custom-sync.yml/runs)
    if [ -f "$FIX/runs-fail" ]; then echo "gh: Server Error (HTTP 500)" >&2; exit 1; fi
    page="$(sed -n 's/.*[?&]page=\([0-9]*\).*/\1/p' <<<"?$query")"
    if [ -f "$FIX/runs-page-$page.json" ]; then emit "$FIX/runs-page-$page.json"; else echo '{"total_count":0,"workflow_runs":[]}' > "$FIX/empty.json"; emit "$FIX/empty.json"; fi ;;
  repos/*/git/ref/heads/custom) jq -n --arg s "$TIP" '{object: {sha: $s}}' > "$FIX/ref.json"; emit "$FIX/ref.json" ;;
  repos/*/git/ref/heads/sync/*) echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  repos/*/contents/custom/BASE) jq -n --arg c "$(printf 'v1.0.0\n' | base64)" '{content: $c}' > "$FIX/base.json"; emit "$FIX/base.json" ;;
  repos/stablyai/orca/releases) emit "$FIX/releases.json" ;;
  repos/stablyai/orca/commits/*) jq -n --arg s "$UPSTREAM_SHA" '{sha: $s}' > "$FIX/c.json"; emit "$FIX/c.json" ;;
  *) echo "stub gh: no route for: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmp/bin/gh"

reset() { # a fresh world: v1.4.258 upstream (newer than BASE v1.0.0), no PRs, no runs
  FIX="$tmp/fix"; rm -rf "$FIX"; mkdir -p "$FIX"
  echo '[{"tag_name":"v1.4.258","draft":false,"prerelease":false},{"tag_name":"mobile-android-v0.0.64","draft":false,"prerelease":false}]' > "$FIX/releases.json"
}
page() { # PAGE then ID:CONCLUSION:AGE_HOURS[:BRANCH] entries (CONCLUSION null = still running; BRANCH defaults to custom, "none" leaves
  # head_branch out); "fill:N:CONCLUSION" adds N runs from custom at age 1 h
  local p="$1" runs="[]" e id c age br; shift
  for e in "$@"; do
    IFS=: read -r id c age br <<<"$e"
    if [ "$id" = fill ]; then
      runs="$(jq -c --argjson n "$c" --arg c "$age" --argjson now "$NOW" '. + [range($n) | {id: (100000 + .), conclusion: $c, status: "completed", head_branch: "custom", created_at: (($now - 3600) | todate)}]' <<<"$runs")"
    else
      runs="$(jq -c --argjson id "$id" --arg c "$c" --arg b "${br:-custom}" --argjson t "$((NOW - age * 3600 + 60))" \
        '. + [{id: $id, conclusion: (if $c == "null" then null else $c end), status: "completed", created_at: ($t | todate)} + (if $b == "none" then {} else {head_branch: $b} end)]' <<<"$runs")"
    fi
  done
  jq -n --argjson r "$runs" '{total_count: ($r | length), workflow_runs: $r}' > "$FIX/runs-page-$p.json"
}

run() { # EVENT -> d_out d_rc d_summary
  : > "$tmp/gh.log"; : > "$tmp/summary.md"
  d_rc=0
  d_out="$(env PATH="$tmp/bin:$PATH" GH_LOG="$tmp/gh.log" FIX="$FIX" UPSTREAM_SHA="$UP" TIP="$TIP" GITHUB_REPOSITORY=balakumardev/orca GITHUB_RUN_NUMBER=7 \
    GITHUB_EVENT_NAME="$1" GITHUB_RUN_ID="$ME" NOW_EPOCH="$NOW" GITHUB_STEP_SUMMARY="$tmp/summary.md" ${EXTRA:+"$EXTRA"} \
    bash "$scripts/detect-release.sh" 2>&1)" || d_rc=$?
  d_summary="$(cat "$tmp/summary.md")"
}
out_of() { local v; v="$(sed -n "s/^OUTPUT $1=//p" <<<"$d_out")"; printf '%s' "${v%%$'\n'*}"; }
asked_runs() { grep -qF 'actions/workflows/custom-sync.yml/runs' "$tmp/gh.log"; }
expect_sync() { # NAME
  if [ "$d_rc" = 0 ] && [ "$(out_of proceed)" = true ] && [ "$(out_of branch)" = sync/v1.4.258 ] && ! grep -qF 'custom-sync paused' <<<"$d_out"; then ok "$1"
  else bad "$1: rc=$d_rc proceed=[$(out_of proceed)] out=[$d_out]"; fi
}
expect_paused() { # NAME REASON_SUBSTRING SUMMARY_SUBSTRING: the same stop as the quiet ones (exit 0, proceed false), but loud
  # shellcheck disable=SC2016 # literal text, not an expansion
  if [ "$d_rc" = 0 ] && [ "$(out_of proceed)" = false ] && grep -qF -- "$2" <<<"$(out_of reason)" && [ -z "$(out_of branch)" ] \
     && grep -qF '::warning title=custom-sync paused::' <<<"$d_out" && grep -qF -- "$3" <<<"$d_summary" \
     && grep -qF 'gh workflow run custom-sync.yml --repo balakumardev/orca --ref custom' <<<"$d_summary" && grep -qF '3 x $31 a day' <<<"$d_summary"; then ok "$1"
  else bad "$1: rc=$d_rc proceed=[$(out_of proceed)] reason=[$(out_of reason)] summary=[$d_summary] out=[$d_out]"; fi
}

# ---- the count -------------------------------------------------------------------------------------------------------------
reset; run schedule
expect_sync "scheduled, no runs at all: syncs"
if asked_runs && grep -qF "created=%3E%3D$(jq -nr --argjson t "$((NOW - 86400))" '$t | todate')" "$tmp/gh.log"; then ok "the runs of custom-sync.yml created in the last 24 h are asked for"; else bad "runs query: $(cat "$tmp/gh.log")"; fi
if ! grep -qE 'pr (close|comment|edit|ready)|-X (DELETE|POST|PATCH)|--method' "$tmp/gh.log"; then ok "detect only reads"; else bad "a write: $(cat "$tmp/gh.log")"; fi
reset; page 1 1:failure:2 2:failure:5 3:success:1; run schedule
expect_sync "2 failed runs in 24 h: syncs"
reset; page 1 1:failure:2 2:failure:5 3:failure:20 4:success:1; run schedule
expect_paused "3 failed runs in 24 h: paused" "3 custom-sync runs failed in the last 24 h" "3 failed syncs in 24 h"
if grep -qF 'https://github.com/balakumardev/orca/actions/runs/3' <<<"$d_summary" && grep -qF 'age out of the 24 h window' <<<"$d_summary"; then ok "the summary links the failed runs and says the pause ends by itself"; else bad "summary: $d_summary"; fi
reset; page 1 1:failure:1 2:failure:2 3:failure:3 4:failure:4 5:failure:23; run schedule
expect_paused "5 failed runs in 24 h: paused" "5 custom-sync runs failed" "5 failed syncs in 24 h"

# ---- what is not counted ---------------------------------------------------------------------------------------------------
reset; page 1 1:failure:2 2:failure:5 "$ME:failure:0"; run schedule
expect_sync "a failure of THIS run (a re-run attempt) is not counted: 2 left, syncs"
reset; page 1 1:failure:25 2:failure:30 3:failure:47 4:failure:2 5:failure:3; run schedule
expect_sync "failures older than 24 h are not counted (the API's own filter is not trusted): 2 left, syncs"
reset; page 1 1:cancelled:1 2:cancelled:2 3:timed_out:3 4:startup_failure:4 5:success:5 6:null:0 7:skipped:6 8:action_required:7; run schedule
expect_sync "other conclusions (cancelled, timed_out, startup_failure, success, still running) are not counted: syncs"
# Only runs from custom spend on the model (the `agent` environment): a failed rehearsal from a feature branch never pauses the schedule.
reset; page 1 1:failure:1:feature/x 2:failure:2:fix/sync-agent-crash-recovery 3:failure:3:test/sync-base 4:failure:4 5:failure:5; run schedule
expect_sync "3 failures on feature branches + 2 on custom: only custom counts, 2 left, syncs"
reset; page 1 1:failure:1:feature/x 2:failure:4 3:failure:5 4:failure:6; run schedule
expect_paused "3 failures on custom (plus one on a feature branch): paused" "3 custom-sync runs failed" "3 failed syncs in 24 h"
if ! grep -qF 'actions/runs/1,' <<<"$d_summary" && ! grep -qF 'actions/runs/1)' <<<"$d_summary"; then ok "the feature-branch failure is not linked as a counted run"; else bad "summary links run 1: $d_summary"; fi
reset; page 1 1:failure:1:none 2:failure:2 3:failure:3; run schedule
expect_paused "a run without head_branch counts as custom (conservative on spend): 3, paused" "3 custom-sync runs failed" "3 failed syncs in 24 h"

# ---- a dispatch is never capped --------------------------------------------------------------------------------------------
reset; page 1 1:failure:1 2:failure:2 3:failure:3 4:failure:4 5:failure:5; run workflow_dispatch
expect_sync "a manual dispatch with 5 failed runs in 24 h is not capped"
if ! asked_runs; then ok "a dispatch does not even read the runs"; else bad "dispatch read the runs: $(cat "$tmp/gh.log")"; fi
reset; page 1 1:failure:1 2:failure:2 3:failure:3; run ""
expect_sync "no event name (a local run) is not capped"

# ---- an unknown count pauses -----------------------------------------------------------------------------------------------
reset; : > "$FIX/runs-fail"; run schedule
expect_paused "the runs API call fails: paused" "could not be counted (the runs API call failed" "could not be counted"
reset; echo '{"message":"Resource not accessible by integration","status":"403"}' > "$FIX/runs-page-1.json"; run schedule
expect_paused "a reply that is not a runs list (no workflow_runs) is never read as 'no runs': paused" "is not a list of runs" "could not be counted"
reset; echo 'not json <html>' > "$FIX/runs-page-1.json"; run schedule
expect_paused "a reply that is not JSON: paused" "could not be counted" "could not be counted"
reset; echo '{"total_count":1,"workflow_runs":[{"id":1,"conclusion":"failure","created_at":"yesterday"}]}' > "$FIX/runs-page-1.json"; run schedule
expect_paused "a run without a readable creation time: paused" "no readable id or creation time" "could not be counted"

# ---- pages --------------------------------------------------------------------------------------------------------------------
reset; page 1 fill:100:success; page 2 1:failure:1 2:failure:2 3:failure:3; run schedule
expect_paused "a full first page: the second one is read, and its 3 failures pause" "3 custom-sync runs failed" "3 failed syncs"
if grep -qF 'page=2' "$tmp/gh.log" && ! grep -qF 'page=3' "$tmp/gh.log"; then ok "page 2 is read, page 3 is not (page 2 was not full)"; else bad "pages: $(cat "$tmp/gh.log")"; fi
reset; page 1 fill:100:success; page 2 fill:100:success; EXTRA=SYNC_CAP_MAX_PAGES=2 run schedule
expect_paused "the page bound is hit (every page full): the count is unknown, paused" "more than 200 runs" "could not be counted"

# ---- the cap is checked last: quiet stops stay quiet --------------------------------------------------------------------------
reset; echo '[{"tag_name":"v0.9.0","draft":false,"prerelease":false}]' > "$FIX/releases.json"; page 1 1:failure:1 2:failure:2 3:failure:3; run schedule
if [ "$d_rc" = 0 ] && [ "$(out_of proceed)" = false ] && grep -qF 'newest upstream release is v0.9.0' <<<"$(out_of reason)" && ! asked_runs && [ -z "$d_summary" ]; then ok "nothing new upstream: the usual quiet stop, the runs are not read, no pause message"
else bad "quiet stop: reason=[$(out_of reason)] summary=[$d_summary] log=[$(cat "$tmp/gh.log")]"; fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
