#!/usr/bin/env bash
# Publish the chosen candidate: push the sync branch (the ONLY branch this workflow pushes), open the PR,
# post the gates commit status, then retire superseded sync PRs. Never force-pushes, never pushes tags, never
# touches the base branch. Runs git and gh only; no repository code is executed here.
#
# Three situations besides the plain first run:
#   - REPLACE_PR (a stale PR of the SAME branch, found by detect-release.sh): the PR is re-checked against the facts detect saw
#     (still open, same repo, against the base branch, opened by the automation, head still the commit detect judged), and only then
#     closed with the superseded marker comment, its branch deleted, and the new candidate pushed to the same branch name and opened
#     as a new PR. If the PR changed in the meantime (a person pushed to it while the sync ran) NOTHING is closed, deleted or pushed:
#     the job ends green without a PR, with a warning and a summary line, and `land` (which needs pr_number) does not run.
#   - ORPHAN_BRANCH: a leftover branch with no PR is deleted first so the push stays a plain push.
#   - GITHUB_RUN_ATTEMPT > 1 (a re-run of the failed jobs re-runs this job too, rerun-infra-failures.sh relies on it): when the first
#     attempt already opened the PR for this very merge commit, that PR is adopted (title, body, draft state and labels refreshed
#     from the new gate results) instead of failing on `gh pr create`. A different candidate cannot be pushed over an existing
#     branch (no force-push), so then the job fails as it always did.
#
# Outputs: pr_url, pr_number, merge_sha, draft (custom-sync's land job reads them).
# Env: GH_TOKEN, REPO (owner/name), FACTS (sync-facts.json of the chosen round), PR_OUT (output of make-pr-body.sh),
#      SUPERSEDE (JSON array of PR numbers), ORPHAN_BRANCH (true/false), REPLACE_PR and REPLACE_HEAD (stale PR to replace), RUN_URL
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
# shellcheck source=stale-sync-pr.sh
. "$(dirname "$0")/stale-sync-pr.sh"

