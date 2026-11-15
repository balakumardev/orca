export const LID_HELPER_VERSION = 1
export const LID_HELPER_PATH = '/Library/PrivilegedHelperTools/orca-lid-hold'
export const LID_STATE_DIR = '/var/db/orca-lid-hold'
export const LID_MARKER_PATH = `${LID_STATE_DIR}/marker`

/**
 * The root-owned helper, installed once with an admin prompt and then called through `sudo -n`.
 * It trusts no argument beyond three fixed verbs and no environment (PATH is reset). A hold ends,
 * and sleep is allowed again, on stdin EOF, on 45 s without a heartbeat line, or on TERM/INT/HUP.
 * The flag is only ever cleared when this helper's own marker says it set it.
 */
export const LID_HELPER_SOURCE = String.raw`#!/bin/bash
# orca-lid-hold: installed by Orca (Settings > Agents > Stay awake with the lid closed). Verbs: hold, reset, version.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
VERSION=1
STATE_DIR=/var/db/orca-lid-hold
MARKER="$STATE_DIR/marker"
LOCK="$STATE_DIR/lock"
PMSET=/usr/bin/pmset
HEARTBEAT_TIMEOUT=45

sleep_disabled() {
  "$PMSET" -g 2>/dev/null | awk '$1 == "SleepDisabled" { print $2 }'
}

holder_alive() {
  local pid cmd
  pid=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -z "$pid" ]; then
    sleep 1
    pid=$(cat "$LOCK/pid" 2>/dev/null)
  fi
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd=$(ps -p "$pid" -o command= 2>/dev/null)
  case "$cmd" in
    *orca-lid-hold*) return 0 ;;
  esac
  return 1
}

release() {
  if [ -e "$MARKER" ]; then
    "$PMSET" -a disablesleep 0 >/dev/null 2>&1
    rm -f "$MARKER"
  fi
  rm -rf "$LOCK"
}

hold() {
  local line
  mkdir -p "$STATE_DIR" || { echo failed; return 1; }
  if ! mkdir "$LOCK" 2>/dev/null; then
    if holder_alive; then
      echo busy
      return 0
    fi
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { echo busy; return 0; }
  fi
  echo $$ > "$LOCK/pid"
  if [ "$(sleep_disabled)" = "1" ] && [ ! -e "$MARKER" ]; then
    rm -rf "$LOCK"
    echo foreign
    return 0
  fi
  trap 'release; exit 0' TERM INT HUP
  trap release EXIT
  : > "$MARKER"
  if ! "$PMSET" -a disablesleep 1 >/dev/null 2>&1; then
    echo failed
    return 1
  fi
  echo held
  while IFS= read -r -t "$HEARTBEAT_TIMEOUT" line; do :; done
  return 0
}

reset() {
  if [ -d "$LOCK" ] && holder_alive; then
    echo busy
    return 0
  fi
  if [ -e "$MARKER" ]; then
    "$PMSET" -a disablesleep 0 >/dev/null 2>&1
    rm -f "$MARKER"
    rm -rf "$LOCK"
    echo reset
  else
    rm -rf "$LOCK"
    echo clean
  fi
}

case "$1" in
  hold) [ "$#" -eq 1 ] || exit 64; hold; exit $? ;;
  reset) [ "$#" -eq 1 ] || exit 64; reset; exit 0 ;;
  version) [ "$#" -eq 1 ] || exit 64; echo "orca-lid-hold $VERSION"; exit 0 ;;
  *) exit 64 ;;
esac
`
