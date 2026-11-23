#!/usr/bin/env bash
# Test for pick-round.sh (which candidate the PR publishes) and pick-repair-base.sh (what round 3 starts from), on made-up
# downloaded artifacts. Run: bash custom/scripts/test/test-pick-round.sh      (needs jq; no git, no network)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
command -v jq >/dev/null 2>&1 || { echo "missing tool: jq"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unset GITHUB_OUTPUT

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# mk DIR N unresolved(true|false) FAILED_GATES(number | none = gates never reported) [leak] [no-bundle] [FILES_STILL_UNRESOLVED, default 1]
mk() {
  local all="$1" n="$2" unresolved="$3" failed="$4" leak="${5:-false}" bundle="${6:-yes}" left="${7:-1}" d i gates='[]'
  d="$all/round-$n"; mkdir -p "$d"
  jq -n --argjson u "$unresolved" --argjson l "$leak" --argjson n "$n" --argjson left "$left" \
    '{unresolved: $u, key_leak: $l, unresolved_files: (if $u then [range($left) | "src/f\(.).ts"] else [] end), agent: {rounds: [{round: $n}]}}' > "$d/sync-facts.json"
  [ "$bundle" = no ] || printf 'bundle\n' > "$d/merge.bundle"
  if [ "$failed" != none ]; then
    mkdir -p "$all/gates-$n-static" "$all/gates-$n-e2e"
    for ((i = 0; i < failed; i++)); do gates="$(jq -c --argjson i "$i" '. + [{id: ("g" + ($i | tostring)), status: "fail"}]' <<<"$gates")"; done
    gates="$(jq -c '. + [{id: "ok", status: "pass"}]' <<<"$gates")"
    jq -n --argjson g "$gates" '{gates: $g}' > "$all/gates-$n-static/gates.json"
    jq -n '{gates: [{id: "e2e", status: "pass"}]}' > "$all/gates-$n-e2e/gates.json"
  fi
}

out() { grep -E "^OUTPUT $2=" <<<"$1" | head -n 1 | cut -d= -f2-; } # OUTPUT-TEXT KEY

base_case() { # NAME ALL_DIR WANT_MODE WANT_PREV_ROUND [WANT_PREV_GATES_ROUND, default: same as the round]
  local name="$1" all="$2" text gates_want="${5-$4}"
  text="$(bash "$scripts/pick-repair-base.sh" "$all" 2>/dev/null)"
  if [ "$(out "$text" mode)" = "$3" ] && [ "$(out "$text" prev_round)" = "$4" ] && [ "$(out "$text" prev_gates_round)" = "$gates_want" ]; then ok "round 3 base: $name -> $3 $4 (gates of round [$gates_want])"
  else bad "round 3 base: $name: got mode=[$(out "$text" mode)] prev_round=[$(out "$text" prev_round)] prev_gates_round=[$(out "$text" prev_gates_round)], want $3 [$4] [$gates_want]"; fi
}

pick_case() { # NAME ALL_DIR WANT_ROUND
  local name="$1" all="$2" text
  text="$(bash "$scripts/pick-round.sh" "$all" 2>/dev/null)"
  if [ "$(out "$text" round)" = "$3" ]; then ok "published candidate: $name -> round $3"; else bad "published candidate: $name: got round [$(out "$text" round)], want $3"; fi
}

# ---- what round 3 starts from ---------------------------------------------------------------------------------------
a="$tmp/a"; mk "$a" 1 false 2; mk "$a" 2 false 1
base_case "round 2 has fewer failed gates" "$a" repair 2
a="$tmp/b"; mk "$a" 1 false 1; mk "$a" 2 false 3
base_case "round 2 made it worse: repair round 1" "$a" repair 1
a="$tmp/c"; mk "$a" 1 false 1; mk "$a" 2 false 1
base_case "a tie goes to the later round" "$a" repair 2
a="$tmp/d"; mk "$a" 1 true none
base_case "round 1 left conflict markers, no round 2: continue round 1 (it has no gate results)" "$a" repair 1 ""
a="$tmp/e"; mk "$a" 1 false 2; mk "$a" 2 false 5 false no
base_case "round 2 crashed before it wrote a bundle: repair round 1" "$a" repair 1
a="$tmp/f"; mk "$a" 1 false none
base_case "a resolved round whose gates never reported is not a base: retry" "$a" retry 1 ""
a="$tmp/g"; mk "$a" 1 false 3; mk "$a" 2 false 0 true
base_case "a round with a key leak is never a base" "$a" repair 1
a="$tmp/h"; mk "$a" 1 true none; mk "$a" 2 true none
base_case "every round unresolved by the same number of files: continue the later round" "$a" repair 2 ""
a="$tmp/i"; mkdir -p "$a"
base_case "nothing downloaded: retry with no previous round" "$a" retry ""
a="$tmp/j"; mk "$a" 1 false 0
base_case "a round with every gate green is a valid base" "$a" repair 1
a="$tmp/k"; mk "$a" 1 true none; mk "$a" 2 false 4
base_case "round 1 unresolved but round 2 resolved: repair round 2" "$a" repair 2
# v1.4.261: round 1 ran out of turns with 9 files unresolved (3 of them need a human); the old pipeline restarted from the merge and the stronger model
# left 14. A round that got further must be continued, not thrown away.
a="$tmp/l"; mk "$a" 1 true none false yes 9; mk "$a" 2 true none false yes 14
base_case "round 2 got less far: continue round 1 (fewer files unresolved)" "$a" repair 1 ""
a="$tmp/m"; mk "$a" 1 true none false yes 9; mk "$a" 2 true none false yes 4
base_case "round 2 got further: continue round 2" "$a" repair 2 ""
a="$tmp/n"; mk "$a" 1 false 3; mk "$a" 2 true none false yes 1
base_case "a resolved candidate with failing gates beats a nearly resolved one" "$a" repair 1
a="$tmp/o"; mk "$a" 1 true none true yes 2
base_case "a partly resolved round whose output leaked the key is never continued: retry" "$a" retry 1 ""
a="$tmp/q"; mk "$a" 1 true none true yes 2; mk "$a" 2 true none false yes 20
base_case "a clean candidate with many files unresolved beats a leaked one" "$a" repair 2 ""

# ---- what the PR publishes: unchanged by the refactor ------------------------------------------------------------------
a="$tmp/p1"; mk "$a" 0 true none; mk "$a" 1 false 2; mk "$a" 2 false 1; mk "$a" 3 false 1
pick_case "tie between round 2 and 3 goes to the later round" "$a" 3
a="$tmp/p2"; mk "$a" 0 true none; mk "$a" 1 false 2; mk "$a" 2 false 1; mk "$a" 3 false 0 true
pick_case "a leaked round 3 loses to a clean round 2" "$a" 2
a="$tmp/p3"; mk "$a" 0 true none; mk "$a" 1 true none
pick_case "only unresolved candidates, equally far: the later one" "$a" 1
# The v1.4.261 incident: round 1 left 9 files unresolved, round 3 left 14, and the later round was published.
a="$tmp/p7"; mk "$a" 0 true none false yes 31; mk "$a" 1 true none false yes 9; mk "$a" 3 true none false yes 14
pick_case "unresolved candidates: the one with the fewest files unresolved, not the latest" "$a" 1
a="$tmp/p8"; mk "$a" 0 true none false yes 31; mk "$a" 1 true none false yes 9; mk "$a" 2 true none false yes 9
pick_case "unresolved candidates tied on files left: the later round" "$a" 2
a="$tmp/p9"; mk "$a" 0 true none false yes 3; mk "$a" 1 true none true yes 1
pick_case "an unresolved candidate with a key leak loses to any other unresolved one" "$a" 0
a="$tmp/p4"; mk "$a" 0 false 0
pick_case "a clean merge with green gates" "$a" 0
a="$tmp/p5"; mk "$a" 0 true none; mk "$a" 1 false 2; mk "$a" 2 false 1 false no
pick_case "a round without a bundle is skipped" "$a" 1
a="$tmp/p6"; mk "$a" 1 false 2; mk "$a" 2 false 1; mk "$a" 3 false 1
text="$(bash "$scripts/pick-round.sh" "$a" 2>/dev/null)"
if [ "$(jq -r 'map(.round) | join(",")' "$a/agent-rounds.json")" = "1,2,3" ]; then ok "agent-rounds.json still unions every round's record"; else bad "agent-rounds.json: $(cat "$a/agent-rounds.json")"; fi
if grep -q "^OUTPUT gates_dirs=.*gates-3-e2e" <<<"$text"; then ok "the chosen round's gate directories are passed on"; else bad "gates_dirs: $text"; fi

# ---- what the model cost this run: one line in the log and on the run's summary page ---------------------------------------
cost_of() { jq --argjson c "$3" '.agent.rounds[0].estimated_cost_usd = $c' "$1/round-$2/sync-facts.json" > "$1/f.tmp" && mv "$1/f.tmp" "$1/round-$2/sync-facts.json"; }
a="$tmp/pc"; mk "$a" 1 false 2; mk "$a" 2 false 1; mk "$a" 3 false 0
cost_of "$a" 1 0.0364; cost_of "$a" 2 0.0451; cost_of "$a" 3 0.8984
: > "$tmp/pc.summary"
text="$(GITHUB_STEP_SUMMARY="$tmp/pc.summary" bash "$scripts/pick-round.sh" "$a" 2>&1)"
if grep -q -F 'Model cost of this run: $0.980 over 3 model round(s).' <<<"$text" && grep -q -F 'Model cost of this run: $0.980 over 3 model round(s).' "$tmp/pc.summary"; then ok "the cost of all rounds is summed, in the job log and on the summary page"; else bad "cost line: text=[$text] summary=[$(cat "$tmp/pc.summary")]"; fi
a="$tmp/pd"; mk "$a" 1 false 2; jq '.agent.rounds[0].skipped = true' "$a/round-1/sync-facts.json" > "$a/f.tmp" && mv "$a/f.tmp" "$a/round-1/sync-facts.json"
: > "$tmp/pd.summary"
text="$(GITHUB_STEP_SUMMARY="$tmp/pd.summary" bash "$scripts/pick-round.sh" "$a" 2>&1)"
if ! grep -q 'Model cost' <<<"$text" && [ ! -s "$tmp/pd.summary" ]; then ok "a round that was skipped (no model call) adds no cost line"; else bad "skipped round: text=[$text] summary=[$(cat "$tmp/pd.summary")]"; fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
