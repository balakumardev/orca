#!/usr/bin/env bash
# Test for land-sync-pr.sh with a stub `gh` (no network, no token, no git).
# Run: bash custom/scripts/test/test-land-sync-pr.sh      (needs bash and jq)
#
# What it proves: a rehearsal-shaped run makes ZERO gh calls; a run with any red or missing gate, a draft PR, a moved custom tip
# or a refused merge never merges and never dispatches; the happy path posts the check-run, merges with a merge commit pinned to the
# head sha, and dispatches the release exactly once with the three inputs, in that order; a re-run does not release twice.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
command -v jq >/dev/null 2>&1 || { echo "missing tool: jq"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

BASE="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
HEAD="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
MERGED="cccccccccccccccccccccccccccccccccccccccc"
OTHER="dddddddddddddddddddddddddddddddddddddddd"

mkdir "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Stub gh. Every call is logged on one line. Scenario knobs come from the environment; `merged` and `dispatches` are state files.
echo "$*" >> "$GH_LOG"
S="$STATE"
case "$1 $2" in
  "api repos/o/r/git/ref/heads/custom")
    if [ -f "$S/merged" ]; then sha="${TIP_AFTER:-$MERGED}"; else sha="${TIP_BEFORE:-$BASE}"; fi
    printf '{"object":{"sha":"%s"}}\n' "$sha" ;;
  "api repos/o/r/check-runs") cat > "$S/checkrun.json"; echo '{"id":1}' ;;
  "api repos/o/r/git/commits/$MERGED") printf '{"parents":[{"sha":"%s"},{"sha":"%s"}]}\n' "${PARENT1:-$BASE}" "${PARENT2:-$HEAD}" ;;
  "api repos/o/r/actions/workflows/custom-release.yml/runs"*)
    n="${RUNS_BEFORE:-0}"
    if [ -f "$S/dispatches" ] && [ "${DISPATCH_FAILS_BUT_STARTS:-0}" = 1 ]; then n=1; fi
    printf '{"total_count":%s}\n' "$n" ;;
  "pr view")
    if [ -f "$S/merged" ]; then state=MERGED; mc="{\"oid\":\"$MERGED\"}"; else state=OPEN; mc=null; fi
    [ "${MERGE_LIES:-0}" != 1 ] || { state=OPEN; mc=null; }
    printf '{"state":"%s","isDraft":false,"baseRefName":"custom","headRefName":"sync/v1.4.260","headRefOid":"%s","isCrossRepository":false,"mergeStateStatus":"%s","mergeCommit":%s}\n' \
      "$state" "${PR_HEAD:-$HEAD}" "${MERGE_STATE:-CLEAN}" "$mc" ;;
  "pr merge")
    if [ "${MERGE_FAILS:-0}" = 1 ]; then echo "Pull request is not mergeable: required status check is expected" >&2; exit 1; fi
    : > "$S/merged" ;;
  "pr comment") ;;
  "workflow run")
    echo x >> "$S/dispatches"
    # DISPATCH_FAIL_FIRST=N: the first N dispatch attempts exit 1.
    if [ "$(wc -l < "$S/dispatches" | tr -d ' ')" -le "${DISPATCH_FAIL_FIRST:-0}" ]; then echo "HTTP 502" >&2; exit 1; fi ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
STUB
chmod +x "$tmp/bin/gh"

# run NAME [VAR=value ...]: a happy-path environment with the given overrides. Sets l_rc l_out l_log (the gh call log).
n=0
run() {
  local name="$1"; shift
  n=$((n + 1))
  local d="$tmp/case-$n"
  mkdir -p "$d/state"
  : > "$d/gh.log"
  l_log="$d/gh.log"; l_dir="$d"
  l_rc=0
  l_out="$(env -i PATH="$tmp/bin:$PATH" HOME="$d" GH_LOG="$d/gh.log" STATE="$d/state" BASE="$BASE" HEAD="$HEAD" MERGED="$MERGED" \
    GH_TOKEN=x REPO=o/r PR_NUMBER=7 MERGE_SHA="$HEAD" BASE_SHA="$BASE" ROUND=2 BRANCH=sync/v1.4.260 BASE_BRANCH=custom \
    IS_TEST=false TAG_IS_RELEASE=true INPUT_REF= DRAFT=false \
    GATES_RESULT="0=skipped 1=success 2=success 3=skipped" GATES_FAILED="0= 1=3 2=0 3=" \
    RUN_URL=https://example.invalid/run/1 TAG=v1.4.260 GITHUB_EVENT_NAME=schedule GITHUB_REF=refs/heads/custom \
    GITHUB_STEP_SUMMARY="$d/summary.md" LAND_NAP=0 "$@" bash "$scripts/land-sync-pr.sh" 2>&1)" || l_rc=$?
  : "$name"
}
calls() { grep -c -- "$1" "$l_log" || true; }
no_writes() { [ "$(calls 'pr merge')" = 0 ] && [ "$(calls 'check-runs')" = 0 ] && [ "$(calls 'workflow run')" = 0 ]; }

