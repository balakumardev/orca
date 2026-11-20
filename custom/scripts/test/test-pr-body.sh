#!/usr/bin/env bash
# Test for the sync PR renderer (custom/scripts/make-pr-body.mjs) with made-up facts and gate results.
# Run: bash custom/scripts/test/test-pr-body.sh      (needs node, jq; python3 with PyYAML or yq for the release-trigger cases)
#
# Covers: the release sentence follows the on: block of custom-release.yml (no push trigger, push trigger, push that cannot
# fire for the base branch, string and list forms, missing file, no parser); the link to the Playwright evidence artifact; the
# gate warning prefix; what an agent round's exit means (ran out of turns); the repair-edit caveat.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$(cd "$here/.." && pwd)/make-pr-body.mjs"
for tool in node jq; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
has() { grep -q -F -- "$2" "$1"; } # FILE TEXT

# ---- inputs --------------------------------------------------------------------------------------------------------
cat > "$tmp/facts.json" <<'JSON'
{"schema":1,"tag":"v9.9.9","old_base_tag":"v9.9.8","base_branch":"custom","tag_is_release":true,"is_test":false,
 "outcome":"conflicts","unresolved":false,"upstream_sha":"1111111111111111111111111111111111111111",
 "base_sha":"2222222222222222222222222222222222222222","merge_sha":"3333333333333333333333333333333333333333",
 "link_sha":"4444444444444444444444444444444444444444","upstream_commits":3,"our_files_count":2,
 "conflicts":[{"path":"src/a.ts","kind":"content","hunks":1,"resolution":"agent"},{"path":"src/gone.ts","kind":"deleted-by-them","hunks":0,"resolution":"agent","decision":"deleted"}],"caveats":[],
 "scripted":{"upstream_ci_removed":0,"our_wins_restored":[]},"drift":[],
 "repair_edits":["src/owned.ts","tests/e2e/owned.spec.ts"]}
JSON
mkdir -p "$tmp/gates-2-static" "$tmp/gates-2-e2e" "$tmp/raw"
cat > "$tmp/gates-2-static/gates.json" <<'JSON'
{"schema":1,"mode":"sync","runner":{"os":"Linux"},"gates":[
 {"id":"unit","name":"Unit tests for the directories in scope","status":"pass","exit_code":0,"seconds":120,"note":"n","warnings":["The first unit run threw an unhandled error that did not reproduce: src/x.test.ts passed on a re-run."],"output_tail":""},
 {"id":"hunk-survival","name":"Our lines survive the merge (advisory)","status":"pass","exit_code":0,"seconds":9,"note":"1 upstream file(s) we modified checked, 1 with lines of ours lost","warnings":["`src/old/List.tsx` -> `src/new/List.tsx`: 2 of 7 significant lines we added are missing from the merged file, e.g. `useFollowHook({`"],"output_tail":""},
 {"id":"lint-caps","name":"Lint line caps on files we touch","status":"pass","exit_code":0,"seconds":0,"note":"","warnings":["src/big.ts: 296/300 lines (within 10 of the cap)"],"output_tail":""}]}
JSON
cat > "$tmp/gates-2-e2e/gates.json" <<'JSON'
{"schema":1,"mode":"sync","runner":{"os":"macOS"},"gates":[
 {"id":"e2e","name":"Playwright e2e specs in scope","status":"fail","exit_code":1,"seconds":159,"note":"","warnings":[],"output_tail":"1 failed"}]}
JSON
cat > "$tmp/rounds.json" <<'JSON'
[{"round":1,"mode":"first","model":"m-flash","tier":"flash","max_turns":64,"exit_code":0,"wall_s":199,"key_leaks":0,"turns":58,"stop":"success","is_error":false,"output_parsed":true,"input_tokens":100,"output_tokens":10,"estimated_cost_usd":0.2,"report":"ok"},
 {"round":2,"mode":"repair","model":"m-flash","tier":"flash","max_turns":60,"exit_code":1,"wall_s":228,"key_leaks":0,"turns":61,"stop":"error_max_turns","is_error":true,"output_parsed":true,"input_tokens":300,"output_tokens":20,"estimated_cost_usd":0.6,"report":"stopped"}]
JSON

