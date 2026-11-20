#!/usr/bin/env bash
# Test: check-hunk-survival.sh finds lines of ours that a merge dropped from upstream's files, also in a file upstream MOVED and rewrote,
# and run-gates.sh runs it as an ADVISORY gate that cannot fail.
# Run: bash custom/scripts/test/test-check-hunk-survival.sh      (needs git, jq, awk, perl; no pnpm, no network)
#
# The scratch repository has the shape of a real sync (the case that motivated the check, PR #43): an old release, `custom` = old release
# plus our edits, a new release that moves and rewrites one of the files we edited, and a merge commit made like sync-merge.sh makes it
# (`commit-tree -p <custom tip> -p <link>`, the link commit having the parents new release and old release). The merge tree is built by
# hand, so each file can lose or keep our lines on purpose.
#
# Prove the test bites (it must FAIL on a script without the rename mapping, or without the script at all):
#   d="$(mktemp -d)"; cp -R custom/scripts/. "$d"/
#   perl -0pi -e 's/mapped="\$\(awk -F.*?rename-map\.tsv"\)"/mapped=""/s' "$d/check-hunk-survival.sh"        # forget where files moved
#   SCRIPTS_DIR="$d" bash custom/scripts/test/test-check-hunk-survival.sh        # exits 1
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="${SCRIPTS_DIR:-$(cd "$here/.." && pwd)}"
CHECK="$scripts/check-hunk-survival.sh"
RUN_GATES="$scripts/run-gates.sh"
for tool in git jq awk perl; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
[ -f "$CHECK" ] || { echo "FAIL no such script: $CHECK"; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
has() { grep -q -F -- "$2" <<<"$1"; }
lacks() { ! grep -q -F -- "$2" <<<"$1"; }

# lines FILE PREFIX N: N numbered lines. insert_after FILE N TEXT...: the texts go in after line N.
lines() { awk -v p="$2" -v n="$3" 'BEGIN { for (i = 1; i <= n; i++) print p " number " i " of the file" }' > "$1"; }
insert_after() {
  local f="$1" n="$2"; shift 2
  printf '%s\n' "$@" > "$f.ins"
  awk -v n="$n" -v ins="$f.ins" '{ print } NR == n { while ((getline l < ins) > 0) print l }' "$f" > "$f.new" && mv "$f.new" "$f" && rm "$f.ins"
}
edit_line() { awk -v n="$2" -v t="$3" 'NR == n { print t; next } { print }' "$1" > "$1.new" && mv "$1.new" "$1"; }
commit_all() { git add -A && git commit -q -m "$1"; }

# ---- the scratch repository ----------------------------------------------------------------------------------------------------
repo="$tmp/repo"
git init -q -b old "$repo"
cd "$repo"
mkdir -p src/old src/stay src/ours custom
for f in src/old/Moved.tsx src/old/Kept.tsx src/old/Renamed.ts src/old/Gone.ts src/old/KeptOld.ts src/stay/Same.ts src/stay/Partial.ts \
  src/stay/NoiseOnly.ts src/stay/Indent.ts src/stay/Special.ts src/stay/Many.ts; do lines "$f" "$(basename "$f" | cut -d. -f1)" 60; done
echo 'lock a' > pnpm-lock.yaml; echo '# notes' > CLAUDE.md; echo 'echo hi' > custom/x.sh
commit_all "old release"; git tag v1.0.0; old="$(git rev-parse HEAD)"

git checkout -q -b custom
# our customization: lines added to upstream's files
insert_after src/old/Moved.tsx 10 "  const [selectedKey, setSelectedKey] = useState<string | null>(null)" "  useFollowFocusedItem({ selectedKey, setSelectedKey })" "  // wiring for the follow hook" "  x()" "import { useFollowFocusedItem } from '@/follow/use-follow-focused-item'"
insert_after src/old/Kept.tsx 10 "  const keptState = useOurState(initialKeptValue)" "  renderOurKeptThing(keptState, extraOptions)"
insert_after src/old/Renamed.ts 10 "  const renamedState = useOurState(initialRenamedValue)" "  renderOurRenamedThing(renamedState, extraOptions)"
insert_after src/old/Gone.ts 10 "  const goneState = useOurState(initialGoneValue)" "  renderOurGoneThing(goneState, extraOptions)"
insert_after src/old/KeptOld.ts 10 "  const keptOldState = useOurState(initialKeptOldValue)" "  renderOurKeptOldThing(keptOldState, extraOptions)"
insert_after src/stay/Same.ts 10 "  const sameState = useOurState(initialSameValue)" "  renderOurSameThing(sameState, extraOptions)"
insert_after src/stay/Partial.ts 10 "  partialKept(await loadOurThing(partialConfig))" "  partialLost(await loadOurThing(partialConfig))"
insert_after src/stay/NoiseOnly.ts 10 "import { aThing } from './a-thing-with-a-long-name'" "// only a comment that explains the next line" "  a()" "} from '@/some/module/with/a/path'"
insert_after src/stay/Indent.ts 10 "const indentOne = computeOurIndentedThing(inputValue)" "renderOurIndentedThing(indentOne, extraOptions)"
insert_after src/stay/Special.ts 10 '  const el = <div className="a">{`${value} @someone`}</div>' "  console.log('a \`backtick\` and <b>markup</b> and @everyone here')"
insert_after src/stay/Many.ts 10 "  manyLine01(ourManyValueNumberOne)" "  manyLine02(ourManyValueNumberTwo)" "  manyLine03(ourManyValueNumberThree)" "  manyLine04(ourManyValueNumberFour)" "  manyLine05(ourManyValueNumberFive)" "  manyLine06(ourManyValueNumberSix)" "  manyLine07(ourManyValueNumberSeven)" "  manyLine08(ourManyValueNumberEight)" "  manyLine09(ourManyValueNumberNine)"
lines src/ours/NewFile.ts newfile 10 # new in custom: ours entirely, never checked
echo 'lock a
lock ours added line' > pnpm-lock.yaml
echo '# notes
our own note that the merge keeps' >> CLAUDE.md
echo 'echo ours' >> custom/x.sh
echo v1.0.0 > custom/BASE
commit_all "our customization"; ours="$(git rev-parse HEAD)"

git checkout -q -b upstream "$old"
mkdir -p src/new/dir src/other
git mv src/old/Moved.tsx src/new/dir/Moved.tsx; lines src/new/dir/Moved.tsx rewritten 70 # rewritten: nothing like the old file
git mv src/old/Kept.tsx src/new/dir/Kept.tsx; edit_line src/new/dir/Kept.tsx 5 "Kept changed by upstream"
git mv src/old/Renamed.ts src/other/Different.ts
for i in 3 6 9 12 15 18 21 24 27 30 33 36 39 42 45 48 51 54 57 60; do edit_line src/other/Different.ts "$i" "upstream rewrote line $i"; done # about 2/3 similar
git rm -q src/old/Gone.ts src/old/KeptOld.ts
for f in src/stay/Same.ts src/stay/Partial.ts src/stay/NoiseOnly.ts src/stay/Indent.ts src/stay/Special.ts src/stay/Many.ts; do edit_line "$f" 40 "upstream changed line 40"; done
commit_all "new release"; git tag v1.0.1; new="$(git rev-parse HEAD)"
link="$(git commit-tree "$new^{tree}" -p "$new" -p "$old" -m "Link upstream v1.0.1 to v1.0.0")"

# the merge tree: upstream's tree, then what the merge kept of ours
git checkout -q -b merge-work "$new"
insert_after src/new/dir/Kept.tsx 10 "  const keptState = useOurState(initialKeptValue)" "  renderOurKeptThing(keptState, extraOptions)"
insert_after src/other/Different.ts 10 "  const renamedState = useOurState(initialRenamedValue)" "  renderOurRenamedThing(renamedState, extraOptions)"
insert_after src/stay/Same.ts 10 "  const sameState = useOurState(initialSameValue)" "  renderOurSameThing(sameState, extraOptions)"
insert_after src/stay/Partial.ts 10 "  partialKept(await loadOurThing(partialConfig))"
insert_after src/stay/Indent.ts 10 "      const indentOne = computeOurIndentedThing(inputValue)   " "	renderOurIndentedThing(indentOne, extraOptions)"
mkdir -p src/old; git show "$ours:src/old/KeptOld.ts" > src/old/KeptOld.ts # the agent kept the file the upstream deleted
insert_after src/stay/Many.ts 10 "  manyLine01(ourManyValueNumberOne)" # 8 of 9 missing: shows 5 samples
commit_all "merge tree"
merged="$(git commit-tree "$(git rev-parse 'HEAD^{tree}')" -p "$ours" -p "$link" -m "Merge upstream v1.0.1 into custom")"
git checkout -q --detach "$merged"
cd "$tmp"

run_check() { ( cd "$repo" && bash "$CHECK" --old "$old" --ours "$ours" --new "$new" --merged "$merged" --json "$tmp/hs.json" 2> "$tmp/hs.err" ); }
if out="$(run_check)"; then ok "check-hunk-survival.sh ran and exited 0 although lines were lost (it is advisory)"; else bad "check-hunk-survival.sh exited non-zero"; sed 's/^/    /' "$tmp/hs.err" | tail -n 8; out=""; fi

echo "what is reported"
line_for() { grep -F -- "$1" <<<"$out" | head -n 1; }
l="$(line_for 'src/old/Moved.tsx')"
check "a file upstream moved and rewrote: reported under its old AND new path" bash -c '[[ "$1" == *"\`src/old/Moved.tsx\` -> \`src/new/dir/Moved.tsx\`"* ]]' _ "$l"
check "...with both significant lines missing (the comment, the import and the short line do not count)" has "$l" ': 2 of 2 significant lines we added are missing'
check "...and a sample of what is missing" has "$l" 'useFollowFocusedItem({ selectedKey, setSelectedKey })'
check "a file we edited that upstream deleted: reported as removed" has "$(line_for 'src/old/Gone.ts')" 'file removed upstream'
l="$(line_for 'src/stay/Partial.ts')"
check "a file that kept one of two lines: 1 of 2, and the lost one is the sample" bash -c '[[ "$1" == *": 1 of 2 significant"* && "$1" == *"partialLost("* && "$1" != *"partialKept("* ]]' _ "$l"
l="$(line_for 'src/stay/Many.ts')"
check "at most 5 sample lines" test "$(grep -o '`manyLine0' <<<"$l" | wc -l | tr -d ' ')" -eq 5
check "...of 8 missing" has "$l" ': 8 of 9 significant'
l="$(line_for 'src/stay/Special.ts')"
want1='`const el = <div className="a">{'"'"'${value} @someone'"'"'}</div>`'
want2="\`console.log('a 'backtick' and <b>markup</b> and @everyone here')\`"
check "samples are code spans: a backtick in the line becomes an apostrophe; mentions and markup stay inside the span" bash -c '[[ "$1" == *"$2"* && "$1" == *"$3"* ]]' _ "$l" "$want1" "$want2"
for kept in 'src/old/Kept.tsx' 'src/old/Renamed.ts' 'src/stay/Same.ts' 'src/old/KeptOld.ts' 'src/stay/NoiseOnly.ts' 'src/stay/Indent.ts' 'src/ours/NewFile.ts' 'pnpm-lock.yaml' 'CLAUDE.md' 'custom/x.sh'; do
  check "not reported: $kept" lacks "$out" "\`$kept\`"
done
check "a file whose hunk survived when only its path changed (exact content, 98% similar) is not reported" lacks "$out" 'Kept.tsx'
check "a file git pairs by similarity (about 2/3, different base name) is mapped and, its lines intact, not reported" lacks "$out" 'Different.ts'
check "five files are reported in all (Moved, Gone, Partial, Many, Special)" test "$(grep -c . <<<"$out")" -eq 5
check "worst first: Many (8 missing) before Moved (2)" bash -c 'a="$(grep -n "Many.ts" <<<"$1" | cut -d: -f1)"; b="$(grep -n "Moved.tsx" <<<"$1" | cut -d: -f1)"; [ "$a" -lt "$b" ]' _ "$out"
check "the whole output stays within 6000 bytes" test "$(printf '%s' "$out" | wc -c | tr -d ' ')" -le 6000

echo "the JSON side file"
check "json: valid, 11 files checked (scaffolding and the new file left out), 5 affected" bash -c '[[ "$(jq -c "[.checked, .affected]" "$1")" == "[11,5]" ]]' _ "$tmp/hs.json"
check "json: the moved file has both paths and is not marked removed" bash -c '[[ "$(jq -r ".files[] | select(.old == \"src/old/Moved.tsx\") | [.mapped, .removed, .missing, .total] | @tsv" "$1")" == "$(printf "src/new/dir/Moved.tsx\tfalse\t2\t2")" ]]' _ "$tmp/hs.json"
check "json: the deleted file is marked removed" bash -c '[[ "$(jq -r ".files[] | select(.old == \"src/old/Gone.ts\") | .removed" "$1")" == true ]]' _ "$tmp/hs.json"

echo "everything survived: no output"
if out2="$(cd "$repo" && bash "$CHECK" --old "$old" --ours "$ours" --new "$new" --merged "$ours" 2> /dev/null)"; then
  ok "merged = ours (every line is there) exits 0"
else bad "merged = ours exits non-zero"; fi
check "...and nothing at all is reported (the moved files are found at their old path, the kept one too)" test -z "$out2"
check "an unusable argument is an error, not a silent pass" bash -c '! bash "$1" --old x 2>/dev/null' _ "$CHECK"

echo "the output cap"
big="$tmp/big"
git init -q -b old "$big"
(
  cd "$big"
  mkdir -p src/many
  for i in $(seq 1 150); do lines "src/many/File$i.ts" "file$i" 40; done
  commit_all old; git tag v1.0.0
  git checkout -q -b custom
  for i in $(seq 1 150); do insert_after "src/many/File$i.ts" 5 "  ourFirstLostLine$i(someVeryLongArgumentName, anotherVeryLongArgumentName)" "  ourSecondLostLine$i(someVeryLongArgumentName, anotherVeryLongArgumentName)"; done
  commit_all ours
)
bold="$(git -C "$big" rev-parse v1.0.0)"; bours="$(git -C "$big" rev-parse custom)"
bout="$(cd "$big" && bash "$CHECK" --old "$bold" --ours "$bours" --new "$bold" --merged "$bold" 2> /dev/null)"
check "150 files that lost lines: output capped at 6000 bytes" test "$(printf '%s' "$bout" | wc -c | tr -d ' ')" -le 6000
check "...and it says how many more there are" bash -c 'tail -n 1 <<<"$1" | grep -q -E "^\.\.\. and [0-9]+ more file\(s\)"' _ "$bout"

# ---- run-gates.sh: an advisory gate that cannot fail -----------------------------------------------------------------------------
echo "run-gates.sh"
: > "$tmp/our-files.txt"
rg() { # NAME MODE [SCRIPTS_DIR] [extra args...] -> $tmp/out-NAME/gates.json, sets rg_rc
  local name="$1" mode="$2" sd="${3:-$scripts}"; shift 3 || shift 2
  rg_rc=0
  ( cd "$repo" && bash "$sd/run-gates.sh" --out "$tmp/out-$name" --mode "$mode" --our-files "$tmp/our-files.txt" --changed-base "$ours" --only hunk-survival "$@" ) > "$tmp/rg-$name.log" 2>&1 || rg_rc=$?
}
rg sync sync "$scripts"
gj="$tmp/out-sync/gates.json"
check "sync: gate status pass and the run exits 0 (no --exit-zero)" bash -c '[[ "$2" == 0 && "$(jq -r ".gates[0] | [.id, .status] | @tsv" "$1")" == "$(printf "hunk-survival\tpass")" ]]' _ "$gj" "$rg_rc"
check "sync: five warnings, one per file" test "$(jq '.gates[0].warnings | length' "$gj")" -eq 5
check "sync: the moved file is named in a warning" bash -c 'jq -e ".gates[0].warnings[] | select(contains(\"src/new/dir/Moved.tsx\"))" "$1"' _ "$gj"
check "sync: the note counts files" bash -c '[[ "$(jq -r ".gates[0].note" "$1")" == "11 upstream file(s) we modified checked, 5 with lines of ours lost"* ]]' _ "$gj"
check "sync: hunk-survival.json is kept next to gates.json for the repair round" test -s "$tmp/out-sync/hunk-survival.json"
check "sync: gates.json counts no failure" bash -c '[[ "$(jq "[.gates[] | select(.status == \"fail\")] | length" "$1")" == 0 ]]' _ "$gj"

mkdir -p "$tmp/crash"; cp -R "$scripts/." "$tmp/crash/"; printf '#!/usr/bin/env bash\necho "boom" >&2\nexit 3\n' > "$tmp/crash/check-hunk-survival.sh"
rg crash sync "$tmp/crash"
check "a crashing check is a SKIPPED gate, never a failed one, and the run still exits 0" bash -c '[[ "$2" == 0 && "$(jq -r ".gates[0].status" "$1")" == skip && "$(jq -r ".gates[0].note" "$1")" == *"could not run (exit 3)"* ]]' _ "$tmp/out-crash/gates.json" "$rg_rc"
printf '#!/usr/bin/env bash\nsleep 400\n' > "$tmp/crash/check-hunk-survival.sh"
check "(fixture) a check that hangs would be cut by the 300 s timeout in the gate" grep -q 'with_timeout 300 bash "$TOOLS_DIR/check-hunk-survival.sh"' "$scripts/run-gates.sh"

( cd "$repo" && git checkout -q --detach "$ours" )
rg notmerge sync "$scripts"
check "HEAD that is not a sync merge commit: the gate is skipped with a reason, not failed" bash -c '[[ "$2" == 0 && "$(jq -r ".gates[0].status" "$1")" == skip && "$(jq -r ".gates[0].note" "$1")" == *"not the sync'"'"'s link commit"* || "$(jq -r ".gates[0].note" "$1")" == *"not a sync merge commit"* ]]' _ "$tmp/out-notmerge/gates.json" "$rg_rc"
( cd "$repo" && git checkout -q --detach "$merged" )
rg pr pr "$scripts"
check "pr mode has no such gate (a skipped gate would add a caveat to every PR)" bash -c '[[ "$(jq ".gates | length" "$1")" == 0 ]]' _ "$tmp/out-pr/gates.json"

if [ "$fails" -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
