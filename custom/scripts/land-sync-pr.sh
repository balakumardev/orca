#!/usr/bin/env bash
# Land the upstream sync PR by itself when every gate is green, then request the release. Runs in the `land` job of
# custom-sync.yml (the only job that may merge or dispatch) after open-pr.sh opened the PR. Git is not used: gh and jq only.
#
# What it does, in this order; each failed check ends the script before the next step:
#   1. Guards (a second layer behind the job's `if:`): a scheduled run, or a dispatch with an EMPTY `ref`, on refs/heads/custom,
#      with base branch custom, not a rehearsal, a release tag, a sync/vX.Y.Z branch. Anything else dies with zero gh calls.
#   2. The PR is not a draft, and the gates of the CHOSEN round finished green: its custom-gates job result is `success` and its
#      `failed` output is the number 0 (the output counts a crashed gate job as a failure; gates.json files do not).
#   3. The PR is still the one opened (open, base custom, same-repo, head == MERGE_SHA) and the tip of custom is still BASE_SHA
#      (read once, right before the check-run, so a decline never leaves a green attested check behind).
#   4. Post the check-run `gates / result` (conclusion success) on MERGE_SHA. Commit statuses cannot satisfy the required check,
#      which is pinned to the GitHub Actions app; a check-run made with the workflow token belongs to that app.
#   5. Merge with a MERGE COMMIT pinned to MERGE_SHA (never squash, rebase, --admin or --auto) and verify: PR merged, the merge
#      commit's parents are exactly BASE_SHA and MERGE_SHA, and custom's tip is that commit.
#   6. Ask for the release ONCE: `gh workflow run custom-release.yml --ref custom` with sign, notarize and publish true. A merge made
#      with the workflow token does not start the release's `push:` trigger, so this dispatch is the only request. It is skipped
#      when ANY run of custom-release.yml on custom already exists for the merge commit, pushed or dispatched (a re-run of this
#      job, or a person's merge landing in the same minute, must not release twice).
# Not landing is not an error when the reason is expected (draft, red gates, custom moved): exit 0, the reason goes to the job
# summary and to a PR comment, and the PR stays open for a human. An unexpected error exits non-zero and never dispatches.
#
# Env: GH_TOKEN REPO PR_NUMBER MERGE_SHA BASE_SHA ROUND BRANCH BASE_BRANCH IS_TEST TAG_IS_RELEASE INPUT_REF DRAFT
#      NEEDS_REVIEW ("true" = a person reads the PR first) REVIEW_REASONS (one line)
#      GATES_RESULT ("0=success 1=skipped ..." job results by round) GATES_FAILED ("0=0 1= ..." failed outputs by round)
#      RUN_URL TAG; from the runner: GITHUB_EVENT_NAME GITHUB_REF GITHUB_STEP_SUMMARY. LAND_NAP = seconds between polls (default 5).
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

# ---- 1. guards -------------------------------------------------------------------------------------------------------------
refuse() { die "refusing to land: $1"; }
case "${GITHUB_EVENT_NAME:-}" in
  schedule) ;;
  workflow_dispatch) [ -z "${INPUT_REF:-}" ] || refuse "the run was started with ref='${INPUT_REF}' (a rehearsal)" ;;
  *) refuse "event '${GITHUB_EVENT_NAME:-}' is not a scheduled or dispatched run" ;;