# ---- the happy path --------------------------------------------------------------------------------------------------------
run happy
if [ "$l_rc" = 0 ]; then ok "a green sync run lands (exit 0)"; else bad "happy path: rc=$l_rc out=[$l_out]"; fi
if [ "$(calls 'pr merge')" = 1 ] && grep -q -x 'pr merge 7 --repo o/r --merge --match-head-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' "$l_log"; then
  ok "merged once with --merge pinned to the head sha"; else bad "merge call: $(grep 'pr merge' "$l_log" || echo none)"; fi
if ! grep -q -E -- '--(squash|rebase|admin|auto|delete-branch)' "$l_log"; then ok "no squash, rebase, admin, auto or delete-branch flag anywhere"; else bad "forbidden flag in: $(cat "$l_log")"; fi
if jq -e --arg h "$HEAD" '.name == "gates / result" and .head_sha == $h and .status == "completed" and .conclusion == "success" and (.output.summary | contains("round 2")) and (.output.summary | contains("example.invalid"))' "$l_dir/state/checkrun.json" >/dev/null; then
  ok "check-run 'gates / result' success on the head sha, with the real gate result and the run link"; else bad "check-run: $(cat "$l_dir/state/checkrun.json" 2>/dev/null || echo missing)"; fi
if [ "$(calls 'workflow run')" = 1 ] && grep -q -x 'workflow run custom-release.yml --repo o/r --ref custom -f sign=true -f notarize=true -f publish=true' "$l_log"; then
  ok "the release is requested exactly once, from custom, with sign, notarize and publish true"; else bad "dispatch: $(grep 'workflow run' "$l_log" || echo none)"; fi
order="$(grep -n -E 'check-runs|pr merge|workflow run' "$l_log" | sed -E 's/^[0-9]+:(api repos\/o\/r\/)?//; s/ .*//' | tr '\n' ' ')"
if [ "$order" = "check-runs pr workflow " ]; then ok "order: check-run, then merge, then dispatch"; else bad "order: [$order]"; fi
if grep -q 'merged' "$l_dir/summary.md" && grep -q 'Release requested' "$l_dir/summary.md"; then ok "the job summary says merged and release requested"; else bad "summary: $(cat "$l_dir/summary.md")"; fi

# ---- a rehearsal can never land: zero gh calls ----------------------------------------------------------------------------
rehearsal() { # NAME VAR=value ...
  local name="$1"; shift
  run "$name" "$@"
  if [ "$l_rc" != 0 ] && [ ! -s "$l_log" ] && grep -q 'refusing to land' <<<"$l_out"; then ok "rehearsal guard ($name): refused, zero gh calls"; else bad "rehearsal ($name): rc=$l_rc calls=[$(cat "$l_log")] out=[$l_out]"; fi
}
rehearsal "throwaway base branch" BASE_BRANCH=test/sync-base
rehearsal "is_test true" IS_TEST=true
rehearsal "ref given on a dispatch" GITHUB_EVENT_NAME=workflow_dispatch INPUT_REF=v1.4.259
rehearsal "run from a feature branch" GITHUB_REF=refs/heads/wip/auto-release
rehearsal "run from a tag" GITHUB_REF=refs/tags/v1.4.260
rehearsal "a push event" GITHUB_EVENT_NAME=push
rehearsal "not a release tag" TAG_IS_RELEASE=false
rehearsal "a sync-test branch" BRANCH=sync-test/test-main-abc1234-3
rehearsal "branch that is not a sync branch" BRANCH=wip/x
rehearsal "empty event" GITHUB_EVENT_NAME=
run "dispatch with an empty ref lands" GITHUB_EVENT_NAME=workflow_dispatch INPUT_REF=
if [ "$l_rc" = 0 ] && [ "$(calls 'workflow run')" = 1 ]; then ok "a dispatch with an EMPTY ref is a real run and lands"; else bad "empty-ref dispatch: rc=$l_rc out=[$l_out]"; fi