FACTS_FILE="$tmp/facts.json"; ROUNDS_FILE="$tmp/rounds.json"
render() { # NAME WORKFLOW_FILE [extra env assignments...] -> $tmp/out-NAME/pr-body.md (inputs: FACTS_FILE, ROUNDS_FILE)
  local name="$1" wf="$2"; shift 2
  mkdir -p "$tmp/out-$name"
  env RELEASE_WORKFLOW="$wf" REPO=balakumardev/orca RUN_URL=https://example.invalid/run/1 PR_TITLE="Sync upstream v9.9.9" "$@" \
    node "$script" --facts "$FACTS_FILE" --raw "$tmp/raw" --out "$tmp/out-$name" \
      --gates "$tmp/gates-2-static/gates.json" --gates "$tmp/gates-2-e2e/gates.json" --agent-rounds "$ROUNDS_FILE" > /dev/null 2>&1
  body="$tmp/out-$name/pr-body.md"
}

# ---- the release sentence --------------------------------------------------------------------------------------------
cat > "$tmp/dispatch-only.yml" <<'YAML'
name: custom-release
# The `push:` trigger that releases on merges into `custom` is added by the owner at the very end; not here.
on:
  workflow_dispatch:
    inputs:
      note:
        description: "push: is only a word in this text"
        type: string
permissions:
  contents: read
YAML
printf 'name: r\non:\n  push:\n    branches: [custom]\n  workflow_dispatch:\njobs: {}\n' > "$tmp/push-custom.yml"
printf 'name: r\non:\n  push:\n  workflow_dispatch:\njobs: {}\n' > "$tmp/push-bare.yml"
printf 'name: r\non: push\njobs: {}\n' > "$tmp/on-string.yml"
printf 'name: r\non: [push, workflow_dispatch]\njobs: {}\n' > "$tmp/on-list.yml"
printf 'name: r\non:\n  push:\n    branches:\n      - main\n      - "release/**"\njobs: {}\n' > "$tmp/push-other-branch.yml"
printf 'name: r\non:\n  push:\n    tags: ["v*"]\njobs: {}\n' > "$tmp/push-tags-only.yml"
printf 'name: r\non:\n  push:\n    branches: ["**", "!custom"]\njobs: {}\n' > "$tmp/push-negated.yml"
printf 'name: r\non:\n  push:\n    branches-ignore: [custom]\njobs: {}\n' > "$tmp/push-ignored.yml"
printf 'name: r\non:\n  pull_request:\n  schedule:\n    - cron: "0 0 * * *"\njobs: {}\n' > "$tmp/no-push.yml"
printf 'name: r\non: [unclosed\n' > "$tmp/broken.yml"
: > "$tmp/empty.yml"

PUBLISHES='Merging this PR publishes a release.'
BY_HAND='Merging this PR does not publish by itself: start the release by hand with `gh workflow run custom-release.yml --repo balakumardev/orca --ref custom`.'
parser=false
if python3 -I -c 'import yaml' >/dev/null 2>&1 || command -v yq >/dev/null 2>&1; then parser=true; fi

release_case() { # NAME FILE EXPECT(yes|no) [base branch]
  local name="$1" wf="$2" want="$3" base="${4:-custom}"
  jq --arg b "$base" '.base_branch = $b' "$tmp/facts.json" > "$tmp/facts-base.json"
  FACTS_FILE="$tmp/facts-base.json" render "$name" "$wf"
  local hits=0
  has "$body" "$PUBLISHES" && hits=$((hits + 1))
  has "$body" "$BY_HAND" && hits=$((hits + 1))
  if [ "$want" = yes ]; then
    # all three places: the top line, the checklist, the closing line
    if [ "$(grep -c -F -- "$PUBLISHES" "$body")" = 2 ] && has "$body" 'After the merge the release workflow publishes a build.' && ! has "$body" 'does not publish by itself'; then ok "$name: publishes (top, checklist and closing line)"; else bad "$name: expected the publishes wording (hits=$hits)"; fi
  else
    if [ "$(grep -c -F -- "$BY_HAND" "$body")" = 2 ] && has "$body" 'After the merge, start the release by hand' && ! has "$body" 'publishes a release' && ! has "$body" 'release workflow publishes a build'; then ok "$name: does not publish by itself, gives the dispatch command (top, checklist and closing line)"; else bad "$name: expected the by-hand wording (hits=$hits)"; fi
  fi
}

