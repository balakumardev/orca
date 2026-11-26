#!/usr/bin/env bash
# The spend cap of scheduled syncs. Source it after lib.sh; detect-release.sh asks it right before a sync would start. gh and jq only,
# and it never writes anything.
#
# Why: a sync whose agent rounds crash and leave no candidate opens no PR and fails (open-pr.sh), so the next scheduled sync starts the
# tag over by itself. A crash that repeats the same way would then spend paid model rounds every 3 hours (up to about $24 a run: three
# Flash hours) with nobody told. So a SCHEDULED run stops when 3 or more runs of custom-sync.yml from the custom branch
# (`head_branch`) created in the last 24 hours ended `failure` (this run excluded): at most about 3 x $24 a day. Only runs from custom count: the model rounds (the
# spend) exist only on refs/heads/custom (the `agent` environment), and a rehearsal dispatched from a feature branch that fails must
# never pause the real schedule. A manual dispatch is never capped (a person decided to spend),
# and the pause ends by itself once the failures are older than 24 hours. A count that cannot be read (the API call fails, the reply is
# not the runs list, a page bound is hit) pauses too: never sync on an unknown count.
#
# sync_spend_cap REPO sets, for the caller:
#   SYNC_CAP_STOP     reason to stop (empty: go on)
#   SYNC_CAP_SUMMARY  the markdown for the job summary when stopped
# Env: GITHUB_EVENT_NAME (only `schedule` is capped), GITHUB_RUN_ID (this run, never counted), NOW_EPOCH (tests), SYNC_CAP_MAX_PAGES.

# shellcheck disable=SC2034 # the SYNC_CAP_* variables are the results the sourcing script reads
SYNC_CAP_FAILURES=3
SYNC_CAP_WINDOW_HOURS=24
SYNC_CAP_STOP=""
SYNC_CAP_SUMMARY=""

sync_spend_cap() {
  local repo="$1" now since me page reply runs="[]" n failed ids max_pages="${SYNC_CAP_MAX_PAGES:-5}" full=true why=""
  SYNC_CAP_STOP="" SYNC_CAP_SUMMARY=""
  [ "${GITHUB_EVENT_NAME:-}" = schedule ] || return 0
  local resume="dispatch it by hand to retry now: \`gh workflow run custom-sync.yml --repo $repo --ref custom\`"
  now="${NOW_EPOCH:-$(date +%s)}"
  me="${GITHUB_RUN_ID:-0}"
  if ! [[ "$now" =~ ^[0-9]+$ && "$me" =~ ^[0-9]+$ && "$max_pages" =~ ^[0-9]+$ ]]; then
    why="NOW_EPOCH, GITHUB_RUN_ID or SYNC_CAP_MAX_PAGES is not a number"
  else
    since="$(jq -nr --argjson t "$((now - SYNC_CAP_WINDOW_HOURS * 3600))" '$t | todate')"
    for ((page = 1; page <= max_pages; page++)); do
      # One small object per page, checked below: a reply without a runs list is never read as "no runs".
      reply="$(gh api "repos/$repo/actions/workflows/custom-sync.yml/runs?per_page=100&page=$page&created=%3E%3D$since" \
        --jq 'if (.workflow_runs | type) == "array" then {ok: true, runs: [.workflow_runs[] | {id, conclusion, created_at, head_branch}]} else {ok: false} end' 2>/dev/null)" \
        || { why="the runs API call failed (page $page)"; break; }
      if ! jq -e '.ok == true and (.runs | type) == "array"' <<<"$reply" >/dev/null 2>&1; then why="the runs API reply is not a list of runs (page $page)"; break; fi
      runs="$(jq -c --argjson acc "$runs" '$acc + .runs' <<<"$reply")" || { why="the runs API reply could not be read (page $page)"; break; }
      if [ "$(jq '.runs | length' <<<"$reply")" -lt 100 ]; then full=false; break; fi
    done
    if [ -z "$why" ] && [ "$full" = true ]; then why="more than $((max_pages * 100)) runs in ${SYNC_CAP_WINDOW_HOURS} h, more than this check reads"; fi
  fi
  if [ -z "$why" ]; then
    # Counted here, not trusted to the API's filter: created in the window, ended `failure`, run from custom, not this run. A run whose
    # fields cannot be read makes the count unknown. A run with no head_branch counts as custom (conservative on spend).
    failed="$(jq -c --argjson me "$me" --argjson from "$((now - SYNC_CAP_WINDOW_HOURS * 3600))" '
      [.[] | select((.id | type) == "number" and .id != $me and .conclusion == "failure" and (.head_branch // "custom") == "custom"
        and ((.created_at | fromdateiso8601) >= $from)) | .id]' <<<"$runs" 2>/dev/null)" \
      || why="a run in the runs API reply has no readable id or creation time"
  fi
  if [ -n "$why" ]; then
    SYNC_CAP_STOP="scheduled syncs are paused: the failed custom-sync runs of the last ${SYNC_CAP_WINDOW_HOURS} h could not be counted ($why)"
    SYNC_CAP_SUMMARY="### custom-sync paused: failed runs could not be counted
The failed custom-sync runs of the last ${SYNC_CAP_WINDOW_HOURS} h could not be counted ($why), so this scheduled sync did not start: it never syncs on an unknown count, because repeated failures can spend paid model rounds (worst case about 3 x \$24 a day). It resumes by itself when the runs API answers again; $resume."
    return 0
  fi
  n="$(jq 'length' <<<"$failed")"
  log "spend cap: $n failed custom-sync run(s) created in the last ${SYNC_CAP_WINDOW_HOURS} h (cap $SYNC_CAP_FAILURES, this run $me not counted)"
  [ "$n" -ge "$SYNC_CAP_FAILURES" ] || return 0
  ids="$(jq -r --arg r "$repo" '(.[0:5] | map("https://github.com/\($r)/actions/runs/\(.)") | join(", ")) + (if length > 5 then ", ..." else "" end)' <<<"$failed")"
  SYNC_CAP_STOP="scheduled syncs are paused: $n custom-sync runs failed in the last ${SYNC_CAP_WINDOW_HOURS} h (cap $SYNC_CAP_FAILURES)"
  SYNC_CAP_SUMMARY="### custom-sync paused: $n failed syncs in ${SYNC_CAP_WINDOW_HOURS} h
$n custom-sync runs failed in the last ${SYNC_CAP_WINDOW_HOURS} h, so scheduled syncs are paused to cap model spend (worst case about 3 x \$24 a day). Read the failed runs ($ids), fix the cause, then $resume. Scheduled syncs resume by themselves when the failures age out of the ${SYNC_CAP_WINDOW_HOURS} h window."
}
