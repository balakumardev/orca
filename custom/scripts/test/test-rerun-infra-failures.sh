#!/usr/bin/env bash
# Test for rerun-infra-failures.sh with a stub `gh` (no network, no token).
# Run: bash custom/scripts/test/test-rerun-infra-failures.sh      (needs bash and jq)
# SCRIPTS_DIR=<dir> points it at another copy of the scripts.
#
# The stub serves the run list, the jobs of a run and the check-run annotations of a job from fixture files (the script's own `--jq`
# filters run through real jq) and records `gh run rerun`. Each case builds ONE run and asks whether it was re-run. What it proves:
# the evidence case (a pull-request gate run whose e2e job was "not acquired" and whose derived `result` job failed) is re-run; every
# infrastructure annotation of the list triggers it; a real failure anywhere, a timeout cancellation, a human cancellation, a run
# cancelled by a newer run, an unreadable annotation, a fork's run, a run of another workflow (custom-release.yml among them), a
# run older than 6 hours or in its 4th attempt, and (custom-sync only) an infrastructure fault in a job whose re-run would also
# re-run paid agent rounds are NOT re-run; a job cancelled because a sibling failed does not block; a dry run sends nothing.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="${SCRIPTS_DIR:-$(cd "$here/.." && pwd)}"
command -v jq >/dev/null 2>&1 || { echo "missing tool: jq"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY DRY_RUN LOOKBACK_HOURS MAX_ATTEMPTS NOW_EPOCH

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

NOW="$(jq -nr '"2026-11-20T12:00:00Z" | fromdateiso8601')"
PRG=".github/workflows/custom-pr-gates.yml"
SYNC=".github/workflows/custom-sync.yml"
REL=".github/workflows/custom-release.yml"
NOT_ACQUIRED="The job was not acquired by Runner of type hosted even after multiple attempts"
EXIT1="Process completed with exit code 1."

mkdir "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
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
if [ "$1" = run ] && [ "$2" = rerun ]; then
  [ ! -f "$FIX/rerun-fails" ] || { echo "HTTP 403" >&2; exit 1; }
  echo "RERUN $3 $*" >> "$GH_LOG"; exit 0
fi
[ "$1" = api ] || { echo "stub gh: unexpected call: $*" >&2; exit 2; }
path="${2%%\?*}"
case "$path" in
  repos/*/actions/runs) [ ! -f "$FIX/list-fails" ] || { echo "HTTP 500" >&2; exit 1; }; emit "$FIX/runs.json" ;;
  repos/*/actions/runs/*/jobs) emit "$FIX/jobs-$(basename "$(dirname "$path")").json" ;;
  repos/*/check-runs/*/annotations)
    id="$(basename "$(dirname "$path")")"
    [ ! -f "$FIX/ann-$id.unreadable" ] || { echo "HTTP 500" >&2; exit 1; }
    emit "$FIX/ann-$id.json" ;;
  repos/*/pulls/*) emit "$FIX/pull-$(basename "$path").json" ;;
  *) echo "stub gh: no route for: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmp/bin/gh"

# ---- fixture builders ---------------------------------------------------------------------------------------------------------
FIX="$tmp/fix"
reset() { rm -rf "$FIX"; mkdir -p "$FIX"; echo '{"workflow_runs":[]}' > "$FIX/runs.json"; JOBSEQ=1000; }
addrun() { # ID PATH CONCLUSION ATTEMPT AGE_HOURS [HEAD_REPO]. A pull-request gate run gets PR number == ID, head sha "sha-<ID>", and an open PR at that head.
  local prs='[]'
  case "$2" in "$PRG"*) prs="[{\"number\": $1}]"; echo "{\"state\":\"open\",\"head\":{\"sha\":\"sha-$1\"}}" > "$FIX/pull-$1.json" ;; esac
  jq --argjson id "$1" --arg p "$2" --arg c "$3" --argjson a "$4" --argjson age "$5" --arg hr "${6:-balakumardev/orca}" --argjson now "$NOW" --argjson prs "$prs" \
    '.workflow_runs += [{id: $id, name: ($p | sub(".*/"; "") | sub(".yml$"; "")), path: $p, conclusion: $c, run_attempt: $a, head_sha: ("sha-" + ($id | tostring)),
       pull_requests: $prs, updated_at: (($now - ($age * 3600)) | todate), head_repository: {full_name: $hr}}]' "$FIX/runs.json" > "$FIX/r.tmp" && mv "$FIX/r.tmp" "$FIX/runs.json"
  [ -f "$FIX/jobs-$1.json" ] || echo '{"jobs":[]}' > "$FIX/jobs-$1.json"
}
addjob() { # RUN_ID NAME CONCLUSION [ANNOTATION|UNREADABLE]
  JOBSEQ=$((JOBSEQ + 1))
  jq --argjson id "$JOBSEQ" --arg n "$2" --arg c "$3" '.jobs += [{id: $id, name: $n, conclusion: $c}]' "$FIX/jobs-$1.json" > "$FIX/j.tmp" && mv "$FIX/j.tmp" "$FIX/jobs-$1.json"
  case "${4:-}" in
    UNREADABLE) : > "$FIX/ann-$JOBSEQ.unreadable" ;;
    '') echo '[]' > "$FIX/ann-$JOBSEQ.json" ;;
    *) jq -n --arg m "$4" '[{title: "", message: $m}]' > "$FIX/ann-$JOBSEQ.json" ;;
  esac
}
go() { # env assignments... -> g_out g_rc
  : > "$tmp/gh.log"
  g_rc=0
  g_out="$(env PATH="$tmp/bin:$PATH" GH_LOG="$tmp/gh.log" FIX="$FIX" GH_TOKEN=dummy REPO=balakumardev/orca NOW_EPOCH="$NOW" "$@" \
    bash "$scripts/rerun-infra-failures.sh" 2>&1)" || g_rc=$?
}
reran() { grep -q "^RERUN $1 run rerun $1 --repo balakumardev/orca --failed\$" "$tmp/gh.log"; }
no_rerun() { ! grep -q '^RERUN ' "$tmp/gh.log"; }
expect_rerun() { if [ "$g_rc" = 0 ] && reran "$2"; then ok "$1"; else bad "$1: rc=$g_rc out=[$g_out] log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi; }
expect_none() { # NAME [REASON_SUBSTRING]
  if [ "$g_rc" = 0 ] && no_rerun && { [ -z "${2:-}" ] || grep -qF -- "$2" <<<"$g_out"; }; then ok "$1"; else bad "$1: rc=$g_rc out=[$g_out] log=[$(tr '\n' ';' < "$tmp/gh.log")]"; fi
}

# ---- the evidence: a pull-request gate run whose macOS e2e job was never acquired -------------------------------------------
reset; addrun 1 "$PRG" failure 1 1
addjob 1 "gates / static" success; addjob 1 "gates / e2e" cancelled "$NOT_ACQUIRED"; addjob 1 "gates / result" failure "$EXIT1"
go; expect_rerun "pr-gates: e2e 'not acquired' (cancelled) with the derived result job failed: the failed jobs are re-run" 1
if grep -q 'filter=latest' "$tmp/gh.log"; then ok "the jobs are listed with filter=latest (the newest attempt only)"; else bad "jobs call: $(grep jobs "$tmp/gh.log")"; fi

# ---- every infrastructure annotation ----------------------------------------------------------------------------------------
i=10
for text in "$NOT_ACQUIRED" "The hosted runner lost communication with the server. Anything in your workflow that terminates the runner process" \
  "The runner has received a shutdown signal. This can happen when the runner service is stopped" \
  "Received request to deprovision: The runner has received a shutdown signal" "The self-hosted runner: mac-1 stopped responding" \
  "The host sent a message and the process received a shutdown signal" "The runner has received a shutdown notice" \
  "THE JOB WAS NOT ACQUIRED BY RUNNER OF TYPE HOSTED"; do
  i=$((i + 1)); reset; addrun "$i" "$PRG" failure 1 1; addjob "$i" "gates / static" success; addjob "$i" "gates / e2e" failure "$text"
  go; expect_rerun "annotation '${text:0:60}...' is an infrastructure fault" "$i"
done
reset; addrun 2 "$PRG" failure 1 1; addjob 2 "gates / e2e" failure "Error: the e2e specs failed"; addjob 2 "gates / result" failure "$EXIT1"
go; expect_none "an ordinary failure (no infrastructure annotation anywhere) is not re-run" "not an infrastructure fault: gates / e2e"

# ---- a real failure anywhere stops it ---------------------------------------------------------------------------------------
reset; addrun 3 "$PRG" failure 1 1
addjob 3 "gates / static" failure "$EXIT1"; addjob 3 "gates / e2e" cancelled "$NOT_ACQUIRED"; addjob 3 "gates / result" failure "$EXIT1"
go; expect_none "a real failure (static) next to an infrastructure fault (e2e): not re-run" "gates / static"
reset; addrun 3 "$PRG" failure 1 1
addjob 3 "gates / static" cancelled "The job running on runner GitHub Actions 5 has exceeded the maximum execution time of 45 minutes."; addjob 3 "gates / e2e" cancelled "$NOT_ACQUIRED"
go; expect_none "a job cancelled for exceeding timeout-minutes is a real failure, not neutral" "gates / static"
reset; addrun 3 "$PRG" failure 1 1; addjob 3 "gates / static" failure "$EXIT1"; addjob 3 "gates / e2e" failure "$NOT_ACQUIRED"; addjob 3 "gates / extra" failure
go; expect_none "a failed job with no annotation at all is a real failure" "gates / extra"

# ---- a job cancelled because a sibling failed is neutral --------------------------------------------------------------------
reset; addrun 4 "$PRG" failure 1 1; addjob 4 "gates / static" cancelled "The operation was canceled."; addjob 4 "gates / e2e" cancelled "$NOT_ACQUIRED"
go; expect_rerun "a job cancelled with 'The operation was canceled.' does not block the infrastructure re-run" 4
reset; addrun 4 "$PRG" failure 1 1; addjob 4 "gates / static" cancelled; addjob 4 "gates / e2e" cancelled "$NOT_ACQUIRED"
go; expect_rerun "a cancelled job with no annotation does not block either" 4
reset; addrun 5 "$PRG" cancelled 1 1; addjob 5 "gates / static" cancelled "The run was canceled by @someone."; addjob 5 "gates / e2e" cancelled "The operation was canceled."
go; expect_none "a run a person cancelled (no infrastructure annotation) is not re-run" "no failed job carries"
reset; addrun 6 "$PRG" cancelled 1 1; addjob 6 "gates / e2e" cancelled "$NOT_ACQUIRED"; addjob 6 "gates / static" cancelled "Canceling since a higher priority waiting request for 'custom-pr-gates-5' exists"
go; expect_none "a run cancelled by a newer run of its concurrency group is not re-run" "newer run"
reset; addrun 7 "$PRG" failure 1 1; addjob 7 "gates / e2e" cancelled "$NOT_ACQUIRED"; addjob 7 "gates / static" cancelled UNREADABLE
go; expect_none "an annotation that cannot be read counts as a real failure" "unreadable"
reset; addrun 7 "$PRG" failure 1 1; addjob 7 "gates / e2e" cancelled UNREADABLE; addjob 7 "gates / static" success
go; expect_none "an infrastructure job whose annotations cannot be read is not guessed at" "unreadable"
reset; addrun 8 "$PRG" failure 1 1; addjob 8 "gates / static" success; addjob 8 "gates / e2e" success; addjob 8 "gates / result" failure "$EXIT1"
go; expect_none "only the derived result job failed: nothing to re-run, nothing blamed on the runner" "no failed job carries"

# ---- attempts and age -------------------------------------------------------------------------------------------------------
reset; addrun 20 "$PRG" failure 3 1; addjob 20 "gates / e2e" cancelled "$NOT_ACQUIRED"
go; expect_rerun "attempt 3 is still re-run (a 4th attempt is allowed)" 20
reset; addrun 21 "$PRG" failure 4 1; addjob 21 "gates / e2e" cancelled "$NOT_ACQUIRED"
go; expect_none "attempt 4 is not re-run: a persistent outage ends"
reset; addrun 22 "$PRG" failure 1 5; addjob 22 "gates / e2e" cancelled "$NOT_ACQUIRED"
go; expect_rerun "a run that finished 5 hours ago is re-run" 22
reset; addrun 23 "$PRG" failure 1 7; addjob 23 "gates / e2e" cancelled "$NOT_ACQUIRED"
go; expect_none "a run that finished 7 hours ago is left alone"
reset; addrun 24 "$PRG" success 1 1; addjob 24 "gates / e2e" success
go; expect_none "a successful run is not a candidate"

# ---- which runs are ours ----------------------------------------------------------------------------------------------------
reset; addrun 30 "$REL" failure 1 1; addjob 30 build failure "$NOT_ACQUIRED"; addjob 30 publish skipped
go; expect_none "custom-release.yml is never re-run, even when its build job was not acquired"
reset; addrun 31 ".github/workflows/custom-rerun-infra.yml" failure 1 1; addjob 31 rerun failure "$NOT_ACQUIRED"
go; expect_none "the re-run workflow does not re-run itself"
reset; addrun 32 ".github/workflows/other.yml" failure 1 1; addjob 32 x failure "$NOT_ACQUIRED"
go; expect_none "a workflow that is not ours is ignored"
reset; addrun 33 "$PRG" failure 1 1 "someone-else/orca"; addjob 33 "gates / e2e" cancelled "$NOT_ACQUIRED"
go; expect_none "a run of a fork's pull request is not ours to re-run"
reset; addrun 34 "$PRG@refs/pull/12/merge" failure 1 1; addjob 34 "gates / e2e" cancelled "$NOT_ACQUIRED"
go; expect_rerun "a run path with an @ref suffix is still recognised" 34

# ---- a re-run joins the PR's concurrency group (cancel-in-progress: true) -------------------------------------------------------
reset; addrun 60 "$PRG" failure 1 1; addjob 60 "gates / e2e" cancelled "$NOT_ACQUIRED"; echo '{"state":"open","head":{"sha":"sha-newer"}}' > "$FIX/pull-60.json"
go; expect_none "pr-gates: the PR has a newer head (its newer run would be cancelled by a re-run of this one): nothing is re-run" "newer head"
reset; addrun 61 "$PRG" failure 1 1; addjob 61 "gates / e2e" cancelled "$NOT_ACQUIRED"; echo '{"state":"closed","head":{"sha":"sha-61"}}' > "$FIX/pull-61.json"
go; expect_none "pr-gates: the PR is closed or merged: nothing is re-run" "no longer open"
reset; addrun 62 "$PRG" failure 1 1; addjob 62 "gates / e2e" cancelled "$NOT_ACQUIRED"; jq '.workflow_runs[0].pull_requests = []' "$FIX/runs.json" > "$FIX/r.tmp" && mv "$FIX/r.tmp" "$FIX/runs.json"
go; expect_none "pr-gates: a run with no pull request attached is skipped" "no pull request is attached"
reset; addrun 63 "$PRG" failure 1 1; addjob 63 "gates / e2e" cancelled "$NOT_ACQUIRED"; rm "$FIX/pull-63.json"
go; expect_none "pr-gates: a pull request that cannot be read is not guessed at" "could not read PR #63"

# ---- custom-sync: only the jobs whose re-run is coherent --------------------------------------------------------------------
for name in "detect" "merge" "gates (round 0) / e2e" "gates (round 3) / e2e" "open-pr" "land"; do
  reset; addrun 40 "$SYNC" failure 1 1; addjob 40 "$name" failure "$NOT_ACQUIRED"
  go; expect_rerun "custom-sync: an infrastructure fault in '$name' is re-run" 40
done
for name in "agent (round 1, flash) / agent" "agent (round 3, pro) / agent" "gates (round 1) / e2e" "gates (round 2) / static" "pick the base of round 3"; do
  reset; addrun 41 "$SYNC" failure 1 1; addjob 41 "$name" failure "$NOT_ACQUIRED"
  go; expect_none "custom-sync: an infrastructure fault in '$name' is left for a person (paid or candidate-changing dependents)" "left for a person"
done
reset; addrun 42 "$SYNC" failure 1 1; addjob 42 "gates (round 0) / e2e" failure "$NOT_ACQUIRED"; addjob 42 "open-pr" failure "$EXIT1"
go; expect_none "custom-sync: a real failure in open-pr next to an infrastructure fault: not re-run" "open-pr"

# ---- dry run, errors ----------------------------------------------------------------------------------------------------------
reset; addrun 50 "$PRG" failure 1 1; addjob 50 "gates / e2e" cancelled "$NOT_ACQUIRED"
go DRY_RUN=true
if [ "$g_rc" = 0 ] && no_rerun && grep -qF "would re-run" <<<"$g_out"; then ok "dry run: decides and says so, sends nothing"; else bad "dry run: rc=$g_rc out=[$g_out]"; fi
reset; addrun 51 "$PRG" failure 1 1; addjob 51 "gates / e2e" cancelled "$NOT_ACQUIRED"; : > "$FIX/rerun-fails"
go
if [ "$g_rc" = 0 ] && grep -qF "could not re-run" <<<"$g_out"; then ok "a refused re-run is a warning, not a failure of the job"; else bad "refused rerun: rc=$g_rc out=[$g_out]"; fi
reset; : > "$FIX/list-fails"
go
if [ "$g_rc" != 0 ] && grep -qF "could not list" <<<"$g_out"; then ok "a run list that cannot be read fails the job (visible, not silent)"; else bad "list failure: rc=$g_rc out=[$g_out]"; fi
reset; addrun 52 "$PRG" failure 1 1; addjob 52 "gates / e2e" cancelled "$NOT_ACQUIRED"; addrun 53 "$SYNC" failure 1 1; addjob 53 "land" failure "$NOT_ACQUIRED"
go
if [ "$g_rc" = 0 ] && reran 52 && reran 53; then ok "several candidate runs are each judged and re-run"; else bad "two runs: $(tr '\n' ';' < "$tmp/gh.log")"; fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
