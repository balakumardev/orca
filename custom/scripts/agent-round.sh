#!/usr/bin/env bash
# One round of the cloud coding agent that resolves merge conflicts. Three subcommands so that the API key is
# present in exactly one workflow step (`run`); `prepare` and `finish` only run git, jq and our own scripts.
#
#   agent-round.sh prepare   build the merge state (or fetch the previous candidate) and write the prompt
#   agent-round.sh run       call Claude Code CLI against DeepInfra's Anthropic-compatible endpoint (needs the key)
#   agent-round.sh finish    record tokens/cost/report in sync-facts.json, enforce scope, commit, bundle
#
# Env (all subcommands): SYNC_OUT, TOOLS_DIR, ROUND (1..3), MODE (first | repair | retry), TIER (flash | pro).
#   first   resolve the conflicted files of a fresh merge.
#   repair  start from a candidate an earlier round committed, show the model that candidate's REAL gate output, and let it
#           edit the conflicted files plus the files our customization commits own. Rounds 2 and 3 use it (round 3 starts from
#           the best earlier candidate, chosen by pick-repair-base.sh).
#   retry   a fresh merge again, with the earlier attempt's gate output as context. Round 3 only when no earlier round left
#           a resolved merge commit to repair.
# prepare also: PREV_DIR (dir holding the previous round's sync-facts.json and, for repair, merge.bundle),
#               PREV_GATES (dir holding the previous round's gates.json, optional),
#               and for MODE first|retry the start variables of sync-merge.sh (UPSTREAM_SHA BASE_SHA BASE_BRANCH BRANCH
#               LABEL TAG IS_TEST TAG_IS_RELEASE).
# run also: DEEPINFRA_API_KEY (never echoed, never in argv), AGENT_WALL_SECONDS (optional).
#
# The model's output is untrusted text: nothing it says is executed or treated as a verification result.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${SYNC_OUT:?}" "${TOOLS_DIR:?}" "${ROUND:?}" "${MODE:?}" "${TIER:?}"
sync_out

case "$TIER" in
  flash) MODEL="deepseek-ai/DeepSeek-V4.1-Flash-1017"; PRICE_IN="0.20"; PRICE_OUT="0.60" ;;
  pro) MODEL="deepseek-ai/DeepSeek-V4-Pro-0813"; PRICE_IN="1.30"; PRICE_OUT="2.60" ;;
  *) die "TIER must be flash or pro" ;;
esac
case "$MODE" in first|repair|retry) ;; *) die "MODE must be first, repair or retry" ;; esac

section_text() { # FILE SECTION...: print the lines of the prompt that belong to the given sections
  awk -v want=" $* " '/^#@ /{cur=$2; next} index(want, " " cur " ") {print}' "$1"
}

