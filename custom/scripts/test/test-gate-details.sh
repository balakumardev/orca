#!/usr/bin/env bash
# Test: a failing gate records `details` in gates.json (the failure-relevant excerpt of its log), and the repair prompt shows it.
# Run: bash custom/scripts/test/test-gate-details.sh      (needs jq, perl; no pnpm, no network)
#
# Why: the repair round used to see only the last 40 lines (3500 bytes) of a failing gate's log. For the Playwright gate that is the list of
# failing test names; the assertion messages (`Expected ... Received ...`) are above it. In PR #43 the model could not know why a spec failed.
# The fixtures in fixtures/gate-logs are REAL output of the pinned tools (vitest 5.0.5, TypeScript 7, Playwright 1.64.1, oxlint, oxfmt 0.74,
# local paths scrubbed), plus one real CI vitest log; e2e-build-failure.txt is written by hand after a vite build error.
#
# Part 1 sources gate_details and feeds it each log. Part 2 checks the byte bounds and odd input (NUL, invalid UTF-8, a character split by the
# cut). Part 3 runs the whole run-gates.sh with a stub pnpm/npx that prints those logs, and reads gates.json and the prompt block.
#
# Prove the test bites (it must FAIL on the pre-change scripts):
#   d="$(mktemp -d)"; cp -R custom/scripts/. "$d"/; git show HEAD:custom/scripts/run-gates.sh > "$d/run-gates.sh"
#   git show HEAD:custom/scripts/lib.sh > "$d/lib.sh"; rm "$d/gate-details.sh"
#   SCRIPTS_DIR="$d" bash custom/scripts/test/test-gate-details.sh        # exits 1
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="${SCRIPTS_DIR:-$(cd "$here/.." && pwd)}"
fix="$here/fixtures/gate-logs"
for tool in jq perl; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
has() { grep -q -F -- "$2" <<<"$1"; } # TEXT NEEDLE
lacks() { ! grep -q -F -- "$2" <<<"$1"; }
body_of() { sed '/^--- last lines of the log ---$/,$d' <<<"$1"; } # everything before the end-of-log tail

# ---- part 1: one extractor per tool, on real output --------------------------------------------------------------------------
# shellcheck source=../lib.sh
. "$scripts/lib.sh"
if [ -f "$scripts/gate-details.sh" ]; then
  # shellcheck source=../gate-details.sh
  . "$scripts/gate-details.sh"
else
  bad "gate-details.sh exists in $scripts"
  gate_details() { :; }
fi
details() { gate_details "$1" "$fix/$2"; } # GATE_ID FIXTURE

d="$(details e2e playwright-list.txt)"
old_tail="$(tail -n 40 "$fix/playwright-list.txt")"
echo "playwright (list reporter)"
check "control: the old 40-line tail does NOT hold the first spec's assertion (it is the bug)" lacks "$old_tail" 'toHaveAttribute'
for needle in 'toHaveAttribute' 'Expected: "Search agents"' 'Received: ""' 'unexpected value "null"' 'placeholder text moved to aria-placeholder' \
  'toHaveCount' 'Expected: 2' 'Received: 1' 'Expected: 4' 'Received: 3' 'the app did not start: ENOENT' '4 failed, 1 passed' 'sidebar.spec.ts:6:46'; do
  check "list: details has [$needle]" has "$d" "$needle"
done
check "list: the failing source line is kept" has "$d" "await expect(page.getByTestId('search')).toHaveAttribute"
check "list: the source frame around it is dropped" lacks "$(body_of "$d")" '    7 |   })'
check "list: the Error Context artifact path is dropped" lacks "$(body_of "$d")" 'error-context.md'
check "list: the passing spec is not a failure block" lacks "$(body_of "$d")" '5) ['
d="$(details e2e playwright-dot.txt)"
echo "playwright (dot reporter, what std-env's isAgent selects)"
check "dot: details has the first assertion and the summary" bash -c '[[ "$1" == *"Received: \"\""* && "$1" == *"4 failed, 1 passed"* ]]' _ "$d"

