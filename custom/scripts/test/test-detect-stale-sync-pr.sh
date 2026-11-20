#!/usr/bin/env bash
# Test for the "a stale sync PR is replaced, not waited on" decision of detect-release.sh / stale-sync-pr.sh, with a stub `gh`
# (no network, no token). Run: bash custom/scripts/test/test-detect-stale-sync-pr.sh      (needs bash and jq)
# SCRIPTS_DIR=<dir> points it at another copy of the scripts (used to prove the cases fail against the unmodified ones).
#
# The stub answers the REST shapes the script reads from fixture files (a commit with parents/author/committer/message, the comments
# of a PR, the compare status, the PR lists) and applies the script's own `--jq` filter to them with real jq, so the filters are
# exercised, not bypassed. Cases: no PR; an open PR that is current stops; an open stale PR with only automation commits is
# replaced (replace_pr, replace_head, orphan_branch); every safety guard has its own case that leaves the PR alone and says why
# (head by a person, either identity half wrong, another upstream commit, wrong link commit, not opened by the automation, from
# a fork, base not custom, compare not "ahead", two open PRs); the retry cap (3 closed as superseded stop it, 2 do not); only a PR
# the automation closed with the marker counts (a person's closure, a marker from a person, a person's comment after the marker
# stop the search); a rehearsal makes no PR lookups. The stub also serves the PR's commit list with upstream's people in it: an
# implementation that scanned every commit of the PR for a human author would refuse the stale PR, so the replace case would fail.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="${SCRIPTS_DIR:-$(cd "$here/.." && pwd)}"
command -v jq >/dev/null 2>&1 || { echo "missing tool: jq"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY INPUT_REF INPUT_BASE_BRANCH

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

BOT="41898282+github-actions[bot]@users.noreply.github.com"
HUMAN="mail@balakumar.dev"
UP="c91a7a6e2b8f4d0a1c3e5f7091a2b3c4d5e6f708"   # the upstream commit of v1.4.258 (also the stub's answer for the tag)
OLD="1111111111111111111111111111111111111111"  # the previous BASE tag commit
P0="2222222222222222222222222222222222222222"   # custom when the sync started
TIP="3333333333333333333333333333333333333333"  # custom now
LINK="4444444444444444444444444444444444444444"
HEAD="5555555555555555555555555555555555555555"
BRANCH_TIP="6666666666666666666666666666666666666666" # where the sync branch points when it exists (the PR's head or an orphan's)
MSG_HEAD=$'Merge upstream v1.4.258 into custom\n\nUpstream commit: '"$UP"$' (v1.4.258)\nPrevious BASE: v1.0.0\nConflicts: 0 file(s) conflicted\n\nOrca-Custom-Patch: upstream-sync\n'
MSG_LINK=$'Link upstream v1.4.258 to v1.0.0\n\nSynthetic commit made by custom-sync.\n'

mkdir "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Stub gh. Every call is logged. Fixture files live in $FIX; --jq filters are applied with real jq.
echo "$*" >> "$GH_LOG"
args=("$@")
jqprog=""
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  if [ "${args[$i]}" = "--jq" ]; then jqprog="${args[$((i + 1))]}"; fi
  i=$((i + 1))
done
emit() {
  [ -f "$1" ] || { echo "stub gh: no fixture $(basename "$1") for: $*" >&2; exit 1; }
  if [ -n "$jqprog" ]; then jq -r -c "$jqprog" "$1"; else cat "$1"; fi
}
if [ "$1" = pr ] && [ "$2" = list ]; then
  case "$*" in
    *"--state all"*) emit "$FIX/prs-all.json" ;;
    *"--state open"*) emit "$FIX/prs-open.json" ;;
    *) echo "stub gh: unexpected pr list: $*" >&2; exit 2 ;;
  esac
  exit 0
