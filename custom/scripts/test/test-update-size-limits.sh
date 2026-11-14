#!/usr/bin/env bash
# Test for custom/scripts/update-size-limits.sh, the release gate for the in-app updater's size rule.
# Run: bash custom/scripts/test/test-update-size-limits.sh      (needs bash; the real-zip cases need zipinfo and ditto or zip)
#
# Part 1 drives the number check at both sides of each limit. Part 2 feeds the zip check a stub zipinfo, so the parsing is tested
# on any machine. Part 3 builds real zips with the system's own tools and runs the real zipinfo (skipped, and said so, where
# the tools are missing). Part 4 proves package-release.sh runs the gate.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="${SCRIPTS_DIR:-$(cd "$here/.." && pwd)}"
gate="$scripts/update-size-limits.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
skip() { printf 'skip %s\n' "$1"; }

# run_gate ARGS...: runs the gate; sets g_rc and g_out (stdout and stderr together).
run_gate() {
  g_rc=0
  g_out="$(bash "$gate" "$@" 2>&1)" || g_rc=$?
}
# expect NAME RC PATTERN ARGS...: the gate exits RC and its output matches PATTERN.
expect() {
  local name="$1" want="$2" pattern="$3"
  shift 3
  run_gate "$@"
  if [ "$g_rc" = "$want" ] && [[ "$g_out" == *$pattern* ]]; then ok "$name"; else bad "$name: rc=$g_rc (wanted $want) out=[$g_out]"; fi
}

const() { bash "$gate" --print | awk -F= -v n="$1" '$1 == n { print $2 }'; }
max_ratio="$(const RELEASE_MAX_EXPANSION_TENTHS)"
max_entries="$(const RELEASE_MAX_ENTRIES)"
max_zip="$(const RELEASE_MAX_ZIP_BYTES)"

# ---- part 1: the numbers --------------------------------------------------------------------------------------------------
expect "a real build's numbers (18,819 entries, 2.59 times) pass" 0 "within the release limits" --check 18819 777000000 300000000
expect "an expansion of exactly the limit passes" 0 "within the release limits" --check 10 $((max_ratio * 1000)) 10000
expect "an expansion one byte over the limit fails, and says so" 1 "times its size" --check 10 $((max_ratio * 1000 / 10 + 1)) 1000
expect "exactly the entry limit passes" 0 "within the release limits" --check "$max_entries" 10 1000000
expect "one entry over the limit fails" 1 "over the limit of $max_entries" --check $((max_entries + 1)) 10 1000000
expect "exactly the zip size limit passes" 0 "within the release limits" --check 10 10 "$max_zip"
expect "one byte over the zip size limit fails" 1 "byte limit" --check 10 10 $((max_zip + 1))
expect "an empty zip fails" 1 "the zip is empty" --check 0 0 0
run_gate --check 1000000 999999999999 $((max_zip + 1))
if [ "$g_rc" = 1 ] && [[ "$g_out" == *"byte limit"* ]] && [[ "$g_out" == *"entries"* ]] && [[ "$g_out" == *"times its size"* ]]; then
  ok "every limit that is passed is reported, not only the first"
else bad "several violations: rc=$g_rc out=[$g_out]"; fi
expect "text where a number belongs fails closed (exit 2)" 2 "not a number" --check 5 abc 10
expect "a number too long for shell arithmetic fails closed" 2 "not a number" --check 5 99999999999999999999 10
expect "a missing argument is a usage error" 2 "usage" --check 5 10
expect "no argument is a usage error" 2 "usage"
expect "an unknown option is a usage error, not a file name" 2 "usage" --nonsense
expect "a missing zip fails closed" 2 "no such file" "$tmp/absent.zip"

