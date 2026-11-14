#!/usr/bin/env bash
# Make the candidate merge of one sync round the checked-out branch of this repository.
# Run inside a checkout of the base branch (any job after `merge`). The bundle carries only the objects that are
# new; the base commit is the checkout itself and the upstream commit is fetched here, so no job ever re-downloads
# history it already has.
#
# Env: ROUND_DIR (directory holding sync-facts.json and merge.bundle of the round to load)
# Effects: branch <facts.branch> exists and is checked out at <facts.merge_sha>; stdout/outputs: none.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${ROUND_DIR:?}"
facts="$ROUND_DIR/sync-facts.json"
[ -s "$facts" ] && [ -s "$ROUND_DIR/merge.bundle" ] || die "round directory has no sync-facts.json / merge.bundle"
branch="$(jq -r .branch "$facts")"; merge_sha="$(jq -r .merge_sha "$facts")"
base_sha="$(jq -r .base_sha "$facts")"; upstream_sha="$(jq -r .upstream_sha "$facts")"

git cat-file -e "$base_sha^{commit}" || die "base commit $base_sha is not in this checkout"
git cat-file -e "$upstream_sha^{commit}" 2>/dev/null || fetch_upstream "$upstream_sha"
git fetch -q "$ROUND_DIR/merge.bundle" "+refs/heads/$branch:refs/heads/$branch"
[ "$(git rev-parse "refs/heads/$branch")" = "$merge_sha" ] || die "bundle tip does not match merge_sha in the facts"
git checkout -q "$branch"
log "loaded $branch at $merge_sha"
