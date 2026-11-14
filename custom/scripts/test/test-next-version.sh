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

# A base that went backwards must fail loudly: the updater would never offer a build on a base lower than the running one.
refuses() {
  local name="$1" base="$2" tags="$3" pattern="$4" out rc=0
  printf '%s\n' "$base" >"$tmp/BASE"
  out="$(printf '%s' "$tags" | bash "$script" --base-file "$tmp/BASE" --stdin 2>&1)" || rc=$?
  if [ "$rc" = 1 ] && [[ "$out" == *"$pattern"* ]] && [[ "$out" != *VERSION=* ]]; then
    echo "ok   $name refused"
  else
    echo "FAIL $name: rc=$rc out=[$out]"
    fail=1
  fi
}
refuses "a base below the highest released base" v1.4.257 $'v1.4.258+custom.4\n' "a release on v1.4.258 already exists"
refuses "the highest base released before a lower one" v1.4.250 $'v1.4.258+custom.9\nv1.4.251+custom.10\n' "a release on v1.4.258 already exists"
refuses "a lower patch compared by number and not as text" v1.4.9 $'v1.4.10+custom.5\n' "a release on v1.4.10 already exists"
refuses "a lower major" v1.9.99 $'v2.0.0+custom.5\n' "a release on v2.0.0 already exists"
check "the same base as the highest release is fine" v1.4.258 $'v1.4.258+custom.4\nv1.4.257+custom.9\n' "1.4.258+custom.10"
check "a base above every release is fine" v1.4.10 $'v1.4.9+custom.5\n' "1.4.10+custom.6"
check "a malformed tag on a higher base does not block a build" v1.4.258 $'v1.9.0-rc.1+custom.4\nv1.9.0+custom.x\n' "1.4.258+custom.4"

# A bad base must be refused.
printf 'v1.4.258-rc.1\n' >"$tmp/BASE"
if printf '' | bash "$script" --base-file "$tmp/BASE" --stdin >/dev/null 2>&1; then
  echo "FAIL a hyphenated base tag was accepted"
  fail=1
else
  echo "ok   hyphenated base tag refused"
fi

# --from-github reads two lists with `gh api`. A failure of EITHER must stop the script: a missing list means a lower N,
# and a lower N is a tag that already exists. (Inside $(...) bash clears `set -e`, so only the last command used to count.)
stub="$tmp/stub-bin"
mkdir -p "$stub"
cat >"$stub/gh" <<'STUB'
#!/bin/sh
case "$*" in
  *releases*)
    if [ "${FAKE_GH_FAIL_RELEASES:-}" = 1 ]; then echo "gh: HTTP 403 (rate limit)" >&2; exit 1; fi
    printf '%s\n' 'v1.4.258+custom.9'
    ;;
  *matching-refs*)
    if [ "${FAKE_GH_FAIL_REFS:-}" = 1 ]; then echo "gh: HTTP 502" >&2; exit 1; fi
    printf '%s\n' 'refs/tags/v1.4.258+custom.7'
    ;;
esac
STUB
chmod +x "$stub/gh"
github_run() {
  printf 'v1.4.258\n' >"$tmp/BASE"
  PATH="$stub:$PATH" GITHUB_REPOSITORY=owner/repo bash "$script" --base-file "$tmp/BASE" --from-github 2>&1
}
github_expect_failure() {
  local name="$1" out rc=0
  out="$(github_run)" || rc=$?
  if [ "$rc" != 0 ] && [[ "$out" != *VERSION=* ]]; then
    echo "ok   $name stops the script"
  else
    echo "FAIL $name: rc=$rc out=[$out]"
    fail=1
  fi
}
out="$(github_run)" || out="errored: $out"
if [ "$(printf '%s\n' "$out" | sed -n 's/^VERSION=//p')" = "1.4.258+custom.10" ]; then
  echo "ok   both gh lists read -> 1.4.258+custom.10"
else
  echo "FAIL both gh lists read: out=[$out]"
  fail=1
fi
FAKE_GH_FAIL_RELEASES=1 github_expect_failure "a failing release list"
FAKE_GH_FAIL_REFS=1 github_expect_failure "a failing tag list"

exit "$fail"
