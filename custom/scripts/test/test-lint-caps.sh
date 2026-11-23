#!/usr/bin/env bash
# Test for lint-caps.mjs: a file over its cap is reported, a file that .oxlintrc.json ignores (generated code) is not. Run: bash custom/scripts/test/test-lint-caps.sh   (needs node, jq)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
for tool in node jq; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected [$3], got [$2]"; fi; }

mkdir -p "$tmp/src/shared" "$tmp/cloud/app" "$tmp/src/x/dist"
for i in $(seq 1 305); do echo "export const v$i = $i"; done > "$tmp/src/shared/big.generated.ts"
cp "$tmp/src/shared/big.generated.ts" "$tmp/src/shared/big.ts"
cp "$tmp/src/shared/big.generated.ts" "$tmp/cloud/app/big.ts"
cp "$tmp/src/shared/big.generated.ts" "$tmp/src/x/dist/big.ts"
files=(src/shared/big.generated.ts src/shared/big.ts cloud/app/big.ts src/x/dist/big.ts)

run() { (cd "$tmp" && node "$scripts/lint-caps.mjs" "${files[@]}"); }

printf '{"ignorePatterns":["src/shared/*.generated.ts","**/dist","cloud/**"]}\n' > "$tmp/.oxlintrc.json"
out="$(run)"
eq "only the file oxlint checks is over the cap" "$(jq -c '[.over[].path]' <<<"$out")" '["src/shared/big.ts"]'
eq "ignored files are not counted as checked" "$(jq -r '.checked' <<<"$out")" "1"

printf '{"ignorePatterns":["src/shared/rpc.generated.ts"]}\n' > "$tmp/.oxlintrc.json"
eq "a pattern for another file ignores nothing" "$(run | jq -r '.over | length')" "4"

rm "$tmp/.oxlintrc.json"
eq "no .oxlintrc.json: every file over the cap is reported" "$(run | jq -r '.over | length')" "4"

printf 'not json' > "$tmp/.oxlintrc.json"
eq "an unreadable .oxlintrc.json ignores nothing (the gate never skips more than oxlint does)" "$(run | jq -r '.over | length')" "4"

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