if [ "$parser" = true ]; then
  release_case "workflow_dispatch only (today's file)" "$tmp/dispatch-only.yml" no
  release_case "the real custom-release.yml of this checkout" "$here/../../../.github/workflows/custom-release.yml" "$(grep -q -E '^  push:' "$here/../../../.github/workflows/custom-release.yml" 2>/dev/null && echo yes || echo no)"
  release_case "push trigger for custom" "$tmp/push-custom.yml" yes
  release_case "bare push trigger" "$tmp/push-bare.yml" yes
  release_case "on: push (string form)" "$tmp/on-string.yml" yes
  release_case "on: [push, ...] (list form)" "$tmp/on-list.yml" yes
  release_case "push only for other branches" "$tmp/push-other-branch.yml" no
  release_case "push for tags only" "$tmp/push-tags-only.yml" no
  release_case "push for every branch except custom" "$tmp/push-negated.yml" no
  release_case "push with branches-ignore custom" "$tmp/push-ignored.yml" no
  release_case "pull_request and schedule only" "$tmp/no-push.yml" no
  release_case "push for custom, but the PR targets another branch" "$tmp/push-custom.yml" no test/sync-base
  release_case "branches: ['**'] matches a branch with a slash" "$tmp/push-negated.yml" yes feature/x
else
  echo "skip release-trigger cases that need a YAML parser: no python3 with PyYAML and no yq on this machine"
fi

render missing "$tmp/does-not-exist.yml"
if has "$body" 'There is no `custom-release.yml` in this checkout' && ! has "$body" "$PUBLISHES"; then ok "missing release workflow: says nothing is published, does not crash"; else bad "missing release workflow wording"; fi

for f in broken empty; do
  render "$f" "$tmp/$f.yml"
  if [ -s "$body" ] && ! has "$body" "$PUBLISHES" && ! has "$body" 'does not publish by itself' && has "$body" 'Check the `on:` block of `custom-release.yml`'; then ok "$f.yml: unreadable file gets the conservative sentence, no crash"; else bad "$f.yml wording"; fi
done

# No YAML parser on PATH at all (only node): conservative sentence. A stub yq that prints JSON proves the yq route.
mkdir -p "$tmp/bin-node-only" "$tmp/bin-yq"
ln -sf "$(command -v node)" "$tmp/bin-node-only/node"; ln -sf "$(command -v node)" "$tmp/bin-yq/node"
printf '#!/bin/sh\n/bin/cat "$FAKE_YQ_JSON"\n' > "$tmp/bin-yq/yq"; chmod +x "$tmp/bin-yq/yq"
mkdir -p "$tmp/out-noparser"
env PATH="$tmp/bin-node-only" RELEASE_WORKFLOW="$tmp/dispatch-only.yml" REPO=balakumardev/orca "$(command -v node)" "$script" --facts "$tmp/facts.json" --raw "$tmp/raw" --out "$tmp/out-noparser" > /dev/null 2>&1
if has "$tmp/out-noparser/pr-body.md" 'Check the `on:` block of `custom-release.yml`' && ! has "$tmp/out-noparser/pr-body.md" "$PUBLISHES"; then ok "no YAML parser available: conservative sentence"; else bad "no-parser wording"; fi
for want in yes no; do
  mkdir -p "$tmp/out-yq-$want"
  if [ "$want" = yes ]; then printf '{"on":{"push":null,"workflow_dispatch":null}}' > "$tmp/yq.json"; else printf '{"on":{"workflow_dispatch":null}}' > "$tmp/yq.json"; fi
  env PATH="$tmp/bin-yq" FAKE_YQ_JSON="$tmp/yq.json" RELEASE_WORKFLOW="$tmp/dispatch-only.yml" REPO=balakumardev/orca "$(command -v node)" "$script" --facts "$tmp/facts.json" --raw "$tmp/raw" --out "$tmp/out-yq-$want" > /dev/null 2>&1
  if { [ "$want" = yes ] && has "$tmp/out-yq-$want/pr-body.md" "$PUBLISHES"; } || { [ "$want" = no ] && has "$tmp/out-yq-$want/pr-body.md" 'does not publish by itself'; }; then ok "yq route ($want) reads the JSON yq prints (stub yq: the contract, not a real yq)"; else bad "yq route $want"; fi
done

