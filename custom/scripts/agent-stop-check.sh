#!/usr/bin/env bash
# The Stop hook of a model round of the upstream sync: a SCRIPT, not a model, decides whether the agent may end its turn. When it tries to,
# this runs the cheap deterministic checks it is already allowed to run, in order, and refuses the stop with a short reason while one is red:
#   1 conflict-markers  no conflict marker and no misused DELETE-THIS-FILE in the files the round may edit (files.tsv)
#   2 lint-caps         the oxlint line caps of those files (lint-caps.mjs, the same estimate as the `lint-caps` gate)
#   3 typecheck         `pnpm tc` (skipped when the sandbox has no dependencies); only errors in files the round may edit block, because
#                       the model cannot fix the others and a round must not burn its turns on them
# It stops at the first red group and blocks with `{"decision":"block","reason":...}` on stdout (Claude Code feeds the reason back and the
# turn goes on); a green run prints nothing and allows the stop. A green stop check is NOT the gates: they still decide.
#
# Runs inside the sandbox as the sandbox user, in the sandbox copy of the tree, installed root-owned by `agent-sandbox.sh setup` together
# with lib.sh, gate-details.sh, lint-caps.mjs, files.tsv and hook.conf (all next to this file; the model cannot edit them). Claude Code runs it
# through the root-owned managed settings file (see agent-sandbox.sh: --settings hooks are switched off by --safe-mode, managed ones are not).
# No network call, no secret: the key stays with the runner user behind the proxy.
#
# Bounds, all enforced here, state in $STATE_DIR/state.json (sandbox-writable, never in the repo):
#   AGENT_STOP_MAX_BLOCKS      at most this many blocks per round (default 6, below the 8 consecutive blocks after which Claude Code itself
#                              overrides a hook)
#   AGENT_STOP_BUDGET_SECONDS  the total time all runs of this hook may use per round (default 1200)
#   AGENT_STOP_CHECK_TIMEOUT   the limit of one `pnpm tc` (default 600; cut to what is left of the budget)
# A group that fails with the very same output right after a block (the model tried and nothing changed) is waived: the next group runs and the
# stop is allowed at the end with the outcome `no-progress`. When a bound is reached the stop is allowed and ONE line in stop-hook.log says
# why. FAIL OPEN: any internal error (a missing tool, an unreadable file, a broken state file) allows the stop; this script always exits 0.
# Outcome words (state.json `outcome`, read by agent-round.sh run): green, block-cap, time-budget, check-timeout, no-progress, out-of-scope,
# hook-error, and `block` while the last decision was a block.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd -P)" # physical: lint-caps.mjs only runs when its own path has no symlink in it
DECIDED=0
STATE_DIR=""
STATE_FILE=""
S_JSON='{}'

# Every way out is exit 0: a block is the JSON on stdout, never an exit code (exit 2 would block too). An error before a decision is
# recorded as hook-error, best effort, and the stop is allowed.
on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ] && [ "$DECIDED" -eq 0 ] && [ -n "$STATE_FILE" ]; then
    { printf '{"calls":1,"blocks":0,"spent_s":0,"outcome":"hook-error","groups":[],"waived":[],"sigs":{}}\n' > "$STATE_FILE.tmp" && mv -f "$STATE_FILE.tmp" "$STATE_FILE" \
      && printf '%s allow (hook-error): the hook failed with exit %s\n' "$(date -u +%H:%M:%S)" "$rc" >> "$STATE_DIR/stop-hook.log"; } 2>/dev/null || true
  fi
  exit 0
}
trap on_exit EXIT

# shellcheck source=lib.sh
. "$HOOK_DIR/lib.sh"
# shellcheck source=gate-details.sh
. "$HOOK_DIR/gate-details.sh"