fi
[ "$1" = api ] || { echo "stub gh: unexpected call: $*" >&2; exit 2; }
path="${2%%\?*}"
case "$path" in
  repos/*/git/ref/heads/custom | repos/*/git/ref/heads/test/*) emit "$FIX/custom-ref.json" ;;
  repos/*/git/ref/heads/sync/*)
    if [ -f "$FIX/branch-exists" ]; then
      echo "{\"object\":{\"sha\":\"$BRANCH_TIP\"}}" | { if [ -n "$jqprog" ]; then jq -r -c "$jqprog"; else cat; fi; }
    else echo "HTTP 404" >&2; exit 1; fi ;;
  repos/*/contents/custom/BASE) emit "$FIX/base-file.json" ;;
  repos/stablyai/orca/commits/*) echo "{\"sha\":\"$UPSTREAM_SHA\"}" | { if [ -n "$jqprog" ]; then jq -r -c "$jqprog"; else cat; fi; } ;;
  repos/*/compare/*) if [ -f "$FIX/compare-fails" ]; then echo "HTTP 500" >&2; exit 1; fi; emit "$FIX/compare.json" ;;
  repos/*/issues/*/comments) emit "$FIX/comments-$(basename "$(dirname "$path")").json" ;;
  repos/*/pulls/*/commits) emit "$FIX/pr-commits.json" ;;
  repos/*/git/commits/*) emit "$FIX/commit-$(basename "$path").json" ;;
  # `commits/<sha>` computes the commit's files and stats against its first parent: for a sync merge that is the whole upstream
  # delta (26606 files on v1.4.265), slow or timing out in real life. A script that reads it is wrong even if this fixture could answer.
  repos/*/commits/*) echo "stub gh: $path computes a diff of the whole upstream delta; read git/commits/<sha> instead" >&2; exit 1 ;;
  *) echo "stub gh: no route for: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmp/bin/gh"

# ---- fixture builders -------------------------------------------------------------------------------------------------------
reset() { # a fresh world: custom is at $TIP, BASE file says v1.0.0, no PRs, no branch, compare says "ahead"
  FIX="$tmp/fix"; rm -rf "$FIX"; mkdir -p "$FIX"
  jq -n --arg s "$TIP" '{object: {sha: $s}}' > "$FIX/custom-ref.json"
  jq -n --arg c "$(printf 'v1.0.0\n' | base64)" '{content: $c}' > "$FIX/base-file.json"
  echo '[]' > "$FIX/prs-all.json"; echo '[]' > "$FIX/prs-open.json"
  echo '{"status":"ahead","ahead_by":2}' > "$FIX/compare.json"
  # What GitHub lists as the PR's commits: upstream's people and upstream's own bot, then ours. Never read by a correct script.
  jq -n --arg e "$BOT" '[{sha:"u1",commit:{author:{email:"neil@example.com"}}},{sha:"u2",commit:{author:{email:"jinjing@example.com"}}},
    {sha:"u3",commit:{author:{email:$e}}}]' > "$FIX/pr-commits.json"
}
commit() { # SHA PARENTS(comma list) AUTHOR_EMAIL COMMITTER_EMAIL MESSAGE
  jq -n --arg sha "$1" --arg parents "$2" --arg a "$3" --arg c "$4" --arg m "$5" \
    '{sha: $sha, parents: ($parents | split(",") | map(select(. != "")) | map({sha: .})),
      author: {email: $a}, committer: {email: $c}, message: $m}' > "$FIX/commit-$1.json"
}
pristine() { # the automation's merge for UP on top of P0, with its link commit
  commit "$HEAD" "$P0,$LINK" "$BOT" "$BOT" "$MSG_HEAD"
  commit "$LINK" "$UP,$OLD" "$BOT" "$BOT" "$MSG_LINK"
}
pr() { # STATE [NUMBER] [AUTHOR_LOGIN] [BASE] [CROSS] [HEAD] [DRAFT]: add one PR for sync/v1.4.258 to the all-list
  local n="${2:-43}"
  jq --argjson n "$n" --arg st "$1" --arg l "${3:-app/github-actions}" --arg b "${4:-custom}" --argjson x "${5:-false}" --arg h "${6:-$HEAD}" --argjson d "${7:-false}" \
    '. + [{number: $n, state: $st, headRefName: "sync/v1.4.258", headRefOid: $h, baseRefName: $b, isCrossRepository: $x, isDraft: $d, author: {login: $l}}]' \
    "$FIX/prs-all.json" > "$FIX/p.tmp" && mv "$FIX/p.tmp" "$FIX/prs-all.json"
}
comments() { # NUMBER then LOGIN BODY pairs, oldest first
  local n="$1"; shift
  local out="[]"
  while [ "$#" -ge 2 ]; do out="$(jq --arg l "$1" --arg b "$2" '. + [{user: {login: $l}, body: $b}]' <<<"$out")"; shift 2; done
  echo "$out" > "$FIX/comments-$n.json"
}
MARK=$'superseded: custom moved on, syncing again\n\n<!-- custom-sync:superseded -->\n'
closed_by_us() { pr CLOSED "$1"; comments "$1" "github-actions[bot]" "A progress note" "github-actions[bot]" "$MARK"; }

run() { # [INPUT_REF] [INPUT_BASE_BRANCH] -> d_out d_rc
  : > "$tmp/gh.log"
  d_rc=0
  d_out="$(env PATH="$tmp/bin:$PATH" GH_LOG="$tmp/gh.log" FIX="$FIX" UPSTREAM_SHA="$UP" BRANCH_TIP="$BRANCH_TIP" \
    GITHUB_REPOSITORY=balakumardev/orca GITHUB_RUN_NUMBER=7 INPUT_REF="${1:-v1.4.258}" INPUT_BASE_BRANCH="${2:-custom}" \
    bash "$scripts/detect-release.sh" 2>&1)" || d_rc=$?
}
out_of() { local v; v="$(sed -n "s/^OUTPUT $1=//p" <<<"$d_out")"; printf '%s' "${v%%$'\n'*}"; }
expect_stop() { # NAME REASON_SUBSTRING: proceeds=false, the reason says it, and no replacement is announced
  if [ "$d_rc" = 0 ] && [ "$(out_of proceed)" = false ] && grep -qF -- "$2" <<<"$(out_of reason)" && [ -z "$(out_of replace_pr)" ]; then ok "$1"
  else bad "$1: rc=$d_rc proceed=[$(out_of proceed)] reason=[$(out_of reason)] replace_pr=[$(out_of replace_pr)]"; fi
}
expect_replace() { # NAME NUMBER
  if [ "$d_rc" = 0 ] && [ "$(out_of proceed)" = true ] && [ "$(out_of replace_pr)" = "$2" ] && [ "$(out_of replace_head)" = "$HEAD" ] \
     && [ "$(out_of orphan_branch)" = true ] && [ "$(out_of orphan_sha)" = "$BRANCH_TIP" ] && [ "$(out_of branch)" = sync/v1.4.258 ] && [ "$(out_of is_test)" = false ]; then ok "$1"
  else bad "$1: rc=$d_rc out=[$d_out]"; fi
}
reads_only() { # detect only reads: no close, comment, delete or push
  if grep -qE 'pr (close|comment|edit|ready)|-X (DELETE|POST|PATCH)|--method' "$tmp/gh.log"; then bad "$1: detect wrote something: $(cat "$tmp/gh.log")"; else ok "$1"; fi
}

# ---- no PR at all -----------------------------------------------------------------------------------------------------------
reset
run
if [ "$d_rc" = 0 ] && [ "$(out_of proceed)" = true ] && [ -z "$(out_of replace_pr)" ] && [ "$(out_of orphan_branch)" = false ] && [ -z "$(out_of orphan_sha)" ] && [ "$(out_of branch)" = sync/v1.4.258 ]; then ok "no PR for the tag: sync it, nothing to replace, no orphan branch (orphan_sha empty)"; else bad "no PR: rc=$d_rc out=[$d_out]"; fi

# ---- an open PR that is current stops ---------------------------------------------------------------------------------------
reset; pristine; pr OPEN 43; commit "$HEAD" "$TIP,$LINK" "$BOT" "$BOT" "$MSG_HEAD"
run
expect_stop "an open PR whose first parent is the tip of custom is current: the search stops" "PR #43 (OPEN) already exists for sync/v1.4.258"
if grep -qF "has not moved" <<<"$(out_of reason)"; then ok "the reason says custom has not moved"; else bad "reason: $(out_of reason)"; fi

# ---- a stale PR that nobody touched is replaced ----------------------------------------------------------------------------
reset; pristine; pr OPEN 43; : > "$FIX/branch-exists"
run
expect_replace "a stale open PR with only automation commits is replaced (replace_pr, replace_head, orphan_branch true), although the PR also lists upstream's people" 43
reads_only "detect makes no write call for the replacement (open-pr does it)"
if grep -qF "replacing stale PR #43" <<<"$(out_of reason)"; then ok "the reason names the PR being replaced"; else bad "reason: $(out_of reason)"; fi

# ---- every safety guard has its own case ------------------------------------------------------------------------------------
reset; pristine; pr OPEN 43
commit "$HEAD" "$P0,$LINK" "$HUMAN" "$HUMAN" $'Merge remote-tracking branch \'origin/custom\' into sync/v1.4.258\n'
run; expect_stop "a head commit made by a person (a hand-pushed fix or merge) leaves the PR alone" "not the merge commit this automation made"
if grep -qF "left alone" <<<"$(out_of reason)"; then ok "and says it was left alone"; else bad "reason: $(out_of reason)"; fi
reset; pristine; pr OPEN 43; commit "$HEAD" "$P0,$LINK" "$HUMAN" "$BOT" "$MSG_HEAD"
run; expect_stop "the head's AUTHOR is a person while the committer is the bot: left alone" "left alone"
reset; pristine; pr OPEN 43; commit "$HEAD" "$P0,$LINK" "$BOT" "noreply@github.com" "$MSG_HEAD"
run; expect_stop "the head's COMMITTER is not the bot (the web 'Update branch' button): left alone" "left alone"
reset; pristine; pr OPEN 43; commit "$HEAD" "$P0,$LINK" "$BOT" "$BOT" "${MSG_HEAD//Orca-Custom-Patch: upstream-sync/}"
run; expect_stop "a head without the Orca-Custom-Patch trailer: left alone" "left alone"
reset; pristine; pr OPEN 43; commit "$HEAD" "$P0,$LINK" "$BOT" "$BOT" "${MSG_HEAD//$UP/9999999999999999999999999999999999999999}"
run; expect_stop "a head that merged a different upstream commit: left alone" "left alone"
reset; pristine; pr OPEN 43; commit "$HEAD" "$P0" "$BOT" "$BOT" "$MSG_HEAD"
run; expect_stop "a head with one parent: left alone" "left alone"
reset; pristine; pr OPEN 43; commit "$HEAD" "$P0,$LINK,$OLD" "$BOT" "$BOT" "$MSG_HEAD"
run; expect_stop "a head with three parents (an octopus someone made): left alone" "left alone"
reset; pristine; pr OPEN 43; commit "$LINK" "$UP" "$BOT" "$BOT" "$MSG_LINK"
run; expect_stop "a link commit with one parent: left alone" "second parent"
reset; pristine; pr OPEN 43; commit "$HEAD" "$P0,$LINK" "$BOT" "$BOT" "${MSG_HEAD/Merge upstream v1.4.258 into custom/Some other subject}"
run; expect_stop "a head whose subject is not 'Merge upstream ...': left alone" "left alone"
reset; pristine; pr OPEN 43; commit "$LINK" "$UP,$OLD" "$BOT" "$BOT" "Some other subject"
run; expect_stop "a link commit whose subject is not 'Link upstream ...': left alone" "second parent"
reset; pristine; pr OPEN 43; commit "$LINK" "$OLD,$UP" "$BOT" "$BOT" "$MSG_LINK"
run; expect_stop "a link commit whose first parent is not the upstream commit: left alone" "second parent"
reset; pristine; pr OPEN 43; commit "$LINK" "$UP,$OLD" "$HUMAN" "$HUMAN" "$MSG_LINK"
run; expect_stop "a link commit made by a person: left alone" "second parent"
reset; pristine; pr OPEN 43 balakumardev
run; expect_stop "a PR a person opened is left alone" "not opened by the automation"
reset; pristine; pr OPEN 43 app/github-actions custom false "$HEAD" true
run; expect_stop "a DRAFT PR (gates failed, '[needs manual merge]', or a person working on it) is left alone, and the reason says it is a draft" "it is a draft"
reset; pristine; pr OPEN 43 app/github-actions custom false "$HEAD" true; commit "$HEAD" "$TIP,$LINK" "$BOT" "$BOT" "$MSG_HEAD"
run; expect_stop "a draft whose custom has not moved says draft too (never 'replace')" "it is a draft"
reset; pristine; pr OPEN 43; jq 'map(del(.isDraft))' "$FIX/prs-all.json" > "$FIX/p.tmp" && mv "$FIX/p.tmp" "$FIX/prs-all.json"
run; expect_stop "a PR that does not say whether it is a draft is treated as one" "it is a draft"
reset; pristine; pr OPEN 43; : > "$FIX/branch-exists"
run; expect_replace "the same stale PR, ready (not a draft), is replaced" 43
# A fork's PR that happens to use the branch name `sync/<tag>` comes back from `gh pr list --head` too. It is not our PR and does not
# hold our branch, so it must neither stop the search nor count as a second open PR or an attempt.
reset; pristine; pr OPEN 43 app/github-actions custom true
run
if [ "$d_rc" = 0 ] && [ "$(out_of proceed)" = true ] && [ -z "$(out_of replace_pr)" ] && [ "$(out_of orphan_branch)" = false ]; then ok "an open PR from a FORK with the same branch name is ignored: the tag is synced, nothing replaced"; else bad "fork open: rc=$d_rc out=[$d_out]"; fi
reset; pristine; pr MERGED 40 balakumardev custom true
run
if [ "$d_rc" = 0 ] && [ "$(out_of proceed)" = true ]; then ok "a MERGED PR from a fork with the same branch name does not say custom/BASE moved on"; else bad "fork merged: rc=$d_rc out=[$d_out]"; fi
reset; pristine; pr CLOSED 41 balakumardev custom true; comments 41 balakumardev "no thanks"
run
if [ "$d_rc" = 0 ] && [ "$(out_of proceed)" = true ]; then ok "a CLOSED PR from a fork (a stranger's 'no') does not stop the search"; else bad "fork closed: rc=$d_rc out=[$d_out]"; fi
reset; pristine; pr OPEN 43; pr OPEN 44 balakumardev custom true; : > "$FIX/branch-exists"
run; expect_replace "our stale PR next to a fork's PR of the same branch name: ours is replaced (the fork's is not a second open PR)" 43
reset; pristine; closed_by_us 41; closed_by_us 42; closed_by_us 45; pr OPEN 43; pr CLOSED 47 balakumardev custom true; : > "$FIX/branch-exists"
run; expect_stop "a fork's closed PR is not an automation closure either: the cap counts only our own three" "cap 3"
reset; pristine; pr OPEN 43 app/github-actions main
run; expect_stop "a PR against another base is left alone" "base is main"
reset; pristine; pr OPEN 43; echo '{"status":"diverged"}' > "$FIX/compare.json"
run; expect_stop "a first parent that is not an ancestor of custom (compare says diverged) is left alone" "compare says 'diverged'"
reset; pristine; pr OPEN 43; echo '{"status":"behind"}' > "$FIX/compare.json"
run; expect_stop "compare says behind: left alone" "compare says 'behind'"
reset; pristine; pr OPEN 43; : > "$FIX/compare-fails"
run; expect_stop "a compare that fails is not a licence to close: left alone" "compare says 'unreadable'"
reset; pristine; pr OPEN 43; rm "$FIX/commit-$HEAD.json"
run; if [ "$d_rc" != 0 ] || [ "$(out_of proceed)" = false ]; then
  if [ -z "$(out_of replace_pr)" ]; then ok "an unreadable head commit never produces a replacement"; else bad "unreadable head: replace_pr=$(out_of replace_pr)"; fi
else bad "unreadable head: $d_out"; fi
reset; pristine; pr OPEN 43; pr OPEN 44
run; expect_stop "two open PRs for the branch are left for a person" "2 open PRs"

# ---- merged and closed PRs --------------------------------------------------------------------------------------------------
reset; pristine; pr MERGED 40
run; expect_stop "a merged PR stops the search" "PR #40 (MERGED) already exists"
reset; pristine; pr CLOSED 41; comments 41 "balakumardev" "no thanks"
run; expect_stop "a PR a person closed is a 'no': never replaced" "a person closed it"
reset; pristine; pr CLOSED 41; comments 41 "balakumardev" "$MARK"
run; expect_stop "the superseded marker written by a person does not count as the automation's" "a person closed it"
reset; pristine; pr CLOSED 41; comments 41 "github-actions[bot]" "$MARK" "balakumardev" "wait, I wanted this one"
run; expect_stop "a person's comment after the marker means a person is involved: stop" "a person closed it"
reset; pristine; pr CLOSED 41; run
expect_stop "a closed PR with no comment at all is a person's: stop" "a person closed it"
reset; pristine; closed_by_us 41; pr OPEN 43; : > "$FIX/branch-exists"
run; expect_replace "one earlier PR closed by the automation does not stop a stale open PR from being replaced" 43
reset; closed_by_us 41; : > "$FIX/branch-exists"
run
if [ "$d_rc" = 0 ] && [ "$(out_of proceed)" = true ] && [ -z "$(out_of replace_pr)" ] && [ "$(out_of orphan_branch)" = true ] && [ "$(out_of orphan_sha)" = "$BRANCH_TIP" ]; then ok "a PR closed by the automation and nothing open: sync again (the branch it left is an orphan, orphan_sha is the commit it holds)"; else bad "closed, none open: $d_out"; fi
reset; pristine; closed_by_us 41; closed_by_us 42; pr OPEN 43; : > "$FIX/branch-exists"
run; expect_replace "two earlier replacements: a third is still allowed (the cap is 3 closed)" 43
reset; pristine; closed_by_us 41; closed_by_us 42; closed_by_us 45; pr OPEN 43
run; expect_stop "three PRs already closed as superseded: the stale open PR is left for a person" "cap 3"
reset; closed_by_us 41; closed_by_us 42; closed_by_us 45
run; expect_stop "three PRs already closed as superseded and none open: do not sync again by itself" "cap 3"
reset; pristine; closed_by_us 41; closed_by_us 42; closed_by_us 45; pr CLOSED 46; comments 46 "balakumardev" "closing"
run; expect_stop "one closure by a person among the automation's: stop" "PR #46 (CLOSED)"

# ---- older sync PRs are still listed for open-pr.sh to retire --------------------------------------------------------------
reset; pristine; pr OPEN 43; : > "$FIX/branch-exists"
jq -n '[{number: 30, headRefName: "sync/v1.0.1", author: {login: "app/github-actions"}, isCrossRepository: false},
        {number: 31, headRefName: "sync/v1.0.2", author: {login: "balakumardev"}, isCrossRepository: false},
        {number: 43, headRefName: "sync/v1.4.258", author: {login: "app/github-actions"}, isCrossRepository: false}]' > "$FIX/prs-open.json"
run
if [ "$(out_of supersede)" = "[30]" ] && [ "$(out_of replace_pr)" = 43 ]; then ok "older tags' PRs by the automation are still listed for retiring; the replaced PR and a person's PR are not"; else bad "supersede=[$(out_of supersede)] out=[$d_out]"; fi

# ---- a rehearsal is untouched ----------------------------------------------------------------------------------------------
reset; pristine; pr OPEN 43; : > "$FIX/branch-exists"
run v1.4.258 test/rehearsal-base
if [ "$d_rc" = 0 ] && [ "$(out_of proceed)" = true ] && [ "$(out_of is_test)" = true ] && [ -z "$(out_of replace_pr)" ] && [ "$(out_of supersede)" = "[]" ] && ! grep -q '^pr ' "$tmp/gh.log"; then
  ok "a rehearsal (throwaway base branch) makes no pull-request lookup and replaces nothing"
else bad "rehearsal: rc=$d_rc out=[$d_out] log=[$(cat "$tmp/gh.log")]"; fi
reset; pristine; pr OPEN 43
run "$UP"
if [ "$d_rc" = 0 ] && [ "$(out_of is_test)" = true ] && [ -z "$(out_of replace_pr)" ] && ! grep -q '^pr ' "$tmp/gh.log"; then ok "a bare sha as ref is a rehearsal: no pull-request lookup, nothing replaced"; else bad "sha rehearsal: $d_out"; fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