d="$(details unit vitest-failures.txt)"
echo "vitest"
for needle in ' FAIL  src/foo.test.ts > suite > adds' 'AssertionError: expected 2 to be 3' '- Expected' '+ Received' '❯ src/foo.test.ts:5:19' \
  ' FAIL  src/bar.test.ts [ src/bar.test.ts ]' "Cannot find module './not-here'" 'Unhandled Errors' 'Error: late' 'This error originated in "src/baz.test.ts"' \
  'Test Files  2 failed | 1 passed (3)'; do
  check "vitest: details has [$needle]" has "$d" "$needle"
done
check "vitest: the source frame is dropped" lacks "$(body_of "$d")" "expect(1 + 1).toBe(3)"
d="$(gate_details unit-related "$here/fixtures/unit-flake-real.txt")"
check "vitest (a real CI log): the unhandled errors and the file they came from are kept" bash -c '[[ "$1" == *"Unhandled Errors"* && "$1" == *"git-branch-cleanup-real-git.test.ts"* && "$1" == *"Errors  2 errors"* ]]' _ "$d"
check "vitest (a real CI log): 996 passing files are not copied" lacks "$(body_of "$d")" 'HostRemoveDialog.test.tsx'

for f in tsc-plain.txt tsc-pretty.txt; do
  d="$(details typecheck "$f")"
  echo "tsc ($f)"
  for needle in 'tsc: 7 distinct error(s) in 2 file(s)' 'by code: TS2353 x2' 'tc/a.ts (6)' "Cannot find module './moved/gone'" "Expected 2 arguments, but got 1." \
    "'name' does not exist in type '{ id: number; }'"; do
    check "$f: details has [$needle]" has "$d" "$needle"
  done
  check "$f: no code frame or squiggle in the excerpt" bash -c '! grep -q "~~~" <<<"$1"' _ "$(body_of "$d")"
done
d="$(printf 'tests/e2e/a.spec.ts: 2 type error(s), baseline allows 0.\ntests/e2e/a.spec.ts(3,1): error TS2305: Module "./x" has no exported member "y".\n  Did you mean "z"?\n  Third line\nThe baseline may only shrink. Fix it: pnpm check:e2e-typecheck-ratchet --prune\n' > "$tmp/ratchet.log"; gate_details e2e-ratchet "$tmp/ratchet.log")"
check "ratchet: the verdict, the error and its continuation lines are kept" bash -c '[[ "$1" == *"baseline allows 0"* && "$1" == *"TS2305"* && "$1" == *"Did you mean"* && "$1" == *"may only shrink"* ]]' _ "$d"

for f in oxlint-default.txt oxlint-github.txt oxlint-oneline.txt; do
  d="$(details lint "$f")"
  echo "oxlint ($f)"
  check "$f: four diagnostics with path:line:col" bash -c '[[ "$1" == *"oxlint: 4 diagnostic(s) in 1 file(s)"* && "$1" == *"lint/a.ts:1:7:"* && "$1" == *"no-unused-vars"* && "$1" == *"lint/a.ts:4:9:"* && "$1" == *"eqeqeq"* ]]' _ "$d"
  check "$f: the per-file count names the file (not an empty name)" has "$d" 'lint/a.ts (4)'
done
d="$(details format oxfmt-check.txt)"
check "oxfmt: the unformatted file is listed without its timing, with the fix command" bash -c '[[ "$1" == *"oxfmt --check: 1 file(s)"* && "$1" == *"lint/b.ts"* && "$1" != *"b.ts (0ms)"* && "$1" == *"oxfmt --write"* ]]' _ "$(body_of "$d")"
printf 'Checking formatting...\n[warn] src/a.ts\n[warn] src/b.tsx\n[warn] Code style issues found in 2 files. Run Prettier with --write to fix.\n' > "$tmp/warn.log"
d="$(gate_details format "$tmp/warn.log")"
check "oxfmt ([warn] style): both files, not the summary sentence" bash -c '[[ "$1" == *"2 file(s) differ"* && "$1" == *"src/a.ts"* && "$1" == *"src/b.tsx"* ]]' _ "$(body_of "$d")"