esac
[ "${GITHUB_REF:-}" = refs/heads/custom ] || refuse "the run is on '${GITHUB_REF:-}', not refs/heads/custom"
[ "${BASE_BRANCH:-}" = custom ] || refuse "the base branch is '${BASE_BRANCH:-}', not custom"
[ "${IS_TEST:-}" = false ] || refuse "this is a rehearsal (is_test='${IS_TEST:-}')"
[ "${TAG_IS_RELEASE:-}" = true ] || refuse "the ref is not an upstream release tag"
[[ "${BRANCH:-}" =~ ^sync/v[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse "'${BRANCH:-}' is not a sync/vX.Y.Z branch"
: "${GH_TOKEN:?}" "${REPO:?}" "${PR_NUMBER:?}" "${MERGE_SHA:?}" "${BASE_SHA:?}" "${ROUND:?}"
[[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || refuse "PR number '$PR_NUMBER' is not a number"
DRAFT="${DRAFT:-}" GATES_RESULT="${GATES_RESULT:-}" GATES_FAILED="${GATES_FAILED:-}" RUN_URL="${RUN_URL:-}" TAG="${TAG:-$BRANCH}"
RELEASE_CMD="gh workflow run custom-release.yml --repo $REPO --ref custom -f sign=true -f notarize=true -f publish=true"

say() { printf '%s\n' "$*" >&2; if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"; fi; }
comment() { gh pr comment "$PR_NUMBER" --repo "$REPO" --body "$1" >/dev/null || warn "could not comment on PR #$PR_NUMBER"; }
nap() { sleep "${LAND_NAP:-5}"; }
tip() { local r; r="$(gh api "repos/$REPO/git/ref/heads/custom")" && jq -r '.object.sha' <<<"$r"; }
view() { local r; r="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json "$1")" && jq -r "$2" <<<"$r"; }
# decline REASON: expected reasons not to land. Nothing was changed; a human takes the PR from here.
decline() {
  say "### custom-sync landing: not landed ($TAG)"
  say "$1"
  comment "Not merged automatically: $1 The PR is left open for a human."
  exit 0
}
# fail REASON: an unexpected error. The job turns red; nothing after this point runs.
fail() {
  say "### custom-sync landing: FAILED ($TAG)"
  say "$1"
  comment "Automatic landing stopped: $1"
  die "$1"
}

# ---- 2. draft and gates ----------------------------------------------------------------------------------------------------
if [ "$DRAFT" != false ]; then
  say "### custom-sync landing: not landed ($TAG)"
  say "The PR is a draft (gates failed or the merge is unresolved); the PR body says which. Left for a human."
  exit 0
fi
# shellcheck disable=SC2086 # word splitting of the "round=value" list is the point
pick() { local pair; for pair in $1; do if [ "${pair%%=*}" = "$2" ]; then printf '%s' "${pair#*=}"; return 0; fi; done; }
result="$(pick "$GATES_RESULT" "$ROUND")"
failed="$(pick "$GATES_FAILED" "$ROUND")"
gates_note="gate round $ROUND: job result '${result:-none}', failed gates '${failed:-none}'"
if [ "$result" != success ] || ! [[ "$failed" =~ ^[0-9]+$ ]] || [ "$failed" -ne 0 ]; then
  decline "the gates did not all pass ($gates_note)."
fi

# A model decided something the gates cannot judge (it deleted a file of ours, or lines of our customizations are missing from a
# merged file): a person reads the PR first. review-needed.sh decides, make-pr-body.sh records it, open-pr.sh passes it on.
if [ "${NEEDS_REVIEW:-}" = true ]; then
  decline "a person must read this PR before it merges (${REVIEW_REASONS:-see the caveats in the PR body}). Every gate passed; this is not a failure. Merge it with a merge commit when it is right, then run the custom-release workflow on custom with sign, notarize and publish set to true."
fi

# ---- 3. the PR and the tip of custom ---------------------------------------------------------------------------------------
pr="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json state,isDraft,baseRefName,headRefName,headRefOid,isCrossRepository)" \
  || fail "could not read PR #$PR_NUMBER. This run merged nothing."
jq -e --arg sha "$MERGE_SHA" --arg branch "$BRANCH" \
  '.state == "OPEN" and .isDraft == false and .baseRefName == "custom" and .headRefName == $branch and .headRefOid == $sha and .isCrossRepository == false' \
  <<<"$pr" >/dev/null || fail "PR #$PR_NUMBER is not the open PR this run created (not open, a draft, another base or branch, a fork, or its head is not ${MERGE_SHA:0:10}). This run merged nothing; if the PR is already merged, an earlier attempt of this job did it: check that the release was requested."
now="$(tip)" || fail "could not read the tip of custom. This run merged nothing."
[ "$now" = "$BASE_SHA" ] || decline "custom moved from ${BASE_SHA:0:10} to ${now:0:10} while the sync ran, so the gates ran against an old base. If nobody pushes to this branch, the next scheduled sync closes this PR and syncs again from the current custom; pushing to the branch (or closing the PR) takes it over."

# ---- 4. the required check -------------------------------------------------------------------------------------------------
summary="custom-sync ran the gates on this merge commit (mode sync: static and e2e jobs of custom-gates.yml): $gates_note.${RUN_URL:+ Run: $RUN_URL}"
jq -n --arg sha "$MERGE_SHA" --arg url "$RUN_URL" --arg summary "$summary" \
  '{name: "gates / result", head_sha: $sha, status: "completed", conclusion: "success",
    output: {title: "Gates passed in the custom-sync run", summary: $summary}} + (if $url == "" then {} else {details_url: $url} end)' \
  | gh api "repos/$REPO/check-runs" --method POST --input - >/dev/null \
  || fail "could not post the gates / result check-run. This run merged nothing."

# ---- 5. merge and verify ---------------------------------------------------------------------------------------------------
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do # the required check can take a moment to count
  mstate="$(view mergeStateStatus .mergeStateStatus)" || mstate=UNKNOWN
  case "$mstate" in BLOCKED | UNKNOWN | '') nap ;; *) break ;; esac
done
case "$mstate" in
  BEHIND | DIRTY) fail "PR #$PR_NUMBER cannot be merged as it stands (merge state $mstate). This run merged nothing." ;;
esac
if ! out="$(gh pr merge "$PR_NUMBER" --repo "$REPO" --merge --match-head-commit "$MERGE_SHA" 2>&1)"; then
  [ "$(view state .state || true)" = MERGED ] || fail "GitHub refused the merge: ${out:0:400}. This run merged nothing."
  warn "gh pr merge reported an error but the PR is merged; going on to verify it"
fi
merged=""
for _ in 1 2 3 4 5 6; do
  merged="$(view mergeCommit,state 'select(.state == "MERGED") | .mergeCommit.oid // empty' || true)"
  [ -z "$merged" ] || break
  nap
done
[ -n "$merged" ] || fail "PR #$PR_NUMBER does not show as merged after the merge call. Check it; no release was requested."
commit="$(gh api "repos/$REPO/git/commits/$merged")" || fail "could not read merge commit ${merged:0:10}. The PR is merged; no release was requested."
parents="$(jq -r '[.parents[].sha] | join(" ")' <<<"$commit")"
[ "$parents" = "$BASE_SHA $MERGE_SHA" ] \
  || fail "the PR is merged as ${merged:0:10}, but its parents are '$parents', not custom $BASE_SHA and the checked head $MERGE_SHA. No release was requested; look at custom."
now="$(tip)" || now=""
[ "$now" = "$merged" ] || fail "the PR is merged as ${merged:0:10}, but the tip of custom is '${now:0:10}'. custom moved again; no release was requested (a later push releases by itself)."
say "### custom-sync landing: merged ($TAG)"
say "PR #$PR_NUMBER merged as ${merged:0:10} ($gates_note). Requesting the release."
comment "Merged automatically by custom-sync: every gate passed (${gates_note}). Merge commit ${merged:0:10}. The release is requested next.${RUN_URL:+ Run: $RUN_URL}"

# ---- 6. the release, exactly once ------------------------------------------------------------------------------------------
release_requested() { # a custom-release run on custom for the merge commit exists, whatever started it (push or dispatch)
  local r n
  r="$(gh api "repos/$REPO/actions/workflows/custom-release.yml/runs?head_sha=$merged&branch=custom")" || return 1
  n="$(jq -r '.total_count' <<<"$r")"
  [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -gt 0 ]
}
dispatch() { gh workflow run custom-release.yml --repo "$REPO" --ref custom -f sign=true -f notarize=true -f publish=true; }
request_release() {
  if release_requested; then say "A release run for ${merged:0:10} already exists; not requesting another."; return 0; fi
  if dispatch; then return 0; fi
  warn "the release dispatch failed; checking whether it started a run anyway"
  nap
  if release_requested; then return 0; fi
  dispatch
}
request_release || die "PR #$PR_NUMBER is merged as ${merged:0:10} but the release could not be requested. Run: $RELEASE_CMD"
say "Release requested."
