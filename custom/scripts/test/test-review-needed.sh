#!/usr/bin/env bash
# Test for review-needed.sh: which sync PRs a person must read before they merge. Run: bash custom/scripts/test/test-review-needed.sh   (needs jq)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
command -v jq >/dev/null 2>&1 || { echo "missing tool: jq"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# shellcheck source=../review-needed.sh
. "$scripts/review-needed.sh"

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected [$3], got [$2]"; fi; }

facts() { printf '%s\n' "$1" > "$tmp/facts.json"; echo "$tmp/facts.json"; }
gates() { printf '%s\n' "$1" > "$tmp/gates.json"; echo "$tmp/gates.json"; }
CLEAN='{"conflicts":[{"path":"a.ts","kind":"content","resolution":"agent"},{"path":".github/workflows/x.yml","kind":"deleted-by-us","resolution":"scripted: dropped upstream CI file","decision":"deleted"}]}'
HUNK_OK='{"gates":[{"id":"hunk-survival","status":"pass","warnings":[]},{"id":"unit","status":"pass","warnings":["Not counted: 1 test"]}]}'
HUNK_LOST='{"gates":[{"id":"hunk-survival","status":"pass","warnings":["`src/a.ts`: 9 of 9 significant lines we added are missing","`src/b.tsx`: 2 of 2 significant lines we added are missing"]}]}'

eq "a clean merge: nothing to review" "$(review_needed "$(facts "$CLEAN")" "$(gates "$HUNK_OK")")" ""
eq "no gates given: nothing to review" "$(review_needed "$(facts "$CLEAN")")" ""
eq "a gates file that is missing or empty is skipped" "$(review_needed "$(facts "$CLEAN")" "$tmp/missing.json")" ""
eq "a scripted drop of an upstream CI file is not a deletion by the model" "$(review_needed "$(facts "$CLEAN")")" ""
eq "a repair round deleted a file" "$(review_needed "$(facts '{"repair_deleted":["src/ours.tsx"]}')")" "a repair round deleted 1 file(s): src/ours.tsx"
eq "the reason lists at most four files" "$(review_needed "$(facts '{"repair_deleted":["a","b","c","d","e","f"]}')")" "a repair round deleted 6 file(s): a, b, c, d, ..."
eq "the model resolved a conflict by deleting the file" "$(review_needed "$(facts '{"conflicts":[{"path":"src/x.ts","kind":"deleted-by-them","resolution":"agent","decision":"deleted"}]}')")" "the model resolved 1 conflict(s) by deleting the file: src/x.ts"
eq "keeping the file of a modify/delete conflict is not a reason" "$(review_needed "$(facts '{"conflicts":[{"path":"src/x.ts","kind":"deleted-by-them","resolution":"agent","decision":"kept"}]}')")" ""
eq "hunk-survival warnings are a reason, counted by file" "$(review_needed "$(facts "$CLEAN")" "$(gates "$HUNK_LOST")")" "lines of our customizations are missing from 2 merged file(s) (hunk-survival)"
eq "warnings of another gate are not" "$(review_needed "$(facts "$CLEAN")" "$(gates '{"gates":[{"id":"unit","warnings":["Not counted: 1"]}]}')")" ""
two="$(review_needed "$(facts '{"repair_deleted":["src/ours.tsx"]}')" "$(gates "$HUNK_LOST")")"
eq "both signals give both reasons, one per line" "$(wc -l <<<"$two" | tr -d ' ')" "2"
eq "facts without any of the fields: nothing" "$(review_needed "$(facts '{}')")" ""

printf 'not json' > "$tmp/bad-gates.json"
eq "a gates file that is not JSON makes the check fail (never reads as nothing to review)" "$(if review_needed "$(facts "$CLEAN")" "$tmp/bad-gates.json" >/dev/null 2>&1; then echo passed; else echo failed; fi)" "failed"

echo "review_meta: the answer written into pr-meta.json"
printf '{"state":"clean","draft":false}\n' > "$tmp/meta.json"
review_meta "$tmp/meta.json" "$(facts "$CLEAN")" "$(gates "$HUNK_OK")"
eq "a clean sync: needs_review false, no reasons, the rest of the meta kept" "$(jq -c '[.needs_review, .review_reasons, .state, .draft]' "$tmp/meta.json")" '[false,[],"clean",false]'
printf '{"state":"clean","draft":false}\n' > "$tmp/meta.json"
review_meta "$tmp/meta.json" "$(facts '{"repair_deleted":["src/ours.tsx"]}')" "$(gates "$HUNK_LOST")"
eq "two reasons: needs_review true and both listed" "$(jq -c '[.needs_review, (.review_reasons | length)]' "$tmp/meta.json")" '[true,2]'
printf '{"state":"clean"}\n' > "$tmp/meta.json"
printf 'not json' > "$tmp/bad-facts.json"
review_meta "$tmp/meta.json" "$tmp/bad-facts.json"
eq "facts that cannot be read: a person must look" "$(jq -c '[.needs_review, .review_reasons[0]]' "$tmp/meta.json")" '[true,"the review check itself failed, so a person must look"]'

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
