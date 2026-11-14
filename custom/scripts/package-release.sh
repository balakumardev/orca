#!/usr/bin/env bash
# Package a verified Orca.app into the release files, then prove the shipped bytes still verify.
#
#   package-release.sh --app <Orca.app> --out-dir <dir> --version V --tag T --base B --upstream-commit SHA
#                      --built-from SHA --mode unsigned|signed|notarized [--team ID]
#
# Writes into <out-dir>:
#   Orca-<version>-arm64-mac.zip        ditto zip (plain `zip -r` breaks symlinks and signatures)
#   Orca-<version>-arm64-mac.zip.sha256 "<hash>  <file name>", the format `shasum -a 256 -c` reads
#   manifest.json                       {version, tag, base, upstream_commit, built_from_sha, built_at, signed, team_id,
#                                        notarized, asset, sha256, size}
#
# The zip is extracted again and verify-app.sh runs on the extracted copy, so a zip that lost a symlink or the
# stapled ticket fails here and not on the owner's Mac. The asset name keeps the "+" of the version verbatim: GitHub
# stores it as-is (measured), and the manifest, not URL guessing, is what the installer reads.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="" out_dir="" version="" tag="" base="" upstream_commit="" built_from="" mode="" team=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) app="${2:?}"; shift 2 ;;
    --out-dir) out_dir="${2:?}"; shift 2 ;;
    --version) version="${2:?}"; shift 2 ;;
    --tag) tag="${2:?}"; shift 2 ;;
    --base) base="${2:?}"; shift 2 ;;
    --upstream-commit) upstream_commit="${2:?}"; shift 2 ;;
    --built-from) built_from="${2:?}"; shift 2 ;;
    --mode) mode="${2:?}"; shift 2 ;;
    --team) team="${2:?}"; shift 2 ;;
    *) echo "package-release: unknown argument $1" >&2; exit 2 ;;
  esac
done
for v in app out_dir version tag base upstream_commit built_from mode; do
  [ -n "${!v}" ] || { echo "package-release: --${v//_/-} is required" >&2; exit 2; }
done
case "$mode" in
  unsigned | signed | notarized) ;;
  *) echo "package-release: --mode must be unsigned, signed or notarized" >&2; exit 2 ;;
esac
command -v jq >/dev/null || { echo "package-release: jq is required" >&2; exit 2; }

mkdir -p "$out_dir"
asset="Orca-${version}-arm64-mac.zip"
zip_path="$out_dir/$asset"
rm -f "$zip_path" "$zip_path.sha256" "$out_dir/manifest.json"

echo "== ditto -c -k --keepParent -> $asset"
ditto -c -k --keepParent "$app" "$zip_path"

hash="$(shasum -a 256 "$zip_path" | awk '{print $1}')"
printf '%s  %s\n' "$hash" "$asset" >"$zip_path.sha256"
size="$(stat -f%z "$zip_path")"
echo "sha256 $hash, $size bytes"

echo "== round trip: extract the zip and verify the copy"
check_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orca-roundtrip.XXXXXX")"
trap 'rm -rf "$check_dir"' EXIT
ditto -x -k "$zip_path" "$check_dir"
extracted="$check_dir/$(basename "$app")"
[ -d "$extracted" ] || { echo "package-release: the zip does not contain $(basename "$app") at its top level" >&2; exit 1; }
verify_args=(--app "$extracted" --version "$version" --mode "$mode")
if [ "$mode" != "unsigned" ]; then verify_args+=(--team "$team"); fi
bash "$here/verify-app.sh" "${verify_args[@]}" >"$check_dir/verify.log" 2>&1 || {
  cat "$check_dir/verify.log"
  echo "::error title=Round trip failed::the extracted copy of $asset does not verify as $mode"
  exit 1
}
tail -n 1 "$check_dir/verify.log"

signed=false
notarized=false
team_json=null
if [ "$mode" != "unsigned" ]; then
  signed=true
  team_json="\"$team\""
fi
if [ "$mode" = "notarized" ]; then notarized=true; fi

jq -n \
  --arg version "$version" --arg tag "$tag" --arg base "$base" \
  --arg upstream_commit "$upstream_commit" --arg built_from_sha "$built_from" \
  --arg built_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson signed "$signed" --argjson team_id "$team_json" --argjson notarized "$notarized" \
  --arg asset "$asset" --arg sha256 "$hash" --argjson size "$size" \
  '{version: $version, tag: $tag, base: $base, upstream_commit: $upstream_commit, built_from_sha: $built_from_sha,
    built_at: $built_at, signed: $signed, team_id: $team_id, notarized: $notarized,
    asset: $asset, sha256: $sha256, size: $size}' >"$out_dir/manifest.json"

echo "== manifest.json"
cat "$out_dir/manifest.json"
ls -l "$out_dir"
