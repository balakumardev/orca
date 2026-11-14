#!/usr/bin/env bash
# Notarize an .app with an App Store Connect API key, then staple the ticket to it.
#
#   notarize-app.sh <path/to/Orca.app>
#
# Environment:
#   ASC_KEY_PATH        path of the .p8 (mode 600; the caller deletes it)
#   APPLE_API_KEY_ID    key id (public identifier)
#   APPLE_API_ISSUER    issuer id (public identifier)
#   NOTARY_TIMEOUT      how long to wait for Apple, notarytool duration syntax (default 40m)
#   GITHUB_OUTPUT       receives submission_id=<id> when set
#
# Exit codes: 0 accepted and stapled, 1 rejected or any other failure (the Apple log is printed), 3 Apple still had the
# submission "In Progress" when the timeout hit (the ticket stays valid: check it with `notarytool info <id>`; a team's
# first notarizations can take hours, and resubmitting the same file only queues it again).
#
# notarytool and stapler need only the API key, so the signing keychain should already be gone when this runs.
set -euo pipefail

app="${1:?usage: notarize-app.sh <path/to/Orca.app>}"
: "${ASC_KEY_PATH:?ASC_KEY_PATH is not set}"
: "${APPLE_API_KEY_ID:?APPLE_API_KEY_ID is not set}"
: "${APPLE_API_ISSUER:?APPLE_API_ISSUER is not set}"
timeout="${NOTARY_TIMEOUT:-40m}"
[ -d "$app" ] || { echo "notarize-app: $app is not a directory" >&2; exit 2; }
[ -s "$ASC_KEY_PATH" ] || { echo "notarize-app: $ASC_KEY_PATH is missing or empty" >&2; exit 2; }

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orca-notary.XXXXXX")"
trap 'rm -rf "$work"' EXIT
zip_file="$work/Orca-notarize.zip"
auth=(--key "$ASC_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")

echo "== zipping $app for submission (ditto keeps symlinks and signatures; plain zip does not)"
ditto -c -k --keepParent "$app" "$zip_file"
echo "submission size: $(du -sm "$zip_file" | awk '{print $1}') MB"

echo "== notarytool submit --wait (timeout $timeout), started $(date -u +%H:%M:%S)Z"
set +e
xcrun notarytool submit "$zip_file" "${auth[@]}" --wait --timeout "$timeout" --output-format json >"$work/submit.json" 2>"$work/submit.err"
submit_rc=$?
set -e
echo "notarytool exited $submit_rc at $(date -u +%H:%M:%S)Z"

json_field() { plutil -extract "$1" raw -o - "$work/submit.json" 2>/dev/null || true; }
submission_id="$(json_field id)"
status="$(json_field status)"
if [ -s "$work/submit.err" ]; then sed 's/^/notarytool: /' "$work/submit.err" | tail -n 20; fi
if [ -s "$work/submit.json" ]; then cat "$work/submit.json"; echo; fi
if [ -n "$submission_id" ] && [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "submission_id=$submission_id" >>"$GITHUB_OUTPUT"
fi

if [ -z "$submission_id" ]; then
  echo "::error title=Notarization did not start::notarytool returned no submission id (exit $submit_rc); credentials, network or Apple outage."
  exit 1
fi

case "$status" in
  Accepted) ;;
  "In Progress" | "")
    echo "::error title=Notarization still in progress::submission $submission_id was not finished after $timeout (status '${status:-unknown}'). Check it with: xcrun notarytool info $submission_id ... ; do not resubmit the same build."
    exit 3
    ;;
  *)
    echo "::error title=Notarization failed::submission $submission_id ended with status '$status'. Apple's log follows."
    xcrun notarytool log "$submission_id" "${auth[@]}" "$work/log.json" || true
    if [ -s "$work/log.json" ]; then cat "$work/log.json"; echo; fi
    exit 1
    ;;
esac

echo "== accepted ($submission_id); stapling"
# The ticket CDN can lag a few seconds behind the Accepted status.
stapled=0
for attempt in 1 2 3 4 5; do
  if xcrun stapler staple "$app"; then
    stapled=1
    break
  fi
  echo "staple attempt $attempt failed; retrying in 20 s"
  sleep 20
done
if [ "$stapled" != 1 ]; then
  echo "::error title=Stapling failed::the ticket for $submission_id could not be stapled after 5 attempts"
  exit 1
fi
xcrun stapler validate "$app"
echo "notarized and stapled: $app"
