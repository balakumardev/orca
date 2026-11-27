#!/usr/bin/env bash
# Sourced by make-pr-body.sh and by custom/scripts/test/test-review-needed.sh; never run it.
#
# review_needed FACTS [GATES_JSON...]: prints one line per reason a person must read the sync PR before it merges, and nothing when the
# PR may land by itself. land-sync-pr.sh declines to merge a PR with any reason and leaves it open and ready (not a draft).
#
# Why: a model resolves the merge and repairs gate failures, and a customization can be lost without any gate failing: the model drops
# our import from a file it resolved, or deletes a file of ours that it judges obsolete. Gates cannot see that, so the signals that can
# are treated as "a person decides":
#   1. a repair round deleted a file, or a conflict was resolved by deleting the file;
#   2. the hunk-survival gate warns that lines our customizations added to a file are missing from the merged file, AND the model's
#      report does not account for that file. The prompt makes it end its report with one line per flagged file:
#      `LOST-LINES <file>: restored in <path> | already provided by <path> | left, because <reason>` (agent-round.sh stores them as
#      `lost_lines` in the round record, because the stored report is cut at 6000 bytes). Only `restored in` and `already provided by`
#      count as accounted for; `left` and a missing line stop the merge. The model's claim is not verified here, so a wrong claim
#      lands; on 2026-11-22 it was right for all four entries of the v1.4.269 sync.
# Seen 2026-11-22: the model deleted activity-thread-row-identity.tsx, and 9 of 9 lines of ours were missing from
# use-agent-pane-threads.ts after round 1, with every other gate green.

# shellcheck source=lost-lines-claims.sh
. "$(dirname "${BASH_SOURCE[0]}")/lost-lines-claims.sh"

review_needed() {
  local facts="$1" g f flagged claims all_flagged="" unaddressed=""; shift
  jq -r '
    ((.repair_deleted // []) | if length > 0 then "a repair round deleted \(length) file(s): \(.[0:4] | join(", "))\(if length > 4 then ", ..." else "" end)" else empty end),
    ([.conflicts[]? | select(.decision == "deleted" and ((.resolution // "") | startswith("scripted") | not)) | .path] | if length > 0 then "the model resolved \(length) conflict(s) by deleting the file: \(.[0:4] | join(", "))\(if length > 4 then ", ..." else "" end)" else empty end)
  ' "$facts" || return 1
  for g in "$@"; do
    [ -s "$g" ] || continue
    # The flagged file of each warning is its first backticked path, or, when upstream moved the file, the NEW path: the gate writes
    # `old` -> `new` (one code span each); a single span `old -> new` is read the same way.
    flagged="$(jq -r '.gates[]? | select(.id == "hunk-survival") | (.warnings // [])[] | (capture("^`(?<a>[^`]+)`(?: -> `(?<b>[^`]+)`)?") // empty) | (.b // .a) | sub("^.* -> "; "")' "$g")" || return 1
    [ -z "$flagged" ] || all_flagged="${all_flagged:+$all_flagged
}$flagged"
  done
  if [ -n "$all_flagged" ]; then
    # Every LOST-LINES line the model wrote, over all rounds up to the chosen one, oldest first.
    claims="$(jq -r '[.agent.rounds[]? | (.lost_lines // [])[]] | .[]' "$facts")" || return 1
    unaddressed="$(unaccounted_files <(printf '%s\n' "$all_flagged" | awk '!seen[$0]++') <(printf '%s\n' "$claims"))" || return 1
    unaddressed="$(printf '%s' "$unaddressed" | awk 'NR > 1 { printf ", " } { printf "%s", $0 }')"
  fi
  if [ -n "$unaddressed" ]; then
    printf 'lines of our customizations are missing from a merged file and the model did not account for it: %s\n' "$unaddressed"
  fi
}

# review_meta PR_META FACTS [GATES_JSON...]: adds `needs_review` (bool) and `review_reasons` (list) to the PR's pr-meta.json. A review
# check that itself fails counts as a reason: nothing lands unseen because a check broke.
review_meta() {
  local meta="$1" facts="$2" reasons
  shift 2
  reasons="$(review_needed "$facts" "$@")" || reasons="the review check itself failed, so a person must look"
  jq --arg r "$reasons" '. + {needs_review: ($r != ""), review_reasons: ($r | split("\n") | map(select(length > 0)))}' "$meta" > "$meta.next" && mv "$meta.next" "$meta"
}
