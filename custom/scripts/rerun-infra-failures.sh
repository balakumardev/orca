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
#     only cancelled (no annotation, or only "The operation was canceled": cancelled because a sibling failed) or it is the
#     aggregating `result` job of custom-gates.yml, whose failure in a pull request is derived by design from `static` and `e2e`
#     (it exits 1 whenever one of them did not succeed) and says nothing by itself. A job that was cancelled for exceeding
#     `timeout-minutes` has an annotation of its own and counts as real. An annotation that cannot be read counts as real.
#   - NO PERSON cancelled the run: any annotation "... canceled by @<someone>" (on ANY failed job, the derived `result` job and a job
#     that also carries an infrastructure annotation included) means somebody pressed "Cancel workflow" and said stop. Re-running it
#     could let open-pr and land merge and release what that person stopped. The run is never re-run, however many of its other jobs
#     were "not acquired". Any other "The run was canceled" wording that does not name who is not trusted as neutral either.
#   - The run was not cancelled by a newer run of its concurrency group ("higher priority waiting request" in an annotation).
#   - custom-pr-gates only: its pull request is still OPEN and its head is still the run's head_sha. A re-run attempt joins the
#     concurrency group of its PR (custom-pr-gates-<PR>, cancel-in-progress: true), so re-running the run of an OLD head would CANCEL
#     the run a newer push started, leaving the newer head with no `gates / result`. A run with no PR attached is skipped.
#     (custom-sync's group has cancel-in-progress false: a re-run can only displace a pending scheduled run, which comes back in 3 hours.)
#   - custom-sync only: no NEWER custom-sync run exists (created after this one, in any state: queued, running or done). A re-run
#     replays the detect outputs of the old run (its BASE_SHA, its replace_pr), spends the three paid agent rounds again and can
#     open a PR for a tag a newer run already synced or merged; it would also take the one pending slot of the concurrency group
#     from the newer run. The newer run (every 3 hours at the latest) decides again from the current state of custom.
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
# The runs are listed PER WORKFLOW (`actions/workflows/<file>/runs`, paginated), not repository-wide: the repository-wide list is
# newest first and capped, and this workflow's own runs (every 15 minutes) and every other workflow would push ours out of it.
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
PERSON_CANCEL_RE='(canceled|cancelled) by @'
NEUTRAL_CANCEL_RE='^[[:space:]]*the operation was canceled'
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
# Every run (any status: a NEWER run that is still queued or running matters) of each workflow we re-run, one small object per line.
runs=""
for wf in $(jq -r '.[]' <<<"$PATHS_JSON"); do
  one="$(gh api "repos/$REPO/actions/workflows/${wf##*/}/runs?per_page=100&created=%3E%3D$since" --paginate \
    --jq '.workflow_runs[] | {id, name, path: (.path | sub("@.*$"; "")), status, conclusion, run_attempt, head_sha, created_at, updated_at, repo: (.head_repository.full_name // null), pr: (.pull_requests[0].number // null)}')" \
    || die "could not list the runs of $wf in $REPO"
  runs="$runs$one"$'\n'
done
candidates="$(jq -c -s --argjson now "$NOW_EPOCH" --argjson hours "$LOOKBACK_HOURS" --argjson max "$MAX_ATTEMPTS" --arg repo "$REPO" '
  . as $all
  | [.[] | select(.status == "completed" and (.conclusion == "failure" or .conclusion == "cancelled"))
       | select((.repo // $repo) == $repo)
       | select((.updated_at | fromdateiso8601) >= ($now - $hours * 3600))
       | select(.run_attempt < $max)
       | . as $r
       | {id, name, path, attempt: .run_attempt, conclusion, head_sha, pr,
          newer: ([$all[] | select(.path == $r.path and .id != $r.id and ((.created_at | fromdateiso8601) > ($r.created_at | fromdateiso8601)))] | length)}]' <<<"$runs")"

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
  local run="$1" id path jobs failed allowed name concl jid text kind pr sha cur newer derived
  local -a infra_names=() blockers=()
  id="$(jq -r '.id' <<<"$run")"; path="$(jq -r '.path' <<<"$run")"
  verdict=skip why=""
  allowed="$(allowed_jobs_re "$path")" || { why="not a workflow this script re-runs"; return 0; }
  newer="$(jq -r '.newer // 0' <<<"$run")"
  if [ "$path" = .github/workflows/custom-sync.yml ] && [ "$newer" -gt 0 ]; then
    why="$newer newer custom-sync run(s) exist: a re-run would replay this run's old detect outputs and take the place of the newer one"; return 0
  fi
  jobs="$(gh api "repos/$REPO/actions/runs/$id/jobs?filter=latest&per_page=100" --paginate --jq '.jobs[] | {id, name, conclusion}' | jq -s '.')" \
    || { why="could not list its jobs"; return 0; }
  failed="$(jq -c '.[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out")' <<<"$jobs")"
  [ -n "$failed" ] || { why="no failed job in the latest attempt"; return 0; }
  while IFS= read -r job; do
    name="$(jq -r '.name' <<<"$job")"; concl="$(jq -r '.conclusion' <<<"$job")"; jid="$(jq -r '.id' <<<"$job")"
    derived=false; if [[ "$name" =~ $DERIVED_JOB_RE ]]; then derived=true; fi
    if ! text="$(annotation_text "$jid")"; then
      if [ "$derived" = false ]; then blockers+=("$name (annotations unreadable)"); fi
      continue
    fi
    # Read for every failed job, the derived `result` job too: where a person's cancel is written is not ours to choose.
    if grep -qiE "$PERSON_CANCEL_RE" <<<"$text"; then why="a person cancelled the run ($name): it is theirs to restart"; return 0; fi
    if grep -qiE "$SUPERSEDED_RE" <<<"$text"; then why="cancelled by a newer run of its concurrency group ($name)"; return 0; fi
    if [ "$derived" = true ]; then continue; fi
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
  if [ "$path" = .github/workflows/custom-pr-gates.yml ]; then
    pr="$(jq -r '.pr // empty' <<<"$run")"; sha="$(jq -r '.head_sha // empty' <<<"$run")"
    if [ -z "$pr" ] || [ -z "$sha" ]; then why="no pull request is attached to the run"; return 0; fi
    cur="$(gh api "repos/$REPO/pulls/$pr" --jq '.state + " " + .head.sha')" || { why="could not read PR #$pr"; return 0; }
    if [ "$cur" != "open $sha" ]; then
      why="PR #$pr is no longer open at ${sha:0:10} ($cur): a re-run would cancel the run of its newer head"; return 0
    fi
  fi
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
