#!/usr/bin/env bash
# Write the GitHub release notes for a custom build to stdout, from real data only.
#
#   release-notes.sh --manifest <manifest.json> [--repo owner/repo] [--head <rev>]
#
# Run it inside a checkout that has the base tag (fetch it from https://github.com/stablyai/orca.git when missing).
# Customizations come from the `Orca-Custom-Patch:` trailers of `git log <base>..<head>`. Trailers that start with
# `fork-` or `release-` mark fork plumbing (scaffold, neutralised upstream workflows, this release machinery); they are
# not user-visible changes and are left out of the list.
set -euo pipefail

manifest="" repo="${GITHUB_REPOSITORY:-balakumardev/orca}" head="HEAD"
while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) manifest="${2:?}"; shift 2 ;;
    --repo) repo="${2:?}"; shift 2 ;;
    --head) head="${2:?}"; shift 2 ;;
    *) echo "release-notes: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -f "$manifest" ] || { echo "release-notes: --manifest <file> is required" >&2; exit 2; }

field() { jq -r --arg k "$1" '.[$k] // empty' "$manifest"; }
version="$(field version)" tag="$(field tag)" base="$(field base)" upstream_commit="$(field upstream_commit)"
asset="$(field asset)" sha256="$(field sha256)" team_id="$(field team_id)"
signed="$(field signed)" notarized="$(field notarized)"
for v in version tag base upstream_commit asset sha256; do
  [ -n "${!v}" ] || { echo "release-notes: manifest has no $v" >&2; exit 1; }
done

git rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
  echo "release-notes: base tag $base is not in this checkout; fetch it from upstream first" >&2
  exit 1
}
git merge-base --is-ancestor "$base^{commit}" "$head" || {
  echo "release-notes: $base is not an ancestor of $head" >&2
  exit 1
}
base_version="${base#v}"

# One line per patch commit, oldest first: "<trailer>\t<subject>". Plumbing trailers are dropped, and so is
# a conventional-commit prefix ("feat(sidebar): ") to keep the list readable.
patches="$(git log --reverse --format='%(trailers:key=Orca-Custom-Patch,valueonly,separator=%x2C)%x09%s' "$base..$head" |
  awk -F'\t' '$1 != "" && $1 !~ /^(fork|release)-/ { sub(/^[a-z]+(\([^)]*\))?!?: /, "", $2); print $1 "\t" $2 }')"

echo "**Unofficial community build.** This is Orca ${base_version} from [stablyai/orca](https://github.com/stablyai/orca) with a few local changes, built by GitHub Actions in this fork. It is not affiliated with or endorsed by Stably. It keeps the upstream bundle ID \`com.stablyai.orca\`, and the in-app updater is disabled in this build: updates come from new releases here."
echo
echo "## Upstream base"
echo
echo "- Orca [${base_version}](https://github.com/stablyai/orca/releases/tag/${base}) (commit \`${upstream_commit:0:10}\`)"
echo
echo "## Customizations in this build"
echo
if [ -n "$patches" ]; then
  printf '%s\n' "$patches" | while IFS=$'\t' read -r name subject; do
    echo "- **${name}**: ${subject}"
  done
else
  echo "- none (this build is the upstream release, unmodified apart from the version string)"
fi
echo
echo "## Build"
echo
echo "- Version \`${version}\`, Apple silicon (arm64) only."
if [ "$signed" = "true" ]; then
  echo "- Signed with a Developer ID Application certificate (team \`${team_id}\`)."
else
  echo "- NOT signed with a Developer ID certificate."
fi
if [ "$notarized" = "true" ]; then
  echo "- Notarized by Apple and stapled."
else
  echo "- NOT notarized: Gatekeeper will refuse a copy that carries the browser's quarantine flag (see Install)."
fi
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  echo "- Built by ${GITHUB_SERVER_URL:-https://github.com}/${repo}/actions/runs/${GITHUB_RUN_ID} from commit \`$(field built_from_sha | cut -c1-10)\`."
fi
echo "- SHA-256 of \`${asset}\`: \`${sha256}\`"
echo
echo "## Install"
echo
echo "Download with the GitHub CLI. A download made by the CLI does not get the quarantine flag, so it needs no Gatekeeper approval:"
echo
echo '```sh'
echo "gh release download '${tag}' --repo ${repo} --pattern '*.zip' --pattern '*.sha256' --dir ~/Downloads/orca-custom"
echo "cd ~/Downloads/orca-custom && shasum -a 256 -c '${asset}.sha256'"
echo '```'
echo
echo "Quit Orca, then replace the app (\`ditto\` keeps the signature intact; Finder's unzip also works):"
echo
echo '```sh'
echo "ditto -x -k ~/Downloads/orca-custom/${asset} ~/Downloads/orca-custom/"
echo "mv /Applications/Orca.app ~/Orca-previous.app"
echo "mv ~/Downloads/orca-custom/Orca.app /Applications/Orca.app"
echo '```'
echo
echo "A download in the browser carries the quarantine flag. macOS then checks the app with Gatekeeper, which only passes for a notarized build."
