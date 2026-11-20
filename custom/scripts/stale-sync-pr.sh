#!/usr/bin/env bash
# What to do about an existing pull request for the sync branch of a release tag. Source it after lib.sh. gh and jq only, and it
# never writes anything: detect-release.sh asks it, open-pr.sh (which does the closing) asks again right before it acts.
#
# Why: a sync PR could never heal itself. `custom` moves while a sync runs (a person merges another PR), `land` then refuses to
# merge, the PR stays open, and detect stopped on "a PR already exists" for ever. Now a STALE PR that nobody touched is closed with a
# marker comment and the tag is synced again from the current custom, on the same branch name sync/<tag>.
#
# SAFETY: every one of these must hold, otherwise the PR is left alone and the reason is said.
#   - The PR is OPEN, from this repository, against custom, opened by the automation, READY (not a draft) and the only open PR for
#     the branch. A draft is a sync PR whose gates failed or whose merge needs a person ("[gates failed]", "[needs manual merge]"),
#     or one a person turned back into a draft: `land` declines it because it is red, not because custom moved, and a person may be
#     working on it locally, so it is never replaced. PRs of a FORK that happen to use the same branch name are not ours: `gh pr
#     list --head <name>` returns them too, and they are dropped before anything is counted.
#   - Its head commit is untouched automation output: the merge commit sync-merge.sh made for THIS upstream commit (author and
#     committer are the automation, `Orca-Custom-Patch: upstream-sync`, `Upstream commit: <sha>`), whose second parent is the link
#     commit on top of that upstream commit. A commit a person pushes (a fix, "Update branch", a merge of custom) becomes the new
#     head and fails this. Why the head and not "every commit of the PR is by the automation": the PR also carries every upstream
#     commit between the two release tags (written by upstream's people), upstream's own release commit has the SAME identity as
#     ours (its release bot is github-actions too), and GitHub lists at most 250 commits of a PR; such a scan always refuses or
#     proves nothing. The two commits are read through `git/commits/<sha>` (what land-sync-pr.sh reads too), NEVER `commits/<sha>`:
#     that one computes the commit's files and stats against its first parent, and for a sync merge that is the whole upstream delta
#     (26606 files on v1.4.265), which is slow or times out, and a read that fails leaves the PR alone for ever. Fields are top-level.
#   - STALE: custom has commits the head lacks. The merge's first parent (custom when the sync started) is a proper ancestor of the
#     current tip and not the tip. (A compare of custom...head would carry the whole upstream release as a diff; P...tip is two
#     custom commits.)
#   - Fewer than SYNC_PR_RETRY_CAP earlier PRs of this branch name were closed by this automation (a closed PR whose LAST comment is
#     the marker below, written by the automation). A PR closed any other way is a person's "no" and stops the search as before.
#
# classify_sync_prs REPO BRANCH BASE_BRANCH BASE_SHA UPSTREAM_SHA sets, for the caller:
#   SYNC_PR_STOP           reason to stop (empty: go on)
#   SYNC_PR_REPLACE        number of the stale PR to replace (empty: none), SYNC_PR_REPLACE_HEAD its head sha at the time of the check
# Both stay empty when no PR exists for the branch, which is the ordinary case.

# shellcheck disable=SC2034 # the SYNC_PR_* variables are the results the sourcing script reads
SUPERSEDED_MARKER='<!-- custom-sync:superseded -->'
SUPERSEDED_TEXT='superseded: custom moved on, syncing again'
SYNC_PR_RETRY_CAP=3
SYNC_PR_WHY=""
SYNC_PR_FIRST_PARENT=""

# The comment that closes a replaced PR: visible text plus the marker that later runs count attempts by.
superseded_comment() { printf '%s\n\n%s\n' "$SUPERSEDED_TEXT" "$SUPERSEDED_MARKER"; }

