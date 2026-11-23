#!/usr/bin/env bash
# Publish the chosen candidate: push the sync branch (the ONLY branch this workflow pushes), open the PR,
# post the gates commit status, then retire superseded sync PRs. Never force-pushes, never pushes tags, never
# touches the base branch. Runs git and gh only; no repository code is executed here.
#
# Situations besides the plain first run:
#   - REPLACE_PR (a stale PR of the SAME branch, found by detect-release.sh): the PR is re-checked against the facts detect saw
#     (still open, same repo, against the base branch, opened by the automation, READY not a draft, head still the commit detect
#     judged), and only then closed with the superseded marker comment, its branch deleted, and the new candidate pushed to the same
#     branch name and opened as a new PR. If the PR changed in the meantime (a person pushed to it or turned it into a draft while the
#     sync ran) NOTHING is closed, deleted or pushed: the job ends green without a PR, with a warning and a summary line, and `land`
#     (which needs pr_number) does not run.
#   - ORPHAN_BRANCH: a leftover branch with no PR is deleted first so the push stays a plain push.
#   - A branch is DELETED only on proof, read from GitHub right before the delete (the tip is read again each time, never trusted from
#     earlier): the tip is exactly the commit detect saw (REPLACE_HEAD for the replaced PR, ORPHAN_SHA for a leftover branch) AND no
#     other open PR of this repository, against any base, has the branch as its head (deleting a branch closes every PR that has it as
#     its head, without a comment, and detect would then read the PR as closed by a person). Otherwise (a person pushed since, an
#     earlier attempt of this run published another candidate and opened a PR) NOTHING is deleted or pushed and the job ends green
#     without a PR, like the replace guard. A tip that already is this run's merge commit is not deleted and not pushed again.
#   - An open PR for this very merge commit (an earlier attempt opened it; a re-run of the failed jobs, which rerun-infra-failures.sh
#     relies on, runs this job again) is adopted, on any attempt: title, body, draft state and labels refreshed from the new gate
#     results, instead of failing on `gh pr create`.
#
# Outputs: pr_url, pr_number, merge_sha, draft, needs_review, review_reasons (custom-sync's land job reads them).
# Env: GH_TOKEN, REPO (owner/name), FACTS (sync-facts.json of the chosen round), PR_OUT (output of make-pr-body.sh),
#      SUPERSEDE (JSON array of PR numbers), ORPHAN_BRANCH (true/false), ORPHAN_SHA (the commit the leftover branch held when detect
#      looked), REPLACE_PR and REPLACE_HEAD (stale PR to replace), RUN_URL
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
# shellcheck source=stale-sync-pr.sh
. "$(dirname "$0")/stale-sync-pr.sh"

: "${GH_TOKEN:?}" "${REPO:?}" "${FACTS:?}" "${PR_OUT:?}"
SUPERSEDE="${SUPERSEDE:-[]}"
REPLACE_PR="${REPLACE_PR:-}"
REPLACE_HEAD="${REPLACE_HEAD:-}"
ORPHAN_SHA="${ORPHAN_SHA:-}"
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
# End green without a PR (no pr_number output, so `land` does not run): something on GitHub is not what detect saw.
bail() {
  warn "$1 No branch is deleted or pushed from here on and no PR is opened."
  say "### custom-sync: no PR opened for $branch"
  say "$1 Look at the branch and its PRs; the sync this run made was thrown away."
  exit 0
}
# The commit the branch points at right now; empty when it does not exist (or the read failed: then nothing is ever deleted, and a
# plain push is rejected when the branch does exist).
branch_tip() { branch_sha "$REPO" "$branch"; }
# Open PRs of THIS repository whose head is the sync branch, against any base. `gh pr list --head` also returns a fork's PR that uses
# the same branch name; it is not ours and does not hold our branch, so it is dropped.
open_prs_of_branch() {
  gh pr list --repo "$REPO" --state open --head "$branch" --limit 30 --json number,url,headRefOid,baseRefName,isCrossRepository \
    | jq -c '[.[] | select(.isCrossRepository != true)]'
}
# check_branch_may_go: reads the tip and the open PRs NOW and sets BRANCH_TIP and BRANCH_BLOCKER (why the branch must not be deleted;
# empty when it may go or is already free or already holds this run's commit). Call it as a plain statement, right before the delete.
BRANCH_TIP="" BRANCH_BLOCKER=""
check_branch_may_go() {
  local others expected
  BRANCH_BLOCKER=""
  BRANCH_TIP="$(branch_tip)"
  if [ -z "$BRANCH_TIP" ] || [ "$BRANCH_TIP" = "$merge_sha" ]; then return 0; fi
  others="$(open_prs_of_branch | jq -r --arg n "${REPLACE_PR:-0}" '[.[] | select((.number | tostring) != $n) | "#\(.number)"] | join(", ")')"
  if [ -n "$others" ]; then
    BRANCH_BLOCKER="$branch (now at ${BRANCH_TIP:0:10}) is the head of open PR $others, which is not the PR being replaced"
    return 0
  fi
  [ "${ORPHAN_BRANCH:-false}" = true ] || return 0 # nothing is deleted on this path; the plain push below is rejected when the branch exists
  if [ -n "$REPLACE_PR" ]; then expected="$REPLACE_HEAD"; else expected="$ORPHAN_SHA"; fi
  if [ -z "$expected" ]; then
    BRANCH_BLOCKER="detect did not say which commit $branch held (it is at ${BRANCH_TIP:0:10} now)"
  elif [ "$BRANCH_TIP" != "$expected" ]; then
    BRANCH_BLOCKER="$branch moved from ${expected:0:10} (what detect saw) to ${BRANCH_TIP:0:10}: a person pushed to it, or an earlier attempt of this run published another candidate"
  fi
}

