#!/usr/bin/env bash
# Test for the hygiene gate of run-gates.sh: a file that still holds the one-line delete marker fails it with a message that names the file.
# Run: bash custom/scripts/test/test-gate-hygiene-marker.sh      (needs git, jq; no pnpm, no network)
#
# Why: in the v1.4.269 sync (run 45004282909) a repair round left `DELETE-THIS-FILE` in a file, and typecheck, lint and format each failed
# with an error that did not say why, while this gate (whose note claimed "no unresolved sentinel") passed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
for tool in git jq; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
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
git -C "$repo" init -q
printf 'v1.0.0\n' > "$repo/custom/BASE"
printf 'export const a = 1\n' > "$repo/src/kept.ts"
printf 'DELETE-THIS-FILE\n' > "$repo/src/dropped.ts"
printf 'a file that merely mentions DELETE-THIS-FILE in a longer sentence so it is not a marker\n' > "$repo/src/mentions.ts"
git -C "$repo" add -A && git -C "$repo" commit -q -m init
git -C "$repo" tag v1.0.0

hygiene() { # NAME OUR_FILE... -> h_status h_log
  local name="$1" out="$tmp/out-$1"; shift
  printf '%s\n' "$@" > "$tmp/our-$name.txt"
  ( cd "$repo" && bash "$scripts/run-gates.sh" --out "$out" --mode sync --changed-base v1.0.0 --our-files "$tmp/our-$name.txt" --only hygiene ) > "$tmp/gate-$name.out" 2>&1 || true
  h_status="$(jq -r '.gates[] | select(.id == "hygiene") | .status' "$out/gates.json")"
  h_log="$out/logs/hygiene.log"
}

hygiene marker src/kept.ts src/dropped.ts
if [ "$h_status" = fail ] && grep -q 'delete marker left in src/dropped.ts' "$h_log"; then ok "a file that is only the delete marker fails the gate and is named"; else bad "marker: status=$h_status"; fi

hygiene clean src/kept.ts src/mentions.ts
if [ "$h_status" = pass ]; then ok "a clean tree, and a file that only mentions the marker, pass"; else bad "clean: status=$h_status"; fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
