#!/usr/bin/env bash
# Test for how sync-merge.sh start treats files that upstream MOVED between two releases and that our patches edited:
# a move below git's 50% similarity default (v1.4.261 trimmed two files while moving them), and a moved file that no path
# list knows (our-files.txt holds the old paths). Run: bash custom/scripts/test/test-sync-merge-renames.sh   (needs git, jq, awk;
# no network, no pnpm).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
for tool in git jq awk; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

# Upstream 1.0.0: four 60-line files. 1.0.1 moves theta unchanged apart from line 5 (a rename git always pairs), moves zeta and keeps
# only its first 24 lines (about 38% similar: below the 50% default, above 30%), deletes eta outright, and edits line 5 of a
# generated file. We edit line 5 of the same files (eta: line 7), so every one of them conflicts.
src="$tmp/source"
git init -q -b main "$src"
(
  cd "$src"
  mkdir src
  for f in theta zeta eta; do seq 1 60 | sed "s/^/$f line /" > "src/$f.ts"; done
  seq 1 60 | sed "s/^/gen line /" > src/table.generated.ts
  git add -A && git commit -q -m "upstream 1.0.0" && git tag v1.0.0
  git branch custom
  edit() { awk -v t="$2" -v n="$3" 'NR == n { print t; next } { print }' "$1" > "$1.new" && mv "$1.new" "$1"; }
  mkdir src/moved
  git mv src/theta.ts src/moved/theta.ts && edit src/moved/theta.ts "theta UPSTREAM" 5
  git mv src/zeta.ts src/moved/zeta.ts && head -n 24 src/moved/zeta.ts > src/moved/zeta.new && mv src/moved/zeta.new src/moved/zeta.ts && edit src/moved/zeta.ts "zeta UPSTREAM" 5
  git rm -q src/eta.ts
  edit src/table.generated.ts "gen UPSTREAM" 5
  git add -A && git commit -q -m "upstream 1.0.1" && git tag v1.0.1
  git checkout -q custom
  edit src/theta.ts "theta CUSTOM" 5; edit src/zeta.ts "zeta CUSTOM" 5; edit src/eta.ts "eta CUSTOM" 7; edit src/table.generated.ts "gen CUSTOM" 5
  mkdir custom && echo v1.0.0 > custom/BASE
  git add -A && git commit -q -m "our change

Orca-Custom-Patch: test"
)
BASE_SHA="$(git -C "$src" rev-parse custom)"
UPSTREAM_SHA="$(git -C "$src" rev-parse 'v1.0.1^{commit}')"

repo="$tmp/repo"
git clone -q --no-hardlinks "$src" "$repo"; git -C "$repo" checkout -q custom
out="$tmp/out"
( cd "$repo" && env SYNC_OUT="$out" UPSTREAM_SHA="$UPSTREAM_SHA" BASE_SHA="$BASE_SHA" BASE_BRANCH=custom BRANCH=sync/test LABEL=test TAG=v1.0.1 \
    IS_TEST=true TAG_IS_RELEASE=false DEFER_LOCKFILE=1 bash "$scripts/sync-merge.sh" start > "$tmp/start.log" 2>&1 ) \
  || { bad "sync-merge.sh start ran"; sed 's/^/    /' "$tmp/start.log" | tail -n 20; exit 1; }
ok "sync-merge.sh start ran"

row() { awk -F'\t' -v p="$1" '$1 == p {print $2 "|" $4}' "$out/conflicts.tsv"; } # PATH -> kind|resolution

echo "a file upstream moved and trimmed (about 38% similar) is still paired with its old path"
check "zeta: a content conflict at the new path, left to the model" test "$(row src/moved/zeta.ts)" = "content|pending"
check "zeta: the old path is not reported as deleted by them" test -z "$(row src/zeta.ts)"

echo "a file upstream moved: our edit travelled with it, so it is ours although our-files.txt only lists the old path"
check "our-files.txt holds the old path only" bash -c "grep -qxF src/theta.ts '$out/our-files.txt' && ! grep -qxF src/moved/theta.ts '$out/our-files.txt'"
check "theta: left to the model, not settled by taking upstream's version" test "$(row src/moved/theta.ts)" = "content|pending"
check "theta: absent from the files taken from upstream" bash -c "! grep -qxF src/moved/theta.ts '$out/taken-from-upstream.txt'"
check "theta: the conflict markers hold both our line and upstream's" bash -c "grep -q 'theta CUSTOM' '$repo/src/moved/theta.ts' && grep -q 'theta UPSTREAM' '$repo/src/moved/theta.ts'"

echo "a file upstream really deleted is left to the agent to keep or drop (kind deleted-by-them, not a content conflict)"
check "eta: deleted by them, pending for the agent" test "$(row src/eta.ts)" = "deleted-by-them|pending"

echo "a generated file is still never merged by hand"
check "table.generated.ts: upstream's version taken" test "$(row src/table.generated.ts)" = "content|scripted: generated file, upstream's version taken"
check "table.generated.ts: holds upstream's line" grep -q 'gen UPSTREAM' "$repo/src/table.generated.ts"

check "the merge outcome is conflicts (three files are left)" test "$(jq -r .outcome "$out/sync-facts.json")" = conflicts
check "exactly three conflicted files are pending" test "$(jq -r '[.conflicts[] | select(.resolution == "pending")] | length' "$out/sync-facts.json")" = 3

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