# ---- the model API turned every round away and nothing is resolved: no PR, a red run ----------------------------------------
# A draft PR for this tag would end the search of every later sync (an open PR is the answer, a draft is never replaced), so after the
# balance or the key is fixed nothing would retry it. With no PR the next scheduled sync starts the tag over by itself.
if jq -e '.unresolved == true and ((.agent.rounds // []) | length > 0) and all(.agent.rounds[]; ((.api_status // 0) >= 401 and (.api_status // 0) <= 403))' "$FACTS" >/dev/null; then
  refused="$(jq -r '[.agent.rounds[].api_status] | max' "$FACTS")"
  model_api_refused "$refused" || die "the facts of $branch carry an api_status that is not a refusal: '$refused'"
  printf '::error title=No PR opened: the model API refused every round::HTTP %s on every model round of %s, nothing was resolved. Fix the DeepInfra balance or DEEPINFRA_API_KEY; the next scheduled sync starts this tag over by itself.\n' "$refused" "$branch" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### custom-sync: no PR opened for %s\nThe model API refused every round (HTTP %s) and nothing was resolved. A draft PR would block the retry, so none was opened. Fix the DeepInfra balance or DEEPINFRA_API_KEY; the next scheduled sync starts this tag over.\n' "$branch" "$refused" >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

# ---- an open PR for this very commit: a first attempt opened it, adopt it ----------------------------------------------------
adopted=""
if [ "$(branch_tip)" = "$merge_sha" ]; then
  adopted="$(open_prs_of_branch | jq -c --arg sha "$merge_sha" --arg b "$base_branch" '[.[] | select(.headRefOid == $sha and .baseRefName == $b)] | first // empty')"
fi

if [ -n "$adopted" ]; then
  pr_number="$(jq -r '.number' <<<"$adopted")"; pr_url="$(jq -r '.url' <<<"$adopted")"
  log "attempt ${GITHUB_RUN_ATTEMPT:-1}: adopting PR #$pr_number that an earlier attempt opened for $merge_sha"
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
    info="$(gh pr view "$REPLACE_PR" --repo "$REPO" --json state,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,author)" \
      || die "could not read PR #$REPLACE_PR to re-check it before replacing it"
    ORPHAN_BRANCH=true # the old PR's branch has to go before the new one can take its name
    left_alone=""
    case "$(jq -r '.state' <<<"$info")" in
      OPEN)
        if [ "$(jq -r '.isCrossRepository' <<<"$info")" != false ]; then left_alone="it comes from a fork"
        elif [ "$(jq -r '.headRefName' <<<"$info")" != "$branch" ]; then left_alone="its head branch is not $branch"
        elif [ "$(jq -r '.baseRefName' <<<"$info")" != "$base_branch" ] || [ "$base_branch" != custom ]; then left_alone="its base is not custom"
        elif ! jq -e --arg re "$AUTOMATION_LOGIN_RE" '(.author.login // "") | test($re)' <<<"$info" >/dev/null; then left_alone="it was not opened by the automation"
        elif [ "$(jq -r '.isDraft' <<<"$info")" != false ]; then left_alone="it is a draft now (its gates failed or a person is working on it); only a ready PR is replaced"
        elif [ "$(jq -r '.headRefOid' <<<"$info")" != "$REPLACE_HEAD" ]; then
          left_alone="its head moved from ${REPLACE_HEAD:0:10} to $(jq -r '.headRefOid' <<<"$info" | cut -c1-10) while the sync ran (a person pushed to it?)"
        fi
        if [ -z "$left_alone" ]; then # before closing anything: would its branch be free to delete?
          check_branch_may_go
          left_alone="$BRANCH_BLOCKER"
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
  fi

  # A leftover branch (the replaced PR's, or an interrupted run's with no PR) is deleted first so the push can stay a plain push,
  # but only on proof (see the header): the tip is read again here, right before the delete.
  check_branch_may_go
  [ -z "$BRANCH_BLOCKER" ] || bail "$branch is left alone: $BRANCH_BLOCKER."
  if [ "${ORPHAN_BRANCH:-false}" = true ] && [ -n "$BRANCH_TIP" ] && [ "$BRANCH_TIP" != "$merge_sha" ]; then
    if [ -n "$REPLACE_PR" ]; then warn "deleting $branch (the head of replaced PR #$REPLACE_PR)"; else warn "deleting orphan branch $branch (no PR was ever opened for it)"; fi
    gh api -X DELETE "repos/$REPO/git/refs/heads/$branch"
  fi
  if [ "$BRANCH_TIP" = "$merge_sha" ]; then
    log "$branch already holds $merge_sha (an earlier attempt pushed it): not pushing again"
  else
    git push origin "refs/heads/$branch:refs/heads/$branch" || die "push of $branch was rejected (see above; if it names a workflow file, the token lacks the workflows permission)"
  fi

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
gh_out needs_review "$(jq -r '.needs_review // false' "$PR_OUT/pr-meta.json")"
gh_out review_reasons "$(jq -r '(.review_reasons // []) | join("; ")' "$PR_OUT/pr-meta.json" | tr -d '\000-\037' | cut -c1-400)"

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
