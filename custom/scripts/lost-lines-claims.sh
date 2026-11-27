#!/usr/bin/env bash
# Sourced by review-needed.sh (which decides whether `land` may merge a sync PR) and by agent-stop-check.sh (the Stop hook of a model round,
# which refuses to let the model finish before it has written a LOST-LINES line for every vanished-lines entry); never run it. One copy, so
# the stop check and the review judge a claim the same way.

# unaccounted_files FLAGGED CLAIMS [any]: FLAGGED and CLAIMS are files. Prints the flagged files (one per line, in order) that no LOST-LINES
# claim accounts for. The last claim about a file decides. A claim accounts for a file when its verdict is `restored in` or `already provided
# by`; with the third argument `any` every verdict counts (the stop check only needs the model to have DECIDED: a `left, because` still stops
# the merge later, in review-needed.sh). A claim names its file by exact path, or, when the model mistyped
# it, by the one flagged file that is nearest by edit distance (at most 1 character in 15, at least 2; paths under 20 characters must match
# exactly; a tie names nothing). The model is a small, cheap one and drops letters when it retypes a long path (`claude-acounts`,
# `sesion`): v1.4.278 stopped on that, with a correct claim written under a wrong path. The claim itself is still not verified.
unaccounted_files() {
  awk -v anyverdict="$([ "${3:-}" = any ] && echo 1 || echo 0)" '
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
      good = (anyverdict || index(v, "restored in ") == 1 || index(v, "already provided by ") == 1) ? 1 : 0
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
