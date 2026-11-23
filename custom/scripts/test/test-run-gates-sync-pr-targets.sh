#!/usr/bin/env bash
# Regression test: a sync PR is measured against the upstream release it merges, not against the old custom.
# Run: bash custom/scripts/test/test-run-gates-sync-pr-targets.sh      (needs git, jq; no pnpm, no network)
#
# The bug it pins: in pr mode the gates cover "files changed since the PR base". A sync PR bumps custom/BASE, so that set is the whole
# upstream delta (26606 files on v1.4.265, upstream's own over-cap files and the cloud/ tests among them): the line-cap gate went red on
# upstream code and the unit gate ran out its 25 minutes. With SYNC_PR=1 the set is what differs from the release custom/BASE names.
#
# It builds a scratch repo: an upstream release (tag v1.1.0), an older custom (the PR base) and a sync head = that release plus our edits,
# then reads targets-all.txt from run-gates.sh --only hygiene.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
RUN_GATES="${RUN_GATES:-$scripts/run-gates.sh}"
for tool in git jq; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
[ -f "$RUN_GATES" ] || { echo "no such script: $RUN_GATES"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

repo="$tmp/repo"
mkdir -p "$repo/src" "$repo/custom"
git -C "$repo" init -q -b upstream
printf 'export const shared = 1\n' > "$repo/src/shared.ts"
printf 'export const upstreamNew = 1\n' > "$repo/src/upstream-new.ts"
git -C "$repo" add -A && git -C "$repo" commit -q -m "upstream release"
git -C "$repo" tag v1.1.0

git -C "$repo" checkout -q --orphan old-custom
git -C "$repo" rm -rq --cached . && rm -rf "$repo/src"
mkdir -p "$repo/src"
printf 'v1.0.0\n' > "$repo/custom/BASE"
printf 'export const shared = 0\n' > "$repo/src/shared.ts"
printf 'export const old = 1\n' > "$repo/src/old-only.ts"
git -C "$repo" add -A && git -C "$repo" commit -q -m "old custom"
old="$(git -C "$repo" rev-parse HEAD)"

git -C "$repo" checkout -q -b sync/v1.1.0 upstream
mkdir -p "$repo/custom"
printf 'v1.1.0\n' > "$repo/custom/BASE"
printf 'export const shared = 2 // our edit\n' > "$repo/src/shared.ts"
printf 'export const mine = 1\n' > "$repo/src/mine.ts"
git -C "$repo" add -A && git -C "$repo" commit -q -m "sync head"
: > "$tmp/our-files.txt"

run_targets() { # NAME SYNC_PR -> prints the sorted target list
  local out="$tmp/out-$1"
  ( cd "$repo" && env SYNC_PR="$2" bash "$RUN_GATES" --out "$out" --mode pr --changed-base "$old" --our-files "$tmp/our-files.txt" --only hygiene ) > "$tmp/run-$1.log" 2>&1 || true
  [ -f "$out/targets-all.txt" ] || { echo "no targets-all.txt: $(tail -n 3 "$tmp/run-$1.log")"; return 0; }
  tr '\n' ' ' < "$out/targets-all.txt"
}

got="$(run_targets sync 1)"
if [ "$got" = "custom/BASE src/mine.ts src/shared.ts " ]; then ok "SYNC_PR=1: the targets are what differs from the release, not the upstream delta ($got)"
else bad "SYNC_PR=1 targets: '$got'"; fi

got="$(run_targets plain '')"
if [ "$got" = "custom/BASE src/mine.ts src/shared.ts src/upstream-new.ts " ]; then ok "no SYNC_PR: a contributor PR is still measured against its base ($got)"
else bad "plain pr targets: '$got'"; fi

if [ "$fails" -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