# ---- not landing: nothing merged, nothing dispatched ---------------------------------------------------------------------
declined() { # NAME VAR=value ...   expects exit 0, no merge, no check-run, no dispatch
  local name="$1"; shift
  run "$name" "$@"
  if [ "$l_rc" = 0 ] && no_writes; then ok "declined ($name): exit 0, no check-run, no merge, no dispatch"; else bad "declined ($name): rc=$l_rc calls=[$(cat "$l_log")] out=[$l_out]"; fi
}
declined "a gate failed" GATES_FAILED="0= 1=3 2=1 3="
declined "gate round empty failed output" GATES_FAILED="0= 1=3 2= 3="
declined "gate job did not succeed" GATES_RESULT="0=skipped 1=success 2=failure 3=skipped"
declined "gate job was skipped" GATES_RESULT="0=skipped 1=success 2=skipped 3=skipped"
declined "no gate values at all" GATES_RESULT= GATES_FAILED=
declined "failed output is not a number" GATES_FAILED="0= 1=3 2=none 3="
declined "round 0 red although round 2 is green" ROUND=0 GATES_RESULT="0=success 1=skipped 2=success 3=skipped" GATES_FAILED="0=2 1= 2=0 3="
declined "custom moved during the sync" TIP_BEFORE="$OTHER"
run "draft PR" DRAFT=true
if [ "$l_rc" = 0 ] && no_writes && [ "$(calls 'pr comment')" = 0 ]; then ok "a draft PR is left alone (exit 0, no calls)"; else bad "draft: rc=$l_rc calls=[$(cat "$l_log")]"; fi
run "green round 0 clean merge" ROUND=0 GATES_RESULT="0=success 1=skipped 2=skipped 3=skipped" GATES_FAILED="0=0 1= 2= 3="
if [ "$l_rc" = 0 ] && [ "$(calls 'pr merge')" = 1 ]; then ok "a clean round-0 merge with green gates lands too"; else bad "round 0: rc=$l_rc out=[$l_out]"; fi
if [ "$(calls 'pr comment')" -ge 1 ]; then ok "the landing leaves a PR comment"; else bad "no PR comment on a landing"; fi
run "red gates comment" GATES_FAILED="0= 1=3 2=1 3="
if grep -q 'pr comment 7' "$l_log" && grep -q 'did not all pass' "$l_dir/summary.md"; then ok "a declined run says why in the PR and in the job summary"; else bad "no reason posted: $(cat "$l_dir/summary.md")"; fi

# ---- errors: red job, never a dispatch --------------------------------------------------------------------------------------
failing() { # NAME VAR=value ...   expects non-zero and no dispatch
  local name="$1"; shift
  run "$name" "$@"
  if [ "$l_rc" != 0 ] && [ "$(calls 'workflow run')" = 0 ]; then ok "error ($name): job fails, no dispatch"; else bad "error ($name): rc=$l_rc calls=[$(cat "$l_log")] out=[$l_out]"; fi
}
failing "PR head is not the checked sha" PR_HEAD="$OTHER"
if [ "$(calls 'pr merge')" = 0 ] && [ "$(calls 'check-runs')" = 0 ]; then ok "  ...and nothing was merged or checked"; else bad "PR-head case wrote something: $(cat "$l_log")"; fi
failing "merge refused" MERGE_FAILS=1
if [ "$(calls 'check-runs')" = 1 ] && ! [ -f "$l_dir/state/merged" ]; then ok "  ...after the check-run, but nothing merged"; else bad "merge-refused state wrong: $(cat "$l_log")"; fi
failing "PR does not show as merged" MERGE_LIES=1
failing "merge commit has the wrong parents" PARENT1="$OTHER"
failing "custom moved after the merge" TIP_AFTER="$OTHER"
failing "merge state DIRTY" MERGE_STATE=DIRTY
failing "merge state BEHIND" MERGE_STATE=BEHIND

# ---- exactly once ----------------------------------------------------------------------------------------------------------
run "a re-run after the release was requested" RUNS_BEFORE=1
if [ "$l_rc" = 0 ] && [ "$(calls 'workflow run')" = 0 ]; then ok "a dispatched run for the merge commit already exists: no second dispatch"; else bad "re-run: rc=$l_rc calls=[$(cat "$l_log")]"; fi
run "first dispatch fails, run did start" DISPATCH_FAIL_FIRST=1 DISPATCH_FAILS_BUT_STARTS=1
if [ "$l_rc" = 0 ] && [ "$(calls 'workflow run')" = 1 ]; then ok "an ambiguous dispatch failure that started a run is not repeated"; else bad "ambiguous: rc=$l_rc dispatches=$(calls 'workflow run')"; fi
run "first dispatch fails, no run" DISPATCH_FAIL_FIRST=1
if [ "$l_rc" = 0 ] && [ "$(calls 'workflow run')" = 2 ]; then ok "a dispatch that failed and started nothing is retried once"; else bad "retry: rc=$l_rc dispatches=$(calls 'workflow run')"; fi
run "both dispatches fail" DISPATCH_FAIL_FIRST=5
if [ "$l_rc" != 0 ] && [ "$(calls 'workflow run')" = 2 ] && grep -q 'gh workflow run custom-release.yml' <<<"$l_out"; then ok "two failed dispatches: the job fails and names the command to run by hand"; else bad "both fail: rc=$l_rc dispatches=$(calls 'workflow run') out=[$l_out]"; fi

if [ "$fails" -gt 0 ]; then printf '\n%s test(s) failed\n' "$fails"; exit 1; fi
printf '\nall tests passed\n'
