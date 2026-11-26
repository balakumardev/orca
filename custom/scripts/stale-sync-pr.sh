#!/usr/bin/env bash
# What to do about an existing pull request for the sync branch of a release tag. Source it after lib.sh. gh and jq only, and it
# never writes anything: detect-release.sh asks it, open-pr.sh (which does the closing) asks again right before it acts.
#
# Why: a sync PR could never heal itself. `custom` moves while a sync runs (a person merges another PR), `land` then refuses to
# merge, the PR stays open, and detect stopped on "a PR already exists" for ever. Now a STALE PR that nobody touched is closed with a
# marker comment and the tag is synced again from the current custom, on the same branch name sync/<tag>. The same goes for an old
# failed DRAFT that nobody touched (the rule is the last part of the safety list below).
#
# SAFETY: every one of these must hold, otherwise the PR is left alone and the reason is said.
#   - The PR is OPEN, from this repository, against custom, opened by the automation and the only open PR for the branch. PRs of a
#     FORK that happen to use the same branch name are not ours: `gh pr list --head <name>` returns them too, and they are dropped
#     before anything is counted.
#   - READY (not a draft) is the ordinary case below. A DRAFT is a sync PR whose gates failed or whose merge needs a person
#     ("[gates failed]", "[needs manual merge]"), or one a person turned back into a draft: `land` declines it because it is red, not
#     because custom moved, and a person may be working on it, so a draft is replaced only by the separate, stricter rule at the end of
#     this header ("an old FAILED DRAFT").
#   - Its head commit is untouched automation output: the merge commit sync-merge.sh made for THIS upstream commit (author and
#     committer are the automation, `Orca-Custom-Patch: upstream-sync`, `Upstream commit: <sha>`), whose second parent is the link
#     commit on top of that upstream commit. A commit a person pushes (a fix, "Update branch", a merge of custom) becomes the new
#     head and fails this. Why the head and not "every commit of the PR is by the automation": the PR also carries every upstream
#     commit between the two release tags (written by upstream's people), upstream's own release commit has the SAME identity as
#     ours (its release bot is github-actions too), and GitHub lists at most 250 commits of a PR; such a scan always refuses or
#     proves nothing. The two commits are read through `git/commits/<sha>` (what land-sync-pr.sh reads too), NEVER `commits/<sha>`:
#     that one computes the commit's files and stats against its first parent, and for a sync merge that is the whole upstream delta
#     (26606 files on v1.4.265), which is slow or times out, and a read that fails leaves the PR alone for ever. Fields are top-level.
#   - A READY PR is also STALE: custom has commits the head lacks. The merge's first parent (custom when the sync started) is a proper
#     ancestor of the current tip and not the tip. (A compare of custom...head would carry the whole upstream release as a diff;
#     P...tip is two custom commits.)
#   - Fewer than SYNC_PR_RETRY_CAP earlier PRs of this branch name were closed by this automation (a closed PR whose LAST comment is
#     the marker below, written by the automation). A PR closed any other way is a person's "no" and stops the search as before.
#
# An old FAILED DRAFT (2026-11-26; evidence: PR #75, v1.4.274: every model round died with its runner, the run left a draft with
# conflict markers, and that draft ended the search of every later sync until the owner marked it ready by hand). A draft is replaced
# too, by the same close-and-sync-again, when ALL of these hold (failed_draft_is_unattended, re-run by open-pr.sh right before it
# closes anything, because the sync takes hours):
#   - Its title is exactly what make-pr-body.mjs gives a failed candidate of this tag: "[needs manual merge] Sync upstream <tag>" or
#     "[gates failed] Sync upstream <tag>". Anything else is a person's draft (or a title a person edited).
#   - It is at least SYNC_DRAFT_MIN_AGE_HOURS (6) old, read from the PR's createdAt, so a person has had the time to look at it.
#   - Nobody but the automation acted on it: the issue events (labeled and unlabeled, renamed, convert_to_draft, ready_for_review,
#     head_ref_force_pushed, reviews requested, ...), the issue comments, the reviews and the inline review comments carry no login
#     other than the automation's. Any event of a person counts, however small; an author that cannot be read counts as a person; a
#     read that fails leaves the draft alone. (The head check above covers pushes.)
#   - Its description carries no key-leak banner (`> [!CAUTION]`, pr-body-key-leaks.mjs): a person has to rotate DEEPINFRA_API_KEY, and a
#     retry would put the same prompt in front of the model again.
#   - A draft needs no "stale": a failed draft is retried although custom has not moved. The first parent must still be custom's tip
#     or a proper ancestor of it (compare says ahead). The retry cap is the same and counts these closures too (the marker is shared), so
#     one tag gets at most SYNC_PR_RETRY_CAP automatic retries, whatever mix of stale and failed-draft replacements they are.
#   - A person keeps a failed draft by commenting on it, editing it or pushing to it at any time before it is replaced.
#
# classify_sync_prs REPO BRANCH BASE_BRANCH BASE_SHA UPSTREAM_SHA sets, for the caller:
#   SYNC_PR_STOP           reason to stop (empty: go on)
#   SYNC_PR_REPLACE        number of the PR to replace (empty: none), SYNC_PR_REPLACE_HEAD its head sha at the time of the check
#   SYNC_PR_REPLACE_DRAFT  true when that PR is an old failed draft (open-pr.sh then re-checks it as one), else false
#   SYNC_PR_REPLACE_RETRY  which automatic retry this replacement is (1 to SYNC_PR_RETRY_CAP), empty when nothing is replaced
# All stay empty when no PR exists for the branch, which is the ordinary case.