# pr_closed_by_us REPO NUMBER: the LAST comment of the PR is the automation's superseded comment. Any doubt (an API error, no
# comment, a person's comment after it) is "no", which keeps the search stopped.
pr_closed_by_us() {
  local last
  last="$(gh api "repos/$1/issues/$2/comments?per_page=100" --paginate --jq '.[] | {login: .user.login, body: .body}' | jq -s 'last // empty')" || return 1
  [ -n "$last" ] || return 1
  jq -e --arg re "$AUTOMATION_LOGIN_RE" --arg m "$SUPERSEDED_MARKER" \
    '((.login // "") | test($re)) and ((.body // "") | contains($m))' <<<"$last" >/dev/null
}

# head_is_untouched REPO HEAD_SHA UPSTREAM_SHA: the head is the automation's own merge for UPSTREAM_SHA, with nothing on top.
# On success SYNC_PR_FIRST_PARENT is the custom tip the sync started from; on failure SYNC_PR_WHY says why.
head_is_untouched() {
  local repo="$1" head="$2" up="$3" m link lk
  SYNC_PR_FIRST_PARENT="" SYNC_PR_WHY=""
  m="$(gh api "repos/$repo/git/commits/$head")" || { SYNC_PR_WHY="its head commit ${head:0:10} could not be read"; return 1; }
  if ! jq -e --arg e "$AUTOMATION_EMAIL" --arg u "$up" '
       (.message | split("\n")) as $lines
       | (.parents | length) == 2
         and .author.email == $e and .committer.email == $e
         and ($lines[0] | startswith("Merge upstream "))
         and ($lines | any(.[]; . == "Orca-Custom-Patch: upstream-sync"))
         and ($lines | any(.[]; startswith("Upstream commit: " + $u + " ")))' <<<"$m" >/dev/null; then
    SYNC_PR_WHY="its head commit ${head:0:10} is not the merge commit this automation made for upstream ${up:0:10} (a person pushed to the branch, or it holds another upstream commit)"
    return 1
  fi
  link="$(jq -r '.parents[1].sha' <<<"$m")"
  lk="$(gh api "repos/$repo/git/commits/$link")" || { SYNC_PR_WHY="the link commit ${link:0:10} under its head could not be read"; return 1; }
  if ! jq -e --arg e "$AUTOMATION_EMAIL" --arg u "$up" \
       '(.parents | length) == 2 and .parents[0].sha == $u and .author.email == $e and .committer.email == $e
        and (.message | startswith("Link upstream "))' <<<"$lk" >/dev/null; then
    SYNC_PR_WHY="the second parent ${link:0:10} of its head is not the automation's link commit for upstream ${up:0:10}"
    return 1
  fi
  SYNC_PR_FIRST_PARENT="$(jq -r '.parents[0].sha' <<<"$m")"
}

