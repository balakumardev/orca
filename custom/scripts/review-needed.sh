#!/usr/bin/env bash
# Sourced by make-pr-body.sh and by custom/scripts/test/test-review-needed.sh; never run it.
#
# review_needed FACTS [GATES_JSON...]: prints one line per reason a person must read the sync PR before it merges, and nothing when the
# PR may land by itself. land-sync-pr.sh declines to merge a PR with any reason and leaves it open and ready (not a draft).
#
# Why: a model resolves the merge and repairs gate failures, and a customization can be lost without any gate failing: the model drops
# our import from a file it resolved, or deletes a file of ours that it judges obsolete. Gates cannot see that, so the two signals that
# can are treated as "a person decides": (1) a repair round deleted a file, or a conflict was resolved by deleting the file; (2) the
# hunk-survival gate warns that lines our customizations added to a file upstream changed are missing from the merged file.
# Seen 2026-11-22 on the v1.4.269 sync: the model deleted activity-thread-row-identity.tsx, and 9 of 9 lines of ours were missing from
# use-agent-pane-threads.ts after two rounds, with every other gate green.
review_needed() {
  local facts="$1" g; shift
  jq -r '
    ((.repair_deleted // []) | if length > 0 then "a repair round deleted \(length) file(s): \(.[0:4] | join(", "))\(if length > 4 then ", ..." else "" end)" else empty end),
    ([.conflicts[]? | select(.decision == "deleted" and ((.resolution // "") | startswith("scripted") | not)) | .path] | if length > 0 then "the model resolved \(length) conflict(s) by deleting the file: \(.[0:4] | join(", "))\(if length > 4 then ", ..." else "" end)" else empty end)
  ' "$facts" || return 1
  for g in "$@"; do
    [ -s "$g" ] || continue
    jq -r '.gates[]? | select(.id == "hunk-survival") | (.warnings // []) | if length > 0 then "lines of our customizations are missing from \(length) merged file(s) (hunk-survival)" else empty end' "$g" || return 1
  done
}

# review_meta PR_META FACTS [GATES_JSON...]: adds `needs_review` (bool) and `review_reasons` (list) to the PR's pr-meta.json. A review
# check that itself fails counts as a reason: nothing lands unseen because a check broke.
review_meta() {
  local meta="$1" facts="$2" reasons
  shift 2
  reasons="$(review_needed "$facts" "$@")" || reasons="the review check itself failed, so a person must look"
  jq --arg r "$reasons" '. + {needs_review: ($r != ""), review_reasons: ($r | split("\n") | map(select(length > 0)))}' "$meta" > "$meta.next" && mv "$meta.next" "$meta"
}
