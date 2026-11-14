#!/usr/bin/env bash
# Publish the chosen candidate: push the sync branch (the ONLY branch this workflow pushes), open the PR,
# post the gates commit status, then retire superseded sync PRs. Never force-pushes, never pushes tags, never
# touches the base branch. Runs git and gh only; no repository code is executed here.
#
# Env: GH_TOKEN, REPO (owner/name), FACTS (sync-facts.json of the chosen round), PR_OUT (output of make-pr-body.sh),
#      SUPERSEDE (JSON array of PR numbers), ORPHAN_BRANCH (true/false), RUN_URL
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${GH_TOKEN:?}" "${REPO:?}" "${FACTS:?}" "${PR_OUT:?}"
SUPERSEDE="${SUPERSEDE:-[]}"
branch="$(jq -r .branch "$FACTS")"; base_branch="$(jq -r .base_branch "$FACTS")"; merge_sha="$(jq -r .merge_sha "$FACTS")"
[[ "$branch" == sync/* || "$branch" == sync-test/* ]] || die "refusing to push '$branch': only sync/* and sync-test/* branches are allowed"
git rev-parse -q --verify "refs/heads/$branch" >/dev/null || die "branch $branch does not exist locally"
[ "$(git rev-parse "refs/heads/$branch")" = "$merge_sha" ] || die "local $branch is not the merge commit from the facts"

# A leftover branch with no PR (an interrupted earlier run) is deleted first so the push can stay a plain push.
if [ "${ORPHAN_BRANCH:-false}" = true ]; then
  warn "deleting orphan branch $branch (no PR was ever opened for it)"
  gh api -X DELETE "repos/$REPO/git/refs/heads/$branch"
fi
git push origin "refs/heads/$branch:refs/heads/$branch" || die "push of $branch was rejected (see above; if it names a workflow file, the token lacks the workflows permission)"

title="$(cat "$PR_OUT/pr-title.txt")"
draft="$(jq -r .draft "$PR_OUT/pr-meta.json")"
existing_labels="$(gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name')"
args=(--repo "$REPO" --base "$base_branch" --head "$branch" --title "$title" --body-file "$PR_OUT/pr-body.md")
[ "$draft" != true ] || args+=(--draft)
for l in $(jq -r '.labels[]' "$PR_OUT/pr-meta.json"); do
  if grep -qxF -- "$l" <<<"$existing_labels"; then args+=(--label "$l"); else warn "label '$l' does not exist in $REPO; create it to get it applied"; fi
done
pr_url="$(gh pr create "${args[@]}")"
pr_number="${pr_url##*/}"
log "opened $pr_url (draft=$draft)"
gh_out pr_url "$pr_url"
gh_out pr_number "$pr_number"

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
     && jq -e '.author.login | test("^(app/)?github-actions(\\[bot\\])?$")' <<<"$info" >/dev/null; then
    old_branch="$(jq -r '.headRefName' <<<"$info")"
    gh pr close "$n" --repo "$REPO" --comment "Superseded by $pr_url (upstream $(jq -r .tag "$FACTS")). This branch is deleted." >/dev/null
    gh api -X DELETE "repos/$REPO/git/refs/heads/$old_branch" >/dev/null || warn "could not delete $old_branch"
    log "closed superseded PR #$n and deleted $old_branch"
  else
    warn "PR #$n no longer looks like a superseded sync PR; left alone"
  fi
done