echo "no recognised report: never worse than the old tail"
d="$(details e2e e2e-build-failure.txt)"
check "build error: says the report was not recognised" has "$d" 'no recognised failure report'
check "build error: the error-looking lines are shown" has "$d" 'Rollup failed to resolve import'
check "build error: the end of the log follows" has "$d" 'ELIFECYCLE Command failed with exit code 1.'
printf 'Error: 3 locale keys are missing in src/renderer/src/i18n/locales/fr.json\n  sidebar.activity.title\n' > "$tmp/loc.log"
check "an unknown gate id gets the generic excerpt" has "$(gate_details localization "$tmp/loc.log")" 'locale keys are missing'
check "an empty or missing log gives an empty excerpt" test -z "$(gate_details unit "$tmp/none.log")$(: > "$tmp/empty.log"; gate_details unit "$tmp/empty.log")"

# ---- part 2: bounds and odd bytes --------------------------------------------------------------------------------------------
echo "bounds and odd bytes"
big="$tmp/big.log"
perl -e 'for my $i (1 .. 3000) { printf "  %d) [electron-headless] › tests/e2e/x%d.spec.ts:10:5 › title %d\n\n    Error: expect(locator).toHaveText(expected) failed\n\n    Expected: \"%s\"\n    Received: \"\"\n\n", $i, $i, $i, "y" x 200 } print "  3000 failed\n"' > "$big"
check "fixture: the huge log is over 1 MB" test "$(wc -c < "$big" | tr -d ' ')" -gt 1000000
d="$(gate_details e2e "$big")"
check "a huge log gives at most 8000 bytes plus the marker lines (default target)" test "$(printf '%s\n' "$d" | wc -c | tr -d ' ')" -le 8200
check "a huge log: the first failures are kept" has "$d" 'title 1'
check "a huge log: says where the rest is" has "$d" 'the whole log is in the gates artifact (logs/e2e.log)'
d="$(GATE_DETAILS_BYTES=999999 gate_details e2e "$big")"
check "no caller can lift the cap above 12000 bytes" test "$(printf '%s\n' "$d" | wc -c | tr -d ' ')" -le 12001
d="$(GATE_DETAILS_BYTES=3000 gate_details e2e "$big")"
check "a lower target is honoured" test "$(printf '%s\n' "$d" | wc -c | tr -d ' ')" -le 3200

odd="$tmp/odd.log"
{
  printf 'error TS2307: a line with a NUL \000 inside\n'
  printf 'error TS2322: invalid UTF-8 \377\376 and a lone lead byte \303 here\n'
  printf '\033[31mred\033[0m a stray ESC \033 and a bell \007 and a CR\r\n'
  printf 'quote " backslash \\ tab \t brace { } and a mojibake %s\n' "$(printf '\303\251\342\202\254\360\237\230\200')"
  perl -e 'print "error TS2345: x", "\xc3\xa9" x 9000, "\n"' # an odd offset: the line cut lands inside a two-byte character
  printf 'tail line\n'
} > "$odd"
for id in typecheck e2e lint unit localization; do
  d="$(gate_details "$id" "$odd")"
  printf '%s\n' "$d" > "$tmp/odd.details"
  # strict decoding with perl: macOS's iconv rejects valid text whose characters straddle its read buffer
  check "odd bytes ($id): valid UTF-8, no control bytes, at most 12000 bytes" bash -c 'perl -MEncode -e '"'"'local $/; open my $f, "<:raw", $ARGV[0] or exit 2; my $s = <$f>; exit(eval { Encode::decode("UTF-8", $s, Encode::FB_CROAK | Encode::LEAVE_SRC); 1 } ? 0 : 1)'"'"' "$1" && perl -ne "exit 1 if /[\\x00-\\x08\\x0b-\\x1f\\x7f]/" "$1" && [ "$(wc -c < "$1")" -le 12001 ]' _ "$tmp/odd.details"
  check "odd bytes ($id): the end of the log is still there" has "$d" 'tail line'
  check "odd bytes ($id): the text goes into JSON" jq -n -c --rawfile d "$tmp/odd.details" '{details: $d}'
done

