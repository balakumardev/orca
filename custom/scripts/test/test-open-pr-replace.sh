#!/usr/bin/env bash
# Test for open-pr.sh: replacing a stale PR of the same branch, adopting the PR of a first attempt on a re-run, and the paths that
# existed before (plain, orphan branch, superseded older tags). Real git (a local bare "origin" the script pushes to), stub `gh`.
# Run: bash custom/scripts/test/test-open-pr-replace.sh      (needs bash, git, jq)
# SCRIPTS_DIR=<dir> points it at another copy of the scripts.
#
# The stub records every call in order and answers the PR reads from fixture files; its `api -X DELETE .../git/refs/heads/B` and the
# script's `git push` act on the real bare repository, and `pr create` records what origin held at that moment. So the order
# (re-check, close with the marker, delete the branch, push, create) and the end state (origin's branch is the new merge commit)
# are observed, not assumed. The guards: a PR that changed since detect saw it (head moved, merged, from a fork, other base,
# another author, another branch) is left alone, and then NOTHING is closed, deleted or pushed and no PR number is output.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="${SCRIPTS_DIR:-$(cd "$here/.." && pwd)}"
for t in jq git; do command -v "$t" >/dev/null 2>&1 || { echo "missing tool: $t"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY GITHUB_RUN_ATTEMPT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
BRANCH="sync/v1.4.258"
MARK=$'superseded: custom moved on, syncing again\n\n<!-- custom-sync:superseded -->\n'

mkdir "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Stub gh: logs every call; PR reads come from $FIX; branch deletion and the branch lookup act on the real bare repo $ORIGIN.
echo "$*" >> "$GH_LOG"
args=("$@")
jqprog="" path="" method=GET
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  case "${args[$i]}" in
    --jq) jqprog="${args[$((i + 1))]}" ;;
    -X) method="${args[$((i + 1))]}" ;;
    repos/*) [ -n "$path" ] || path="${args[$i]%%\?*}" ;;
  esac
  i=$((i + 1))
done
emit() {
  [ -f "$1" ] || { echo "stub gh: no fixture $(basename "$1") for: $*" >&2; exit 1; }
  if [ -n "$jqprog" ]; then jq -r -c "$jqprog" "$1"; else cat "$1"; fi
}
case "$1 $2" in
  "label list") printf 'upstream-sync\nagent-resolved\nneeds-review\n' ;;
  "pr view") emit "$FIX/view-$3.json" ;;
  "pr list") emit "$FIX/list-open.json" ;;
  "pr close") jq '.state = "CLOSED"' "$FIX/view-$3.json" > "$FIX/v.tmp" && mv "$FIX/v.tmp" "$FIX/view-$3.json" ;;
  "pr create") echo "ORIGIN_AT_CREATE=$(git --git-dir="$ORIGIN" rev-parse "refs/heads/$BRANCH" 2>&1)" >> "$GH_LOG"; echo "https://github.com/balakumardev/orca/pull/99" ;;
  "pr edit" | "pr ready") ;;
  "api -X" | "api repos"*)
    case "$method $path" in
      "DELETE repos/"*/git/refs/heads/*) git --git-dir="$ORIGIN" update-ref -d "refs/heads/${path#*/git/refs/heads/}" ;;
      "GET repos/"*/git/ref/heads/*) git --git-dir="$ORIGIN" rev-parse -q --verify "refs/heads/${path#*/git/ref/heads/}" >/dev/null ;;
      "GET repos/"*/issues/*/comments) emit "$FIX/comments-$(basename "$(dirname "$path")").json" ;;
      "POST repos/"*/statuses/*) ;;
      *) if [[ "$path" == */statuses/* ]]; then :; else echo "stub gh: no route for: $*" >&2; exit 1; fi ;;
    esac ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
STUB
chmod +x "$tmp/bin/gh"

# ---- the world ----------------------------------------------------------------------------------------------------------------
# world [ORIGIN_BRANCH: old|merge|none] [BRANCH_NAME]: a work repo whose local sync branch is the new merge commit; origin holds
# the branch as an unrelated old commit (old), as the new merge commit (merge: what attempt 1 pushed) or not at all (none).
world() {
  local ob="${1:-old}" b="${2:-$BRANCH}"
  BRANCH="$b"
  WORK="$tmp/work"; ORIGIN="$tmp/origin.git"; FIX="$tmp/fix"
  rm -rf "$WORK" "$ORIGIN" "$FIX"; mkdir -p "$FIX"
  git init -q --bare "$ORIGIN"
  git init -q "$WORK"
  git -C "$WORK" checkout -q -b custom
  echo base > "$WORK/f"; git -C "$WORK" add f; git -C "$WORK" commit -q -m base
  git -C "$WORK" remote add origin "$ORIGIN"
  git -C "$WORK" push -q origin custom
  git -C "$WORK" checkout -q -b "$b"
  echo old > "$WORK/f"; git -C "$WORK" commit -q -am "old stale merge"
  OLD_SHA="$(git -C "$WORK" rev-parse HEAD)"
  git -C "$WORK" checkout -q custom; git -C "$WORK" branch -q -D "$b"
  git -C "$WORK" checkout -q -b "$b"
  echo new > "$WORK/f"; git -C "$WORK" commit -q -am "new merge"
  MERGE_SHA="$(git -C "$WORK" rev-parse HEAD)"
  case "$ob" in
    old) git -C "$WORK" push -q origin "$OLD_SHA:refs/heads/$b" ;;
    merge) git -C "$WORK" push -q origin "refs/heads/$b:refs/heads/$b" ;;
    none) : ;;
  esac
  jq -n --arg b "$b" --arg s "$MERGE_SHA" '{branch: $b, base_branch: "custom", merge_sha: $s, tag: "v1.4.258"}' > "$tmp/facts.json"
  mkdir -p "$tmp/pr"
  echo "Sync upstream v1.4.258" > "$tmp/pr/pr-title.txt"; echo "body" > "$tmp/pr/pr-body.md"
  meta false
  echo '[]' > "$FIX/list-open.json"
  git -C "$WORK" checkout -q "$b"
}
meta() { jq -n --argjson d "$1" '{draft: $d, labels: ["upstream-sync", "needs-review", "no-such-label"], gates_status: "success"}' > "$tmp/pr/pr-meta.json"; }
view() { # NUMBER [STATE] [HEAD] [BASE] [CROSS] [LOGIN] [HEADREF] [DRAFT]
  jq -n --arg st "${2:-OPEN}" --arg h "${3:-$OLD_SHA}" --arg b "${4:-custom}" --argjson x "${5:-false}" --arg l "${6:-app/github-actions}" \
    --arg hr "${7:-$BRANCH}" --argjson d "${8:-false}" \
    '{state: $st, headRefName: $hr, headRefOid: $h, baseRefName: $b, isCrossRepository: $x, author: {login: $l}, isDraft: $d}' > "$FIX/view-$1.json"
}
comments() { jq -n --arg l "$2" --arg b "$3" '[{user: {login: $l}, body: $b}]' > "$FIX/comments-$1.json"; }

run() { # env assignments... -> o_out o_rc
  : > "$tmp/gh.log"
  o_rc=0
  o_out="$(cd "$WORK" && env PATH="$tmp/bin:$PATH" GH_LOG="$tmp/gh.log" FIX="$FIX" ORIGIN="$ORIGIN" BRANCH="$BRANCH" \
    GH_TOKEN=dummy REPO=balakumardev/orca FACTS="$tmp/facts.json" PR_OUT="$tmp/pr" RUN_URL=https://example.invalid/run "$@" \
    bash "$scripts/open-pr.sh" 2>&1)" || o_rc=$?
}
out_of() { local v; v="$(sed -n "s/^OUTPUT $1=//p" <<<"$o_out")"; printf '%s' "${v%%$'\n'*}"; }
origin_sha() { git --git-dir="$ORIGIN" rev-parse -q --verify "refs/heads/$BRANCH" 2>/dev/null || echo none; }
line_of() { grep -n -m1 -E -- "$1" "$tmp/gh.log" | cut -d: -f1 || true; }
called() { grep -qE -- "$1" "$tmp/gh.log"; }
untouched() { # NAME: nothing was closed, deleted, pushed or opened, and no PR number came out
  if ! called '^pr close ' && ! called '-X DELETE' && ! called '^pr create ' && [ "$(origin_sha)" = "$OLD_SHA" ] && [ -z "$(out_of pr_number)" ] && [ "$o_rc" = 0 ] \
     && grep -qF "left alone" <<<"$o_out"; then ok "$NAME_PREFIX$1"
  else bad "$NAME_PREFIX$1: rc=$o_rc origin=$(origin_sha) log=[$(tr '\n' ';' < "$tmp/gh.log")] out=[$o_out]"; fi
}
NAME_PREFIX=""

# ---- replace: the happy path, observed in order ----------------------------------------------------------------------------
world old; view 43 OPEN "$OLD_SHA"
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"
v="$(line_of '^pr view 43 ')"; c="$(line_of '^pr close 43 ')"; d="$(line_of '-X DELETE repos/balakumardev/orca/git/refs/heads/sync/v1.4.258')"; cr="$(line_of '^pr create ')"
if [ "$o_rc" = 0 ] && [ -n "$v" ] && [ -n "$c" ] && [ -n "$d" ] && [ -n "$cr" ] && [ "$v" -lt "$c" ] && [ "$c" -lt "$d" ] && [ "$d" -lt "$cr" ]; then ok "stale PR: re-checked, then closed, then its branch deleted, then the new PR created (in that order)"
else bad "order: rc=$o_rc v=$v c=$c d=$d cr=$cr out=[$o_out] log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi
if [ "$(origin_sha)" = "$MERGE_SHA" ] && grep -qF "ORIGIN_AT_CREATE=$MERGE_SHA" "$tmp/gh.log"; then ok "the new merge commit was pushed to the SAME branch name before the PR was created, with no force-push"; else bad "origin=$(origin_sha) want $MERGE_SHA"; fi
if grep -qF 'superseded: custom moved on, syncing again' "$tmp/gh.log" && grep -qF 'custom-sync:superseded' "$tmp/gh.log"; then ok "the close comment carries the visible text and the marker later runs count by"; else bad "close call: $(grep '^pr close' "$tmp/gh.log")"; fi
if [ "$(out_of pr_number)" = 99 ] && [ "$(out_of merge_sha)" = "$MERGE_SHA" ] && [ "$(out_of draft)" = false ]; then ok "outputs describe the new PR (number, merge_sha, draft)"; else bad "outputs: $o_out"; fi
if called 'create .*--head sync/v1.4.258' && called 'create .*--base custom' && called '--label upstream-sync' && called '--label needs-review' && ! called 'no-such-label'; then ok "the new PR is created from the branch against custom with the labels that exist"; else bad "create call: $(grep '^pr create' "$tmp/gh.log")"; fi
if called 'statuses/'"$MERGE_SHA"; then ok "the gate statuses are posted on the new merge commit"; else bad "no status call"; fi

# ---- replace: a PR that changed since detect looked is left alone -----------------------------------------------------------
NAME_PREFIX="replace guard: "
world old; view 43 OPEN "dddddddddddddddddddddddddddddddddddddddd"
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"; untouched "a person pushed to the PR while the sync ran (head moved): nothing closed, deleted or pushed, no PR output"
if grep -qF "head moved" <<<"$o_out"; then ok "replace guard: and the warning says the head moved"; else bad "warning text: $o_out"; fi
world old; view 43 MERGED "$OLD_SHA"
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"; untouched "the PR was merged meanwhile"
world old; view 43 CLOSED "$OLD_SHA"; comments 43 balakumardev "closing this myself"
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"; untouched "a person closed it meanwhile"
world old; view 43 OPEN "$OLD_SHA" custom true
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"; untouched "it comes from a fork"
world old; view 43 OPEN "$OLD_SHA" main
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"; untouched "its base is not custom"
world old; view 43 OPEN "$OLD_SHA" custom false balakumardev
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"; untouched "it was not opened by the automation"
world old; view 43 OPEN "$OLD_SHA" custom false app/github-actions sync/other
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"; untouched "its head branch is another one"
NAME_PREFIX=""

# ---- replace: an earlier attempt of this job already closed it --------------------------------------------------------------
world old; view 43 CLOSED "$OLD_SHA"; comments 43 "github-actions[bot]" "$MARK"
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"
if [ "$o_rc" = 0 ] && ! called '^pr close ' && called '-X DELETE' && [ "$(origin_sha)" = "$MERGE_SHA" ] && [ "$(out_of pr_number)" = 99 ]; then ok "already closed by the automation (an earlier attempt): no second close, the branch is replaced and the PR opened"; else bad "closed-by-us: rc=$o_rc out=[$o_out] log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi
world none; view 43 CLOSED "$OLD_SHA"; comments 43 "github-actions[bot]" "$MARK"
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"
if [ "$o_rc" = 0 ] && ! called '-X DELETE' && [ "$(origin_sha)" = "$MERGE_SHA" ] && [ "$(out_of pr_number)" = 99 ]; then ok "the old branch is already gone: no delete call, the push still works"; else bad "branch gone: rc=$o_rc out=[$o_out]"; fi

# ---- replace is for real sync branches only ---------------------------------------------------------------------------------
world none sync-test/x; view 43 OPEN "$OLD_SHA" custom false app/github-actions sync-test/x
run SUPERSEDE='[]' ORPHAN_BRANCH=false REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"
if [ "$o_rc" != 0 ] && ! called '^pr close ' && ! called '^pr create ' && grep -qF "only sync/* branches" <<<"$o_out"; then ok "a rehearsal branch (sync-test/*) is never replaced: the job refuses before closing anything"; else bad "sync-test replace: rc=$o_rc out=[$o_out]"; fi
BRANCH="sync/v1.4.258"

# ---- the paths that existed before ------------------------------------------------------------------------------------------
world none
run SUPERSEDE='[]' ORPHAN_BRANCH=false
if [ "$o_rc" = 0 ] && ! called '^pr close ' && ! called '-X DELETE' && called '^pr create ' && [ "$(origin_sha)" = "$MERGE_SHA" ] && [ "$(out_of pr_number)" = 99 ]; then ok "plain first run (no replacement, no orphan): push and create, nothing closed or deleted"; else bad "plain: rc=$o_rc out=[$o_out]"; fi
if ! called '^pr list '; then ok "a first attempt never looks for a PR to adopt"; else bad "attempt 1 listed PRs: $(grep '^pr list' "$tmp/gh.log")"; fi
world old
run SUPERSEDE='[]' ORPHAN_BRANCH=true
if [ "$o_rc" = 0 ] && ! called '^pr close ' && called '-X DELETE' && [ "$(origin_sha)" = "$MERGE_SHA" ] && called '^pr create '; then ok "orphan branch (no PR): deleted, pushed, PR created, and no PR is closed"; else bad "orphan: rc=$o_rc out=[$o_out]"; fi
world old; view 30 OPEN "$OLD_SHA" custom false app/github-actions sync/v1.0.1; view 31 OPEN "$OLD_SHA" custom false balakumardev sync/v1.0.2
run SUPERSEDE='[30,31]' ORPHAN_BRANCH=true
if called '^pr close 30 ' && called 'heads/sync/v1.0.1' && ! called '^pr close 31 ' && grep -qF "PR #31 no longer looks like a superseded sync PR" <<<"$o_out"; then ok "older tags' PRs: the one by the automation is closed with its branch deleted, a person's is left alone"; else bad "supersede: out=[$o_out] log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi

# ---- a re-run (attempt 2) adopts the PR attempt 1 opened for the same commit ----------------------------------------------
world merge; view 99 OPEN "$MERGE_SHA" custom false app/github-actions "$BRANCH" true
jq -n --arg s "$MERGE_SHA" '[{number: 99, url: "https://github.com/balakumardev/orca/pull/99", headRefOid: $s}]' > "$FIX/list-open.json"
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_RUN_ATTEMPT=2
if [ "$o_rc" = 0 ] && ! called '^pr create ' && called '^pr edit 99 ' && called '^pr ready 99 ' && ! called 'ready 99 .*--undo' && [ "$(out_of pr_number)" = 99 ] && [ "$(out_of draft)" = false ]; then ok "attempt 2: the open PR for the same commit is adopted (no create), refreshed, and made ready because the gates are green now"; else bad "adopt: rc=$o_rc out=[$o_out] log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi
if called 'pr edit 99 .*--title' && called '--body-file' && called '--add-label upstream-sync' && ! called 'no-such-label'; then ok "attempt 2: title, body and labels are refreshed"; else bad "edit call: $(grep '^pr edit' "$tmp/gh.log")"; fi
if called 'statuses/'"$MERGE_SHA"; then ok "attempt 2: the gate statuses are posted again"; else bad "no status call on adoption"; fi
world merge; view 99 OPEN "$MERGE_SHA" custom false app/github-actions "$BRANCH" false; meta true
jq -n --arg s "$MERGE_SHA" '[{number: 99, url: "https://github.com/balakumardev/orca/pull/99", headRefOid: $s}]' > "$FIX/list-open.json"
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_RUN_ATTEMPT=3
if [ "$o_rc" = 0 ] && called '^pr ready 99 .*--undo' && [ "$(out_of draft)" = true ]; then ok "attempt 3: a PR that is ready but now has failing gates goes back to draft"; else bad "undo: rc=$o_rc log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi
world merge; view 99 OPEN "$MERGE_SHA" custom false app/github-actions "$BRANCH" true; meta true
jq -n --arg s "$MERGE_SHA" '[{number: 99, url: "https://github.com/balakumardev/orca/pull/99", headRefOid: $s}]' > "$FIX/list-open.json"
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_RUN_ATTEMPT=2
if [ "$o_rc" = 0 ] && ! called '^pr ready '; then ok "a draft PR whose gates still fail is left a draft (no ready call)"; else bad "draft stays: $(tr '\n' ';' < "$tmp/gh.log")"; fi
world old
jq -n --arg s "$OLD_SHA" '[{number: 99, url: "https://github.com/balakumardev/orca/pull/99", headRefOid: $s}]' > "$FIX/list-open.json"
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_RUN_ATTEMPT=2
if [ "$o_rc" != 0 ] && ! called '^pr create ' && ! called '^pr edit ' && [ "$(origin_sha)" = "$OLD_SHA" ]; then ok "attempt 2 with another candidate than the open PR's: not adopted, the push is rejected (no force-push) and the job fails as before"; else bad "different candidate: rc=$o_rc out=[$o_out]"; fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