# ---- evidence link, warning prefix, exit reason, repair edits ------------------------------------------------------------
render main "$tmp/dispatch-only.yml"
has "$body" 'artifact `e2e-results-2` of [this run](https://example.invalid/run/1)' && ok "a failed e2e gate links the e2e-results-<round> artifact of the run" || bad "e2e artifact link"
has "$body" 'Unit tests for the directories in scope: The first unit run threw an unhandled error that did not reproduce' && ok "a gate warning is shown under the gate's name" || bad "gate warning text"
has "$body" 'Our lines survive the merge (advisory): `src/old/List.tsx` -> `src/new/List.tsx`: 2 of 7 significant lines we added are missing from the merged file' && ok "the advisory hunk-survival finding is a caveat under its gate's name" || bad "hunk-survival caveat"
hs_line="$({ grep -n -F 'Our lines survive the merge (advisory): ' "$body" || true; } | cut -d: -f1 | sed -n '1p')"
lc_line="$({ grep -n -F 'Near a lint cap: src/big.ts' "$body" || true; } | cut -d: -f1 | sed -n '1p')"
un_line="$({ grep -n -F 'Unit tests for the directories in scope: The first unit run' "$body" || true; } | cut -d: -f1 | sed -n '1p')"
[ -n "$hs_line" ] && [ -n "$lc_line" ] && [ -n "$un_line" ] && [ "$lc_line" -lt "$hs_line" ] && [ "$hs_line" -lt "$un_line" ] && ok "...listed between lint-caps and unit, in the gate order (GATE_ORDER)" || bad "hunk-survival order (lint-caps line '$lc_line', hunk-survival line '$hs_line', unit line '$un_line')"
! has "$body" 'Near a lint cap: The first unit run' && ok "a unit warning is not labelled as a lint-cap warning" || bad "unit warning mislabelled"
has "$body" 'Near a lint cap: src/big.ts' && ok "a lint-cap warning keeps its label" || bad "lint-cap label"
has "$body" '| 2 | repair |' && has "$body" '1: ran out of turns; edits kept; gates decide' && ok "the model table says the round ran out of turns, edits kept, gates decide" || bad "exit column wording"
has "$body" 'Agent round 2 ran out of turns (61/60); its edits were kept and the gates judged the result.' && ok "caveat for a round that ran out of turns" || bad "max-turns caveat"
! has "$body" 'ended with an error or a non-zero exit; see the model block' && ok "no unexplained generic error caveat" || bad "generic error caveat still present"
grep -q -E '^\| 1 \| first \|.*\| 0 \|$' "$body" && ok "a clean round shows just its exit code" || bad "clean round row: $(grep '^| 1 | first' "$body")"
has "$body" 'Repair round(s) edited 2 file(s) that were not conflicted: `src/owned.ts`, `tests/e2e/owned.spec.ts`' && has "$body" '1 of them is a test or spec (`tests/e2e/owned.spec.ts`)' && ok "repair edits are listed and the test edits are called out" || bad "repair-edit caveat"

# a round that hit the wall clock, one that crashed, one that wrote nothing readable
jq '[.[0], (.[1] | .stop = "" | .exit_code = 124), {"round":3,"mode":"repair","model":"m","tier":"pro","max_turns":80,"exit_code":2,"wall_s":5,"key_leaks":0,"turns":1,"stop":"error_during_execution","is_error":true,"output_parsed":true,"input_tokens":1,"output_tokens":1,"estimated_cost_usd":0.1,"report":""}]' "$tmp/rounds.json" > "$tmp/rounds2.json"
ROUNDS_FILE="$tmp/rounds2.json" render exits "$tmp/dispatch-only.yml"
has "$body" '124: hit the wall-clock limit; edits kept; gates decide' && has "$body" '2: ended with an error (exit 2, error_during_execution); edits kept; gates decide' && ok "wall-clock and other error exits are explained too" || bad "other exit reasons"

# a modify/delete conflict shows what the agent decided
has "$body" '| `src/gone.ts` | deleted-by-them | 0 | agent (deleted the file) |' && ok "the conflict table says the agent deleted the file" || bad "decision column: $(grep 'src/gone.ts' "$body")"

# a round the script skipped because only conflicts that need a human were left
jq '[.[0], {"round":2,"mode":"repair","model":"m","tier":"flash","max_turns":0,"exit_code":0,"wall_s":0,"key_leaks":0,"turns":0,"stop":"","skipped":true,"is_error":true,"output_parsed":false,"input_tokens":0,"output_tokens":0,"estimated_cost_usd":0,"report":""}]' "$tmp/rounds.json" > "$tmp/rounds3.json"
ROUNDS_FILE="$tmp/rounds3.json" render skipped "$tmp/dispatch-only.yml"
has "$body" '0: skipped; no file was left that a model may resolve' && ok "a skipped round says so instead of 'no readable output'" || bad "skipped round wording: $(grep '^| 2 | repair' "$body")"

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
