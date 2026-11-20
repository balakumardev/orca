#!/usr/bin/env bash
# Decide whether this run should raise a sync PR, and for which upstream commit.
#
# Needs: gh, jq. Env: GH_TOKEN, GITHUB_REPOSITORY, INPUT_REF (optional), INPUT_BASE_BRANCH (optional).
# Writes step outputs (see the gh_out calls); exits 0 even when there is nothing to do.
#
# Release selection: the HIGHEST semver among stable desktop releases (tag regex in lib.sh, not draft,
# not prerelease), not the newest published. Upstream tags are not ancestors of each other (every
# release is `main` plus a few release-only commits), so publication order says nothing about which
# tag contains which, while a higher version number always means a later cut.
#
# An existing PR for sync/<tag> ends the search (an open one is the answer, a merged one means custom/BASE moved on, one a person
# closed means "no"), with ONE exception that lets a sync heal itself: an open PR that is stale (custom moved on while it ran, so
# `land` refused it) and untouched automation output is replaced. This script only decides and reports it (outputs replace_pr and
# replace_head, orphan_branch true); open-pr.sh re-checks it and closes the PR. The rules and the safety guards are in stale-sync-pr.sh.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
# shellcheck source=stale-sync-pr.sh
. "$(dirname "$0")/stale-sync-pr.sh"

REPO="${GITHUB_REPOSITORY:?}"
BASE_BRANCH="${INPUT_BASE_BRANCH:-custom}"
REF="${INPUT_REF:-}"

valid_ref "$BASE_BRANCH" || die "base_branch is not a plain branch name"
[ -z "$REF" ] || valid_ref "$REF" || die "ref is not a plain ref name or sha"

stop() {
  log "Nothing to do: $1"
  gh_out proceed false
  gh_out reason "$1"
  exit 0
}

BASE_SHA="$(gh api "repos/$REPO/git/ref/heads/$BASE_BRANCH" --jq .object.sha 2>/dev/null)" \
  || die "base branch '$BASE_BRANCH' does not exist in $REPO"
BASE_TAG="$(gh api "repos/$REPO/contents/custom/BASE?ref=$BASE_SHA" --jq .content 2>/dev/null | base64 -d | tr -d '[:space:]')" \
  || die "custom/BASE is missing on $BASE_BRANCH"
[[ "$BASE_TAG" =~ $TAG_RE ]] || die "custom/BASE does not hold a release tag (got '$BASE_TAG')"

IS_TEST=false
TAG_IS_RELEASE=false
REPLACE_PR=""
REPLACE_HEAD=""
if [ -z "$REF" ]; then
  releases="$(gh api "repos/$UPSTREAM_REPO/releases?per_page=100")"
  TAG="$(jq -r --arg re "$TAG_RE" '.[] | select(.draft == false and .prerelease == false) | .tag_name | select(test($re))' <<<"$releases" \
    | sed 's/^v//' | sort -V | tail -n 1)"
  [ -n "$TAG" ] || stop "no stable desktop release found in the newest 100 upstream releases"
  TAG="v$TAG"
  TAG_IS_RELEASE=true
  semver_gt "$TAG" "$BASE_TAG" || stop "$BASE_BRANCH is on $BASE_TAG; newest upstream release is $TAG"
else
  TAG="$REF"
  if [[ "$REF" =~ $TAG_RE ]]; then TAG_IS_RELEASE=true; fi
  # Only a stable release tag aimed at the real branch is a real PR; everything else is a rehearsal.
  if [ "$TAG_IS_RELEASE" != true ] || [ "$BASE_BRANCH" != "custom" ]; then IS_TEST=true; fi
  if [ "$IS_TEST" = false ]; then
    semver_gt "$TAG" "$BASE_TAG" || stop "$TAG is not newer than $BASE_TAG"
  fi
fi

# A bare commit sha reads better short in titles and branch names; the full sha is kept in upstream_sha. Only the label is
# shortened: the lookup below uses the ref as it was given, because a short sha need not resolve (a full one always does).
RESOLVE_REF="$TAG"
[[ ! "$TAG" =~ ^[0-9a-f]{40}$ ]] || TAG="${TAG:0:7}"

