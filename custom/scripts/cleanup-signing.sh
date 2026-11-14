#!/usr/bin/env bash
# Undo import-signing-cert.sh: restore the keychain search list and default keychain, delete the temporary keychain,
# the notary key and every other temp file. Safe to run any number of times, with or without a prior import.
#
#   cleanup-signing.sh [state-dir]      (default: $ORCA_SIGN_STATE, else $RUNNER_TEMP/orca-signing)
set -uo pipefail

state="${1:-${ORCA_SIGN_STATE:-${RUNNER_TEMP:-/nonexistent}/orca-signing}}"

if [ -d "$state" ]; then
  if [ -s "$state/search-list.txt" ]; then
    restore=()
    while IFS= read -r entry; do
      # Only entries that still exist; the temp keychain is deleted below anyway.
      if [ -n "$entry" ] && [ -e "$entry" ]; then restore+=("$entry"); fi
    done <"$state/search-list.txt"
    if [ "${#restore[@]}" -gt 0 ]; then
      security list-keychains -d user -s "${restore[@]}" || echo "::warning::could not restore the keychain search list"
    fi
  fi
  if [ -s "$state/default-keychain.txt" ]; then
    previous="$(head -n 1 "$state/default-keychain.txt")"
    if [ -n "$previous" ] && [ -e "$previous" ]; then
      security default-keychain -d user -s "$previous" || echo "::warning::could not restore the default keychain"
    fi
  fi
  for keychain in "$state"/*.keychain-db; do
    [ -e "$keychain" ] || continue
    security delete-keychain "$keychain" 2>/dev/null || rm -f "$keychain"
  done
  rm -rf "$state"
  echo "signing state removed ($state)"
else
  echo "no signing state at $state; nothing to remove"
fi

# The notary key is written outside the keychain state by notarize-app.sh.
if [ -n "${RUNNER_TEMP:-}" ]; then
  rm -f "$RUNNER_TEMP"/AuthKey_*.p8
fi
exit 0
