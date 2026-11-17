#!/usr/bin/env bash
# Choose the candidate to publish among the sync rounds that were downloaded as artifacts.
# Usage: pick-round.sh ALL_DIR   (ALL_DIR holds round-N/ and gates-N-*/ directories from download-artifact)
#
# round-0 is what the merge job made without a model (clean, scripted, or an unresolved fallback). Rounds 1..3 are
# agent attempts. Score = round_score in lib.sh: the number of failed gates; 1000 plus the number of files still carrying
# conflict markers for an unresolved candidate (so the one that got further wins, not merely the later one), and 1000 for a
# resolved one whose gates never reported; a round whose output contained the API key (its edits were discarded) scores
# 100000 and loses to everything. Lowest score wins; on a tie the later round wins (it saw more information).
# Outputs: round, round_dir, gates_dirs (space separated, may be empty), score. Also writes ALL_DIR/agent-rounds.json,
# the union of every round's agent records, so the PR reports the cost of rounds that were not chosen too.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

all="${1:?usage: pick-round.sh ALL_DIR}"
best=-1; best_score=999999
for d in "$all"/round-*; do
  [ -d "$d" ] || continue
  n="${d##*round-}"
  [[ "$n" =~ ^[0-9]+$ ]] || continue
  score="$(round_score "$all" "$n")" || continue # a round without sync-facts.json or merge.bundle left no candidate
  log "round $n: unresolved=$(jq -r '.unresolved' "$d/sync-facts.json") key_leak=$(jq -r '.key_leak // false' "$d/sync-facts.json") score=$score"
  if [ "$score" -le "$best_score" ]; then best="$n"; best_score="$score"; fi
done
[ "$best" -ge 0 ] || die "no usable sync round found in $all"
gates=""
for g in "$all"/gates-"$best"-*; do [ -d "$g" ] && gates="$gates $g"; done
jq -s '[.[] | (.agent.rounds // [])[]] | unique_by(.round) | sort_by(.round)' "$all"/round-*/sync-facts.json > "$all/agent-rounds.json"
gh_out round "$best"
gh_out round_dir "$all/round-$best"
gh_out gates_dirs "${gates# }"
gh_out score "$best_score"
