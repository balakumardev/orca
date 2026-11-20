#!/usr/bin/env bash
# Test for format-our-files.sh and its place in sync-merge.sh finish, with a fake formatter (strips trailing spaces from the files it is
# given) so no node_modules, network or oxfmt is needed. Run: bash custom/scripts/test/test-format-our-files.sh   (needs git, jq)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
for tool in git jq; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

# The fake formatter: `fake --write [--] FILE...` removes trailing spaces. It fails on a file that holds the word BROKEN (a parse
# error), after handling the others, the way the real one reports a file it cannot parse.
fake="$tmp/fake-oxfmt"
cat > "$fake" <<'FAKE'
#!/usr/bin/env bash
rc=0
for a in "$@"; do
  case "$a" in --write|--) continue ;; esac
  if grep -q BROKEN -- "$a"; then rc=2; continue; fi
  sed -E 's/ +$//' "$a" > "$a.tmp" && mv "$a.tmp" "$a"
done
exit $rc
FAKE
chmod +x "$fake"

work="$tmp/work"
mkdir -p "$work/src" "$work/custom/scripts" "$work/.github/workflows"
cd "$work"
git init -q -b main .
printf 'const a = 1   \n' > src/needs-format.ts
printf 'const b = 2\n' > src/already-formatted.ts
printf 'const c = 3  \n' > src/has-markers.ts
printf '<<<<<<< ours\nx  \n=======\ny\n>>>>>>> theirs\n' >> src/has-markers.ts
printf 'const d = 4  \nBROKEN\n' > src/unparsable.ts
printf 'const e = 5  \n' > src/also-needs-format.tsx
printf '# notes  \n' > src/readme-like.md
printf 'const f = 6  \n' > custom/scripts/scaffolding.mjs
printf 'name: x  \n' > .github/workflows/ci.yml
git add -A && git commit -q -m base
printf '%s\n' src/needs-format.ts src/already-formatted.ts src/has-markers.ts src/unparsable.ts src/also-needs-format.tsx src/readme-like.md \
  custom/scripts/scaffolding.mjs .github/workflows/ci.yml src/gone-upstream.ts > "$tmp/our-files.txt"

echo "format-our-files.sh"
out="$(OXFMT_BIN="$fake" bash "$scripts/format-our-files.sh" "$tmp/our-files.txt" 2>/dev/null)" || out="FAILED"
check "it lists the two files the formatter changed, in path order" test "$out" = "$(printf 'src/also-needs-format.tsx\nsrc/needs-format.ts')"
check "a file that needed it is formatted" test "$(cat src/needs-format.ts)" = "const a = 1"
check "a file that was fine is left alone and not listed" test "$(cat src/already-formatted.ts)" = "const b = 2"
check "a file with conflict markers is not touched" grep -q 'const c = 3  $' src/has-markers.ts
check "a file the formatter cannot parse does not stop the others" test "$(cat src/also-needs-format.tsx)" = "const e = 5"
check "the unparsable file is not listed" test -z "$(grep -x 'src/unparsable.ts' <<<"$out" || true)"
check "a markdown file is not touched" grep -q 'notes  $' src/readme-like.md
check "fork scaffolding is not touched" grep -q 'const f = 6  $' custom/scripts/scaffolding.mjs
check "upstream CI is not touched" grep -q 'name: x  $' .github/workflows/ci.yml
check "a path that no longer exists is skipped without an error" test "$out" != FAILED
out2="$(OXFMT_BIN="$fake" bash "$scripts/format-our-files.sh" "$tmp/our-files.txt" 2>/dev/null || echo FAILED)"
check "a second run changes nothing and lists nothing" test -z "$out2"
out3="$(OXFMT_BIN="" bash "$scripts/format-our-files.sh" "$tmp/our-files.txt" 2>/dev/null || echo FAILED)"
check "no formatter set: prints nothing, exits 0" test -z "$out3"
out4="$(OXFMT_BIN="$tmp/does-not-exist" bash "$scripts/format-our-files.sh" "$tmp/our-files.txt" 2>/dev/null || echo FAILED)"
check "a formatter path that does not exist: prints nothing, exits 0" test -z "$out4"

echo "install-oxfmt.sh"
so="$tmp/sync-out"; mkdir -p "$so"
out5="$(SYNC_OUT="$so" OXFMT_DIR="$tmp/ox" bash "$scripts/install-oxfmt.sh" 2>/dev/null || echo FAILED)"
check "no recorded version: no output, exit 0, nothing installed" bash -c "test -z '$out5' && test ! -e '$tmp/ox/node_modules'"
printf '0.74.0; touch %s/pwned\n' "$tmp" > "$so/oxfmt-version.txt"
out6="$(SYNC_OUT="$so" OXFMT_DIR="$tmp/ox" bash "$scripts/install-oxfmt.sh" 2>/dev/null || echo FAILED)"
check "an odd version text is refused, never run as a command" bash -c "test -z '$out6' && test ! -e '$tmp/pwned'"

echo
if [ "$fails" -eq 0 ]; then echo "all checks passed"; else echo "$fails check(s) FAILED"; exit 1; fi