conf_get() { awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$HOOK_DIR/hook.conf"; }
num_or() { case "$1" in '' | *[!0-9]*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac; }
with_timeout() { # SECONDS CMD...
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout -k 10 "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout -k 10 "$secs" "$@"
  else "$@"; fi
}

STATE_DIR="$(conf_get STATE_DIR)"
[ -n "$STATE_DIR" ] && [ -d "$STATE_DIR" ] || exit 1
STATE_FILE="$STATE_DIR/state.json"
DEPS="$(conf_get DEPS)"
UPSTREAM="$(conf_get UPSTREAM)"
MAX_BLOCKS="$(num_or "${AGENT_STOP_MAX_BLOCKS:-}" 6)"
BUDGET="$(num_or "${AGENT_STOP_BUDGET_SECONDS:-}" 1200)"
CHECK_TIMEOUT="$(num_or "${AGENT_STOP_CHECK_TIMEOUT:-}" 600)"
FILES_TSV="$HOOK_DIR/files.tsv"

sj() { S_JSON="$(jq -c "$@" <<<"$S_JSON")"; }
save_state() { printf '%s\n' "$S_JSON" > "$STATE_FILE.tmp" && mv -f "$STATE_FILE.tmp" "$STATE_FILE"; }
note() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$1" >> "$STATE_DIR/stop-hook.log"; }

# upstream_has PATH: is PATH a file of the new release? Trees only, no blob fetch. Unknown counts as no.
upstream_has() {
  local out
  [ -n "$UPSTREAM" ] || return 1
  out="$(GIT_NO_LAZY_FETCH=1 git ls-tree "$UPSTREAM" -- "$1" 2>/dev/null)" || return 1
  case "$out" in *" blob "*) return 0 ;; esac
  return 1
}

# sentinel_legit KIND PATH: a file that holds only DELETE-THIS-FILE, and that sync-merge.sh finish will remove (0), or that it would NOT
# honour (1): a content conflict, or a file upstream has outside a modify/delete conflict.
sentinel_legit() {
  case "$1" in
    content | both-added) return 1 ;;
    owned | moved) if upstream_has "$2"; then return 1; fi ;;
  esac
  return 0
}

marker_hit() { # KIND PATH
  if grep -a -q -E '^(<<<<<<<|>>>>>>>|\|\|\|\|\|\|\|)( |$)' -- "$2"; then return 0; fi
  case "$1" in content | both-added) if grep -a -q -E '^=======[[:space:]]*$' -- "$2"; then return 0; fi ;; esac
  return 1
}

# A check sets CHECK to pass | fail | timeout | budget | oos (red, but only outside the files the round may edit) | skip, and for fail FAIL_TEXT.
CHECK=pass
FAIL_TEXT=""

check_conflict_markers() {
  local kind p bad="" n=0
  CHECK=pass; FAIL_TEXT=""
  while IFS="$(printf '\t')" read -r kind p; do
    [ -n "$p" ] && [ -f "$p" ] && [ ! -L "$p" ] || continue
    if is_delete_request "$p"; then
      if ! sentinel_legit "$kind" "$p"; then bad="$bad
- $p: holds only $DELETE_SENTINEL, but this file cannot be deleted (upstream still has it, or it is a content conflict): put the real resolved content back"; n=$((n + 1)); fi
    elif marker_hit "$kind" "$p"; then
      bad="$bad
- $p: still holds conflict marker lines (<<<<<<<, |||||||, ======= or >>>>>>>)"; n=$((n + 1))
    fi
    [ "$n" -lt 40 ] || break
  done < "$FILES_TSV"
  if [ -n "$bad" ]; then CHECK=fail; FAIL_TEXT="$(printf '%s\n' "$bad" | sed '/^$/d')"; fi
}

check_lint_caps() {
  local p kind json over
  CHECK=pass; FAIL_TEXT=""
  json="$(
    while IFS="$(printf '\t')" read -r kind p; do
      [ -n "$p" ] && [ -f "$p" ] && [ ! -L "$p" ] || continue
      if is_delete_request "$p"; then continue; fi
      printf '%s\0' "$p"
    done < "$FILES_TSV" | with_timeout 60 xargs -r -0 node "$HOOK_DIR/lint-caps.mjs" | jq -s -c 'map(.over) | add // []'
  )"
  over="$(jq -r '.[] | "- \(.path): \(.lines) lines, the cap is \(.cap)"' <<<"$json")"
  if [ -n "$over" ]; then CHECK=fail; FAIL_TEXT="$(printf '%s\n' "$over" | trunc_bytes 3000)"; fi
}

