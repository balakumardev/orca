#!/usr/bin/env bash
# List the paths our customization touches: the diff of the BASE tag against a base commit.
# Usage: our-files.sh BASE_SHA OUT_FILE   (run inside a checkout that contains BASE_SHA)
# Used by the pull-request gates; the sync workflow gets the same list from sync-merge.sh.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

base_sha="${1:?usage: our-files.sh BASE_SHA OUT_FILE}"; out="${2:?}"
tag="$(git show "$base_sha:custom/BASE" | tr -d '[:space:]')"
[[ "$tag" =~ $TAG_RE ]] || die "custom/BASE on $base_sha is not a release tag"
git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null || fetch_upstream "+refs/tags/$tag:refs/tags/$tag"
git diff --name-only --no-renames "refs/tags/$tag" "$base_sha" | sort -u > "$out"
log "our files: $(wc -l < "$out" | tr -d ' ') paths (diff of $tag against $base_sha)"
