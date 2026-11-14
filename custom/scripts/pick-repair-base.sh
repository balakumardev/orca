#!/usr/bin/env bash
# Decide what the last model round (round 3, Pro) starts from, among the downloaded rounds 1 and 2.
# Usage: pick-repair-base.sh ALL_DIR   (ALL_DIR holds round-N/ and gates-N-*/ directories from download-artifact)
#
# Why: a fresh retry from the merge start is only allowed to edit the files the merge left conflicted, so it cannot fix what the
# gates found anywhere else (the rehearsal's last round said the one failing e2e test needed a change outside its four files).
# A repair keeps the best candidate so far, shows the model that candidate's real gate output and lets it edit the conflicted files
# plus the files our customization commits own (agent-round.sh, mode repair).
#
# The base is the candidate pick-round.sh would publish if the pipeline stopped now, restricted to rounds that are worth repairing:
# the merge is resolved, the round's output did not contain the API key, and its gates reported (see round_score in lib.sh).
# Lowest number of failed gates wins; on a tie the later round (it saw more information).
# When no such candidate exists (every round left conflict markers, crashed, or leaked) the answer is a fresh `retry`.
# Outputs: mode (repair | retry), prev_round (the base for repair; for retry the latest round that left a candidate, whose
#          unresolved files go into the prompt, or empty), prev_gates_round (prev_round when that round's gate results
#          exist, else empty: the agent workflow downloads gate results only for a non-empty value), score (of the base, or empty).
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

all="${1:?usage: pick-repair-base.sh ALL_DIR}"
base="" base_score=999999 latest=""
for n in 1 2; do
  score="$(round_score "$all" "$n")" || { log "round $n: no candidate (no facts or no bundle)"; continue; }
  latest="$n"
  log "round $n: unresolved=$(jq -r '.unresolved' "$all/round-$n/sync-facts.json") key_leak=$(jq -r '.key_leak // false' "$all/round-$n/sync-facts.json") score=$score"
  if [ "$score" -lt 1000 ] && [ "$score" -le "$base_score" ]; then base="$n"; base_score="$score"; fi
done

has_gates() { local g; for g in "$all"/gates-"$1"-*/gates.json; do if [ -s "$g" ]; then return 0; fi; done; return 1; }

if [ -n "$base" ]; then
  log "round 3 repairs round $base ($base_score failed gate(s))"
  gh_out mode repair
  gh_out prev_round "$base"
  gh_out prev_gates_round "$base"
  gh_out score "$base_score"
else
  log "no resolved candidate with reported gates: round 3 starts again from the merge${latest:+ (shown what round $latest left)}"
  gh_out mode retry
  gh_out prev_round "$latest"
  if [ -n "$latest" ] && has_gates "$latest"; then gh_out prev_gates_round "$latest"; else gh_out prev_gates_round ""; fi
  gh_out score ""
fi