check_typecheck() {
  local log rc=0 limit remaining t0 files errs inscope="" f paths="$STATE_DIR/scope.txt" kind p
  CHECK=pass; FAIL_TEXT=""
  if [ "$DEPS" != 1 ]; then CHECK=skip; return 0; fi
  remaining=$((BUDGET - S_SPENT - ($(date +%s) - START)))
  if [ "$remaining" -lt 10 ]; then CHECK=budget; return 0; fi
  limit="$CHECK_TIMEOUT"; if [ "$remaining" -lt "$limit" ]; then limit="$remaining"; fi
  log="$(mktemp "$STATE_DIR/tc.XXXXXX")"
  t0="$(date +%s)"
  with_timeout "$limit" pnpm tc > "$log" 2>&1 < /dev/null || rc=$?
  if [ "$rc" -eq 0 ]; then rm -f "$log"; return 0; fi
  if { [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ] || [ "$rc" -eq 143 ]; } && [ $(($(date +%s) - t0)) -ge $((limit - 1)) ]; then
    rm -f "$log"; CHECK=timeout; FAIL_TEXT="typecheck"; return 0
  fi
  # The files the round may edit, minus the ones it is dropping with the delete marker (tsc complains about those).
  : > "$paths"
  while IFS="$(printf '\t')" read -r kind p; do
    [ -n "$p" ] || continue
    if [ -f "$p" ] && is_delete_request "$p"; then continue; fi
    printf '%s\n' "$p" >> "$paths"
  done < "$FILES_TSV"
  files="$(gate_details_clean < "$log" | perl -ne 'if (/^(?:\[[^\]]*\]\s*)?(.*?)\(\d+,\d+\): error TS\d+/) { print "$1\n" } elsif (/^(?:\[[^\]]*\]\s*)?(.*?):\d+:\d+ - error TS\d+/) { print "$1\n" }' | LC_ALL=C sort -u)"
  if [ -z "$files" ]; then
    rm -f "$log"; CHECK=oos; FAIL_TEXT="pnpm tc exited $rc without a TypeScript error line (a tool failure the model cannot fix)"; return 0
  fi
  while IFS= read -r f; do
    f="${f#./}"; f="${f#"$PWD"/}"
    [ -n "$f" ] || continue
    if grep -q -x -F -- "$f" "$paths" || grep -q -F -- "/$f" "$paths"; then inscope="$inscope $f"; fi
  done <<<"$files"
  if [ -z "$inscope" ]; then
    rm -f "$log"; CHECK=oos; FAIL_TEXT="pnpm tc is red, but only in files this round may not edit"; return 0
  fi
  errs="$(gate_details typecheck "$log" | trunc_bytes 3500)"
  rm -f "$log"
  CHECK=fail
  FAIL_TEXT="pnpm tc reports errors in files you may edit:$(printf '%s' "$inscope" | trunc_bytes 600)
$errs"
}

sig_of() { printf '%s' "$1" | cksum | tr -d ' ' ; }

START="$(date +%s)"
input="$(cat || true)"
cwd="$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null || true)"
if [ -n "$cwd" ] && [ -d "$cwd" ]; then cd "$cwd"; fi

if [ -s "$STATE_FILE" ]; then S_JSON="$(jq -c . "$STATE_FILE")"; fi
S_CALLS="$(jq -r '(.calls // 0) | if type == "number" then floor else 0 end' <<<"$S_JSON")"
S_BLOCKS="$(jq -r '(.blocks // 0) | if type == "number" then floor else 0 end' <<<"$S_JSON")"
S_SPENT="$(jq -r '(.spent_s // 0) | if type == "number" then floor else 0 end' <<<"$S_JSON")"
S_CALLS=$((S_CALLS + 1))
sj --argjson c "$S_CALLS" --argjson b "$S_BLOCKS" '.calls = $c | .blocks = $b | .groups = (.groups // []) | .waived = (.waived // []) | .sigs = (.sigs // {})'

