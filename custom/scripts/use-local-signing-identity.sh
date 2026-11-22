#!/usr/bin/env bash
# Name the Developer ID Application identity this machine already holds, for the signing steps that follow, and change nothing else.
#
# For the release build on the owner's own Mac (the self-hosted runner). import-signing-cert.sh is for a throw-away hosted runner: it makes
# a keychain the FIRST entry of the user's search list AND the default keychain, and puts the old list back afterwards. On a Mac somebody
# uses that is the wrong thing: anything saved while the job runs goes to a keychain that is then deleted, and a job that dies (lid closed,
# power cut) leaves the search list and the default pointing at a keychain that no longer exists. This script only reads.
#
# Input (environment):
#   ORCA_SIGN_TEAM_ID   the Team ID the identity must belong to (the workflow's EXPECTED_TEAM_ID)
# Optional:
#   GITHUB_ENV          file that receives CSC_NAME, the SHA-1 of the identity (default /dev/null). A hash, not the name, for the
#                       reason given in import-signing-cert.sh.
#   SECURITY_BIN        the `security` tool (test hook)
set -euo pipefail

team="${ORCA_SIGN_TEAM_ID:?ORCA_SIGN_TEAM_ID is not set}"
sec="${SECURITY_BIN:-security}"
if ! [[ "$team" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "use-local-signing-identity: '$team' is not a Team ID (10 letters or digits)" >&2
  exit 1
fi

# Only valid identities (-v): an expired or untrusted one is listed without it, and codesign would fail in the middle of the build.
identities="$("$sec" find-identity -v -p codesigning || true)"
matches="$(printf '%s\n' "$identities" | grep -F '"Developer ID Application:' | grep -F "($team)\"" || true)"
hashes="$(printf '%s\n' "$matches" | awk 'NF { print $2 }' | sort -u)"
count="$(printf '%s' "$hashes" | grep -c . || true)"

if [ "$count" -lt 1 ]; then
  echo "::error title=No Developer ID identity::this Mac has no valid 'Developer ID Application' identity for team $team in its keychains. Install the certificate, or set the repository variable RELEASE_RUNS_ON back to a hosted runner (see the skill fork-release-and-sync)." >&2
  exit 1
fi
if [ "$count" -gt 1 ]; then
  echo "::warning title=Several Developer ID identities::$count valid identities for team $team (a renewal leaves two); using the first by hash."
fi
identity_hash="$(printf '%s\n' "$hashes" | awk 'NR == 1 { print $1 }')"
if ! [[ "$identity_hash" =~ ^[0-9A-F]{40}$ ]]; then
  echo "use-local-signing-identity: could not read a SHA-1 from the identity list" >&2
  exit 1
fi
echo "::add-mask::$identity_hash"
echo "CSC_NAME=$identity_hash" >>"${GITHUB_ENV:-/dev/null}"
echo "using the Developer ID identity already in this Mac's keychains ($count valid for team $team); no keychain was created or changed"
