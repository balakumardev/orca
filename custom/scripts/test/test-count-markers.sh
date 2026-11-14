#!/usr/bin/env bash
# Test for count_markers / has_markers (lib.sh): the "Hunks" column of the sync PR and the hunk count in the agent prompt
# must count conflict HUNKS (one start marker each), not marker lines. Run: bash custom/scripts/test/test-count-markers.sh
# (needs git; no network). A real zdiff3 merge conflict with three separate hunks is the main case.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
command -v git >/dev/null 2>&1 || { echo "missing tool: git"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
# shellcheck source=../lib.sh
. "$scripts/lib.sh"

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# A real merge: both sides change three regions that are far apart, so git reports three hunks.
r="$tmp/repo"
git init -q "$r"
(
  cd "$r"
  for i in $(seq 1 60); do echo "line $i"; done > f.txt
  git add f.txt && git commit -q -m base
  base="$(git rev-parse HEAD)"
  git checkout -q -b ours
  for n in 5 30 55; do sed -i.bak "${n}s/.*/ours $n/" f.txt; done; rm -f f.txt.bak
  git commit -q -am ours
  git checkout -q -b theirs "$base"
  for n in 5 30 55; do sed -i.bak "${n}s/.*/theirs $n/" f.txt; done; rm -f f.txt.bak
  git commit -q -am theirs
  git checkout -q ours
  git -c merge.conflictStyle=zdiff3 merge --no-commit theirs >/dev/null 2>&1 || true
)
starts="$(grep -c '^<<<<<<< ' "$r/f.txt")"
ends="$(grep -c '^>>>>>>> ' "$r/f.txt")"
got="$(count_markers "$r/f.txt")"
if [ "$starts" = 3 ] && [ "$ends" = 3 ] && [ "$got" = 3 ]; then ok "a real 3-hunk conflict counts 3 (it has $starts start and $ends end marker lines)"; else bad "3-hunk conflict: starts=$starts ends=$ends count_markers=$got"; fi
if has_markers "$r/f.txt"; then ok "has_markers sees the conflicted file"; else bad "has_markers missed a conflicted file"; fi

printf 'a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> theirs\nb\n' > "$tmp/one.txt"
[ "$(count_markers "$tmp/one.txt")" = 1 ] && ok "one hunk counts 1" || bad "one hunk: $(count_markers "$tmp/one.txt")"

printf 'clean\nfile\n' > "$tmp/clean.txt"
[ "$(count_markers "$tmp/clean.txt")" = 0 ] && ok "a clean file counts 0" || bad "clean file: $(count_markers "$tmp/clean.txt")"
! has_markers "$tmp/clean.txt" && ok "has_markers is false for a clean file" || bad "has_markers true for a clean file"

# has_markers keeps its old, wider detection: any one marker line is enough (a half-resolved file must not pass).
printf 'a\n>>>>>>> theirs\n' > "$tmp/end-only.txt"
printf 'a\n||||||| base\n' > "$tmp/ancestor-only.txt"
printf 'a\n<<<<<<< HEAD\n' > "$tmp/start-only.txt"
for f in end-only ancestor-only start-only; do
  if has_markers "$tmp/$f.txt"; then ok "has_markers: $f is a marker file"; else bad "has_markers missed $f"; fi
done
printf 'a\n<<<<<<<<<<\n=======\n' > "$tmp/lookalike.txt" # no space after seven characters, and a bare =======: not a conflict
! has_markers "$tmp/lookalike.txt" && ok "has_markers ignores look-alike lines" || bad "has_markers matched a look-alike"

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
