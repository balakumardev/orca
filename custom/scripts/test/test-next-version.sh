#!/usr/bin/env bash
# Unit test for custom/scripts/next-version.sh with fake tag lists. Run: bash custom/scripts/test/test-next-version.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../next-version.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail=0
check() {
  local name="$1" base="$2" tags="$3" want_version="$4"
  printf '%s\n' "$base" >"$tmp/BASE"
  local out got
  if ! out="$(printf '%s' "$tags" | bash "$script" --base-file "$tmp/BASE" --stdin 2>&1)"; then
    echo "FAIL $name: script errored: $out"
    fail=1
    return
  fi
  got="$(printf '%s\n' "$out" | sed -n 's/^VERSION=//p')"
  if [ "$got" != "$want_version" ]; then
    echo "FAIL $name: got '$got', want '$want_version'"
    fail=1
    return
  fi
  if [ "$(printf '%s\n' "$out" | sed -n 's/^TAG=//p')" != "v$want_version" ]; then
    echo "FAIL $name: TAG is not v$want_version"
    fail=1
    return
  fi
  echo "ok   $name -> $got"
}

check "no tags at all hits the floor" v1.4.258 "" "1.4.258+custom.4"
check "only unrelated tags" v1.4.258 $'v1.4.258\nv1.4.257\nsome-tag\n' "1.4.258+custom.4"
check "custom.3 exists (local build) stays at the floor" v1.4.258 $'v1.4.258+custom.3\n' "1.4.258+custom.4"
check "custom.4 exists" v1.4.258 $'v1.4.258+custom.4\n' "1.4.258+custom.5"
check "N is global across bases" v1.4.259 $'v1.4.258+custom.4\nv1.4.258+custom.9\nv1.4.257+custom.6\n' "1.4.259+custom.10"
check "numeric not lexical order" v1.4.258 $'v1.4.258+custom.9\nv1.4.258+custom.10\nv1.4.258+custom.2\n' "1.4.258+custom.11"
check "hyphenated and malformed tags are ignored" v1.4.258 $'v1.4.258-rc.1+custom.99\nv1.4.258+custom.x\nv1.4.258+custom.\nfoo+custom.50\n' "1.4.258+custom.4"
check "leading zeros are not octal" v1.4.258 $'v1.4.258+custom.08\nv1.4.258+custom.09\n' "1.4.258+custom.10"
check "blank lines and CRLF-free input" v1.4.258 $'\n\nv1.4.258+custom.5\n\n' "1.4.258+custom.6"

# A bad base must be refused.
printf 'v1.4.258-rc.1\n' >"$tmp/BASE"
if printf '' | bash "$script" --base-file "$tmp/BASE" --stdin >/dev/null 2>&1; then
  echo "FAIL a hyphenated base tag was accepted"
  fail=1
else
  echo "ok   hyphenated base tag refused"
fi

exit "$fail"
