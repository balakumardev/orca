#!/usr/bin/env bash
# One round of the cloud coding agent that resolves merge conflicts. Three subcommands so that the API key is
# present in exactly one workflow step (`run`); `prepare` and `finish` only run git, jq and our own scripts.
#
#   agent-round.sh prepare   build the merge state (or fetch the previous candidate) and write the prompt
#   agent-round.sh run       call Claude Code CLI against DeepInfra's Anthropic-compatible endpoint (needs the key)
#   agent-round.sh finish    record tokens/cost/report in sync-facts.json, enforce scope, commit, bundle
#
# Env (all subcommands): SYNC_OUT, TOOLS_DIR, ROUND (1..3), MODE (first | repair | retry), TIER (flash | pro).
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
  files="$(jq -r '.conflicts[] | select(.resolution != "scripted" and (.resolution | startswith("scripted") | not)) | select(.kind == "content" or .kind == "both-added") | "- \(.path) (\(.kind), \(.hunks) conflict hunk(s))"' "$SYNC_OUT/sync-facts.json")"
  if [ "$MODE" = repair ]; then
    # A repair may also touch the files our customization commits own (never fork infrastructure or upstream CI).
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      if our_wins_path "$p" || foreign_ci_path "$p"; then continue; fi
      grep -qxF -- "- $p" <<<"$(printf '%s\n' "$files" | sed -E 's/ \(.*//')" || files="$files
- $p (owned by a customization)"
    done < "$SYNC_OUT/our-files.txt"
    files="$(printf '%s\n' "$files" | grep -v '^$')"
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
$(jq -r '.gates[] | select(.status == "fail") | "### \(.name) (exit \(.exit_code))\n\(.output_tail)"' "${gate_files[@]}" | head -c 7000)"
    else
      check="$check
(no check output; the previous attempt left these files unresolved: $(jq -r '(.unresolved_files // []) | join(", ")' "${prev_facts:-/dev/null}" 2>/dev/null))"
    fi
  fi

  local customizations
  # Only commits that change product code: fork scaffolding (custom/, .github/) is none of the model's business.
  customizations="$(git log --no-merges --grep='^Orca-Custom-Patch:' --format='- %h: %s%n%b' "$(facts_get .base_sha)" -- . ':(exclude)custom' ':(exclude).github' ':(exclude)CUSTOM.md' | head -c 6000)"

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
  # Rehearsal: Flash resolved 5 conflicted files in 61 turns. The caps are hard limits, not targets.
  if [ "$MODE" = repair ]; then turns=60; wall=1200
  else turns=$((24 + 10 * nfiles)); [ "$turns" -le 70 ] || turns=70; wall=1500; fi
  [ "$TIER" != pro ] || wall=1800
  jq -n -c --arg model "$MODEL" --arg tier "$TIER" --arg mode "$MODE" --argjson round "$ROUND" --argjson turns "$turns" --argjson wall "$wall" --argjson nfiles "$nfiles" \
    '{model: $model, tier: $tier, mode: $mode, round: $round, max_turns: $turns, wall_seconds: $wall, files: $nfiles}' > "$SYNC_OUT/agent-plan.json"
  log "agent plan: $(cat "$SYNC_OUT/agent-plan.json"); prompt $(wc -c < "$prompt") bytes"
}

cmd_run() {
  : "${DEEPINFRA_API_KEY:?DEEPINFRA_API_KEY must be set for this step}"
  local plan="$SYNC_OUT/agent-plan.json" turns wall out="$SYNC_OUT/agent-out.json" started rc=0
  turns="$(jq -r .max_turns "$plan")"; wall="${AGENT_WALL_SECONDS:-$(jq -r .wall_seconds "$plan")}"
  # The CLI's own state lives outside SYNC_OUT: SYNC_OUT is uploaded as an artifact, the CLI's config is not.
  local cfg="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/claude-config-round-$ROUND"
  mkdir -p "$cfg"
  started="$(date +%s)"
  # A clean environment: only what the CLI needs, so no runner variable can leak into (or out of) the session.
  # The key reaches the process through its environment only; it is never an argument and never printed.
  # shellcheck disable=SC2086
  (
    cd "$(git rev-parse --show-toplevel)"
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
        < "$SYNC_OUT/agent-prompt.txt" > "$out" 2> "$out.err"
  ) || rc=$?
  local wall_s=$(( $(date +%s) - started )) leaks=0 f
  # Leak check: the key must not appear in anything the CLI wrote. Matching blanks the files rather than shipping them.
  for f in "$out" "$out.err"; do
    [ -f "$f" ] || continue
    if grep -q -F -f <(printf '%s' "$DEEPINFRA_API_KEY") "$f" 2>/dev/null; then
      leaks=$((leaks + 1)); printf '[output removed: it contained the API key]\n' > "$f"
    fi
  done
  jq -n -c --argjson rc "$rc" --argjson wall "$wall_s" --argjson leaks "$leaks" '{exit_code: $rc, wall_s: $wall, key_leaks: $leaks}' > "$SYNC_OUT/agent-run.json"
  log "agent finished: exit $rc after ${wall_s}s (key leak check: $leaks)"
  # Never fail this step on the model's behalf: finish records the outcome and the PR still opens (as a draft).
  exit 0
}

cmd_finish() {
  local run out="$SYNC_OUT/agent-out.json" plan="$SYNC_OUT/agent-plan.json"
  run="$(cat "$SYNC_OUT/agent-run.json" 2>/dev/null || echo '{"exit_code":-1,"wall_s":0,"key_leaks":0}')"
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
    report="$(jq -r '(.result // "")' "$out" | LC_ALL=C tr -d '\000-\010\013\014\016-\037' | grep -v -F '~~~~' | head -c 6000 || true)"
  fi
  local cost
  cost="$(awk -v i="$in_tok" -v o="$out_tok" -v pi="$PRICE_IN" -v po="$PRICE_OUT" 'BEGIN { printf "%.4f", i / 1e6 * pi + o / 1e6 * po }')"
  local tmp
  tmp="$(mktemp)"
  jq --argjson run "$run" --argjson plan "$(cat "$plan")" --arg report "$report" --argjson in_tok "$in_tok" --argjson out_tok "$out_tok" \
     --argjson turns "$turns" --arg stop "$stop" --arg iserr "$errflag" --argjson cost "$cost" --arg usage_ok "$usage_ok" \
    '.agent = ((.agent // {rounds: []}) | .rounds += [{
        round: $plan.round, mode: $plan.mode, model: $plan.model, tier: $plan.tier, max_turns: $plan.max_turns,
        exit_code: $run.exit_code, wall_s: $run.wall_s, key_leaks: $run.key_leaks, turns: $turns, stop: $stop,
        is_error: ($iserr == "true"), output_parsed: ($usage_ok == "true"), input_tokens: $in_tok, output_tokens: $out_tok,
        estimated_cost_usd: $cost, report: $report }])' "$SYNC_OUT/sync-facts.json" > "$tmp" && mv "$tmp" "$SYNC_OUT/sync-facts.json"

  if [ "$MODE" = repair ]; then bash "$TOOLS_DIR/sync-merge.sh" finish --repair; else bash "$TOOLS_DIR/sync-merge.sh" finish; fi
}

case "${1:-}" in
  prepare) cmd_prepare ;;
  run) cmd_run ;;
  finish) cmd_finish ;;
  *) die "usage: agent-round.sh prepare|run|finish" ;;
esac