# ---- part 3: the whole run-gates.sh, and the prompt block ----------------------------------------------------------------------
echo "run-gates.sh end to end (stub pnpm and npx print the logs above)"
repo="$tmp/repo"
mkdir -p "$repo/src/mine" "$repo/tests/e2e" "$repo/node_modules" "$repo/custom" "$tmp/bin"
printf 'v1.0.0\n' > "$repo/custom/BASE"
printf 'export const a = 1\n' > "$repo/src/mine/a.ts"
printf 'export {}\n' > "$repo/src/mine/a.test.ts"
printf 'export {}\n' > "$repo/tests/e2e/x.spec.ts"
( cd "$repo" && git init -q -b main && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m init )
printf 'src/mine/a.ts\nsrc/mine/a.test.ts\ntests/e2e/x.spec.ts\n' > "$tmp/our-files.txt"
cat > "$tmp/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
# Prints a captured log and fails, like the real tool would; STUB_TC overrides the typecheck log.
f="$GATE_LOGS"
case "$*" in
  *oxlint*) cat "$f/oxlint-default.txt"; exit 1 ;;
  *oxfmt*) cat "$f/oxfmt-check.txt"; exit 1 ;;
  *vitest*) cat "$f/vitest-failures.txt"; exit 1 ;;
  tc) cat "${STUB_TC:-$f/tsc-plain.txt}"; exit 1 ;;
  *check:e2e-typecheck-ratchet*) printf 'tests/e2e/x.spec.ts: 1 type error(s), baseline allows 0.\n'; cat "$f/tsc-plain.txt"; exit 1 ;;
  *verify:localization-coverage*) printf 'Error: 3 locale keys are missing in fr.json\n'; exit 1 ;;
  *ensure:electron-runtime*) exit 0 ;;
esac
exit 0
STUB
cat > "$tmp/bin/npx" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"playwright test"*) cat "$GATE_LOGS/playwright-list.txt"; exit 1 ;;
esac
exit 0
STUB
printf '#!/usr/bin/env bash\nshift\nexec "$@"\n' > "$tmp/bin/xvfb-run"
chmod +x "$tmp/bin/pnpm" "$tmp/bin/npx" "$tmp/bin/xvfb-run"

run_gates() { # NAME [ENV=VALUE...] -> $tmp/out-NAME/gates.json
  local name="$1"; shift
  ( cd "$repo" && env PATH="$tmp/bin:$PATH" GATE_LOGS="$fix" "$@" bash "$scripts/run-gates.sh" --out "$tmp/out-$name" --mode sync --our-files "$tmp/our-files.txt" \
      --only typecheck,lint,format,unit,localization,e2e-ratchet,e2e --exit-zero ) > "$tmp/run-$name.log" 2>&1
}
gj="$tmp/out-main/gates.json"
if run_gates main; then ok "run-gates.sh ran to the end"; else bad "run-gates.sh ran to the end"; sed 's/^/    /' "$tmp/run-main.log" | tail -n 12; fi
check "gates.json is valid JSON" jq -e . "$gj"
check "all seven gates failed (the stubs exit 1)" test "$(jq '[.gates[] | select(.status == "fail")] | length' "$gj")" -eq 7
gate() { jq -r --arg id "$1" '.gates[] | select(.id == $id) | .'"$2" "$gj"; }
check "every failing gate has details" test "$(jq '[.gates[] | select(.status == "fail" and ((.details // "") | length > 0))] | length' "$gj")" -eq 7
check "every gate keeps output_tail (the old field) and exit_code" test "$(jq '[.gates[] | select((.output_tail | length) > 0 and .exit_code == 1)] | length' "$gj")" -eq 7
check "no details are longer than 12000 bytes" test "$(jq '[.gates[] | .details // "" | utf8bytelength] | max' "$gj")" -le 12000
check "e2e details: the assertion the old tail could not show" bash -c '[[ "$1" == *"toHaveAttribute"* && "$1" == *"Received: \"\""* ]]' _ "$(gate e2e details)"
check "e2e output_tail is still only the tail (no assertion above the cut)" bash -c '[[ "$1" != *"toHaveAttribute"* ]]' _ "$(gate e2e output_tail)"
check "typecheck details: the error lines" bash -c '[[ "$1" == *"TS2307"* && "$1" == *"by code:"* ]]' _ "$(gate typecheck details)"
check "unit details: the failing test and its diff" bash -c '[[ "$1" == *"FAIL  src/foo.test.ts > suite > adds"* && "$1" == *"- Expected"* ]]' _ "$(gate unit details)"
check "lint details: the rule and location" bash -c '[[ "$1" == *"lint/a.ts:2:1"* && "$1" == *"no-debugger"* ]]' _ "$(gate lint details)"
check "format details: the file" bash -c '[[ "$1" == *"lint/b.ts"* ]]' _ "$(gate format details)"
check "localization (no extractor) still has details: the generic excerpt" bash -c '[[ "$1" == *"locale keys are missing"* ]]' _ "$(gate localization details)"
check "the details are also kept as a file in the artifact (logs/e2e.details.txt)" test -s "$tmp/out-main/logs/e2e.details.txt"
check "a passing gate has no details field" bash -c '! jq -e ".gates[] | select(.status == \"pass\") | .details" "$1" >/dev/null 2>&1' _ "$gj"