cmd_prepare() {
  local p prev_facts="${PREV_DIR:+$PREV_DIR/sync-facts.json}"
  if [ "$MODE" = repair ]; then
    [ -s "$PREV_DIR/merge.bundle" ] && [ -s "$prev_facts" ] || die "repair needs the previous round's merge.bundle and sync-facts.json in PREV_DIR"
    cp "$prev_facts" "$SYNC_OUT/sync-facts.json"
    set_git_identity
    local branch base_sha upstream_sha
    branch="$(facts_get .branch)"; base_sha="$(facts_get .base_sha)"; upstream_sha="$(facts_get .upstream_sha)"
    git cat-file -e "$upstream_sha^{commit}" 2>/dev/null || fetch_upstream "$upstream_sha"
    git fetch -q "$PREV_DIR/merge.bundle" "$branch:$branch"
    git checkout -q -B "$branch" "$(facts_get .merge_sha)"
    git show "$base_sha:custom/BASE" >/dev/null # base is present
    git diff --name-only "$(facts_get .old_base_commit)" "$base_sha" | sort -u > "$SYNC_OUT/our-files.txt"
  else
    # first / retry: re-create the conflicted merge from scratch. The merge is deterministic, so this is the same
    # state the merge job saw; no repository state needs to travel between jobs.
    [ -z "${PREV_DIR:-}" ] || [ ! -s "$prev_facts" ] || cp "$prev_facts" "$SYNC_OUT/prev-facts.json"
    # No repository code may run before the key-bearing step: the lockfile regeneration waits for `finish`.
    DEFER_LOCKFILE=1 bash "$TOOLS_DIR/sync-merge.sh" start
    [ "$(facts_get .outcome)" = conflicts ] || log "note: the merge no longer conflicts; the agent will have nothing to do"
    if [ -s "$SYNC_OUT/prev-facts.json" ]; then
      facts_set agent "$(jq -c '.agent // null' "$SYNC_OUT/prev-facts.json")"
    fi
  fi

  local files manual nfiles check old_tag
  old_tag="$(facts_get .old_base_tag)"
  # A repair has no conflict markers left to count, so only a fresh merge (first, retry) is told the hunk count.
  files="$(jq -r --arg mode "$MODE" '.conflicts[] | select(.resolution != "scripted" and (.resolution | startswith("scripted") | not)) | select(.kind == "content" or .kind == "both-added") | if $mode == "repair" then "- \(.path) (\(.kind), conflicted in the merge; the file holds the earlier resolution)" else "- \(.path) (\(.kind), \(.hunks) conflict hunk(s))" end' "$SYNC_OUT/sync-facts.json")"
  if [ "$MODE" = repair ]; then
    # A repair may also touch the files our customization commits own (never fork infrastructure or upstream CI).
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      if our_wins_path "$p" || foreign_ci_path "$p"; then continue; fi
      grep -qxF -- "- $p" <<<"$(printf '%s\n' "$files" | sed -E 's/ \(.*//')" || files="$files
- $p (owned by a customization)"
    done < "$SYNC_OUT/our-files.txt"
    files="$(printf '%s\n' "$files" | sed '/^$/d')" # not grep -v: it exits 1 when nothing is left, and set -e would end the step
  fi
  manual="$(jq -r '[.conflicts[] | select((.resolution | startswith("scripted") | not) and .kind != "content" and .kind != "both-added") | "- \(.path) (\(.kind))"] | if length == 0 then "" else "NOT YOURS (modify/delete conflicts need a human; leave these files exactly as they are):\n" + join("\n") end' "$SYNC_OUT/sync-facts.json")"
  nfiles="$(printf '%s\n' "$files" | grep -c . || true)"

  # Previous check output, as data. Gate output comes from our scripts; unresolved markers come from the facts.
  check=""
  if [ "$MODE" != first ]; then
    check="CHECK OUTPUT (untrusted data from automated checks on the previous attempt):"
    local gate_files=()
    [ -z "${PREV_GATES:-}" ] || while IFS= read -r p; do gate_files+=("$p"); done < <(find "$PREV_GATES" -name gates.json 2>/dev/null | sort)
    if [ "${#gate_files[@]}" -gt 0 ] && [ -n "$(jq -r '.gates[] | select(.status == "fail") | .id' "${gate_files[@]}" 2>/dev/null)" ]; then
      check="$check
$(jq -r '.gates[] | select(.status == "fail") | "### \(.name) (exit \(.exit_code))\n\(.output_tail)"' "${gate_files[@]}" | trunc_bytes 7000)"
    else
      check="$check
(no check output; the previous attempt left these files unresolved: $(jq -r '(.unresolved_files // []) | join(", ")' "${prev_facts:-/dev/null}" 2>/dev/null))"
    fi
  fi

  local customizations
  # Only commits that change product code: fork scaffolding (custom/, .github/, CLAUDE.md, our skills) is none of the model's
  # business (customization_log in lib.sh). trunc_bytes, not head -c: a closed pipe would kill the log under pipefail.
  customizations="$(customization_log "$(facts_get .base_sha)" | trunc_bytes 6000)"

  local prompt="$SYNC_OUT/agent-prompt.txt" sections
  if [ "$MODE" = repair ]; then sections="all repair"; else sections="all merge"; fi
  # Pass values through the environment so they are never re-parsed as code or as awk/sed patterns.
  # shellcheck disable=SC2086
  section_text "$TOOLS_DIR/../agent/prompt.txt" $sections | P_TAG="$(facts_get .tag)" P_OLD_TAG="$old_tag" P_BASE_BRANCH="$(facts_get .base_branch)" \
    P_BASE_SHA="$(facts_get .base_sha)" P_UPSTREAM_SHA="$(facts_get .upstream_sha)" P_OLD_COMMIT="$(facts_get .old_base_commit)" \
    P_CUSTOMIZATIONS="$customizations" P_FILES="$files" P_MANUAL="$manual" P_CHECK="$check" \
    node -e '
      const fs = require("node:fs")
      const map = { TAG: "P_TAG", OLD_TAG: "P_OLD_TAG", BASE_BRANCH: "P_BASE_BRANCH", BASE_SHA: "P_BASE_SHA", UPSTREAM_SHA: "P_UPSTREAM_SHA",
        OLD_COMMIT: "P_OLD_COMMIT", CUSTOMIZATIONS: "P_CUSTOMIZATIONS", FILES: "P_FILES", MANUAL_FILES: "P_MANUAL", CHECK_OUTPUT: "P_CHECK" }
      let text = fs.readFileSync(0, "utf8")
      for (const [name, env] of Object.entries(map)) text = text.split("{{" + name + "}}").join(process.env[env] ?? "")
      process.stdout.write(text.replace(/\n{3,}/g, "\n\n"))
    ' > "$prompt"

  local turns wall
  # Rehearsal: Flash resolved 5 conflicted files in 61 turns; a repair of 56 editable files hit a cap of 60 (it counted 61) with
  # its edits intact. The caps are hard limits, not targets; a round that reaches one is reported as such in the PR.
  if [ "$MODE" = repair ]; then turns=80; wall=1200
  else turns=$((24 + 10 * nfiles)); [ "$turns" -le 70 ] || turns=70; wall=1500; fi
  # Pro (round 3, repair or retry) is the expensive tier: $1.30 per million input tokens, and a turn re-reads about 53k of them
  # (measured on Flash repairs), about $0.07 a turn. 60 turns is about $4; the old 80 was about $5.5. If every turn ran at the
  # 131k context ceiling it would be about $10 against $14. Flash keeps its caps.
  if [ "$TIER" = pro ]; then [ "$turns" -le 60 ] || turns=60; wall=1800; fi
  jq -n -c --arg model "$MODEL" --arg tier "$TIER" --arg mode "$MODE" --argjson round "$ROUND" --argjson turns "$turns" --argjson wall "$wall" --argjson nfiles "$nfiles" \
    '{model: $model, tier: $tier, mode: $mode, round: $round, max_turns: $turns, wall_seconds: $wall, files: $nfiles}' > "$SYNC_OUT/agent-plan.json"
  log "agent plan: $(cat "$SYNC_OUT/agent-plan.json"); prompt $(wc -c < "$prompt") bytes"
}