# ---- part 2: zipinfo's line, with a stub ------------------------------------------------------------------------------------
printf 'zip' >"$tmp/stub.zip"
stub() { # LINE: a zipinfo that prints LINE
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$STUB_LINE"\n' >"$tmp/zipinfo-stub"
  chmod +x "$tmp/zipinfo-stub"
  STUB_LINE="$1"
  export STUB_LINE
}
run_stub() { # LINE: the gate on the stub zip with that zipinfo line
  stub "$1"
  g_rc=0
  g_out="$(ZIPINFO="$tmp/zipinfo-stub" bash "$gate" "$tmp/stub.zip" 2>&1)" || g_rc=$?
}
run_stub "5 files, 2 bytes uncompressed, 3 bytes compressed:  -50.0%"
# The stub zip is 3 bytes long: 2 bytes expand to less than 3.5 times 3.
if [ "$g_rc" = 0 ] && [[ "$g_out" == *"5 entries, 2 bytes uncompressed, 3 bytes zipped"* ]]; then ok "the totals are read from zipinfo's line (entries, uncompressed bytes) and the zip size from the file"
else bad "stub totals: rc=$g_rc out=[$g_out]"; fi
run_stub "1 file, 11 bytes uncompressed, 3 bytes compressed:  -50.0%"
if [ "$g_rc" = 1 ] && [[ "$g_out" == *"times its size"* ]]; then ok "a singular '1 file' line is read, and an expansion over the limit fails"
else bad "singular line: rc=$g_rc out=[$g_out]"; fi
run_stub "no totals here"
if [ "$g_rc" = 2 ] && [[ "$g_out" == *"gave no totals"* ]]; then ok "a zipinfo line without totals fails closed"; else bad "no totals: rc=$g_rc out=[$g_out]"; fi
g_rc=0
g_out="$(ZIPINFO=/usr/bin/false bash "$gate" "$tmp/stub.zip" 2>&1)" || g_rc=$?
if [ "$g_rc" = 2 ] && [[ "$g_out" == *"could not read"* ]]; then ok "a failing zipinfo fails closed"; else bad "failing zipinfo: rc=$g_rc out=[$g_out]"; fi

# ---- part 3: real zips and the real zipinfo ---------------------------------------------------------------------------------
zipinfo_bin="${ZIPINFO:-/usr/bin/zipinfo}"
if [ ! -x "$zipinfo_bin" ] || { ! command -v ditto >/dev/null && ! command -v zip >/dev/null; }; then
  skip "real zips: needs zipinfo and ditto or zip on this machine"
else
  pack() { # DIR ZIP: zip the contents of DIR the way the release does where ditto exists
    if command -v ditto >/dev/null; then ditto -c -k "$1" "$2"; else (cd "$1" && zip -qr "$2" .); fi
  }
  mkdir -p "$tmp/real" "$tmp/bomb"
  head -c 3000000 /dev/urandom >"$tmp/real/random.bin"
  head -c 209715200 /dev/zero >"$tmp/bomb/zeros"
  pack "$tmp/real" "$tmp/real.zip"
  pack "$tmp/bomb" "$tmp/bomb.zip"
  expect "a real zip of data that does not compress passes" 0 "within the release limits" "$tmp/real.zip"
  expect "a real zip that expands 1000 times is refused" 1 "times its size" "$tmp/bomb.zip"
fi

# ---- part 4: the release script runs it --------------------------------------------------------------------------------------
if grep -Eq '^bash "\$here/update-size-limits\.sh" "\$zip_path"$' "$scripts/package-release.sh"; then ok "package-release.sh runs the gate on the zip it just made, under set -e"
else bad "package-release.sh does not run update-size-limits.sh on \$zip_path"; fi
size_line="$(grep -n 'update-size-limits.sh" "\$zip_path"' "$scripts/package-release.sh" | cut -d: -f1)"
manifest_line="$(grep -n '^jq -n' "$scripts/package-release.sh" | cut -d: -f1)"
if [ -n "$size_line" ] && [ -n "$manifest_line" ] && [ "$size_line" -lt "$manifest_line" ]; then ok "the gate runs before the manifest is written, so a refused zip never gets one"
else bad "the gate must come before the manifest (gate line [$size_line], manifest line [$manifest_line])"; fi

if [ "$fails" -gt 0 ]; then printf '%s check(s) failed\n' "$fails"; exit 1; fi
printf 'all checks passed\n'