: "${GH_TOKEN:?}" "${REPO:?}" "${FACTS:?}" "${PR_OUT:?}"
SUPERSEDE="${SUPERSEDE:-[]}"
REPLACE_PR="${REPLACE_PR:-}"
REPLACE_HEAD="${REPLACE_HEAD:-}"
branch="$(jq -r .branch "$FACTS")"; base_branch="$(jq -r .base_branch "$FACTS")"; merge_sha="$(jq -r .merge_sha "$FACTS")"
[[ "$branch" == sync/* || "$branch" == sync-test/* ]] || die "refusing to push '$branch': only sync/* and sync-test/* branches are allowed"
git rev-parse -q --verify "refs/heads/$branch" >/dev/null || die "branch $branch does not exist locally"
[ "$(git rev-parse "refs/heads/$branch")" = "$merge_sha" ] || die "local $branch is not the merge commit from the facts"

title="$(cat "$PR_OUT/pr-title.txt")"
draft="$(jq -r .draft "$PR_OUT/pr-meta.json")"
existing_labels="$(gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name')"
labels=()
for l in $(jq -r '.labels[]' "$PR_OUT/pr-meta.json"); do
  if grep -qxF -- "$l" <<<"$existing_labels"; then labels+=("$l"); else warn "label '$l' does not exist in $REPO; create it to get it applied"; fi
done

say() { printf '%s\n' "$*" >&2; if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"; fi; }
branch_exists() { gh api "repos/$REPO/git/ref/heads/$branch" >/dev/null 2>&1; }

# ---- a re-run of this job: adopt the PR the first attempt opened for the same commit --------------------------------------
adopted=""
if [[ "${GITHUB_RUN_ATTEMPT:-1}" =~ ^[0-9]+$ ]] && [ "${GITHUB_RUN_ATTEMPT:-1}" -gt 1 ]; then
  adopted="$(gh pr list --repo "$REPO" --state open --head "$branch" --base "$base_branch" --limit 5 --json number,url,headRefOid \
    | jq -c --arg sha "$merge_sha" '[.[] | select(.headRefOid == $sha)] | first // empty')"
fi

if [ -n "$adopted" ]; then
  pr_number="$(jq -r '.number' <<<"$adopted")"; pr_url="$(jq -r '.url' <<<"$adopted")"
  log "attempt $GITHUB_RUN_ATTEMPT: adopting PR #$pr_number that attempt 1 opened for $merge_sha"
  edit=(--repo "$REPO" --title "$title" --body-file "$PR_OUT/pr-body.md")
  for l in ${labels[@]+"${labels[@]}"}; do edit+=(--add-label "$l"); done
  gh pr edit "$pr_number" "${edit[@]}" >/dev/null
  if [ "$draft" = true ]; then
    [ "$(gh pr view "$pr_number" --repo "$REPO" --json isDraft --jq .isDraft)" = true ] || gh pr ready "$pr_number" --repo "$REPO" --undo >/dev/null
  else
    [ "$(gh pr view "$pr_number" --repo "$REPO" --json isDraft --jq .isDraft)" = false ] || gh pr ready "$pr_number" --repo "$REPO" >/dev/null
  fi
else
  # ---- replace a stale PR of the same branch --------------------------------------------------------------------------------
  if [ -n "$REPLACE_PR" ]; then
    [[ "$branch" == sync/* ]] || die "refusing to replace a PR on '$branch': only sync/* branches are replaced"
    [[ "$REPLACE_PR" =~ ^[0-9]+$ ]] && [ -n "$REPLACE_HEAD" ] || die "REPLACE_PR='$REPLACE_PR' REPLACE_HEAD='$REPLACE_HEAD' are not a PR number and a head sha"
    info="$(gh pr view "$REPLACE_PR" --repo "$REPO" --json state,headRefName,headRefOid,baseRefName,isCrossRepository,author)" \
      || die "could not read PR #$REPLACE_PR to re-check it before replacing it"
    left_alone=""
    case "$(jq -r '.state' <<<"$info")" in
      OPEN)
        if [ "$(jq -r '.isCrossRepository' <<<"$info")" != false ]; then left_alone="it comes from a fork"
        elif [ "$(jq -r '.headRefName' <<<"$info")" != "$branch" ]; then left_alone="its head branch is not $branch"
        elif [ "$(jq -r '.baseRefName' <<<"$info")" != "$base_branch" ] || [ "$base_branch" != custom ]; then left_alone="its base is not custom"
        elif ! jq -e --arg re "$AUTOMATION_LOGIN_RE" '(.author.login // "") | test($re)' <<<"$info" >/dev/null; then left_alone="it was not opened by the automation"
        elif [ "$(jq -r '.headRefOid' <<<"$info")" != "$REPLACE_HEAD" ]; then
          left_alone="its head moved from ${REPLACE_HEAD:0:10} to $(jq -r '.headRefOid' <<<"$info" | cut -c1-10) while the sync ran (a person pushed to it?)"
        fi
        if [ -z "$left_alone" ]; then
          gh pr close "$REPLACE_PR" --repo "$REPO" --comment "$(superseded_comment)" >/dev/null
          log "closed stale PR #$REPLACE_PR (head ${REPLACE_HEAD:0:10}); replacing it with a sync from the current $base_branch"
        fi
        ;;
      CLOSED) # an earlier attempt of this very job got this far: carry on only when the automation closed it
        pr_closed_by_us "$REPO" "$REPLACE_PR" || left_alone="it is closed and its last comment is not the automation's superseded marker"
        ;;
      *) left_alone="it is $(jq -r '.state' <<<"$info")" ;;
    esac
    if [ -n "$left_alone" ]; then
      warn "PR #$REPLACE_PR was meant to be replaced but is left alone: $left_alone. Nothing was closed, deleted or pushed."
      say "### custom-sync: no PR opened for $branch"
      say "Stale PR #$REPLACE_PR was left alone because $left_alone. Look at that PR; the sync this run made was thrown away."
      exit 0
    fi
    ORPHAN_BRANCH=true # the old PR's branch has to go before the new one can take its name
  fi

  # A leftover branch with no PR (an interrupted earlier run) is deleted first so the push can stay a plain push.
  if [ "${ORPHAN_BRANCH:-false}" = true ] && branch_exists; then
    if [ -n "$REPLACE_PR" ]; then warn "deleting $branch (the head of replaced PR #$REPLACE_PR)"; else warn "deleting orphan branch $branch (no PR was ever opened for it)"; fi
    gh api -X DELETE "repos/$REPO/git/refs/heads/$branch"
  fi
  git push origin "refs/heads/$branch:refs/heads/$branch" || die "push of $branch was rejected (see above; if it names a workflow file, the token lacks the workflows permission)"

  args=(--repo "$REPO" --base "$base_branch" --head "$branch" --title "$title" --body-file "$PR_OUT/pr-body.md")
  [ "$draft" != true ] || args+=(--draft)
  for l in ${labels[@]+"${labels[@]}"}; do args+=(--label "$l"); done
  pr_url="$(gh pr create "${args[@]}")"
  pr_number="${pr_url##*/}"
fi
log "opened $pr_url (draft=$draft)"
gh_out pr_url "$pr_url"
gh_out pr_number "$pr_number"
gh_out merge_sha "$merge_sha" # for the land job: the head the gates ran on
gh_out draft "$draft"

# PRs opened with the workflow token do not trigger pull_request workflows, so required checks would sit at
# "expected" forever. A commit status under the check's name carries the result of the gates we ran ourselves.
status="$(jq -r .gates_status "$PR_OUT/pr-meta.json")"
case "$status" in success) desc="Gates passed in the sync run" ;; failure) desc="Gates failed or merge unresolved: see the PR body" ;; *) desc="Gates were not run" ;; esac
[ "$status" != pending ] || status=error
for ctx in "gates / static" "gates / e2e" "gates / result"; do
  gh api "repos/$REPO/statuses/$merge_sha" -f state="$status" -f context="$ctx" -f description="$desc" -f target_url="${RUN_URL:-}" >/dev/null \
    || warn "could not post the commit status '$ctx'"
done

# Retire superseded sync PRs only now that the replacement exists. Re-verify each one before touching it.
for n in $(jq -r '.[]' <<<"$SUPERSEDE"); do
  info="$(gh pr view "$n" --repo "$REPO" --json state,headRefName,isCrossRepository,author,baseRefName)"
  if [ "$(jq -r '.state' <<<"$info")" = OPEN ] && [ "$(jq -r '.isCrossRepository' <<<"$info")" = false ] \
     && [[ "$(jq -r '.headRefName' <<<"$info")" == sync/* ]] && [ "$(jq -r '.baseRefName' <<<"$info")" = "$base_branch" ] \
     && jq -e --arg re "$AUTOMATION_LOGIN_RE" '.author.login | test($re)' <<<"$info" >/dev/null; then
    old_branch="$(jq -r '.headRefName' <<<"$info")"
    gh pr close "$n" --repo "$REPO" --comment "Superseded by $pr_url (upstream $(jq -r .tag "$FACTS")). This branch is deleted." >/dev/null
    gh api -X DELETE "repos/$REPO/git/refs/heads/$old_branch" >/dev/null || warn "could not delete $old_branch"
    log "closed superseded PR #$n and deleted $old_branch"
  else
    warn "PR #$n no longer looks like a superseded sync PR; left alone"
  fi
done
