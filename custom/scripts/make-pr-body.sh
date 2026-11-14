#!/usr/bin/env bash
# Collect the raw git facts for the PR body and render title, body and metadata (see make-pr-body.mjs).
# Run inside a checkout that holds the candidate merge commit (and, for a blobless clone, a network connection).
#
# Env: FACTS (sync-facts.json of the chosen round), OUR_FILES (our-files.txt), PR_OUT (output dir, created),
#      GATES_DIRS (space-separated directories that each hold a gates.json; may be empty), AGENT_ROUNDS (optional JSON file),
#      PR_TITLE, RELEASE_URL, RUN_URL, REPO, FULL_DIFF_ARTIFACT, AGENT_RESULTS, AGENT_KEY_LEAKS (passed through to the renderer).
# Output in PR_OUT: pr-body.md, pr-title.txt, pr-meta.json, full-remerge-diff.patch, raw/*.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${FACTS:?}" "${OUR_FILES:?}" "${PR_OUT:?}"
mkdir -p "$PR_OUT/raw"
fj() { jq -r "$1" "$FACTS"; }

merge_sha="$(fj .merge_sha)"; base_sha="$(fj .base_sha)"; upstream_sha="$(fj .upstream_sha)"; old_commit="$(fj .old_base_commit)"
git cat-file -e "$merge_sha^{commit}" || die "merge commit $merge_sha is not in this checkout"

# 1. The resolution diff: what the merge commit decided relative to git's own auto-merge.
paths="$(jq -r '[.conflicts[] | select(.resolution | startswith("scripted: dropped upstream CI") | not) | .path] + (.scripted.our_wins_restored // []) | unique | .[]' "$FACTS")"
: > "$PR_OUT/raw/remerge.patch"
if [ -n "$paths" ] && [ "$(fj '.conflicts | length')" -gt 0 ]; then
  path_args=()
  while IFS= read -r p; do [ -z "$p" ] || path_args+=("$p"); done <<<"$paths"
  git show --remerge-diff --format= "$merge_sha" -- "${path_args[@]}" > "$PR_OUT/raw/remerge.patch" 2>"$PR_OUT/raw/remerge.err" \
    || warn "restricted remerge-diff failed: $(head -c 300 "$PR_OUT/raw/remerge.err")"
fi
# The full diff is an optional artifact: capped at 20 MB (trunc_bytes lets git finish, so a bigger diff is not a SIGPIPE), and a
# failure to produce it is a warning, not the end of the PR.
git show --remerge-diff --format= "$merge_sha" 2>/dev/null | trunc_bytes 20000000 > "$PR_OUT/full-remerge-diff.patch" \
  || warn "the full remerge diff could not be produced; the PR has no full-diff artifact"

# 2. Footprint of our customization: numstat on the old base vs the new tag, restricted to code files we own.
grep -v -E '^(\.github/|custom/)' "$OUR_FILES" > "$PR_OUT/raw/footprint-paths.txt" || true
if [ -s "$PR_OUT/raw/footprint-paths.txt" ]; then
  fp_args=()
  while IFS= read -r p; do [ -z "$p" ] || fp_args+=("$p"); done < "$PR_OUT/raw/footprint-paths.txt"
  git diff --numstat --no-renames "$old_commit" "$base_sha" -- "${fp_args[@]}" > "$PR_OUT/raw/numstat-old.txt" 2>/dev/null || : > "$PR_OUT/raw/numstat-old.txt"
  git diff --numstat --no-renames "$upstream_sha" "$merge_sha" -- "${fp_args[@]}" > "$PR_OUT/raw/numstat-new.txt" 2>/dev/null || : > "$PR_OUT/raw/numstat-new.txt"
else
  : > "$PR_OUT/raw/numstat-old.txt"; : > "$PR_OUT/raw/numstat-new.txt"
fi

# 3. Render.
gate_args=()
for d in ${GATES_DIRS:-}; do
  [ -s "$d/gates.json" ] && gate_args+=(--gates "$d/gates.json")
done
[ -z "${AGENT_ROUNDS:-}" ] || gate_args+=(--agent-rounds "$AGENT_ROUNDS")
node "$(dirname "$0")/make-pr-body.mjs" --facts "$FACTS" --raw "$PR_OUT/raw" --out "$PR_OUT" ${gate_args[@]+"${gate_args[@]}"}
cat "$PR_OUT/pr-meta.json" >&2
