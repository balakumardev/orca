#!/usr/bin/env bash
# Re-run the failed jobs of our own workflow runs when the failure was the runner's fault, not the code's. Runs in
# custom-rerun-infra.yml every 15 minutes. Needs gh and jq. Reads runs, jobs and check-run annotations; its only write is
# `gh run rerun <id> --failed`.
#
# Why: GitHub-hosted macOS jobs often end with the annotation "The job was not acquired by Runner of type hosted even after
# multiple attempts" (conclusion `cancelled`, after 15 minutes), or lose the runner ("lost communication", "received a shutdown
# signal"). Re-running the failed job fixes it every time, but nothing did that, so a PR gate stayed red and a sync stayed
# unlanded until a person clicked "re-run".
#
# WHAT IS RE-RUN: a completed run of custom-pr-gates.yml or custom-sync.yml (custom-agent.yml and custom-gates.yml are called by those
# two and are part of their runs) that failed or was cancelled, finished in the last LOOKBACK_HOURS (6), is in attempt 3 or lower
# (`run_attempt < MAX_ATTEMPTS`, 4: a persistent outage ends after the fourth attempt), comes from this repository (a fork's run is
# not ours to re-run), and passes ALL of these:
#   - At least one failed job has an infrastructure annotation OF ITS OWN (INFRA_RE below). A run is never re-run on a hunch.
#   - No other failed job is a real failure. A failed job counts as real unless its own annotations are infrastructure, or it was
#     only cancelled (no annotation, or only "The operation was canceled"/"The run was canceled": cancelled because a sibling failed
#     or a person cancelled) or it is the aggregating `result` job of custom-gates.yml, whose failure in a pull request is derived
#     by design from `static` and `e2e` (it exits 1 whenever one of them did not succeed) and says nothing by itself. A job that was
#     cancelled for exceeding `timeout-minutes` has an annotation of its own and counts as real. An annotation that cannot be read
#     counts as real.
#   - The run was not cancelled by a newer run of its concurrency group ("higher priority waiting request" in an annotation).
#   - custom-sync only: every infrastructure job is one whose re-run is coherent: detect, merge, the gates of round 0 and round 3,
#     open-pr, land. GitHub re-runs a failed job AND every job that depends on it, and the dependents of the gates of round 1 or 2
#     (and of the agent rounds and pick3) are PAID model rounds that would produce another candidate than the one open-pr already
#     published (a pushed branch is never overwritten): that case stays for a person. open-pr.sh adopts the PR its first attempt
#     opened (GITHUB_RUN_ATTEMPT > 1), so a re-run of round 0 or round 3 gates ends in `land`.
# custom-release.yml is NEVER re-run here: a release is an outside effect (a tag, a GitHub release, an asset the installed apps
# download), its `plan` job reserves the version number N once, and a later re-run of an old run could publish an old commit under
# a number a newer run also planned. A failed release build is visible in Actions and one command re-dispatches it
# (see the skill fork-release-and-sync).
#
# Env: GH_TOKEN, REPO (owner/name). Optional: DRY_RUN=true (decide and print, re-run nothing), LOOKBACK_HOURS, MAX_ATTEMPTS,
#      NOW_EPOCH (tests), GITHUB_STEP_SUMMARY. Exit 0 whatever it decided; non-zero only when the run list cannot be read.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${GH_TOKEN:?}" "${REPO:?}"
DRY_RUN="${DRY_RUN:-false}"
LOOKBACK_HOURS="${LOOKBACK_HOURS:-6}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-4}"
RUN_WINDOW_HOURS=48 # how far back runs are LISTED (a sync run can be created hours before it finishes); LOOKBACK_HOURS judges the finish
NOW_EPOCH="${NOW_EPOCH:-$(date +%s)}"
for v in LOOKBACK_HOURS MAX_ATTEMPTS NOW_EPOCH; do [[ "${!v}" =~ ^[0-9]+$ ]] || die "$v must be a number (got '${!v}')"; done

# Annotations that name a fault of the runner machinery. Matched case-insensitively against title and message of one annotation.
INFRA_RE='not acquired by Runner|lost communication|received a shutdown signal|runner has received a shutdown|The self-hosted runner'
SUPERSEDED_RE='higher priority waiting request'
NEUTRAL_CANCEL_RE='^[[:space:]]*(the operation was canceled|the run was canceled)'
DERIVED_JOB_RE='(^|/ )result$'

# Workflows we re-run and, for each, which infrastructure jobs may be re-run (a regex on the job name; the API names a job of a
# called workflow "<caller job> / <job>").
allowed_jobs_re() {
  case "$1" in
    .github/workflows/custom-pr-gates.yml) printf '%s' '.*' ;;
    .github/workflows/custom-sync.yml) printf '%s' '^(detect|merge|gates \(round [03]\) / .+|open-pr|land)$' ;;
    *) return 1 ;;
  esac
}
PATHS_JSON='[".github/workflows/custom-pr-gates.yml", ".github/workflows/custom-sync.yml"]'