# ---- key-leak guard -------------------------------------------------------------------------------------------
# The key is in this process's environment while the CLI runs, and the agent's auto-approved read-only commands can
# read an environment, so a prompt-injected agent could write the key into a file the pipeline would later commit.
# Everything below runs in `run` (the only step that has the key), after the CLI has exited, and uses grep/find/rm
# only: NO git command may run here, because .git/config is inside the agent's working directory and a planted
# setting (core.fsmonitor and friends) would execute with the key in this step's environment.

# The strings that count as the key: the key, its base64, the key without its first 8 characters (a partial copy),
# its hex and its reverse. Printed one per line and NEVER empty (an empty pattern would match every file). Callers
# read them through a process substitution, so the key is never an argument of any process.
leak_needles() {
  local key="$1"
  {
    printf '%s\n' "$key"
    printf '%s' "$key" | base64 | tr -d '\n'; printf '\n'
    printf '%s' "$key" | od -An -v -tx1 | tr -d ' \n'; printf '\n'
    printf '%s' "$key" | rev; printf '\n'
    if [ "${#key}" -ge 16 ]; then printf '%s\n' "${key:8}"; fi
  } | awk 'length > 0'
}

# Names of files (relative to the given directory) whose CONTENT carries a needle. Binary files count (-a).
files_with_key() { # DIR [extra grep args...]
  local dir="$1"; shift
  ( cd "$dir" && grep -r -a -l -F -f <(leak_needles "$DEEPINFRA_API_KEY") "$@" -- . 2>/dev/null ) | sed 's#^\./##' || true
}

# How many file NAMES (and symlink targets) in the tree carry a needle: a name is an exfiltration channel too.
names_with_key() { # DIR
  ( cd "$1" && { find . -path ./.git -prune -o -print; find . -path ./.git -prune -o -type l -exec readlink -- {} \; ; } 2>/dev/null \
    | grep -c -F -f <(leak_needles "$DEEPINFRA_API_KEY") ) || true
}

# Only ever print a path that is itself free of the key.
safe_name() {
  if grep -q -F -f <(leak_needles "$DEEPINFRA_API_KEY") <<<"$1"; then printf '<name contained the key>'; else printf '%s' "$1"; fi
}