# record() must not depend on its caller's variables: its `local` line used $id of the CALLER (dynamic scope, shellcheck SC2318), which only
# worked because run_gate happens to have an `id` too. Called from a scope with no `id` under `set -u`, as the script runs, it died.
mkdir -p "$tmp/rec/logs" "$tmp/rec/notes"
printf 'src/a.ts(3,5): error TS2345: Argument of type string is not assignable.\n' > "$tmp/rec/logs/typecheck.log"
check "record(): works from a scope that has no \`id\` (set -u) and names its details file by its own id" bash -c '
  set -euo pipefail
  . "$1/lib.sh"; . "$1/gate-details.sh"
  eval "$(awk "/^record\\(\\)/,/^}/" "$1/run-gates.sh")"
  OUT="$2"; record typecheck "Typecheck" fail 1 3
  test -s "$OUT/logs/typecheck.details.txt" && test ! -e "$OUT/logs/.details.txt"
  jq -e ".details | contains(\"error TS2345\")" "$OUT/results.jsonl"' _ "$scripts" "$tmp/rec"

# odd bytes through the whole script: a typecheck log with NUL, invalid UTF-8 and a split character must still give valid JSON
run_gates odd STUB_TC="$odd" || true
check "odd bytes through run-gates.sh: gates.json is valid JSON" jq -e . "$tmp/out-odd/gates.json"
check "odd bytes through run-gates.sh: typecheck still has details" jq -e '.gates[] | select(.id == "typecheck") | (.details | length) > 0' "$tmp/out-odd/gates.json"