summary() { printf '%s\n' "$*" >&2; if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"; fi; }

since="$(jq -nr --argjson t "$((NOW_EPOCH - RUN_WINDOW_HOURS * 3600))" '$t | todate')"
runs="$(gh api "repos/$REPO/actions/runs?status=completed&per_page=100&created=%3E%3D$since" --jq '.workflow_runs')" \
  || die "could not list the workflow runs of $REPO"
candidates="$(jq -c --argjson now "$NOW_EPOCH" --argjson hours "$LOOKBACK_HOURS" --argjson max "$MAX_ATTEMPTS" --argjson paths "$PATHS_JSON" --arg repo "$REPO" '
  [.[] | (.path | sub("@.*$"; "")) as $p
       | select(.conclusion == "failure" or .conclusion == "cancelled")
       | select($paths | index($p))
       | select((.head_repository.full_name // $repo) == $repo)
       | select((.updated_at | fromdateiso8601) >= ($now - $hours * 3600))
       | select(.run_attempt < $max)
       | {id, name, path: $p, attempt: .run_attempt, conclusion}]' <<<"$runs")"

n_runs="$(jq 'length' <<<"$candidates")"
log "$n_runs failed or cancelled run(s) of our workflows finished in the last ${LOOKBACK_HOURS}h below attempt $MAX_ATTEMPTS"
reran=0

# annotation_text JOB_ID: one line per annotation (title and message, newlines flattened). Fails when they cannot be read.
annotation_text() {
  gh api "repos/$REPO/check-runs/$1/annotations?per_page=100" --paginate \
    --jq '.[] | ((.title // "") + " " + (.message // "")) | gsub("[\r\n]+"; " ")'
}

# judge_run RUN_JSON: sets verdict (rerun|skip) and why.
judge_run() {
  local run="$1" id path jobs failed allowed name concl jid text kind
  local -a infra_names=() blockers=()
  id="$(jq -r '.id' <<<"$run")"; path="$(jq -r '.path' <<<"$run")"
  verdict=skip why=""
  allowed="$(allowed_jobs_re "$path")" || { why="not a workflow this script re-runs"; return 0; }
  jobs="$(gh api "repos/$REPO/actions/runs/$id/jobs?filter=latest&per_page=100" --paginate --jq '.jobs[] | {id, name, conclusion}' | jq -s '.')" \
    || { why="could not list its jobs"; return 0; }
  failed="$(jq -c '.[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out")' <<<"$jobs")"
  [ -n "$failed" ] || { why="no failed job in the latest attempt"; return 0; }
  while IFS= read -r job; do
    name="$(jq -r '.name' <<<"$job")"; concl="$(jq -r '.conclusion' <<<"$job")"; jid="$(jq -r '.id' <<<"$job")"
    if [[ "$name" =~ $DERIVED_JOB_RE ]]; then continue; fi
    if ! text="$(annotation_text "$jid")"; then blockers+=("$name (annotations unreadable)"); continue; fi
    if grep -qiE "$SUPERSEDED_RE" <<<"$text"; then why="cancelled by a newer run of its concurrency group ($name)"; return 0; fi
    if grep -qiE "$INFRA_RE" <<<"$text"; then infra_names+=("$name"); continue; fi
    kind=real
    if [ "$concl" = cancelled ] && [ -z "$(grep -viE "$NEUTRAL_CANCEL_RE" <<<"$text" | tr -d '[:space:]' || true)" ]; then kind=neutral; fi
    if [ "$kind" = real ]; then blockers+=("$name ($concl)"); fi
  done <<<"$failed"
  if [ "${#blockers[@]}" -gt 0 ]; then why="a failed job is not an infrastructure fault: ${blockers[*]}"; return 0; fi
  if [ "${#infra_names[@]}" -eq 0 ]; then why="no failed job carries an infrastructure annotation"; return 0; fi
  for name in "${infra_names[@]}"; do
    if ! [[ "$name" =~ $allowed ]]; then
      why="infrastructure fault in '$name', whose re-run would also re-run paid or non-repeatable dependents; left for a person"; return 0
    fi
  done
  verdict=rerun
  why="infrastructure fault in: ${infra_names[*]}"
}

if [ "$n_runs" -gt 0 ]; then
  while IFS= read -r run; do
    verdict=skip why=""
    judge_run "$run"
    id="$(jq -r '.id' <<<"$run")"; label="run $id $(jq -r '.name' <<<"$run") (attempt $(jq -r '.attempt' <<<"$run"), $(jq -r '.conclusion' <<<"$run"))"
    if [ "$verdict" = rerun ]; then
      if [ "$DRY_RUN" = true ]; then
        summary "would re-run $label: $why"
      elif gh run rerun "$id" --repo "$REPO" --failed >/dev/null; then
        summary "re-ran the failed jobs of $label: $why"; reran=$((reran + 1))
      else
        warn "could not re-run $label (already running, too old, or not allowed)"
      fi
    else
      log "skip $label: $why"
    fi
  done < <(jq -c '.[]' <<<"$candidates")
fi
summary "custom-rerun-infra: $n_runs candidate run(s), $reran re-run$([ "$DRY_RUN" = true ] && echo ' (dry run: none sent)' || true)"
