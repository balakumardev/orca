#!/usr/bin/env bash
# ADVISORY check: did the lines our customizations added to upstream-owned files survive the merge?
# Usage (inside a repository that holds the four commits):
#   check-hunk-survival.sh --old REV --ours REV --new REV --merged REV [--json FILE]
#     --old     the upstream release our branch was based on (custom/BASE before the sync)
#     --ours    the base branch tip the sync started from (old release plus our customization commits)
#     --new     the upstream release being merged (any tree-ish with its tree)
#     --merged  the candidate merge commit
#     --json    also write {checked, affected, files: [...]} here (the repair round reads it to widen its edit scope)
# stdout: one line per file that lost lines, worst first, about 6000 bytes in all. Nothing when every line survived. Exit 0 whatever it
# finds: it is a warning source, never a verdict. It cannot fail a gate: run-gates.sh turns a crash into a skipped gate.
#
# Why: the merge takes a file from upstream when upstream moved or rewrote it, and OUR hunk in it vanishes without a conflict, without a
# type error and without a failing unit test (PR #43: our selection state and the call to our follow hook in the file upstream moved
# into another folder; only an e2e spec noticed). Git plumbing and grep -F only: no pnpm, no blob that is not already needed.
#
# Algorithm:
#   1. files we MODIFIED in upstream's tree: diff-filter=M of --old against --ours (files that are new in custom are ours entirely; fork
#      scaffolding, lockfiles and generated files are left out);
#   2. the lines we ADDED there (`git diff -U0`), trimmed; blank, comment-only, import/export-from lines (the import repointing rewrites
#      those on purpose), lines without a letter or digit and lines under 12 characters are not significant;
#   3. where the file lives in the NEW release: the same path when it exists there; else git's rename detection (-M30%, the sync's own
#      threshold) limited to OUR missing files against the files the release added (so no unrelated blob is fetched); else the one file
#      the release added with the same base name;
#   4. each significant line must occur, trimmed and verbatim, in the merged file at that path (or at the old path when the merge kept it).
# Reported per file: how many lines are missing and up to 5 of them; `file removed upstream` when nothing is left to look in.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
export LC_ALL=C

OLD="" OURS="" NEW="" MERGED="" JSON=""
while [ $# -gt 0 ]; do
  case "$1" in
    --old) OLD="$2"; shift 2 ;;
    --ours) OURS="$2"; shift 2 ;;
    --new) NEW="$2"; shift 2 ;;
    --merged) MERGED="$2"; shift 2 ;;
    --json) JSON="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$OLD" ] && [ -n "$OURS" ] && [ -n "$NEW" ] && [ -n "$MERGED" ] || die "usage: check-hunk-survival.sh --old REV --ours REV --new REV --merged REV [--json FILE]"

OUT_CAP=6000
SAMPLES=5
MIN_LEN=12
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/added" "$tmp/res"
G=(git -c core.quotePath=false)

# Not a hunk of ours worth tracking: fork scaffolding, upstream CI, lockfiles and generated files (their lines are rewritten by tools).
skip_file() {
  our_wins_path "$1" || foreign_ci_path "$1" || generated_path "$1" && return 0
  case "$1" in .github/*|pnpm-lock.yaml|*/pnpm-lock.yaml|*.lock|*.snap) return 0 ;; esac
  return 1
}

# 1. Files we modified.
"${G[@]}" diff --name-only --no-renames --diff-filter=M "$OLD" "$OURS" | while IFS= read -r p; do
  [ -n "$p" ] || continue
  skip_file "$p" || printf '%s\n' "$p"
done > "$tmp/files.txt" || true
checked="$(wc -l < "$tmp/files.txt" | tr -d ' ')"

