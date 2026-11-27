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

# unaccounted_files FLAGGED CLAIMS: stdin-free helper; FLAGGED and CLAIMS are files. Prints the flagged files (one per line, in order) that no
# LOST-LINES claim accounts for. The last claim about a file decides. A claim names its file by exact path, or, when the model mistyped
# it, by the one flagged file that is nearest by edit distance (at most 1 character in 15, at least 2; paths under 20 characters must match
# exactly; a tie names nothing). The model is a small, cheap one and drops letters when it retypes a long path (`claude-acounts`,
# `sesion`): v1.4.278 stopped on that, with a correct claim written under a wrong path. The claim itself is still not verified.
unaccounted_files() {
  awk '
    function lev(a, b,   la, lb, i, j, cost, m, d) {
      la = length(a); lb = length(b)
      for (i = 0; i <= la; i++) d[i, 0] = i
      for (j = 0; j <= lb; j++) d[0, j] = j
      for (i = 1; i <= la; i++) for (j = 1; j <= lb; j++) {
        cost = (substr(a, i, 1) == substr(b, j, 1)) ? 0 : 1
        m = d[i - 1, j] + 1
        if (d[i, j - 1] + 1 < m) m = d[i, j - 1] + 1
        if (d[i - 1, j - 1] + cost < m) m = d[i - 1, j - 1] + cost
        d[i, j] = m
      }
      return d[la, lb]
    }
    FILENAME == ARGV[1] { n++; flagged[n] = $0; next }
    {
      line = $0
      if (line !~ /^LOST-LINES [^ ]+: /) next
      sub(/^LOST-LINES /, "", line)
      i = index(line, ": "); p = substr(line, 1, i - 1); v = substr(line, i + 2)
      good = (index(v, "restored in ") == 1 || index(v, "already provided by ") == 1) ? 1 : 0
      target = 0
      for (k = 1; k <= n; k++) if (flagged[k] == p) target = k
      if (!target && length(p) >= 20) {
        best = 100000; ties = 0
        for (k = 1; k <= n; k++) {
          if (length(flagged[k]) < 20) continue
          longest = length(flagged[k]) > length(p) ? length(flagged[k]) : length(p)
          limit = int(longest / 15); if (limit < 2) limit = 2
          dist = lev(p, flagged[k])
          if (dist <= limit) { if (dist < best) { best = dist; target = k; ties = 0 } else if (dist == best) ties++ }
        }
        if (ties > 0) target = 0
      }
      if (target) verdict[target] = good
    }
    END { for (k = 1; k <= n; k++) if (!verdict[k]) print flagged[k] }' "$1" "$2"
}

review_needed() {
  local facts="$1" g f flagged claims all_flagged="" unaddressed=""; shift
  jq -r '
    ((.repair_deleted // []) | if length > 0 then "a repair round deleted \(length) file(s): \(.[0:4] | join(", "))\(if length > 4 then ", ..." else "" end)" else empty end),
    ([.conflicts[]? | select(.decision == "deleted" and ((.resolution // "") | startswith("scripted") | not)) | .path] | if length > 0 then "the model resolved \(length) conflict(s) by deleting the file: \(.[0:4] | join(", "))\(if length > 4 then ", ..." else "" end)" else empty end)
  ' "$facts" || return 1
  for g in "$@"; do
    [ -s "$g" ] || continue
    # The flagged file of each warning is the first backticked path (the new path when upstream moved the file: `old -> new`).
    flagged="$(jq -r '.gates[]? | select(.id == "hunk-survival") | (.warnings // [])[] | (capture("^`(?<f>[^`]+)`") // empty) | .f | sub("^.* -> "; "")' "$g")" || return 1
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
