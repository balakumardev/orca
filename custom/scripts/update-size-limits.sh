#!/usr/bin/env bash
# The size rule of the in-app updater, and the release gate that keeps every published zip inside it.
#
#   update-size-limits.sh <zip>                                  check a real zip (reads `zipinfo -t`)
#   update-size-limits.sh --check ENTRIES UNCOMPRESSED ZIP_BYTES check three numbers (what the zip check does with them)
#   update-size-limits.sh --print                                print every constant as NAME=VALUE
#
# The app refuses an update whose archive lists more than UPDATER_MAX_ARCHIVE_ENTRIES entries or expands to more than
# UPDATER_EXTRACTED_SIZE_FACTOR times the zip, and refuses a manifest that names a zip over UPDATER_MAX_ZIP_BYTES. A release
# that crosses one of those would be published and then rejected by every installed copy, and the failure would show only on
# the owner's Mac. So the release job fails first: RELEASE_* are the limits for a build, set below the app's so that a growing
# bundle is caught with room to spare. A real build (measured) is 18,819 entries at 2.59 times its zip.
#
# The UPDATER_* constants are copies, kept in this one place. They mirror, in src/main/updater/custom/:
#   UPDATER_EXTRACTED_SIZE_FACTOR  custom-update-extract.ts   EXTRACTED_SIZE_FACTOR
#   UPDATER_MAX_ARCHIVE_ENTRIES    custom-update-extract.ts   MAX_ARCHIVE_ENTRIES
#   UPDATER_MAX_ZIP_BYTES          custom-update-manifest.ts  CUSTOM_UPDATE_MAX_ZIP_BYTES
# custom-update-size-limits-script.test.ts fails when a copy drifts or a release limit is not below its updater limit.
set -euo pipefail

# shellcheck disable=SC2034  # read by name in --print (${!name}) and by custom-update-size-limits-script.test.ts
UPDATER_EXTRACTED_SIZE_FACTOR=4
# shellcheck disable=SC2034
UPDATER_MAX_ARCHIVE_ENTRIES=200000
# shellcheck disable=SC2034
UPDATER_MAX_ZIP_BYTES=1073741824

# Whole numbers only: the ratio is held in tenths (35 means 3.5 times).
RELEASE_MAX_EXPANSION_TENTHS=35
RELEASE_MAX_ENTRIES=150000
RELEASE_MAX_ZIP_BYTES=943718400

fail() { printf 'update-size-limits: %s\n' "$*" >&2; exit 2; }

number() { # NAME VALUE: a plain number that cannot overflow shell arithmetic
  [[ "$2" =~ ^[0-9]{1,15}$ ]] || fail "$1 is not a number: $2"
}

# violations ENTRIES UNCOMPRESSED ZIP_BYTES: one line for each limit that is passed; nothing when the zip is within all of them.
violations() {
  local entries="$1" uncompressed="$2" zip_bytes="$3"
  if [ "$zip_bytes" -le 0 ]; then
    echo "the zip is empty"
    return 0
  fi
  if [ "$zip_bytes" -gt "$RELEASE_MAX_ZIP_BYTES" ]; then
    echo "the zip is $zip_bytes bytes, over the $RELEASE_MAX_ZIP_BYTES byte limit"
  fi
  if [ "$entries" -gt "$RELEASE_MAX_ENTRIES" ]; then
    echo "the zip holds $entries entries, over the limit of $RELEASE_MAX_ENTRIES"
  fi
  if [ $((uncompressed * 10)) -gt $((zip_bytes * RELEASE_MAX_EXPANSION_TENTHS)) ]; then
    echo "the zip expands to $uncompressed bytes from $zip_bytes, over $((RELEASE_MAX_EXPANSION_TENTHS / 10)).$((RELEASE_MAX_EXPANSION_TENTHS % 10)) times its size"
  fi
}

check_numbers() { # ENTRIES UNCOMPRESSED ZIP_BYTES
  number entries "$1"
  number uncompressed "$2"
  number zip_bytes "$3"
  local found
  found="$(violations "$1" "$2" "$3")"
  if [ -n "$found" ]; then
    while IFS= read -r line; do
      printf '::error title=Release zip is outside the in-app updater limits::%s\n' "$line"
    done <<<"$found"
    return 1
  fi
  local ratio="n/a"
  if [ "$3" -gt 0 ]; then ratio="$(awk -v u="$2" -v z="$3" 'BEGIN { printf "%.2f", u / z }')"; fi
  echo "update size limits: $1 entries, $2 bytes uncompressed, $3 bytes zipped (x$ratio): within the release limits"
}

check_zip() { # ZIP
  local zip="$1" listing totals zip_bytes
  [ -f "$zip" ] || fail "no such file: $zip"
  # The same tool and the same line the app reads, so both count entries and bytes the same way.
  listing="$("${ZIPINFO:-/usr/bin/zipinfo}" -t "$zip")" || fail "zipinfo could not read $zip"
  if [[ ! "$listing" =~ ([0-9]+)\ files?,\ ([0-9]+)\ bytes\ uncompressed ]]; then
    fail "zipinfo gave no totals for $zip"
  fi
  totals=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}")
  zip_bytes="$(wc -c <"$zip")"
  check_numbers "${totals[0]}" "${totals[1]}" "${zip_bytes//[[:space:]]/}"
}

case "${1:-}" in
  --print)
    for name in UPDATER_EXTRACTED_SIZE_FACTOR UPDATER_MAX_ARCHIVE_ENTRIES UPDATER_MAX_ZIP_BYTES \
      RELEASE_MAX_EXPANSION_TENTHS RELEASE_MAX_ENTRIES RELEASE_MAX_ZIP_BYTES; do
      printf '%s=%s\n' "$name" "${!name}"
    done
    ;;
  --check)
    [ $# -eq 4 ] || fail "usage: update-size-limits.sh --check ENTRIES UNCOMPRESSED ZIP_BYTES"
    check_numbers "$2" "$3" "$4"
    ;;
  "" | -*) fail "usage: update-size-limits.sh <zip> | --check ENTRIES UNCOMPRESSED ZIP_BYTES | --print" ;;
  *)
    [ $# -eq 1 ] || fail "usage: update-size-limits.sh <zip>"
    check_zip "$1"
    ;;
esac