# 2. The lines we added, one file per number; index.tsv maps the number to the path. One diff for all files, so the blobs are fetched
# together. A file's lines are contiguous in the output, so one output file is open at a time.
: > "$tmp/index.tsv"
if [ "$checked" -gt 0 ]; then
  "${G[@]}" diff -U0 --no-renames --no-color --diff-filter=M --src-prefix=a/ --dst-prefix=b/ "$OLD" "$OURS" | awk -v dir="$tmp/added" -v allow="$tmp/files.txt" -v idx="$tmp/index.tsv" '
    BEGIN { while ((getline p < allow) > 0) ok[p] = 1; close(allow); n = 0 }
    /^diff --git / { inhdr = 1; if (cur != "") close(cur); cur = ""; next }
    inhdr && /^\+\+\+ / { path = substr($0, 7); sub(/\t.*$/, "", path); if (path in ok) { n++; cur = dir "/" n; print n "\t" path >> idx } next }
    /^@@ / { inhdr = 0; next }
    !inhdr && cur != "" && /^\+/ { print substr($0, 2) >> cur }
    END { if (cur != "") close(cur) }' || true
fi

# significant_lines: stdin = raw added lines, stdout = trimmed unique lines worth looking for. The noise filters are ERE.
NOISE_COMMENT='^(//|/\*|\*|\*/|#|<!--|-->)'
NOISE_IMPORT='^(import[[:space:]({*"'"'"']|import$|export[[:space:]]+(\*|type[[:space:]]+\{|\{[^}]*\})[^=]*[[:space:]]from[[:space:]]|\}[[:space:]]*from[[:space:]]|from[[:space:]]+["'"'"']|.*=[[:space:]]*require\()'
normalize() { sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
significant_lines() {
  normalize | awk -v min="$MIN_LEN" 'length($0) >= min' | { grep -v -E "$NOISE_COMMENT" || true; } | { grep -v -E "$NOISE_IMPORT" || true; } \
    | { grep -E '[A-Za-z0-9]' || true; } | sort -u
}

# 3. The path in the new release. Only for files that are not there any more.
"${G[@]}" ls-tree -r --name-only "$NEW" | sort > "$tmp/new-paths.txt"
{ grep -F -x -v -f "$tmp/new-paths.txt" "$tmp/files.txt" || true; } > "$tmp/missing.txt"
: > "$tmp/rename-map.tsv"
if [ -s "$tmp/missing.txt" ]; then
  # Files the release added, and (for the rename detector) our missing files against them, as two small trees: git compares
  # only those, not the thousands of files a big release moves, and fetches only their blobs.
  "${G[@]}" diff-tree -r --no-renames --diff-filter=A --no-abbrev --raw "$OLD" "$NEW" > "$tmp/added-raw.txt" || true
  awk -F'\t' '{ n = split($1, m, " "); print m[2] " " m[4] "\t" $2 }' "$tmp/added-raw.txt" > "$tmp/added-info.txt"
  awk -F'\t' '{ print $2 }' "$tmp/added-raw.txt" | sort > "$tmp/added-paths.txt"
  "${G[@]}" ls-tree -r "$OLD" | awk -F'\t' 'NR == FNR { m[$0] = 1; next } ($2 in m) { split($1, a, " "); print a[1] " " a[3] "\t" $2 }' "$tmp/missing.txt" - > "$tmp/source-info.txt" || true
  if [ -s "$tmp/source-info.txt" ] && [ -s "$tmp/added-info.txt" ]; then
    tree_a="$(GIT_INDEX_FILE="$tmp/index-a" git update-index --index-info < "$tmp/source-info.txt" && GIT_INDEX_FILE="$tmp/index-a" git write-tree --missing-ok)" || tree_a=""
    tree_b="$(GIT_INDEX_FILE="$tmp/index-b" git update-index --index-info < "$tmp/added-info.txt" && GIT_INDEX_FILE="$tmp/index-b" git write-tree --missing-ok)" || tree_b=""
    if [ -n "$tree_a" ] && [ -n "$tree_b" ]; then
      "${G[@]}" diff-tree -r -M30% -l20000 --name-status "$tree_a" "$tree_b" 2>/dev/null | awk -F'\t' '$1 ~ /^R/ { print $2 "\t" $3 }' > "$tmp/rename-map.tsv" || true
    fi
  fi
  # What git could not pair (a file rewritten below the similarity threshold): the one added file with the same base name.
  while IFS= read -r p; do
    grep -q -F -x -- "$p" <(cut -f1 "$tmp/rename-map.tsv") && continue
    base="${p##*/}"
    cands="$(awk -F/ -v b="$base" '$NF == b' "$tmp/added-paths.txt" 2>/dev/null || true)"
    if [ -n "$cands" ] && [ "$(printf '%s\n' "$cands" | wc -l | tr -d ' ')" -eq 1 ]; then printf '%s\t%s\n' "$p" "$cands" >> "$tmp/rename-map.tsv"; fi
  done < "$tmp/missing.txt"
fi

# 4. Compare.
affected=0
while IFS="$(printf '\t')" read -r n p; do
  [ -n "$n" ] && [ -f "$tmp/added/$n" ] || continue # a file we only trimmed or changed the mode of has no added line
  significant_lines < "$tmp/added/$n" > "$tmp/sig.txt"
  total="$(wc -l < "$tmp/sig.txt" | tr -d ' ')"
  [ "$total" -gt 0 ] || continue
  mapped="$p"
  if ! grep -q -F -x -- "$p" "$tmp/new-paths.txt"; then
    mapped="$(awk -F'\t' -v p="$p" '$1 == p { print $2; exit }' "$tmp/rename-map.tsv")"
  fi
  : > "$tmp/set.txt"
  found=0
  for cand in "$mapped" "$p"; do
    [ -n "$cand" ] || continue
    if "${G[@]}" cat-file -e "$MERGED:$cand" 2>/dev/null; then
      found=1
      "${G[@]}" cat-file blob "$MERGED:$cand" | normalize >> "$tmp/set.txt"
    fi
  done
  removed=false
  if [ "$found" -eq 0 ]; then
    removed=true; cp "$tmp/sig.txt" "$tmp/missing-lines.txt"; : "${mapped:=$p}"
  else
    { grep -F -x -v -f "$tmp/set.txt" "$tmp/sig.txt" || true; } > "$tmp/missing-lines.txt"
  fi
  missing="$(wc -l < "$tmp/missing-lines.txt" | tr -d ' ')"
  [ "$missing" -gt 0 ] || continue
  affected=$((affected + 1))
  jq -n -c --arg old "$p" --arg mapped "${mapped:-$p}" --argjson missing "$missing" --argjson total "$total" --argjson removed "$removed" \
    --rawfile samples <(awk -v max="$SAMPLES" 'NR <= max' "$tmp/missing-lines.txt") \
    '{old: $old, mapped: $mapped, missing: $missing, total: $total, removed: $removed, samples: ($samples | split("\n") | map(select(length > 0)))}' > "$tmp/res/$affected.json"
done < "$tmp/index.tsv"

if [ "$affected" -gt 0 ]; then jq -s -c 'sort_by(-.missing, .old)' "$tmp"/res/*.json > "$tmp/all.json"; else printf '[]\n' > "$tmp/all.json"; fi
if [ -n "$JSON" ]; then
  jq -n -c --argjson checked "$checked" --argjson affected "$affected" --slurpfile files "$tmp/all.json" '{checked: $checked, affected: $affected, files: $files[0]}' > "$JSON"
fi
log "hunk survival: $checked file(s) of upstream's that we modified, $affected lost significant lines"

# One line per file for the gate's warnings (and so the PR caveats): paths and samples are code spans, so JSX, `@name` and backticks in
# the lines cannot become markup or a mention. The whole text stays within OUT_CAP bytes.
jq -r '
  def q: gsub("`"; "'"'"'") | gsub("[\u0001-\u001f\u007f]"; " ") | .[:90] | "`" + . + "`";
  .[] | (if .removed then "\(.old | q): file removed upstream (no rename found, not kept in the merge); the \(.total) significant line(s) we added there are gone, e.g. "
        elif .old == .mapped then "\(.old | q): \(.missing) of \(.total) significant lines we added are missing from the merged file, e.g. "
        else "\(.old | q) -> \(.mapped | q): \(.missing) of \(.total) significant lines we added are missing from the merged file, e.g. " end)
        + (.samples | map(q) | join(", "))' "$tmp/all.json" | {
  used=0; shown=0; total_lines=0
  while IFS= read -r line; do
    total_lines=$((total_lines + 1))
    if [ $((used + ${#line} + 1)) -le "$OUT_CAP" ]; then printf '%s\n' "$line"; used=$((used + ${#line} + 1)); shown=$((shown + 1)); fi
  done
  if [ "$shown" -lt "$total_lines" ]; then printf '... and %s more file(s) with missing lines (output capped)\n' "$((total_lines - shown))"; fi
}
exit 0
