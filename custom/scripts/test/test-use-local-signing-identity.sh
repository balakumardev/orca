#!/usr/bin/env bash
# Test for use-local-signing-identity.sh with a stub `security` (no keychain is read or changed).
# Run: bash custom/scripts/test/test-use-local-signing-identity.sh
#
# What it pins: the script picks the Developer ID identity of the given team out of a mixed list (development, distribution and
# other teams' identities are ignored), copes with the same identity listed twice, fails with a clear error when there is none, and
# calls nothing but `security find-identity`: a call that creates a keychain or changes the search list or the default keychain is
# what the script exists to avoid.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unset GITHUB_ENV

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

mkdir "$tmp/bin"
cat > "$tmp/bin/security" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$SEC_LOG"
[ "$1" = find-identity ] || { echo "stub security: unexpected call: $*" >&2; exit 2; }
cat "$IDENTITIES"
STUB
chmod +x "$tmp/bin/security"

H1=1111111111111111111111111111111111111111
H2=2222222222222222222222222222222222222222
H3=3333333333333333333333333333333333333333
H4=4444444444444444444444444444444444444444

run() { # IDENTITIES-FILE [TEAM] -> sets u_out u_rc, writes $tmp/env
  : > "$tmp/sec.log"; : > "$tmp/env"
  u_rc=0
  u_out="$(env SECURITY_BIN="$tmp/bin/security" SEC_LOG="$tmp/sec.log" IDENTITIES="$1" ORCA_SIGN_TEAM_ID="${2-KHD36T7C97}" \
    GITHUB_ENV="$tmp/env" bash "$scripts/use-local-signing-identity.sh" 2>&1)" || u_rc=$?
}

# A mixed list: only the Developer ID Application identity of OUR team may be picked.
cat > "$tmp/mixed.txt" <<EOF
  1) $H1 "Apple Development: Someone (AAAAAAAAAA)"
  2) $H2 "Apple Distribution: CoolSolve LLP (KHD36T7C97)"
  3) $H3 "Developer ID Application: CoolSolve LLP (KHD36T7C97)"
  4) $H4 "Developer ID Application: Another Team (BBBBBBBBBB)"
     4 valid identities found
EOF
run "$tmp/mixed.txt"
if [ "$u_rc" = 0 ] && [ "$(cat "$tmp/env")" = "CSC_NAME=$H3" ]; then ok "picks the Developer ID identity of the team"; else bad "mixed list: rc=$u_rc env=$(cat "$tmp/env") out=$u_out"; fi
if [ "$(cat "$tmp/sec.log")" = "find-identity -v -p codesigning" ]; then ok "calls only security find-identity -v -p codesigning"; else bad "security was called as: $(cat "$tmp/sec.log")"; fi
case "$u_out" in *"::add-mask::$H3"*) ok "masks the hash" ;; *) bad "the hash is not masked: $u_out" ;; esac

# The same identity can be listed twice (two keychains hold it): one distinct hash, no warning.
cat > "$tmp/dup.txt" <<EOF
  1) $H3 "Developer ID Application: CoolSolve LLP (KHD36T7C97)"
  2) $H3 "Developer ID Application: CoolSolve LLP (KHD36T7C97)"
     2 valid identities found
EOF
run "$tmp/dup.txt"
if [ "$u_rc" = 0 ] && [ "$(cat "$tmp/env")" = "CSC_NAME=$H3" ]; then ok "one identity listed twice counts once"; else bad "duplicate: rc=$u_rc out=$u_out"; fi
case "$u_out" in *warning*) bad "a duplicate listing warned: $u_out" ;; *) ok "no warning for a duplicate listing" ;; esac

# A renewal leaves two valid identities: the first hash is used, with a warning.
cat > "$tmp/two.txt" <<EOF
  1) $H4 "Developer ID Application: CoolSolve LLP (KHD36T7C97)"
  2) $H3 "Developer ID Application: CoolSolve LLP (KHD36T7C97)"
EOF
run "$tmp/two.txt"
if [ "$u_rc" = 0 ] && [ "$(cat "$tmp/env")" = "CSC_NAME=$H3" ]; then ok "two identities: the first by hash is used"; else bad "two identities: rc=$u_rc env=$(cat "$tmp/env")"; fi
case "$u_out" in *"::warning"*) ok "two identities warn" ;; *) bad "two identities did not warn: $u_out" ;; esac

# None for the team: a clear error, nothing written.
cat > "$tmp/none.txt" <<EOF
  1) $H1 "Apple Development: Someone (AAAAAAAAAA)"
  2) $H4 "Developer ID Application: Another Team (BBBBBBBBBB)"
EOF
run "$tmp/none.txt"
if [ "$u_rc" != 0 ] && [ ! -s "$tmp/env" ]; then ok "no identity for the team fails and writes nothing"; else bad "none: rc=$u_rc env=$(cat "$tmp/env")"; fi
case "$u_out" in *"No Developer ID identity"*RELEASE_RUNS_ON*) ok "the error names the way out" ;; *) bad "the error does not name the way out: $u_out" ;; esac

# An empty identity list (security exits non-zero when there is nothing) is the same failure, not a crash.
: > "$tmp/empty.txt"
run "$tmp/empty.txt"
if [ "$u_rc" != 0 ]; then ok "an empty list fails"; else bad "an empty list passed"; fi

# The team id is checked before anything is read.
run "$tmp/mixed.txt" 'KHD36T7C97; rm -rf'
if [ "$u_rc" != 0 ] && [ ! -s "$tmp/sec.log" ]; then ok "a malformed team id is refused before security runs"; else bad "malformed team: rc=$u_rc log=$(cat "$tmp/sec.log")"; fi
u_rc=0
env SECURITY_BIN="$tmp/bin/security" SEC_LOG="$tmp/sec.log" IDENTITIES="$tmp/mixed.txt" bash "$scripts/use-local-signing-identity.sh" >/dev/null 2>&1 || u_rc=$?
if [ "$u_rc" != 0 ]; then ok "a missing team id is refused"; else bad "a missing team id passed"; fi

if [ "$fails" -gt 0 ]; then echo "$fails failure(s)"; exit 1; fi
echo "all passed"
