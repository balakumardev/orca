#!/usr/bin/env bash
# Compute the version of the next custom build: <base version>+custom.<N>.
#
#   base tag  = first line of custom/BASE (for example v1.4.258)
#   N         = (highest N among ALL existing tags v*+custom.<N>, across every base) + 1, never below the floor
#
# N is global on purpose: the local installer's no-downgrade guard compares only N, so a build on a newer base
# must still get a bigger N than every build on an older base.
#
# Existing tags come from stdin (one per line, "-" is the default source in tests) or, with --from-github, from
# the release list and the git tag list of $GITHUB_REPOSITORY. Drafts are invisible to a read-only token, so a
# stray draft can only collide if somebody left one lying around; the publish job fails loudly in that case.
#
# Output on stdout, one KEY=VALUE per line: VERSION, TAG, BASE, N.
set -euo pipefail

base_file="custom/BASE"
floor=4
source_mode="stdin"

usage() {
  echo "usage: next-version.sh [--base-file FILE] [--floor N] [--from-github | --stdin]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base-file)
      [ $# -ge 2 ] || usage
      base_file="$2"
      shift 2
      ;;
    --floor)
      [ $# -ge 2 ] || usage
      floor="$2"
      shift 2
      ;;
    --from-github)
      source_mode="github"
      shift
      ;;
    --stdin)
      source_mode="stdin"
      shift
      ;;
    *) usage ;;
  esac
done

case "$floor" in
  '' | *[!0-9]*)
    echo "next-version: --floor must be a non-negative integer" >&2
    exit 2
    ;;
esac

[ -f "$base_file" ] || {
  echo "next-version: $base_file not found" >&2
  exit 1
}
base="$(head -n 1 "$base_file" | tr -d '[:space:]')"
# Plain vX.Y.Z only: a hyphen in the version would make Orca's release-channel code treat the build as an rc.
if ! grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' <<<"$base"; then
  echo "next-version: base tag '$base' in $base_file is not vMAJOR.MINOR.PATCH" >&2
  exit 1
fi

list_tags() {
  if [ "$source_mode" = "github" ]; then
    : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set for --from-github}"
    gh api --paginate "repos/${GITHUB_REPOSITORY}/releases?per_page=100" --jq '.[].tag_name'
    gh api --paginate "repos/${GITHUB_REPOSITORY}/git/matching-refs/tags/v" --jq '.[].ref' | sed 's#^refs/tags/##'
  else
    cat
  fi
}

tags="$(list_tags)"
max=-1
while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  if grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+\+custom\.[0-9]+$' <<<"$tag"; then
    n="${tag##*+custom.}"
    # Strip leading zeros so bash does not read "08" as octal.
    n="$((10#$n))"
    if [ "$n" -gt "$max" ]; then
      max="$n"
    fi
  fi
done <<EOF
$tags
EOF

next=$((max + 1))
if [ "$next" -lt "$floor" ]; then
  next="$floor"
fi

version="${base#v}+custom.${next}"
printf 'VERSION=%s\n' "$version"
printf 'TAG=v%s\n' "$version"
printf 'BASE=%s\n' "$base"
printf 'N=%s\n' "$next"
