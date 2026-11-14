#!/usr/bin/env bash
# Run a command up to N times with a growing pause: for the network-bound steps (package installs, Electron download).
# The allowed-actions policy of this repo rules out nick-fields/retry, so the loop lives here.
#
#   retry.sh <attempts> <command> [args...]
set -uo pipefail

attempts="${1:?usage: retry.sh <attempts> <command> [args...]}"
shift
[ $# -gt 0 ] || { echo "retry: no command given" >&2; exit 2; }

for attempt in $(seq 1 "$attempts"); do
  "$@" && exit 0
  rc=$?
  echo "retry: attempt $attempt/$attempts failed with exit $rc: $*" >&2
  if [ "$attempt" -lt "$attempts" ]; then sleep $((attempt * 20)); fi
done
exit 1