# shellcheck disable=SC2034 # the SYNC_PR_* variables are the results the sourcing script reads
SUPERSEDED_MARKER='<!-- custom-sync:superseded -->'
SUPERSEDED_TEXT='superseded: custom moved on, syncing again'
SYNC_PR_RETRY_CAP=3
# A failed draft is replaced only when it is at least this old (hours). Overridable for tests; NOW_EPOCH too.
SYNC_DRAFT_MIN_AGE_HOURS="${SYNC_DRAFT_MIN_AGE_HOURS:-6}"
SYNC_PR_WHY=""
SYNC_PR_FIRST_PARENT=""

# The comment that closes a replaced PR: visible text plus the marker that later runs count attempts by.
superseded_comment() { printf '%s\n\n%s\n' "$SUPERSEDED_TEXT" "$SUPERSEDED_MARKER"; }

# The comment that closes a replaced failed draft: it says what happened and how many automatic retries are left, and carries the SAME
# marker, so pr_closed_by_us counts it like any other closure. superseded_draft_comment RETRY (1 to SYNC_PR_RETRY_CAP).
superseded_draft_comment() {
  local retry="$1" left rest
  left=$((SYNC_PR_RETRY_CAP - retry))
  if [ "$left" -gt 0 ]; then rest="Automatic retries left after this one: $left."
  else rest="No automatic retry is left after this one: if it fails too, this tag waits for a person."; fi
  printf 'superseded: this was an unattended failed draft older than %s hours (nobody but the automation had commented on it, edited it or pushed to it), so the sync is retried automatically from the current custom. This is automatic retry %s of %s. %s To keep a failed draft, comment on it or push to it before the next sync.\n\n%s\n' \
    "$SYNC_DRAFT_MIN_AGE_HOURS" "$retry" "$SYNC_PR_RETRY_CAP" "$rest" "$SUPERSEDED_MARKER"
}

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

# first_person API_PATH ITEM_JQ: the first list element of a GitHub list endpoint whose author is not the automation, as "<what>\t<who>";
# nothing when every element is the automation's. ITEM_JQ turns one element into {who, what}; an element without a readable login counts
# as a person (who is empty). Fails when the list cannot be read.
first_person() {
  gh api "$1?per_page=100" --paginate --jq ".[] | $2" \
    | jq -s -r --arg re "$AUTOMATION_LOGIN_RE" '[.[] | select((.who | test($re)) | not)] | first // empty | "\(.what)\t\(.who)"'
}

