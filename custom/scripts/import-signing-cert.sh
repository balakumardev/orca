#!/usr/bin/env bash
# Import a Developer ID Application .p12 into a throw-away keychain and expose the identity to later steps.
#
# Input (environment, never arguments):
#   P12_BASE64     base64 of the .p12 file
#   P12_PASSWORD   its password
# Optional:
#   RUNNER_TEMP    where the state lives (default: a fresh mktemp dir)
#   GITHUB_ENV     file that receives CSC_NAME / ORCA_SIGN_KEYCHAIN / ORCA_SIGN_STATE (default /dev/null)
#
# Result: a temporary keychain that is unlocked, first on the user search list and the default keychain, holding the
# identity; CSC_NAME is the SHA-1 of the "Developer ID Application" identity. A hash, not the name, because
# electron-builder rejects a CSC_NAME that carries the "Developer ID Application:" prefix while Orca's own helper
# signing hands CSC_NAME to codesign, and a hash satisfies both (and is never ambiguous between certificates).
#
# This changes the user's keychain search list and default keychain, so it only runs on a CI runner unless
# ORCA_SIGN_ALLOW_LOCAL=1 is set. Test hook: ORCA_SIGN_SKIP_SEARCH_LIST=1 leaves the search list and the default
# keychain alone (the import, the key partition list and the identity lookup, which names the keychain, still run), which
# is how this is exercised on a developer's Mac. cleanup-signing.sh undoes whatever was changed.
set -euo pipefail

: "${P12_BASE64:?P12_BASE64 is not set}"
: "${P12_PASSWORD:?P12_PASSWORD is not set}"

if [ "${GITHUB_ACTIONS:-}" != "true" ] && [ "${ORCA_SIGN_ALLOW_LOCAL:-}" != "1" ]; then
  echo "import-signing-cert: refusing to change this machine's keychain search list outside CI (set ORCA_SIGN_ALLOW_LOCAL=1 and use a throw-away HOME to test)" >&2
  exit 1
fi

umask 077
base_dir="${RUNNER_TEMP:-$(mktemp -d)}"
state="$base_dir/orca-signing"
keychain="$state/orca-release.keychain-db"
if [ -e "$state" ]; then
  echo "import-signing-cert: $state already exists; run cleanup-signing.sh first" >&2
  exit 1
fi
mkdir -p "$state"

skip_search_list="${ORCA_SIGN_SKIP_SEARCH_LIST:-}"
if [ "$skip_search_list" != "1" ]; then
  # Remember what to restore: the current user search list and default keychain.
  security list-keychains -d user | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//' >"$state/search-list.txt"
  security default-keychain -d user 2>/dev/null | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//' >"$state/default-keychain.txt" || true
fi

keychain_password="$(openssl rand -hex 24)"
echo "::add-mask::$keychain_password"

printf '%s' "$P12_BASE64" | base64 --decode >"$state/cert.p12"
if [ ! -s "$state/cert.p12" ]; then
  echo "import-signing-cert: P12_BASE64 decoded to an empty file" >&2
  exit 1
fi

security create-keychain -p "$keychain_password" "$keychain"
# Default is a lock after 300 s of inactivity: the signing stage runs far longer than that, and a locked keychain
# shows up as errSecInternalComponent in the middle of codesign. 21600 s = 6 h, the job limit.
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"

security import "$state/cert.p12" -k "$keychain" -P "$P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
rm -f "$state/cert.p12"
# Without this the first codesign call waits for a UI prompt that never comes.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null

if [ "$skip_search_list" != "1" ]; then
  # Search list: ours first, the existing ones after it (Apple's intermediate certificates live in the system keychain).
  existing=()
  while IFS= read -r entry; do
    if [ -n "$entry" ]; then existing+=("$entry"); fi
  done <"$state/search-list.txt"
  security list-keychains -d user -s "$keychain" ${existing[@]+"${existing[@]}"}
  security default-keychain -d user -s "$keychain"
fi

identities="$(security find-identity -v -p codesigning "$keychain" || true)"
matches="$(printf '%s\n' "$identities" | grep -F '"Developer ID Application:' || true)"
count="$(printf '%s' "$matches" | grep -c . || true)"
if [ "$count" -lt 1 ]; then
  echo "::error title=No Developer ID identity::the imported .p12 has no valid 'Developer ID Application' identity (missing, expired or not trusted); every code-signing identity in it, with the reason, is listed above." >&2
  security find-identity -p codesigning "$keychain" | sed -E 's/[0-9A-F]{40}/<sha1>/' >&2 || true
  exit 1
fi
if [ "$count" -gt 1 ]; then
  echo "::warning title=Several Developer ID identities::$count valid identities in the .p12; using the first one."
fi
identity_hash="$(printf '%s\n' "$matches" | awk 'NR==1{print $2}')"
if ! printf '%s' "$identity_hash" | grep -Eq '^[0-9A-F]{40}$'; then
  echo "import-signing-cert: could not read a SHA-1 from: $(printf '%s' "$matches" | head -n 1 | sed 's/[0-9A-F]\{40\}/<hash>/')" >&2
  exit 1
fi
echo "::add-mask::$identity_hash"

{
  echo "CSC_NAME=$identity_hash"
  echo "ORCA_SIGN_KEYCHAIN=$keychain"
  echo "ORCA_SIGN_STATE=$state"
} >>"${GITHUB_ENV:-/dev/null}"

echo "imported 1 identity (of $count) into $keychain; keychain locks after 6 h"