# the prompt block
if declare -F failing_gates_block >/dev/null; then
  blk="$(failing_gates_block 28000 "$gj")"
  check "prompt block: every failing gate has a header" test "$(grep -c '^### .* (exit 1) - ' <<<"$blk")" -eq 7
  check "prompt block: shows the e2e failure excerpt, not the bare tail" bash -c '[[ "$1" == *"toHaveAttribute"* && "$1" == *"failure excerpt"* ]]' _ "$blk"
  check "prompt block: within the 28000-byte budget" test "$(printf '%s' "$blk" | wc -c | tr -d ' ')" -le 28000
  # fair share: one huge gate must not starve the others
  fair_json() { perl -MJSON::PP -e 'my @g; push @g, { id => "a", name => "Huge A", status => "fail", exit_code => 1, details => "a" x 20000 }; push @g, { id => "b", name => "Small B", status => "fail", exit_code => 1, details => "SMALL-B-FULL-TEXT" }; push @g, { id => "c", name => "Huge C", status => "fail", exit_code => 1, details => "c" x 30000 }; push @g, { id => "d", name => "Tail D", status => "fail", exit_code => 2, output_tail => ("t" x 3000) . "TAIL-D-END" }; push @g, { id => "e", name => "Passing E", status => "pass", exit_code => 0, output_tail => "NOT-SHOWN" }; print encode_json({ schema => 1, gates => \@g })'; }
  fair_json > "$tmp/fair.json"
  blk="$(failing_gates_block 28000 "$tmp/fair.json")"
  check "fair share: all four failing gates are shown, the passing one is not" bash -c '[[ "$(grep -c "^### " <<<"$1")" -eq 4 && "$1" != *"NOT-SHOWN"* ]]' _ "$blk"
  check "fair share: the small gate is complete, the tail gate shows its END" bash -c '[[ "$1" == *"SMALL-B-FULL-TEXT"* && "$1" == *"TAIL-D-END"* ]]' _ "$blk"
  check "fair share: a huge gate is cut and says so; the budget holds" bash -c '[[ "$1" == *"cut to fit"* && "$(printf "%s" "$1" | wc -c)" -le 28000 ]]' _ "$blk"
  check "fair share: both huge gates keep about the same room (neither starves the other)" bash -c 'a="$(awk "/^### Huge A/{f=1;next} /^### /{f=0} f" <<<"$1" | wc -c)"; c="$(awk "/^### Huge C/{f=1;next} /^### /{f=0} f" <<<"$1" | wc -c)"; [ "$a" -gt 9000 ] && [ "$c" -gt 9000 ]' _ "$blk"
  # The budget is in BYTES (the caller's trunc_bytes counts bytes): multibyte text must not push the block over it, because the overrun is cut
  # off the END of the block, which is the last failing gate in gate order (e2e-ratchet, e2e), the one the repair most needs.
  mb_json() { perl -Mutf8 -MJSON::PP -e 'my @g; my $n = 0; for my $x (["Typecheck", "details", "é" x 30000], ["Lint", "details", "日" x 30000], ["Unit tests", "output_tail", "😀" x 20000], ["E2E typecheck ratchet", "details", "é日😀" x 10000], ["Playwright e2e specs", "details", ("é" x 30000) . "LAST-GATE-END"]) { push @g, { id => "g" . $n++, name => $x->[0], status => "fail", exit_code => 1, $x->[1] => $x->[2] }; } print encode_json({ schema => 1, gates => \@g })'; }
  mb_json > "$tmp/mb.json"
  failing_gates_block 28000 "$tmp/mb.json" > "$tmp/mb.blk"
  head -c 28000 "$tmp/mb.blk" > "$tmp/mb.cut" # what agent-round.sh does to the block (trunc_bytes 28000): the byte backstop
  check "multibyte: the block itself (before any trunc_bytes) is within 28000 BYTES" test "$(wc -c < "$tmp/mb.blk" | tr -d ' ')" -le 28000
  check "multibyte: all five failing gates have their section, after the byte backstop too" test "$(grep -c '^### ' "$tmp/mb.cut")" -eq 5
  check "multibyte: every section keeps at least 1000 bytes of its text, the last gate included" bash -c 'LC_ALL=C awk "/^### /{ if (n != \"\") print n, b; n = \$2; b = 0; next } { b += length(\$0) + 1 } END { print n, b }" "$1" | LC_ALL=C awk "{ if (\$2 < 1000) bad = 1 } END { exit bad }"' _ "$tmp/mb.cut"
  check "multibyte: the last gate shows its section, cut with the marker" bash -c 'sed -n "/^### Playwright e2e specs/,\$p" "$1" | grep -q -F "cut to fit"' _ "$tmp/mb.cut"
  check "multibyte: still valid UTF-8 (every cut is on a character boundary)" perl -MEncode -e 'local $/; my $s = <STDIN>; eval { decode("UTF-8", $s, Encode::FB_CROAK) }; exit($@ ? 1 : 0)' < "$tmp/mb.blk"
  # ASCII at the limit: eleven gates each with more text than fits, long names: the headers and cut markers count against the budget
  perl -MJSON::PP -e 'my @g; for my $i (1 .. 11) { push @g, { id => "g$i", name => "A rather long gate name number $i for the header size", status => "fail", exit_code => 1, details => ("line of text $i\n" x 2000) } } print encode_json({ schema => 1, gates => \@g })' > "$tmp/asc.json"
  failing_gates_block 28000 "$tmp/asc.json" > "$tmp/asc.blk"
  check "eleven big gates: the block itself is within 28000 bytes (headers and markers are counted)" test "$(wc -c < "$tmp/asc.blk" | tr -d ' ')" -le 28000
  head -c 28000 "$tmp/asc.blk" > "$tmp/asc.cut"
  check "eleven big gates: after the byte backstop each section still ends with its own cut marker (the last one is not clipped)" test "$(grep -c -F 'cut to fit' "$tmp/asc.cut")" -eq 11
  check "a small TOTAL still gives every gate a section" bash -c 'source "$1/lib.sh"; [ "$(failing_gates_block 3000 "$2" | grep -c "^### ")" -eq 11 ] && [ "$(failing_gates_block 3000 "$2" | wc -c)" -le 3000 ]' _ "$scripts" "$tmp/asc.json"
else
  bad "failing_gates_block exists in lib.sh"
fi

if [ "$fails" -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
