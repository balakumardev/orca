#!/usr/bin/env bash
# Verify a built Orca.app before anything is packaged or published. Fails (exit 1) on the first broken expectation.
#
#   verify-app.sh --app <Orca.app> --version <1.4.258+custom.4> --mode unsigned|signed|notarized
#                 [--team <TeamIdentifier>] [--out <file>]
#
#   unsigned    the seal must be intact (ad-hoc), TeamIdentifier must be unset
#   signed      Developer ID signature, hardened runtime, TeamIdentifier == --team (required)
#   notarized   signed + a stapled ticket (stapler validate) + spctl accepts it as Notarized Developer ID
#
# Every mode also checks: codesign --verify --deep --strict, CFBundleShortVersionString == --version, arm64 only.
# --out receives KEY=VALUE lines (team_id, signature, hardened_runtime, arch, bundle_id, size_mb) for the manifest.
set -euo pipefail

app=""
version=""
mode=""
team=""
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) app="${2:?}"; shift 2 ;;
    --version) version="${2:?}"; shift 2 ;;
    --mode) mode="${2:?}"; shift 2 ;;
    --team) team="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    *) echo "verify-app: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -d "$app" ] || { echo "verify-app: $app is not a directory" >&2; exit 2; }
[ -n "$version" ] || { echo "verify-app: --version is required" >&2; exit 2; }
case "$mode" in
  unsigned | signed | notarized) ;;
  *) echo "verify-app: --mode must be unsigned, signed or notarized" >&2; exit 2 ;;
esac
if [ "$mode" != "unsigned" ] && [ -z "$team" ]; then
  echo "verify-app: --team is required for mode $mode" >&2
  exit 2
fi

fail() {
  echo "::error title=Verification failed::$*"
  exit 1
}

plist="$app/Contents/Info.plist"
exe_name="$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$plist")"
exe="$app/Contents/MacOS/$exe_name"

echo "== version"
got_version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$plist")"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$plist")"
echo "CFBundleShortVersionString=$got_version CFBundleVersion=$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$plist") CFBundleIdentifier=$bundle_id"
[ "$got_version" = "$version" ] || fail "CFBundleShortVersionString is '$got_version', expected '$version'"

echo "== architecture"
arch="$(lipo -archs "$exe")"
echo "$exe_name: $arch"
[ "$arch" = "arm64" ] || fail "main executable architectures are '$arch', expected exactly arm64"

echo "== codesign --verify --deep --strict"
codesign --verify --deep --strict --verbose=1 "$app" || fail "codesign verification failed"

details="$(codesign -dv --verbose=4 "$app" 2>&1)"
team_id="$(printf '%s\n' "$details" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
signature="$(printf '%s\n' "$details" | sed -n 's/^Signature=//p' | head -n 1)"
flags="$(printf '%s\n' "$details" | sed -n 's/^CodeDirectory .*flags=\(0x[0-9a-f]*\)(\(.*\)) .*/\1 \2/p' | head -n 1)"
echo "== signature"
printf '%s\n' "$details" | grep -E '^(Identifier|Format|Authority|TeamIdentifier|Signature|Timestamp|CodeDirectory)' || true

# codesign prints "Signature=adhoc" only for ad-hoc seals; a certificate signature has no such line.
if [ -z "$signature" ] && printf '%s\n' "$details" | grep -q '^Authority='; then
  signature="certificate"
fi

hardened="false"
case "$flags" in *runtime*) hardened="true" ;; esac

case "$mode" in
  unsigned)
    [ "$signature" = "adhoc" ] || fail "expected an ad-hoc seal, got Signature='$signature'"
    [ "$team_id" = "not set" ] || [ -z "$team_id" ] || fail "an unsigned build must not carry a TeamIdentifier, got '$team_id'"
    ;;
  signed | notarized)
    [ "$signature" != "adhoc" ] || fail "the app is ad-hoc signed, not Developer ID signed"
    printf '%s\n' "$details" | grep -q '^Authority=Developer ID Application:' || fail "the signing authority is not a Developer ID Application certificate"
    [ "$team_id" = "$team" ] || fail "TeamIdentifier is '$team_id', expected '$team'"
    [ "$hardened" = "true" ] || fail "hardened runtime is not enabled (flags: ${flags:-none}); notarization would be rejected"
    printf '%s\n' "$details" | grep -q '^Timestamp=' || fail "the signature carries no secure timestamp; notarization would be rejected"
    ;;
esac

echo "== Gatekeeper assessment"
spctl_out="$(spctl -a -vvv -t exec "$app" 2>&1 || true)"
printf '%s\n' "$spctl_out"
if [ "$mode" = "notarized" ]; then
  echo "== stapler validate"
  xcrun stapler validate "$app" || fail "no valid notarization ticket stapled to the app"
  printf '%s\n' "$spctl_out" | grep -q 'accepted' || fail "spctl did not accept the app"
  printf '%s\n' "$spctl_out" | grep -q 'source=Notarized Developer ID' || fail "spctl accepted the app, but not as Notarized Developer ID"
elif [ "$mode" = "signed" ]; then
  # Informational: a signed-but-not-notarized build is expected to be rejected by Gatekeeper.
  echo "(signed, not notarized: Gatekeeper rejection above is expected)"
fi

size_mb="$(du -sm "$app" | awk '{print $1}')"
echo "== ok: $app is $mode, $got_version, $arch, ${size_mb} MB on disk"
if [ -n "$out" ]; then
  {
    echo "team_id=$team_id"
    echo "signature=$signature"
    echo "hardened_runtime=$hardened"
    echo "arch=$arch"
    echo "bundle_id=$bundle_id"
    echo "size_mb=$size_mb"
  } >"$out"
fi
