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
# another author, another branch, turned into a draft) is left alone, and then NOTHING is closed, deleted or pushed and no PR
# number is output. A branch is deleted only while it still points at the commit detect saw (REPLACE_HEAD / ORPHAN_SHA) and no
# other open PR uses it: a re-run (attempt 2) that built another candidate, a PR opened on an orphan branch, a person's push after
# detect, a fork's PR with the same branch name and a PR against another base all have a case.
#
# An old failed DRAFT (REPLACE_DRAFT=true, REPLACE_RETRY=n; section "an old failed draft" below): the same close, delete, push, create
# flow, with the draft rules in place of "must be ready": the PR must still be a draft with the automation's failed-sync title, still
# 6 hours old, and still touched by nobody but the automation (events, comments, reviews, no key-leak banner), read again at this
# moment because the sync took hours. The closing comment carries the new text and the same marker. Without REPLACE_DRAFT a draft is
# never replaced.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="${SCRIPTS_DIR:-$(cd "$here/.." && pwd)}"
for t in jq git; do command -v "$t" >/dev/null 2>&1 || { echo "missing tool: $t"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY GITHUB_RUN_ATTEMPT GITHUB_REF AGENT_RESULTS AGENT_KEY_LEAKS
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
BRANCH="sync/v1.4.258"
NOW="$(jq -n '"2026-11-26T12:00:00Z" | fromdateiso8601')" # "now" of every run (NOW_EPOCH); the draft below is 8 hours old
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
      "GET repos/"*/git/ref/heads/*)
        sha="$(git --git-dir="$ORIGIN" rev-parse -q --verify "refs/heads/${path#*/git/ref/heads/}")" || { echo '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/git/refs#get-a-reference","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1; } # the real gh prints the body on stdout
        if [ -n "$jqprog" ]; then jq -n -r --arg s "$sha" '{object: {sha: $s}}' | jq -r "$jqprog"; else echo "$sha"; fi ;;
      "GET repos/"*/issues/*/comments) emit "$FIX/comments-$(basename "$(dirname "$path")").json" ;;
      "GET repos/"*/issues/*/events) emit "$FIX/events-$(basename "$(dirname "$path")").json" ;;
      "GET repos/"*/pulls/*/reviews) emit "$FIX/reviews-$(basename "$(dirname "$path")").json" ;;
      "GET repos/"*/pulls/*/comments) emit "$FIX/revcomments-$(basename "$(dirname "$path")").json" ;;
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
addopen() { # NUMBER HEAD [CROSS] [BASE]: one more entry in what `gh pr list --state open --head <branch>` answers (a fork's PR included)
  jq --argjson n "$1" --arg h "$2" --argjson x "${3:-false}" --arg b "${4:-custom}" \
    '. + [{number: $n, url: ("https://github.com/balakumardev/orca/pull/" + ($n | tostring)), headRefOid: $h, baseRefName: $b, isCrossRepository: $x}]' \
    "$FIX/list-open.json" > "$FIX/l.tmp" && mv "$FIX/l.tmp" "$FIX/list-open.json"
}

run() { # env assignments... -> o_out o_rc
  : > "$tmp/gh.log"
  o_rc=0
  o_out="$(cd "$WORK" && env PATH="$tmp/bin:$PATH" GH_LOG="$tmp/gh.log" FIX="$FIX" ORIGIN="$ORIGIN" BRANCH="$BRANCH" \
    GH_TOKEN=dummy REPO=balakumardev/orca FACTS="$tmp/facts.json" PR_OUT="$tmp/pr" RUN_URL=https://example.invalid/run NOW_EPOCH="$NOW" "$@" \
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
if ! called '^pr list '; then ok "a first run on a free branch name looks at no PR (there is no branch for one to use)"; else bad "free name listed PRs: $(grep '^pr list' "$tmp/gh.log")"; fi
world old
run SUPERSEDE='[]' ORPHAN_BRANCH=true ORPHAN_SHA="$OLD_SHA"
if [ "$o_rc" = 0 ] && ! called '^pr close ' && called '-X DELETE' && [ "$(origin_sha)" = "$MERGE_SHA" ] && called '^pr create '; then ok "orphan branch (no PR, still at the commit detect saw): deleted, pushed, PR created, and no PR is closed"; else bad "orphan: rc=$o_rc out=[$o_out]"; fi
world old; view 30 OPEN "$OLD_SHA" custom false app/github-actions sync/v1.0.1; view 31 OPEN "$OLD_SHA" custom false balakumardev sync/v1.0.2
run SUPERSEDE='[30,31]' ORPHAN_BRANCH=true ORPHAN_SHA="$OLD_SHA"
if called '^pr close 30 ' && called 'heads/sync/v1.0.1' && ! called '^pr close 31 ' && grep -qF "PR #31 no longer looks like a superseded sync PR" <<<"$o_out"; then ok "older tags' PRs: the one by the automation is closed with its branch deleted, a person's is left alone"; else bad "supersede: out=[$o_out] log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi

# ---- a re-run (attempt 2) adopts the PR attempt 1 opened for the same commit ----------------------------------------------
world merge; view 99 OPEN "$MERGE_SHA" custom false app/github-actions "$BRANCH" true
addopen 99 "$MERGE_SHA"
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_RUN_ATTEMPT=2
if [ "$o_rc" = 0 ] && ! called '^pr create ' && called '^pr edit 99 ' && called '^pr ready 99 ' && ! called 'ready 99 .*--undo' && [ "$(out_of pr_number)" = 99 ] && [ "$(out_of draft)" = false ]; then ok "attempt 2: the open PR for the same commit is adopted (no create), refreshed, and made ready because the gates are green now"; else bad "adopt: rc=$o_rc out=[$o_out] log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi
if called 'pr edit 99 .*--title' && called '--body-file' && called '--add-label upstream-sync' && ! called 'no-such-label'; then ok "attempt 2: title, body and labels are refreshed"; else bad "edit call: $(grep '^pr edit' "$tmp/gh.log")"; fi
if called 'statuses/'"$MERGE_SHA"; then ok "attempt 2: the gate statuses are posted again"; else bad "no status call on adoption"; fi
world merge; view 99 OPEN "$MERGE_SHA" custom false app/github-actions "$BRANCH" false; meta true
addopen 99 "$MERGE_SHA"
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_RUN_ATTEMPT=3
if [ "$o_rc" = 0 ] && called '^pr ready 99 .*--undo' && [ "$(out_of draft)" = true ]; then ok "attempt 3: a PR that is ready but now has failing gates goes back to draft"; else bad "undo: rc=$o_rc log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi
world merge; view 99 OPEN "$MERGE_SHA" custom false app/github-actions "$BRANCH" true; meta true
addopen 99 "$MERGE_SHA"
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_RUN_ATTEMPT=2
if [ "$o_rc" = 0 ] && ! called '^pr ready '; then ok "a draft PR whose gates still fail is left a draft (no ready call)"; else bad "draft stays: $(tr '\n' ';' < "$tmp/gh.log")"; fi
# Was "the push is rejected and the job fails": now the open PR that holds the branch is seen first and the job ends green without a PR.
world old; addopen 99 "$OLD_SHA"
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_RUN_ATTEMPT=2
if [ "$o_rc" = 0 ] && ! called '^pr create ' && ! called '^pr edit ' && ! called '-X DELETE' && [ "$(origin_sha)" = "$OLD_SHA" ] && [ -z "$(out_of pr_number)" ] && grep -qF "left alone" <<<"$o_out"; then ok "attempt 2 with another candidate than the open PR's: not adopted, nothing deleted or pushed, green without a PR number (land does not run)"; else bad "different candidate: rc=$o_rc out=[$o_out] log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi

# ---- a branch is deleted only on proof: the reviewer's blocker ---------------------------------------------------------------
STALE="cccccccccccccccccccccccccccccccccccccccc" # the head of the stale PR #43 as detect saw it; NOT the commit attempt 1 published
SEEN="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"  # what detect saw on an orphan branch
NAME_PREFIX="branch safety: "
# Attempt 1 replaced #43 (closed it with the marker, deleted its branch, pushed its candidate A1 = OLD_SHA, opened #44). Attempt 2 built
# another candidate (MERGE_SHA). The branch holds #44's head: it must survive, and #44 must stay open.
world old; view 43 CLOSED "$STALE"; comments 43 "github-actions[bot]" "$MARK"; addopen 44 "$OLD_SHA"
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$STALE" GITHUB_RUN_ATTEMPT=2; untouched "replace, attempt 2, another candidate, #44 open on the branch: branch kept, #44 kept"
if grep -qF "#44" <<<"$o_out"; then ok "branch safety: and the warning names the open PR that holds the branch"; else bad "warning text: $o_out"; fi
# The same with detect's REPLACE_HEAD equal to the tip (the reviewer's repro): the open PR alone is enough to refuse.
world old; view 43 CLOSED "$OLD_SHA"; comments 43 "github-actions[bot]" "$MARK"; addopen 44 "$OLD_SHA"
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA" GITHUB_RUN_ATTEMPT=2; untouched "tip equals REPLACE_HEAD but another open PR uses the branch: kept"
# Attempt 1 got as far as the push but not the PR (no open PR at all): the tip is still not what detect saw.
world old; view 43 CLOSED "$STALE"; comments 43 "github-actions[bot]" "$MARK"
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$STALE" GITHUB_RUN_ATTEMPT=2; untouched "replace, attempt 2, branch holds a commit detect never saw and no PR uses it: kept"
# A person pushed an extra commit to the stale PR's branch after the PR re-check: the PR still reads as the old head, the tip does not.
world old; view 43 OPEN "$STALE"
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$STALE"; untouched "replace: the branch tip is not the head detect judged (a person's commit): the PR is not even closed"
# A second open PR on the branch (against another base) would be closed by the delete without a word.
world old; view 43 OPEN "$OLD_SHA"; addopen 45 "$OLD_SHA" false main
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"; untouched "replace: another open PR (base main) has the branch as its head: nothing closed, deleted or pushed"
# The orphan path (no REPLACE_PR).
world old; addopen 44 "$OLD_SHA"
run SUPERSEDE='[]' ORPHAN_BRANCH=true ORPHAN_SHA="$OLD_SHA" GITHUB_RUN_ATTEMPT=2; untouched "orphan, attempt 2: an open PR was opened on the branch since: kept (even though the tip is what detect saw)"
world old; addopen 44 "$OLD_SHA" false main
run SUPERSEDE='[]' ORPHAN_BRANCH=true ORPHAN_SHA="$OLD_SHA"; untouched "orphan, attempt 1: a PR against ANOTHER base on the branch (someone opened it on the leftover) is kept"
world old
run SUPERSEDE='[]' ORPHAN_BRANCH=true ORPHAN_SHA="$SEEN"; untouched "orphan: the branch moved since detect (a person pushed): kept"
world old
run SUPERSEDE='[]' ORPHAN_BRANCH=true; untouched "orphan: detect gave no commit to compare with: kept"
world old; addopen 50 "$OLD_SHA" true custom
run SUPERSEDE='[]' ORPHAN_BRANCH=true ORPHAN_SHA="$OLD_SHA"
if [ "$o_rc" = 0 ] && called '-X DELETE' && [ "$(origin_sha)" = "$MERGE_SHA" ] && [ "$(out_of pr_number)" = 99 ]; then ok "orphan: a FORK's PR with the same branch name does not hold our branch: replaced as usual"; else bad "fork PR: rc=$o_rc out=[$o_out] log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi
NAME_PREFIX=""
# Attempt 1 pushed this very candidate and failed before the PR: nothing to delete, nothing to push, the PR is created.
world merge; view 43 CLOSED "$STALE"; comments 43 "github-actions[bot]" "$MARK"
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$STALE" GITHUB_RUN_ATTEMPT=2
if [ "$o_rc" = 0 ] && ! called '-X DELETE' && ! called '^pr close ' && called '^pr create ' && [ "$(origin_sha)" = "$MERGE_SHA" ] && [ "$(out_of pr_number)" = 99 ] && grep -qF "not pushing again" <<<"$o_out"; then ok "the branch already holds this run's commit (no PR yet): no delete, no push, the PR is created"; else bad "tip == merge: rc=$o_rc out=[$o_out] log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi

# ---- a draft is never replaced -----------------------------------------------------------------------------------------------
NAME_PREFIX="draft: "
world old; view 43 OPEN "$OLD_SHA" custom false app/github-actions "$BRANCH" true
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"; untouched "the PR became a draft between detect and open-pr (a person, or red gates): nothing closed, deleted or pushed"
if grep -qF "draft" <<<"$o_out"; then ok "draft: and the warning says it is a draft"; else bad "draft text: $o_out"; fi
NAME_PREFIX=""

# ---- an old failed draft: the same flow, the draft rules ---------------------------------------------------------------------
T_MANUAL="[needs manual merge] Sync upstream v1.4.258"
dview() { # NUMBER [HEAD] [TITLE] [CREATED_AT]: an open draft of the automation's, as `gh pr view` reads it, 8 hours old by default
  view "$1" OPEN "${2:-$OLD_SHA}" custom false app/github-actions "$BRANCH" true
  jq --arg t "${3:-$T_MANUAL}" --arg c "${4:-2026-11-26T04:00:00Z}" '. + {title: $t, createdAt: $c, body: "**Merge with a MERGE COMMIT.** Sync of upstream v1.4.258."}' \
    "$FIX/view-$1.json" > "$FIX/v.tmp" && mv "$FIX/v.tmp" "$FIX/view-$1.json"
  jq -n '[{event: "labeled", actor: {login: "github-actions[bot]"}}]' > "$FIX/events-$1.json"
  echo '[]' > "$FIX/comments-$1.json"; echo '[]' > "$FIX/reviews-$1.json"; echo '[]' > "$FIX/revcomments-$1.json"
}
DRAFT=(SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_DRAFT=true REPLACE_RETRY=2)
NAME_PREFIX="failed draft: "
world old; dview 43
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"
v="$(line_of '^pr view 43 --repo balakumardev/orca --json state')"; c="$(line_of '^pr close 43 ')"; d="$(line_of '-X DELETE repos/balakumardev/orca/git/refs/heads/sync/v1.4.258')"; cr="$(line_of '^pr create ')"
if [ "$o_rc" = 0 ] && [ -n "$v" ] && [ -n "$c" ] && [ -n "$d" ] && [ -n "$cr" ] && [ "$v" -lt "$c" ] && [ "$c" -lt "$d" ] && [ "$d" -lt "$cr" ] && [ "$(origin_sha)" = "$MERGE_SHA" ] && [ "$(out_of pr_number)" = 99 ]; then
  ok "an old unattended failed draft: re-checked, closed, its branch deleted, the new PR created, in that order, and the new commit is on origin"
else bad "draft replace: rc=$o_rc v=$v c=$c d=$d cr=$cr origin=$(origin_sha) out=[$o_out] log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi
if called 'unattended failed draft older than 6 hours' && called 'automatic retry 2 of 3' && called 'Automatic retries left after this one: 1' && called 'custom-sync:superseded' \
   && ! called 'superseded: custom moved on, syncing again'; then ok "the close comment says unattended failed draft, older than 6 hours, automatic retry 2 of 3, 1 left, with the shared marker (not the stale-PR text)"
else bad "draft close call: $(grep '^pr close' "$tmp/gh.log")"; fi
if called 'pr view 43 .*--json body' && called 'issues/43/events' && called 'issues/43/comments' && called 'pulls/43/reviews' && called 'pulls/43/comments'; then ok "the draft was judged again right before it was closed (description, events, comments, reviews, inline comments read)"
else bad "re-read lists: $(tr '\n' ';' < "$tmp/gh.log")"; fi
world old; dview 43
run "${DRAFT[@]}" REPLACE_RETRY=3 REPLACE_HEAD="$OLD_SHA"
if [ "$o_rc" = 0 ] && called 'automatic retry 3 of 3' && called 'No automatic retry is left after this one'; then ok "the third automatic retry's comment says that none is left"; else bad "retry 3: $(grep '^pr close' "$tmp/gh.log")"; fi
world old; dview 43; comments 43 "github-actions[bot]" "$(printf 'superseded: this was an unattended failed draft older than 6 hours\n\n<!-- custom-sync:superseded -->\n')"; view 43 CLOSED "$OLD_SHA"
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"
if [ "$o_rc" = 0 ] && ! called '^pr close ' && called '-X DELETE' && [ "$(origin_sha)" = "$MERGE_SHA" ] && [ "$(out_of pr_number)" = 99 ]; then ok "a draft an earlier attempt of this job already closed with the marker: no second close, the branch is replaced and the PR opened"
else bad "draft closed by an earlier attempt: rc=$o_rc out=[$o_out]"; fi

# Everything is read again now: what changed since detect looked leaves the draft alone and nothing is closed, deleted or pushed.
world old; dview 43; comments 43 balakumardev "I am fixing this one"
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"; untouched "a person commented while the sync ran"
if grep -qF "commented on it" <<<"$o_out"; then ok "failed draft: and the warning says so"; else bad "warning: $o_out"; fi
world old; dview 43; jq '. + [{event: "labeled", actor: {login: "balakumardev"}}]' "$FIX/events-43.json" > "$FIX/e.tmp" && mv "$FIX/e.tmp" "$FIX/events-43.json"
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"; untouched "a person edited its labels while the sync ran"
world old; dview 43; jq '. + [{event: "convert_to_draft", actor: {login: "balakumardev"}}]' "$FIX/events-43.json" > "$FIX/e.tmp" && mv "$FIX/e.tmp" "$FIX/events-43.json"
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"; untouched "a person turned it back into a draft"
world old; dview 43; jq -n '[{user: {login: "balakumardev"}}]' > "$FIX/reviews-43.json"
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"; untouched "a person reviewed it"
world old; dview 43; jq -n '[{user: {login: "balakumardev"}}]' > "$FIX/revcomments-43.json"
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"; untouched "a person left an inline review comment"
world old; dview 43 "$OLD_SHA" "[needs manual merge] Sync upstream v1.4.258 (mine)"
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"; untouched "its title was edited"
world old; dview 43; jq '. + {body: "> [!CAUTION]\n> **Rotate DEEPINFRA_API_KEY.**"}' "$FIX/view-43.json" > "$FIX/v.tmp" && mv "$FIX/v.tmp" "$FIX/view-43.json"
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"; untouched "its description carries a key-leak banner"
world old; dview 43; rm "$FIX/events-43.json"
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"; untouched "its events cannot be read (never read as 'nobody acted')"
world old; dview 43
run "${DRAFT[@]}" REPLACE_HEAD=dddddddddddddddddddddddddddddddddddddddd; untouched "its head is not the commit detect judged"
world old; view 43 OPEN "$OLD_SHA" custom false app/github-actions "$BRANCH" false
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"; untouched "it was marked ready for review meanwhile (detect judged a draft)"
if grep -qF "not a draft any more" <<<"$o_out"; then ok "failed draft: and the warning says it is not a draft any more"; else bad "warning: $o_out"; fi
world old; dview 43 "$OLD_SHA" "$T_MANUAL" "2026-11-26T09:00:00Z"
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"; untouched "it is younger than 6 hours at the re-check (a clock or a wrong age is never trusted)"
world old; dview 43; addopen 45 "$OLD_SHA" false main
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"; untouched "another open PR (base main) has the branch as its head: the branch rule holds for a draft too"
world old; dview 43
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA"; untouched "a quiet old draft WITHOUT REPLACE_DRAFT (detect judged it a ready PR): never replaced"
world old; view 43 OPEN "$OLD_SHA" custom false app/github-actions "$BRANCH" false
run "${DRAFT[@]}" REPLACE_HEAD="$OLD_SHA"; untouched "REPLACE_DRAFT=true on a ready PR: left alone"
world old; dview 43
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_DRAFT=true REPLACE_HEAD="$OLD_SHA"
if [ "$o_rc" != 0 ] && ! called '^pr close ' && ! called '-X DELETE' && [ "$(origin_sha)" = "$OLD_SHA" ] && grep -qF "REPLACE_RETRY" <<<"$o_out"; then ok "REPLACE_DRAFT=true without a retry number: the job dies before it closes anything"
else bad "no retry number: rc=$o_rc out=[$o_out]"; fi
world old; dview 43
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_DRAFT=true REPLACE_RETRY=4 REPLACE_HEAD="$OLD_SHA"
if [ "$o_rc" != 0 ] && ! called '^pr close '; then ok "a retry number above the cap (4) is refused before anything is closed"; else bad "retry 4: rc=$o_rc out=[$o_out]"; fi
# The ready PR keeps its own comment text.
world old; view 43 OPEN "$OLD_SHA"
run SUPERSEDE='[]' ORPHAN_BRANCH=true REPLACE_PR=43 REPLACE_HEAD="$OLD_SHA" REPLACE_DRAFT=false
if [ "$o_rc" = 0 ] && called 'superseded: custom moved on, syncing again' && ! called 'unattended failed draft'; then ok "a stale READY PR (REPLACE_DRAFT=false) is closed with the old text, unchanged"; else bad "ready replace text: $(grep '^pr close' "$tmp/gh.log")"; fi
NAME_PREFIX=""

# ---- the model API refused every round: no PR, a red run (a draft would block the retry) ---------------------------------------
agent_facts() { # UNRESOLVED STATUS...: the facts as a run with one model round per STATUS left them
  local unresolved="$1"; shift
  jq --argjson u "$unresolved" --argjson s "$(printf '%s\n' "$@" | jq -s -c 'map(tonumber)')" \
    '. + {unresolved: $u, agent: {rounds: ($s | map({api_status: .}))}}' "$tmp/facts.json" > "$tmp/f.tmp" && mv "$tmp/f.tmp" "$tmp/facts.json"
}
world none; agent_facts true 402 402 402
run SUPERSEDE='[]' ORPHAN_BRANCH=false
if [ "$o_rc" = 1 ] && ! called '^pr create ' && ! called '^pr close ' && ! called '-X DELETE' && [ "$(origin_sha)" = none ] && [ -z "$(out_of pr_number)" ] \
   && grep -qF 'No PR opened: the model API refused every round::HTTP 402' <<<"$o_out"; then ok "every model round refused (402) and nothing resolved: no branch pushed, no PR, the run is red"
else bad "refused every round: rc=$o_rc origin=$(origin_sha) log=[$(tr '\n' ';' < "$tmp/gh.log")] out=[$o_out]"; fi
world none; agent_facts true 402 0 402
run SUPERSEDE='[]' ORPHAN_BRANCH=false
if [ "$o_rc" = 0 ] && called '^pr create ' && [ "$(origin_sha)" = "$MERGE_SHA" ]; then ok "one round was answered by the model: the draft PR is opened as before"
else bad "one round answered: rc=$o_rc out=[$o_out]"; fi
world none; agent_facts true 0
run SUPERSEDE='[]' ORPHAN_BRANCH=false
if [ "$o_rc" = 0 ] && called '^pr create '; then ok "an unresolved candidate whose model ran normally still gets its draft PR for a person"
else bad "unresolved, not refused: rc=$o_rc out=[$o_out]"; fi
world none; agent_facts false 402
run SUPERSEDE='[]' ORPHAN_BRANCH=false
if [ "$o_rc" = 0 ] && called '^pr create '; then ok "a resolved candidate is opened whatever a round's status says"
else bad "resolved: rc=$o_rc out=[$o_out]"; fi

# ---- the agent jobs crashed and no round left a candidate: no PR, a red run (v1.4.274: a lost runner became a draft that blocked the tag) ---
round0_facts() { # IS_TEST: the facts of round 0 (the scripts' merge with its markers; no agent record)
  jq --argjson t "$1" '. + {unresolved: true, is_test: $t, outcome: "conflicts"} | del(.agent)' "$tmp/facts.json" > "$tmp/f.tmp" && mv "$tmp/f.tmp" "$tmp/facts.json"
}
CRASH=(GITHUB_REF=refs/heads/custom 'AGENT_RESULTS=1=failure 2=failure 3=failure' 'AGENT_KEY_LEAKS=1=unknown 2= 3=unknown')
world none; round0_facts false; : > "$tmp/summary.md"
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_STEP_SUMMARY="$tmp/summary.md" "${CRASH[@]}"
if [ "$o_rc" = 1 ] && ! called '^pr create ' && ! called '^pr close ' && ! called '-X DELETE' && ! called '^pr edit ' && [ "$(origin_sha)" = none ] && [ -z "$(out_of pr_number)" ] \
   && grep -qF '::error title=No PR opened: no model round left a candidate::' <<<"$o_out" && grep -qF 'round 1: failure, round 2: failure, round 3: failure' <<<"$o_out" \
   && grep -qF 'next scheduled sync starts this tag over' "$tmp/summary.md"; then ok "crash: every agent job failed and round 0 is the candidate: no branch pushed, no PR, the run is red, the summary says why"
else bad "crash: rc=$o_rc origin=$(origin_sha) log=[$(tr '\n' ';' < "$tmp/gh.log")] out=[$o_out]"; fi
world none; round0_facts false
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_REF=refs/heads/custom 'AGENT_RESULTS=1=cancelled 2=skipped 3=skipped' 'AGENT_KEY_LEAKS=1= 2= 3='
if [ "$o_rc" = 1 ] && ! called '^pr create ' && grep -qF 'round 1: cancelled' <<<"$o_out"; then ok "crash: a cancelled round 1 (job timeout) with no output at all counts too"
else bad "crash (cancelled): rc=$o_rc out=[$o_out]"; fi
world none; round0_facts false; jq '.unresolved = false' "$tmp/facts.json" > "$tmp/f.tmp" && mv "$tmp/f.tmp" "$tmp/facts.json"
run SUPERSEDE='[]' ORPHAN_BRANCH=false "${CRASH[@]}"
if [ "$o_rc" = 1 ] && ! called '^pr create '; then ok "crash: round 0 'resolved' only by leaving the marker-free conflicts as git placed them still opens no PR (no model decided them)"
else bad "crash (round 0 resolved): rc=$o_rc out=[$o_out]"; fi
world none; round0_facts false
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_REF=refs/heads/custom 'AGENT_RESULTS=1=failure 2=skipped 3=skipped' 'AGENT_KEY_LEAKS=1=3 2= 3='
if [ "$o_rc" = 0 ] && called '^pr create ' && [ "$(origin_sha)" = "$MERGE_SHA" ]; then ok "a crashed round whose scan had COUNTED a leak keeps its draft PR (and its banner) as before"
else bad "crash with a counted leak: rc=$o_rc out=[$o_out]"; fi
world none; round0_facts false
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_REF=refs/heads/feature/x 'AGENT_RESULTS=1=failure 2=skipped 3=skipped' 'AGENT_KEY_LEAKS=1= 2= 3='
if [ "$o_rc" = 0 ] && called '^pr create '; then ok "a run from another branch (the agent environment refuses it, so its job fails) opens the draft as before"
else bad "feature branch: rc=$o_rc out=[$o_out]"; fi
world none sync-test/x; round0_facts true
run SUPERSEDE='[]' ORPHAN_BRANCH=false "${CRASH[@]}"
if [ "$o_rc" = 0 ] && called '^pr create '; then ok "a rehearsal (is_test, sync-test/*) opens its draft as before"
else bad "rehearsal: rc=$o_rc out=[$o_out]"; fi
BRANCH="sync/v1.4.258"
world none; round0_facts false
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_REF=refs/heads/custom 'AGENT_RESULTS=1=skipped 2=skipped 3=skipped' 'AGENT_KEY_LEAKS=1= 2= 3='
if [ "$o_rc" = 0 ] && called '^pr create '; then ok "skip_agent (every agent job skipped) opens the draft as before"
else bad "skip_agent: rc=$o_rc out=[$o_out]"; fi
world none; round0_facts false
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_REF=refs/heads/custom
if [ "$o_rc" = 0 ] && called '^pr create '; then ok "without AGENT_RESULTS (an older caller) nothing changes"
else bad "no AGENT_RESULTS: rc=$o_rc out=[$o_out]"; fi
world none; agent_facts true 0
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_REF=refs/heads/custom 'AGENT_RESULTS=1=failure 2=success 3=failure' 'AGENT_KEY_LEAKS=1=unknown 2=0 3=unknown'
if [ "$o_rc" = 0 ] && called '^pr create '; then ok "round 1 crashed but a later round left a candidate: its draft PR is opened as before"
else bad "later round left a candidate: rc=$o_rc out=[$o_out]"; fi
world none; agent_facts true 402 402
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_REF=refs/heads/custom 'AGENT_RESULTS=1=failure 2=success 3=success' 'AGENT_KEY_LEAKS=1=unknown 2=0 3=0'
if [ "$o_rc" = 1 ] && ! called '^pr create ' && grep -qF 'No PR opened: the model API refused every round::HTTP 402' <<<"$o_out" && ! grep -qF 'no model round left a candidate' <<<"$o_out"; then ok "round 1 crashed and the retries were refused (402): the refusal path, unchanged"
else bad "crash then 402: rc=$o_rc out=[$o_out]"; fi

# ---- a merge that needed no model, a red gate, and the repair rounds (custom-sync.yml, agent2's fourth case) crashed or were refused -------
# Round 0 is then a real candidate (resolved, its own red gates), not a merge with markers: the [gates failed] draft opens exactly as it did
# before the repair rounds existed. Neither the crash path (outcome conflicts only) nor the refusal path (unresolved only) applies.
world none; jq '. + {unresolved: false, is_test: false, outcome: "clean"} | del(.agent)' "$tmp/facts.json" > "$tmp/f.tmp" && mv "$tmp/f.tmp" "$tmp/facts.json"; meta true
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_REF=refs/heads/custom 'AGENT_RESULTS=1=skipped 2=failure 3=failure' 'AGENT_KEY_LEAKS=1= 2=unknown 3=unknown'
if [ "$o_rc" = 0 ] && called '^pr create .*--draft' && [ "$(origin_sha)" = "$MERGE_SHA" ]; then ok "clean merge, the repair rounds crashed: round 0's draft PR is opened as before (no crash exit)"
else bad "clean merge, crashed repairs: rc=$o_rc out=[$o_out]"; fi
world none; jq '. + {is_test: false, outcome: "clean"}' "$tmp/facts.json" > "$tmp/f.tmp" && mv "$tmp/f.tmp" "$tmp/facts.json"; agent_facts false 402 402; meta true
run SUPERSEDE='[]' ORPHAN_BRANCH=false GITHUB_REF=refs/heads/custom 'AGENT_RESULTS=1=skipped 2=success 3=success' 'AGENT_KEY_LEAKS=1= 2=0 3=0'
if [ "$o_rc" = 0 ] && called '^pr create .*--draft'; then ok "clean merge, the repair rounds were refused (402): the resolved candidate's draft PR is opened as before"
else bad "clean merge, refused repairs: rc=$o_rc out=[$o_out]"; fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