# A throwaway base branch is always a rehearsal, whatever ref was asked for.
[ "$BASE_BRANCH" = custom ] || IS_TEST=true

UPSTREAM_SHA="$(gh api "repos/$UPSTREAM_REPO/commits/$RESOLVE_REF" --jq .sha 2>/dev/null)" \
  || die "upstream ref '$RESOLVE_REF' does not resolve in $UPSTREAM_REPO"

if [ "$IS_TEST" = true ]; then
  slug="$(printf '%s' "$TAG" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//')"
  LABEL="test-${slug}-${UPSTREAM_SHA:0:7}-${GITHUB_RUN_NUMBER:-0}"
  BRANCH="sync-test/$LABEL"
  TITLE="[test] Sync upstream $TAG (${UPSTREAM_SHA:0:7})"
  SUPERSEDE='[]'
  ORPHAN=false
else
  LABEL="$TAG"
  BRANCH="sync/$TAG"
  TITLE="Sync upstream $TAG"
  # A PR in ANY state for this tag ends the search: an open one is already the answer, a closed one
  # (owner said no) must not be reopened every three hours, a merged one means custom/BASE moved on.
  # Exception (stale-sync-pr.sh): a stale, untouched automation PR is replaced; PRs the automation itself closed that way are
  # counted, and the third replacement is the last.
  classify_sync_prs "$REPO" "$BRANCH" "$BASE_BRANCH" "$BASE_SHA" "$UPSTREAM_SHA"
  [ -z "$SYNC_PR_STOP" ] || stop "$SYNC_PR_STOP"
  REPLACE_PR="$SYNC_PR_REPLACE"
  REPLACE_HEAD="$SYNC_PR_REPLACE_HEAD"
  ORPHAN=false
  if gh api "repos/$REPO/git/ref/heads/$BRANCH" >/dev/null 2>&1; then ORPHAN=true; fi
  # Open sync PRs for older tags opened by this automation (bot author, same repo, same base).
  SUPERSEDE="$(gh pr list --repo "$REPO" --state open --base "$BASE_BRANCH" --limit 50 \
    --json number,headRefName,author,isCrossRepository \
    | jq -c --arg b "$BRANCH" --arg re "$AUTOMATION_LOGIN_RE" '[.[] | select((.headRefName | startswith("sync/")) and .isCrossRepository == false
        and .headRefName != $b and (.author.login | test($re))) | .number]')"
fi

if [ "$TAG_IS_RELEASE" = true ]; then
  RELEASE_URL="https://github.com/$UPSTREAM_REPO/releases/tag/$TAG"
else
  RELEASE_URL="https://github.com/$UPSTREAM_REPO/commit/$UPSTREAM_SHA"
fi

log "Sync target: $TAG ($UPSTREAM_SHA) onto $BASE_BRANCH ($BASE_SHA, BASE $BASE_TAG), test=$IS_TEST, branch=$BRANCH"
gh_out proceed true
if [ -n "$REPLACE_PR" ]; then gh_out reason "sync $TAG onto $BASE_BRANCH, replacing stale PR #$REPLACE_PR"; else gh_out reason "sync $TAG onto $BASE_BRANCH"; fi
gh_out is_test "$IS_TEST"
gh_out tag "$TAG"
gh_out tag_is_release "$TAG_IS_RELEASE"
gh_out label "$LABEL"
gh_out upstream_sha "$UPSTREAM_SHA"
gh_out base_branch "$BASE_BRANCH"
gh_out base_sha "$BASE_SHA"
gh_out base_tag "$BASE_TAG"
gh_out branch "$BRANCH"
gh_out title "$TITLE"
gh_out release_url "$RELEASE_URL"
gh_out supersede "$SUPERSEDE"
gh_out orphan_branch "$ORPHAN"
gh_out replace_pr "$REPLACE_PR"
gh_out replace_head "$REPLACE_HEAD"