# classify_sync_prs REPO BRANCH BASE_BRANCH BASE_SHA UPSTREAM_SHA: see the header.
classify_sync_prs() {
  local repo="$1" branch="$2" base_branch="$3" base_sha="$4" up="$5"
  local prs attempts=0 num n_open pr head rel
  SYNC_PR_STOP="" SYNC_PR_REPLACE="" SYNC_PR_REPLACE_HEAD=""
  prs="$(gh pr list --repo "$repo" --state all --head "$branch" --limit 30 \
    --json number,state,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,author \
    | jq -c '[.[] | select(.isCrossRepository != true)]')"
  [ "$(jq 'length' <<<"$prs")" -gt 0 ] || return 0

  # A merged PR means custom/BASE moved on.
  num="$(jq -r '[.[] | select(.state == "MERGED") | .number] | first // empty' <<<"$prs")"
  if [ -n "$num" ]; then SYNC_PR_STOP="PR #$num (MERGED) already exists for $branch"; return 0; fi

  # Closed PRs: only the ones this automation closed as superseded are retry attempts; any other closed PR is a person's "no".
  for num in $(jq -r '.[] | select(.state == "CLOSED") | .number' <<<"$prs"); do
    if pr_closed_by_us "$repo" "$num"; then
      attempts=$((attempts + 1))
    else
      SYNC_PR_STOP="PR #$num (CLOSED) already exists for $branch; its last comment is not the automation's superseded marker, so a person closed it and it is never reopened or replaced"
      return 0
    fi
  done

  n_open="$(jq '[.[] | select(.state == "OPEN")] | length' <<<"$prs")"
  if [ "$n_open" -gt 1 ]; then
    SYNC_PR_STOP="$n_open open PRs ($(jq -r '[.[] | select(.state == "OPEN") | "#\(.number)"] | join(", ")' <<<"$prs")) already exist for $branch: left for a person"
    return 0
  fi

  if [ "$n_open" -eq 1 ]; then
    pr="$(jq -c '[.[] | select(.state == "OPEN")] | first' <<<"$prs")"
    num="$(jq -r '.number' <<<"$pr")"
    head="$(jq -r '.headRefOid' <<<"$pr")"
    SYNC_PR_STOP="PR #$num (OPEN) already exists for $branch"
    if [ "$base_branch" != custom ]; then SYNC_PR_STOP+=" (left alone: the base branch is $base_branch, not custom)"; return 0; fi
    if [ "$(jq -r '.isCrossRepository' <<<"$pr")" != false ]; then SYNC_PR_STOP+=" (left alone: it does not say it comes from this repository)"; return 0; fi
    if [ "$(jq -r '.baseRefName' <<<"$pr")" != "$base_branch" ]; then SYNC_PR_STOP+=" (left alone: its base is $(jq -r '.baseRefName' <<<"$pr"), not $base_branch)"; return 0; fi
    if ! jq -e --arg re "$AUTOMATION_LOGIN_RE" '(.author.login // "") | test($re)' <<<"$pr" >/dev/null; then
      SYNC_PR_STOP+=" (left alone: it was not opened by the automation)"; return 0
    fi
    if [ "$(jq -r '.isDraft' <<<"$pr")" != false ]; then
      SYNC_PR_STOP+=" (left alone: it is a draft, so its gates failed or a person is working on it; only a ready PR is replaced)"; return 0
    fi
    if ! head_is_untouched "$repo" "$head" "$up"; then SYNC_PR_STOP+=" (left alone: $SYNC_PR_WHY)"; return 0; fi
    if [ "$SYNC_PR_FIRST_PARENT" = "$base_sha" ]; then
      SYNC_PR_STOP+=" (current: $base_branch has not moved since the sync started)"; return 0
    fi
    rel="$(gh api "repos/$repo/compare/$SYNC_PR_FIRST_PARENT...$base_sha" --jq '.status')" || rel="unreadable"
    if [ "$rel" != ahead ]; then
      SYNC_PR_STOP+=" (left alone: could not show that $base_branch moved on from ${SYNC_PR_FIRST_PARENT:0:10}; compare says '$rel')"; return 0
    fi
    if [ "$attempts" -ge "$SYNC_PR_RETRY_CAP" ]; then
      SYNC_PR_STOP+=" and is stale again, but $attempts earlier PRs for $branch were already replaced (cap $SYNC_PR_RETRY_CAP): left for a person"; return 0
    fi
    SYNC_PR_STOP=""
    SYNC_PR_REPLACE="$num"
    SYNC_PR_REPLACE_HEAD="$head"
    log "PR #$num for $branch is stale ($base_branch moved on from ${SYNC_PR_FIRST_PARENT:0:10} to ${base_sha:0:10}) and untouched: it will be replaced (attempt $((attempts + 1)) of $((SYNC_PR_RETRY_CAP + 1)))"
    return 0
  fi

  # Nothing open: only closed superseded PRs are left. Count them.
  if [ "$attempts" -ge "$SYNC_PR_RETRY_CAP" ]; then
    SYNC_PR_STOP="$attempts earlier PRs for $branch were already closed as superseded (cap $SYNC_PR_RETRY_CAP): not syncing it again by itself"
  fi
}
