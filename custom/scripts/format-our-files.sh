#!/usr/bin/env bash
# Run `oxfmt --write` over the code files our customizations own, so that the format gate cannot stay red for a reason a
# machine can fix. A model never runs a formatter (its tools cannot) and wrote 7 unformatted files into PR #43.
#
#   format-our-files.sh OUR_FILES_LIST     prints, one per line, the files whose content the formatter changed
#
# Env: OXFMT_BIN (the formatter; when unset or not executable this prints nothing and exits 0), the work tree is the
# current directory. It selects the same files the format gate checks (run-gates.sh: our files that exist and are
# JS/TS code) minus fork scaffolding and upstream CI, which a model and this script never edit, and minus any file that
# still holds conflict markers (the formatter cannot parse it). It runs in `finish`, where no API key is present.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

list="${1:?usage: format-our-files.sh OUR_FILES_LIST}"
[ -n "${OXFMT_BIN:-}" ] && [ -x "$OXFMT_BIN" ] || exit 0

targets="$(mktemp)"
before="$(mktemp)"
after="$(mktemp)"
trap 'rm -f "$targets" "$before" "$after"' EXIT

while IFS= read -r p; do
  [ -n "$p" ] && [ -f "$p" ] || continue
  case "$p" in *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts) ;; *) continue ;; esac
  if our_wins_path "$p" || foreign_ci_path "$p" || has_markers "$p"; then continue; fi
  printf '%s\n' "$p"
done < "$list" | sort -u > "$targets"
[ -s "$targets" ] || exit 0

# Content hashes before and after: a file the formatter left alone is not reported (git would say the same, but
# the files may already differ from HEAD because of the model's own edits).
hash_all() { while IFS= read -r p; do printf '%s %s\n' "$(git hash-object -- "$p")" "$p"; done < "$targets"; }
hash_all > "$before"
# A file the formatter cannot parse must not stop the others: one pass over all, then one pass per file if it failed.
if ! xargs -r -0 "$OXFMT_BIN" --write < <(tr '\n' '\0' < "$targets") >&2; then
  while IFS= read -r p; do "$OXFMT_BIN" --write -- "$p" >&2 || log "oxfmt could not format $p"; done < "$targets"
fi
hash_all > "$after"
# Both lists are sorted by path (the targets are), so a line that differs names a changed file.
{ diff "$before" "$after" || true; } | sed -n 's/^> [0-9a-f]* //p'
exit 0
