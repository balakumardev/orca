#!/usr/bin/env bash
# Print the commit sha that an upstream release tag points at, dereferencing annotated tag objects.
#
#   resolve-base-commit.sh <tag> [owner/repo]     (default repo: stablyai/orca)
#
# The custom build stamps this sha into ORCA_BUILD_COMMIT, so skill-install pins point at a commit that exists
# on GitHub upstream instead of the fork's own HEAD. Needs `gh` with a token that can read the (public) repo.
set -euo pipefail

tag="${1:?usage: resolve-base-commit.sh <tag> [owner/repo]}"
repo="${2:-stablyai/orca}"

# Tags look like vMAJOR.MINOR.PATCH; refuse anything else before it reaches an API path.
if ! printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "resolve-base-commit: unexpected tag '$tag'" >&2
  exit 1
fi

read -r type sha < <(gh api "repos/${repo}/git/ref/tags/${tag}" --jq '"\(.object.type) \(.object.sha)"')

# An annotated tag points at a tag object, which points at the commit (or, rarely, at another tag object).
hops=0
while [ "$type" = "tag" ]; do
  hops=$((hops + 1))
  if [ "$hops" -gt 5 ]; then
    echo "resolve-base-commit: tag chain for $tag is longer than 5" >&2
    exit 1
  fi
  read -r type sha < <(gh api "repos/${repo}/git/tags/${sha}" --jq '"\(.object.type) \(.object.sha)"')
done

if [ "$type" != "commit" ]; then
  echo "resolve-base-commit: $tag resolves to a $type, not a commit" >&2
  exit 1
fi
if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "resolve-base-commit: '$sha' is not a 40-hex commit sha" >&2
  exit 1
fi
printf '%s\n' "$sha"