# only_the_automation_acted REPO NUMBER: 0 when no person acted on the PR; else 1 and SYNC_PR_WHY says what (or that a list could not be
# read: never a licence to replace). Events, comments, reviews and inline review comments are four lists because none of them has the
# others: a review comment is in no issue list, a rename is in no comment list. Text from outside is cut to plain characters before it
# is put in a reason (reasons end in step outputs and annotations).
only_the_automation_acted() {
  local repo="$1" n="$2" found what who
  SYNC_PR_WHY=""
  found="$(first_person "repos/$repo/issues/$n/events" '{who: (.actor.login // ""), what: .event}')" \
    || { SYNC_PR_WHY="its event history could not be read"; return 1; }
  if [ -n "$found" ]; then
    IFS=$'\t' read -r what who <<<"$found"
    what="$(printf '%s' "$what" | tr -cd 'A-Za-z0-9_ -')"; who="$(printf '%s' "$who" | tr -cd 'A-Za-z0-9_ -')"
    case "$what" in
      convert_to_draft) SYNC_PR_WHY="a person (${who:-unknown}) turned it back into a draft" ;;
      ready_for_review) SYNC_PR_WHY="a person (${who:-unknown}) marked it ready for review" ;;
      renamed) SYNC_PR_WHY="a person (${who:-unknown}) edited its title" ;;
      labeled | unlabeled) SYNC_PR_WHY="a person (${who:-unknown}) changed its labels" ;;
      *) SYNC_PR_WHY="a person (${who:-unknown}) acted on it ($what)" ;;
    esac
    return 1
  fi
  found="$(first_person "repos/$repo/issues/$n/comments" '{who: (.user.login // ""), what: "comment"}')" \
    || { SYNC_PR_WHY="its comments could not be read"; return 1; }
  if [ -n "$found" ]; then SYNC_PR_WHY="a person ($(printf '%s' "${found#*$'\t'}" | tr -cd 'A-Za-z0-9_ -')) commented on it"; return 1; fi
  found="$(first_person "repos/$repo/pulls/$n/reviews" '{who: (.user.login // ""), what: "review"}')" \
    || { SYNC_PR_WHY="its reviews could not be read"; return 1; }
  if [ -n "$found" ]; then SYNC_PR_WHY="a person ($(printf '%s' "${found#*$'\t'}" | tr -cd 'A-Za-z0-9_ -')) reviewed it"; return 1; fi
  found="$(first_person "repos/$repo/pulls/$n/comments" '{who: (.user.login // ""), what: "review comment"}')" \
    || { SYNC_PR_WHY="its inline review comments could not be read"; return 1; }
  if [ -n "$found" ]; then SYNC_PR_WHY="a person ($(printf '%s' "${found#*$'\t'}" | tr -cd 'A-Za-z0-9_ -')) left a review comment on it"; return 1; fi
  return 0
}

# failed_draft_is_unattended REPO NUMBER BRANCH TITLE CREATED_AT: 0 when the draft is a failed sync of this tag that the automation made,
# is old enough and was touched by nobody but the automation (see the header); else 1 and SYNC_PR_WHY says why, always starting "it is a
# draft". Every read that fails answers "no". The head commit is NOT judged here: head_is_untouched does that, from the caller.
failed_draft_is_unattended() {
  local repo="$1" n="$2" tag="${3#sync/}" title="$4" created="$5" now born age body
  SYNC_PR_WHY=""
  [[ "$SYNC_DRAFT_MIN_AGE_HOURS" =~ ^[0-9]+$ ]] || die "SYNC_DRAFT_MIN_AGE_HOURS must be a number (got '$SYNC_DRAFT_MIN_AGE_HOURS')"
  if [ "$title" != "[needs manual merge] Sync upstream $tag" ] && [ "$title" != "[gates failed] Sync upstream $tag" ]; then
    SYNC_PR_WHY="it is a draft whose title is not one this automation gives a failed sync of $tag ('[needs manual merge] ...' or '[gates failed] ...'), so it is a person's draft"
    return 1
  fi
  now="${NOW_EPOCH:-$(date +%s)}"
  born="$(jq -n -r --arg t "$created" '$t | fromdateiso8601' 2>/dev/null)" || born=""
  if ! [[ "$now" =~ ^[0-9]+$ && "$born" =~ ^[0-9]+$ ]]; then SYNC_PR_WHY="it is a draft whose age could not be read"; return 1; fi
  age=$((now - born)); [ "$age" -ge 0 ] || age=0
  if [ "$age" -lt $((SYNC_DRAFT_MIN_AGE_HOURS * 3600)) ]; then
    SYNC_PR_WHY="it is a failed draft opened only $((age / 3600)) h $((age % 3600 / 60)) min ago: it is left for a person to look at until it is ${SYNC_DRAFT_MIN_AGE_HOURS} hours old"
    return 1
  fi
  body="$(gh pr view "$n" --repo "$repo" --json body --jq '.body // ""')" || { SYNC_PR_WHY="it is a draft whose description could not be read"; return 1; }
  if [[ "$body" == *'[!CAUTION]'* ]]; then
    SYNC_PR_WHY="it is a draft with a key-leak warning at the top of its description: a person must rotate DEEPINFRA_API_KEY and decide, a retry would show the model the same prompt"
    return 1
  fi
  if ! only_the_automation_acted "$repo" "$n"; then SYNC_PR_WHY="it is a draft and $SYNC_PR_WHY: it is a person's now"; return 1; fi
}

# classify_sync_prs REPO BRANCH BASE_BRANCH BASE_SHA UPSTREAM_SHA: see the header.
classify_sync_prs() {
  local repo="$1" branch="$2" base_branch="$3" base_sha="$4" up="$5"
  local prs attempts=0 num n_open pr head rel is_draft
  SYNC_PR_STOP="" SYNC_PR_REPLACE="" SYNC_PR_REPLACE_HEAD="" SYNC_PR_REPLACE_DRAFT="" SYNC_PR_REPLACE_RETRY=""
  prs="$(gh pr list --repo "$repo" --state all --head "$branch" --limit 30 \
    --json number,state,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,author,title,createdAt \
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
    # A PR that does not say whether it is a draft is treated as one.
    is_draft=true
    if [ "$(jq -r '.isDraft' <<<"$pr")" = false ]; then is_draft=false; fi
    if [ "$is_draft" = true ]; then
      # An old failed draft nobody but the automation touched is replaced too (the header says what that means); anything else stays.
      if ! failed_draft_is_unattended "$repo" "$num" "$branch" "$(jq -r '.title // ""' <<<"$pr")" "$(jq -r '.createdAt // ""' <<<"$pr")"; then
        SYNC_PR_STOP+=" (left alone: $SYNC_PR_WHY)"; return 0
      fi
    fi
    if ! head_is_untouched "$repo" "$head" "$up"; then SYNC_PR_STOP+=" (left alone: $SYNC_PR_WHY)"; return 0; fi
    if [ "$SYNC_PR_FIRST_PARENT" = "$base_sha" ]; then
      # A ready PR is current while custom has not moved; a failed draft failed whatever custom did, so it goes on to the cap.
      if [ "$is_draft" = false ]; then SYNC_PR_STOP+=" (current: $base_branch has not moved since the sync started)"; return 0; fi
    else
      rel="$(gh api "repos/$repo/compare/$SYNC_PR_FIRST_PARENT...$base_sha" --jq '.status')" || rel="unreadable"
      if [ "$rel" != ahead ]; then
        SYNC_PR_STOP+=" (left alone: could not show that $base_branch moved on from ${SYNC_PR_FIRST_PARENT:0:10}; compare says '$rel')"; return 0
      fi
    fi
    if [ "$attempts" -ge "$SYNC_PR_RETRY_CAP" ]; then
      if [ "$is_draft" = true ]; then
        SYNC_PR_STOP+=" and is an old unattended failed draft, but $attempts earlier PRs for $branch were already replaced (cap $SYNC_PR_RETRY_CAP): left for a person"; return 0
      fi
      SYNC_PR_STOP+=" and is stale again, but $attempts earlier PRs for $branch were already replaced (cap $SYNC_PR_RETRY_CAP): left for a person"; return 0
    fi
    SYNC_PR_STOP=""
    SYNC_PR_REPLACE="$num"
    SYNC_PR_REPLACE_HEAD="$head"
    SYNC_PR_REPLACE_DRAFT="$is_draft"
    SYNC_PR_REPLACE_RETRY="$((attempts + 1))"
    if [ "$is_draft" = true ]; then
      log "PR #$num for $branch is a failed draft older than ${SYNC_DRAFT_MIN_AGE_HOURS} hours that nobody but the automation touched: it will be replaced (automatic retry $((attempts + 1)) of $SYNC_PR_RETRY_CAP)"
    else
      log "PR #$num for $branch is stale ($base_branch moved on from ${SYNC_PR_FIRST_PARENT:0:10} to ${base_sha:0:10}) and untouched: it will be replaced (attempt $((attempts + 1)) of $((SYNC_PR_RETRY_CAP + 1)))"
    fi
    return 0
  fi

  # Nothing open: only closed superseded PRs are left. Count them.
  if [ "$attempts" -ge "$SYNC_PR_RETRY_CAP" ]; then
    SYNC_PR_STOP="$attempts earlier PRs for $branch were already closed as superseded (cap $SYNC_PR_RETRY_CAP): not syncing it again by itself"
  fi
}