cmd_run() {
  : "${DEEPINFRA_API_KEY:?DEEPINFRA_API_KEY must be set for this step}"
  local plan="$SYNC_OUT/agent-plan.json" turns wall out="$SYNC_OUT/agent-out.json" started rc=0
  turns="$(jq -r .max_turns "$plan")"; wall="${AGENT_WALL_SECONDS:-$(jq -r .wall_seconds "$plan")}"
  local top
  top="$(git rev-parse --show-toplevel)" # resolved BEFORE the agent runs: no git after it
  # The CLI's own state lives outside SYNC_OUT: SYNC_OUT is uploaded as an artifact, the CLI's config is not.
  local cfg="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/claude-config-round-$ROUND"
  mkdir -p "$cfg"
  # The CLI's raw stdout and stderr also go there, NOT into SYNC_OUT: the artifact upload runs `always()`, so a step that is
  # cancelled while the CLI is still running must not leave unscanned model output in the uploaded directory. SYNC_OUT
  # receives them only after the scan.
  local raw_out="$cfg/agent-out.json" raw_err="$cfg/agent-out.err"
  local marker="$cfg/start-marker"
  : > "$marker"
  started="$(date +%s)"
  # A clean environment: only what the CLI needs, so no runner variable can leak into (or out of) the session.
  # The key reaches the process through its environment only; it is never an argument and never printed.
  # shellcheck disable=SC2086
  (
    cd "$top"
    with_wall() { if command -v timeout >/dev/null 2>&1; then timeout "$wall" "$@"; else "$@"; fi; }
    with_wall env -i PATH="$PATH" HOME="${HOME:-/tmp}" LANG=C.UTF-8 TMPDIR="${TMPDIR:-/tmp}" \
      ANTHROPIC_BASE_URL="https://api.deepinfra.com/anthropic" \
      ANTHROPIC_AUTH_TOKEN="$DEEPINFRA_API_KEY" \
      ANTHROPIC_API_KEY="" \
      ANTHROPIC_MODEL="$(jq -r .model "$plan")" \
      ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-ai/DeepSeek-V4.1-Flash-1017" \
      ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-ai/DeepSeek-V4-Pro-0813" \
      ANTHROPIC_DEFAULT_HAIKU_MODEL="inclusionAI/Ling-3.0-flash" \
      CLAUDE_CODE_MAX_CONTEXT_TOKENS=131072 \
      CLAUDE_CODE_MAX_OUTPUT_TOKENS=16384 \
      CLAUDE_CODE_SUBAGENT_MODEL=inherit \
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
      DISABLE_AUTOUPDATER=1 \
      DISABLE_TELEMETRY=1 \
      CLAUDE_CONFIG_DIR="$cfg" \
      claude -p \
        --output-format json \
        --max-turns "$turns" \
        --restricted --strict-mcp-config --safe-mode --setting-sources "" \
        --no-session-persistence \
        --permission-mode dontAsk \
        --permission-prompts none \
        --disable-slash-commands \
        --disallowedTools "Bash(*--output*)" \
        --tools "Read,Edit,Write,Grep,Glob,Bash" \
        --allowedTools "Read,Edit,Write,Grep,Glob,Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git ls-tree:*),Bash(git cat-file:*),Bash(git grep:*),Bash(grep:*),Bash(ls:*)" \
        < "$SYNC_OUT/agent-prompt.txt" > "$raw_out" 2> "$raw_err"
  ) || rc=$?
  local wall_s=$(( $(date +%s) - started ))

  # Fail closed (a backstop; the raw output is not in SYNC_OUT until the scan has passed): if anything below dies before
  # the scan has run to the end, whatever model output reached SYNC_OUT is deleted rather than shipped.
  RAW_OUT="$out"; RAW_CFG_OUT="$raw_out"; RAW_CFG_ERR="$raw_err"; SCAN_DONE=0
  trap '[ "$SCAN_DONE" = 1 ] || rm -f "$RAW_OUT" "$RAW_OUT.err" "$RAW_CFG_OUT" "$RAW_CFG_ERR"' EXIT

  # 1. Scan the WHOLE work tree (untracked and ignored files included), the parts of .git that are not objects, and
  #    every file the pipeline will upload, for the key and its derived forms. Names only, never the matching text.
  local hits=() f n
  while IFS= read -r f; do [ -z "$f" ] || hits+=("$(safe_name "$f")"); done < <(files_with_key "$top" --exclude-dir=.git)
  while IFS= read -r f; do [ -z "$f" ] || hits+=("$(safe_name ".git/$f")"); done < <(files_with_key "$top/.git" --exclude-dir=objects)
  while IFS= read -r f; do [ -z "$f" ] || hits+=("artifact: $(safe_name "$f")"); done < <(files_with_key "$SYNC_OUT")
  while IFS= read -r f; do [ -z "$f" ] || hits+=("CLI output: $(safe_name "$f")"); done < <(files_with_key "$cfg" --include='agent-out.*')
  n="$(names_with_key "$top")"
  [ "${n:-0}" -eq 0 ] || hits+=("(${n} file name(s) or link target(s) in the work tree contained the key)")
  local leaks=${#hits[@]}

  if [ "$leaks" -gt 0 ]; then
    # 2. Neutralise. Delete every file the agent wrote (everything newer than the marker, which includes each file that
    #    matched), cut the CLI's own output down to its numbers, and drop the model's report. `finish` (no key in its
    #    environment) then rebuilds the pre-agent merge state with git, because git must not run here: .git is inside
    #    the agent's working directory and a planted setting could execute with the key in this step's environment.
    find "$top" \( -path "$top/.git" -o -path "$SYNC_OUT" \) -prune -o \( -type f -o -type l \) -newer "$marker" -exec rm -f -- {} + 2>/dev/null || true
    if jq -e '{usage, num_turns, subtype, is_error}' "$raw_out" > "$out" 2>/dev/null; then :; else printf '{}\n' > "$out"; fi
    rm -f "$raw_out" "$raw_err"
    while IFS= read -r f; do [ -z "$f" ] || rm -f -- "$SYNC_OUT/$f"; done < <(files_with_key "$SYNC_OUT")
    local names
    names="$(printf '%s, ' "${hits[@]}" | tr -d '\000-\037' | sed -e 's/%/%25/g' -e 's/, $//')"
    printf '::error title=Key leak::Round %s: the agent output contained the API key (file names only): %s. Its edits were discarded. Rotate DEEPINFRA_API_KEY.\n' "$ROUND" "$names"
  else
    # Clean: the CLI's output moves to the uploaded directory (a missing file just means the CLI never started).
    [ ! -f "$raw_out" ] || mv "$raw_out" "$out"
    [ ! -f "$raw_err" ] || mv "$raw_err" "$out.err"
  fi

  jq -n -c --argjson rc "$rc" --argjson wall "$wall_s" --argjson leaks "$leaks" \
    --argjson files "$(printf '%s\n' ${hits[@]+"${hits[@]}"} | jq -R -s -c 'split("\n") | map(select(length > 0))')" \
    '{exit_code: $rc, wall_s: $wall, key_leaks: $leaks, key_leak_files: $files}' > "$SYNC_OUT/agent-run.json"
  gh_out key_leaks "$leaks"
  log "agent finished: exit $rc after ${wall_s}s (key leak check: $leaks)"
  SCAN_DONE=1
  # Never fail this step on the model's behalf: finish records the outcome and the PR still opens (as a draft).
  exit 0
}

cmd_finish() {
  local run out="$SYNC_OUT/agent-out.json" plan="$SYNC_OUT/agent-plan.json"
  run="$(cat "$SYNC_OUT/agent-run.json" 2>/dev/null || echo '{"exit_code":-1,"wall_s":0,"key_leaks":0,"key_leak_files":[]}')"
  local leaks leak_files
  leaks="$(jq -r '.key_leaks // 0' <<<"$run")"; leak_files="$(jq -c '.key_leak_files // []' <<<"$run")"
  local usage_ok=false
  jq -e . "$out" >/dev/null 2>&1 && usage_ok=true
  local report="" in_tok=0 out_tok=0 turns=0 stop="" errflag=true
  if [ "$usage_ok" = true ]; then
    # DeepInfra caches prompts; we count every input token at the full rate, so the dollar figure is an upper bound.
    in_tok="$(jq -r '((.usage.input_tokens // 0) + (.usage.cache_read_input_tokens // 0) + (.usage.cache_creation_input_tokens // 0))' "$out")"
    out_tok="$(jq -r '(.usage.output_tokens // 0)' "$out")"
    turns="$(jq -r '(.num_turns // 0)' "$out")"
    stop="$(jq -r '(.subtype // .stop_reason // "")' "$out")"
    errflag="$(jq -r '(.is_error // false)' "$out")"
    # Untrusted text: keep printable characters, bound the size, and drop anything that could close a markdown fence.
    # grep -v exits 1 when every line was dropped (an empty report is fine); only that status is tolerated. Any other failure
    # of the pipeline leaves the report empty. trunc_bytes lets every stage finish, so no stage dies of SIGPIPE.
    report="$(jq -r '(.result // "")' "$out" | LC_ALL=C tr -d '\000-\010\013\014\016-\037' | { grep -v -F '~~~~' || [ $? -eq 1 ]; } | trunc_bytes 6000)" || report=""
  fi
  # A round that leaked the key has no report: nothing the model wrote is shown, in any encoding.
  if [ "$leaks" -gt 0 ]; then report="[report withheld: this round's output contained the API key]"; fi
  local cost
  cost="$(awk -v i="$in_tok" -v o="$out_tok" -v pi="$PRICE_IN" -v po="$PRICE_OUT" 'BEGIN { printf "%.4f", i / 1e6 * pi + o / 1e6 * po }')"
  local tmp
  tmp="$(mktemp)"
  jq --argjson run "$run" --argjson plan "$(cat "$plan")" --arg report "$report" --argjson in_tok "$in_tok" --argjson out_tok "$out_tok" \
     --argjson turns "$turns" --arg stop "$stop" --arg iserr "$errflag" --argjson cost "$cost" --arg usage_ok "$usage_ok" \
     --argjson leak_files "$leak_files" \
    '.agent = ((.agent // {rounds: []}) | .rounds += [{
        round: $plan.round, mode: $plan.mode, model: $plan.model, tier: $plan.tier, max_turns: $plan.max_turns,
        exit_code: $run.exit_code, wall_s: $run.wall_s, key_leaks: $run.key_leaks, key_leak_files: $leak_files, turns: $turns, stop: $stop,
        is_error: ($iserr == "true"), output_parsed: ($usage_ok == "true"), input_tokens: $in_tok, output_tokens: $out_tok,
        estimated_cost_usd: $cost, report: $report }])' "$SYNC_OUT/sync-facts.json" > "$tmp" && mv "$tmp" "$SYNC_OUT/sync-facts.json"

  # The job summary says why the round stopped, from the CLI's own numbers (the stop word is reduced to a-z 0-9 _ . -).
  # make-pr-body.mjs words the same reasons for the PR; keep the two in step.
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    local why=ok stop_word rc
    stop_word="$(printf '%s' "$stop" | tr -cd 'A-Za-z0-9_.-' | trunc_bytes 40)"
    rc="$(jq -r '.exit_code // -1' <<<"$run")"
    if [ "$leaks" -gt 0 ]; then why="the output contained the API key; edits discarded"
    elif [ "$stop_word" = error_max_turns ]; then why="ran out of turns; edits kept; gates decide"
    elif [ "$rc" = 124 ]; then why="hit the wall-clock limit; edits kept; gates decide"
    elif [ "$usage_ok" != true ]; then why="no readable output; edits kept; gates decide"
    elif [ "$rc" != 0 ] || [ "$errflag" = true ]; then why="ended with an error (exit $rc, stop: ${stop_word:-none}); edits kept; gates decide"
    fi
    printf -- '- Agent round %s (%s, %s): %s of at most %s turns, exit code %s, estimated $%s. Result: %s.\n' \
      "$ROUND" "$MODE" "$TIER" "$turns" "$(jq -r .max_turns "$plan")" "$rc" "$cost" "$why" >> "$GITHUB_STEP_SUMMARY"
  fi

  # AGENT_KEY_LEAK=1 makes sync-merge.sh throw away every edit of this round and mark the candidate unresolved.
  local leak_flag=0
  [ "$leaks" -eq 0 ] || leak_flag=1
  if [ "$MODE" = repair ]; then AGENT_KEY_LEAK="$leak_flag" bash "$TOOLS_DIR/sync-merge.sh" finish --repair; else AGENT_KEY_LEAK="$leak_flag" bash "$TOOLS_DIR/sync-merge.sh" finish; fi
}

case "${1:-}" in
  prepare) cmd_prepare ;;
  run) cmd_run ;;
  finish) cmd_finish ;;
  *) die "usage: agent-round.sh prepare|run|finish" ;;
esac