finish_state() { # OUTCOME: the time this run took is added to the budget
  sj --arg o "$1" --argjson s $((S_SPENT + $(date +%s) - START)) '.outcome = $o | .spent_s = $s'
  save_state
}
allow() { # OUTCOME WHY
  finish_state "$1"
  note "allow ($1) at call $S_CALLS: $2; blocks $S_BLOCKS/$MAX_BLOCKS, hook time $(jq -r .spent_s <<<"$S_JSON")s/${BUDGET}s"
  DECIDED=1
}

if [ "$S_BLOCKS" -ge "$MAX_BLOCKS" ]; then allow block-cap "the limit of $MAX_BLOCKS blocks is reached; the checks were not run"; exit 0; fi
if [ "$S_SPENT" -ge "$BUDGET" ]; then allow time-budget "the time budget of ${BUDGET}s for all stop checks is used up; the checks were not run"; exit 0; fi

result=green
for g in conflict_markers lint_caps typecheck; do
  name="${g//_/-}"
  if jq -e --arg g "$name" '.waived | index($g)' <<<"$S_JSON" >/dev/null; then result=no-progress; continue; fi
  CHECK=pass; FAIL_TEXT=""
  "check_$g"
  case "$CHECK" in
    pass | skip) ;;
    oos) if [ "$result" = green ]; then result="out-of-scope"; fi; note "check $name: $FAIL_TEXT" ;;
    timeout) allow check-timeout "$name hit its time limit; not blocking on a check that cannot finish"; exit 0 ;;
    budget) allow time-budget "less than 10s of the ${BUDGET}s budget is left, too little to run $name; the check was not run"; exit 0 ;;
    fail)
      sig="$(sig_of "$FAIL_TEXT")"
      if [ "$(jq -r --arg g "$name" '.sigs[$g] // ""' <<<"$S_JSON")" = "$sig" ]; then
        # The same failure right after a block: the model tried and nothing changed. Do not keep refusing the stop for it, and do not let
        # it hide the checks after it.
        sj --arg g "$name" '.waived += [$g]'
        note "check $name: unchanged after the last block; waived (no progress)"
        result=no-progress
        continue
      fi
      S_BLOCKS=$((S_BLOCKS + 1))
      sj --arg g "$name" --arg sig "$sig" --argjson b "$S_BLOCKS" '.blocks = $b | .groups += [$g] | .sigs[$g] = $sig'
      finish_state block
      note "block $S_BLOCKS/$MAX_BLOCKS ($name) at call $S_CALLS"
      reason="STOP CHECK (block $S_BLOCKS of $MAX_BLOCKS): $name is red, so you may not stop yet. This is an automatic check, not a person; it ran the same command the real checks run.
$FAIL_TEXT
"
      case "$g" in
        conflict_markers) reason="${reason}Fix each file listed (every marker line must go; delete a file only with the delete marker where the task allows it), then finish again." ;;
        lint_caps) reason="${reason}Bring each file under its cap without splitting it or dropping behaviour: merge duplicated lines and remove dead code, then run pnpm exec oxfmt --write on it. If you cannot get under the cap after an honest try, finish again unchanged and say so in your report." ;;
        typecheck) reason="${reason}Fix these errors in the files you may edit (for a missing import, find where upstream defines it), run pnpm tc again, then finish. If an error is outside what you may edit, say so in your report." ;;
      esac
      DECIDED=1
      jq -n -c --arg r "$(printf '%s' "$reason" | trunc_bytes 5000)" '{decision: "block", reason: $r}'
      exit 0
      ;;
  esac
done
allow "$result" "every check passed or was waived"
exit 0
