#!/usr/bin/env bash
# Test for the ref handling of detect-release.sh with a stub `gh` (no network, no token).
# Run: bash custom/scripts/test/test-detect-release.sh      (needs jq)
#
# The bug: a 40-character commit sha given as `ref` was shortened to 7 characters for the labels and THEN looked up, and
# the upstream API did not resolve the short form ("upstream ref 'c91a7a6' does not resolve"). The stub below resolves a
# full sha or a tag and refuses anything else, like that API did, so this fails on the old script.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
command -v jq >/dev/null 2>&1 || { echo "missing tool: jq"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY INPUT_REF INPUT_BASE_BRANCH

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

FULL="c91a7a6e2b8f4d0a1c3e5f7091a2b3c4d5e6f708"
BASE="0123456789abcdef0123456789abcdef01234567"
mkdir "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Stub gh api: the base branch, custom/BASE, and upstream commit lookups. Every request path is logged.
[ "$1" = api ] || { echo "stub gh: unexpected call: $*" >&2; exit 2; }
echo "$2" >> "$GH_LOG"
case "$2" in
  repos/*/git/ref/heads/*) echo "$BASE_SHA" ;;
  repos/*/contents/custom/BASE*) printf 'v1.0.0\n' | base64 ;;
  repos/stablyai/orca/commits/v1.4.258) echo "$TAG_SHA" ;;
  repos/stablyai/orca/commits/"$FULL_SHA") echo "$FULL_SHA" ;;
  *) echo "stub gh: no such commit: $2" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmp/bin/gh"

run() { # REF [BASE_BRANCH] -> sets d_out d_rc
  : > "$tmp/gh.log"
  d_rc=0
  d_out="$(env PATH="$tmp/bin:$PATH" GH_LOG="$tmp/gh.log" BASE_SHA="$BASE" TAG_SHA="$FULL" FULL_SHA="$FULL" \
    GITHUB_REPOSITORY=balakumardev/orca GITHUB_RUN_NUMBER=7 INPUT_REF="$1" INPUT_BASE_BRANCH="${2:-custom}" \
    bash "$scripts/detect-release.sh" 2>&1)" || d_rc=$?
}
out_of() { sed -n "s/^OUTPUT $1=//p" <<<"$d_out" | head -n 1; }

run "$FULL"
if [ "$d_rc" = 0 ] && [ "$(out_of proceed)" = true ]; then ok "a full 40-character sha as ref proceeds"; else bad "full sha: rc=$d_rc out=[$d_out]"; fi
if [ "$(out_of upstream_sha)" = "$FULL" ]; then ok "upstream_sha is the full sha"; else bad "upstream_sha=[$(out_of upstream_sha)]"; fi
if [ "$(out_of tag)" = "${FULL:0:7}" ]; then ok "the label still uses the short sha"; else bad "tag=[$(out_of tag)]"; fi
if [ "$(out_of branch)" = "sync-test/test-${FULL:0:7}-${FULL:0:7}-7" ] && [ "$(out_of is_test)" = true ]; then ok "a sha ref is a rehearsal with a short branch name"; else bad "branch=[$(out_of branch)] is_test=[$(out_of is_test)]"; fi
if grep -q -x "repos/stablyai/orca/commits/$FULL" "$tmp/gh.log" && ! grep -q "commits/${FULL:0:7}\$" "$tmp/gh.log"; then ok "the lookup asked for the full sha, never the short one"; else bad "gh calls: $(cat "$tmp/gh.log")"; fi

run "${FULL:0:7}"
if [ "$d_rc" != 0 ] && grep -q "does not resolve" <<<"$d_out"; then ok "a 7-character sha that the API cannot resolve still fails loudly"; else bad "short sha: rc=$d_rc out=[$d_out]"; fi

run v1.4.258 test/rehearsal-base # a throwaway base, so no pull-request lookups
if [ "$d_rc" = 0 ] && [ "$(out_of tag)" = v1.4.258 ] && [ "$(out_of upstream_sha)" = "$FULL" ] && [ "$(out_of tag_is_release)" = true ]; then ok "a release tag as ref resolves and keeps its name"; else bad "tag ref: rc=$d_rc out=[$d_out]"; fi

run "$(printf 'f%.0s' $(seq 1 40))"
if [ "$d_rc" != 0 ] && grep -q "does not resolve" <<<"$d_out"; then ok "an unknown full sha fails and names the full ref"; else bad "unknown sha: rc=$d_rc out=[$d_out]"; fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
