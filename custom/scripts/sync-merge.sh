#!/usr/bin/env bash
# Deterministic half of the upstream sync. Two subcommands, both run inside a checkout of the base branch.
#
#   sync-merge.sh start    merge the upstream commit, apply the scripted resolutions, record sync-facts.json,
#                          and commit the merge when nothing is left to resolve.
#   sync-merge.sh finish   after a model (or a human) edited the conflicted files: enforce scope, check for
#                          conflict markers, stage, and commit the merge; `--repair` re-commits an existing
#                          candidate with the same two parents.
#
# Why a "link" commit: upstream release tags are NOT ancestors of each other (each one is `main` plus a few
# release-only commits). A plain `git merge <tag>` therefore uses an old `main` commit as the merge base and
# conflicts in dozens of files nobody touched (version bumps, cherry-picks). We merge a synthetic commit L
# instead: tree(L) = tree(<tag>), parents = (<tag>, <old BASE tag>). Its only job is to make the old BASE tag
# the merge base, so the merge replays exactly OUR changes on top of the new tag. L is a real commit in the
# history of the sync branch, so `git show --remerge-diff` and later syncs work unchanged.
#
# Env for `start`: UPSTREAM_SHA BASE_SHA BASE_BRANCH BRANCH LABEL TAG IS_TEST TAG_IS_RELEASE SYNC_OUT
# Env for `finish`: SYNC_OUT (everything else is read from sync-facts.json).
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

# conflict_set PATH RESOLUTION: update one entry of facts.conflicts.
# conflict_decision PATH VALUE: what the agent decided for a modify/delete conflict (kept | deleted); shown in the PR table.
conflict_decision() {
  local f="$SYNC_OUT/sync-facts.json" tmp
  tmp="$(mktemp)"
  jq --arg p "$1" --arg d "$2" '.conflicts |= map(if .path == $p then .decision = $d else . end)' "$f" > "$tmp" && mv "$tmp" "$f"
}

conflict_set() {
  local f="$SYNC_OUT/sync-facts.json" tmp
  tmp="$(mktemp)"
  jq --arg p "$1" --arg r "$2" '.conflicts |= map(if .path == $p then .resolution = $r else . end)' "$f" > "$tmp" && mv "$tmp" "$f"
}

caveat() { # TEXT
  local f="$SYNC_OUT/sync-facts.json" tmp
  tmp="$(mktemp)"
  jq --arg c "$1" '.caveats = ((.caveats // []) + [$c])' "$f" > "$tmp" && mv "$tmp" "$f"
}

list_unmerged() { git diff --name-only --diff-filter=U | sort -u; }

# our_side_changed PATH: true when our side holds a change in this unmerged file, whatever its path was before. Stage 1 is the
# ancestor and stage 2 is ours; they differ exactly when a customization edited the file, also when upstream moved it and
# the edit travelled to the new path (our-files.txt lists the OLD paths, so a path lookup misses every moved file).
our_side_changed() {
  local stages ancestor ours
  stages="$(git ls-files -u -- "$1")"
  ancestor="$(awk '$3 == 1 {print $2}' <<<"$stages")"
  ours="$(awk '$3 == 2 {print $2}' <<<"$stages")"
  [ -n "$ours" ] && [ "$ours" != "$ancestor" ]
}

conflict_kind() { # PATH -> content | both-added | deleted-by-them | deleted-by-us | other
  case "$(git ls-files -u -- "$1" | awk '{print $3}' | sort -u | tr -d '\n')" in
    123) echo content ;;
    23) echo both-added ;;
    12) echo deleted-by-them ;;
    13) echo deleted-by-us ;;
    *) echo other ;;
  esac
}

write_commit_message() { # OUTFILE SUBJECT
  local out="$1" subject="$2"
  {
    printf '%s\n\n' "$subject"
    printf 'Upstream commit: %s (%s)\n' "$(facts_get .upstream_sha)" "$(facts_get .tag)"
    printf 'Previous BASE: %s\n' "$(facts_get .old_base_tag)"
    printf 'Conflicts: %s file(s) conflicted, %s resolved by script, %s by the cloud agent, %s unresolved\n' \
      "$(facts_get '.conflicts | length')" \
      "$(facts_get '[.conflicts[] | select(.resolution | startswith("scripted"))] | length')" \
      "$(facts_get '[.conflicts[] | select(.resolution == "agent")] | length')" \
      "$(facts_get '[.conflicts[] | select(.resolution == "unresolved")] | length')"
    printf '\nOrca-Custom-Patch: upstream-sync\n'
  } > "$out"
}

# ---------------------------------------------------------------------------------------------- start
cmd_start() {
  local v
  for v in UPSTREAM_SHA BASE_SHA BASE_BRANCH BRANCH LABEL TAG IS_TEST TAG_IS_RELEASE; do : "${!v:?$v is required}"; done
  sync_out
  set_git_identity
  [ -z "$(git status --porcelain)" ] || die "the working tree must be clean before the merge"
  [ "$(git rev-parse HEAD)" = "$BASE_SHA" ] || git checkout -q --detach "$BASE_SHA"

  local old_tag old_commit
  old_tag="$(git show "$BASE_SHA:custom/BASE" | tr -d '[:space:]')"
  [[ "$old_tag" =~ $TAG_RE ]] || die "custom/BASE on the base branch is not a release tag ('$old_tag')"
  git cat-file -e "$UPSTREAM_SHA^{commit}" 2>/dev/null || fetch_upstream "$UPSTREAM_SHA"
  git rev-parse -q --verify "refs/tags/$old_tag^{commit}" >/dev/null || fetch_upstream "+refs/tags/$old_tag:refs/tags/$old_tag"
  old_commit="$(git rev-parse "refs/tags/$old_tag^{commit}")"
  git merge-base --is-ancestor "$old_commit" "$BASE_SHA" \
    || die "BASE tag $old_tag ($old_commit) is not an ancestor of $BASE_BRANCH; fix custom/BASE by hand"

  git checkout -q -B "$BRANCH" "$BASE_SHA"
  : > "$SYNC_OUT/sync-facts.json"
  git diff --name-only --no-renames "$old_commit" "$BASE_SHA" | sort -u > "$SYNC_OUT/our-files.txt"

  local link
  link="$(git commit-tree "$UPSTREAM_SHA^{tree}" -p "$UPSTREAM_SHA" -p "$old_commit" -m "Link upstream $TAG to $old_tag

Synthetic commit made by custom-sync. Its tree is identical to $TAG (${UPSTREAM_SHA:0:12}); its second
parent is the previous BASE tag $old_tag. It exists only so that git uses $old_tag as the merge base
(release tags are not ancestors of each other), which makes the merge replay our changes on the new tag.")"

  # find-renames=30%: git pairs a moved file with its old path only above 50% similarity. A release that moves AND trims a
  # file we edited (v1.4.261: 46% and 48% on two of them) was merged as "deleted by them" plus a new file, a conflict kind
  # the model may not touch and our edit lost. 30% keeps those pairs; a wrong pair is only a content conflict that the gates judge.
  # merge.directoryRenames=false: when upstream moves most of a directory, git relocates the files WE added there and raises a
  # "file location" conflict (stage 2 only: kind `other`, a human step that also skipped every agent round and every gate;
  # v1.4.263 and v1.4.264, three files of tests/e2e/helpers). The relocation is wrong anyway: upstream split that directory
  # over several folders, and our importers still name the old path. Our files stay where our code imports them; what they
  # import from moved files is repointed by (f) below.
  local merge_rc=0
  git -c merge.conflictStyle=zdiff3 -c merge.directoryRenames=false merge -X find-renames=30% --no-commit --no-ff "$link" > "$SYNC_OUT/merge.log" 2>&1 || merge_rc=$?
  [ "$merge_rc" -le 1 ] || { cat "$SYNC_OUT/merge.log" >&2; die "git merge failed with exit $merge_rc"; }

  # Initial conflict list (before any scripted resolution), as TSV: path, kind, hunks, resolution.
  local tsv="$SYNC_OUT/conflicts.tsv" p
  : > "$tsv"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    printf '%s\t%s\t%s\tpending\n' "$p" "$(conflict_kind "$p")" "$( [ -f "$p" ] && count_markers "$p" || echo 0 )" >> "$tsv"
  done < <(list_unmerged)

  # (a) upstream CI the fork must not carry: every workflow not named custom-*, and dependabot config.
  local removed=0
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if foreign_ci_path "$p"; then git rm --sparse -q -f --ignore-unmatch -- "$p"; removed=$((removed + 1)); fi
  done < <(git ls-files -- .github/workflows .github/dependabot.yml .github/dependabot.yaml | sort -u)
  local ci_new
  ci_new="$(git diff --name-only --diff-filter=A "$old_commit" "$UPSTREAM_SHA" -- .github/workflows .github/dependabot.yml | wc -l | tr -d ' ')"

  # (b) our-wins paths: restore exactly our side (and drop anything upstream added there).
  local restored="$SYNC_OUT/our-wins-restored.txt" keep_list
  : > "$restored"
  keep_list="$(git ls-tree -r --name-only "$BASE_SHA" -- custom .github/pull_request_template.md CUSTOM.md CLAUDE.md .claude/skills .github/workflows | while IFS= read -r p; do our_wins_path "$p" && printf '%s\n' "$p"; done || true)"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ -n "$(git ls-files -u -- "$p")" ] || ! git diff --cached --quiet "$BASE_SHA" -- "$p"; then
      printf '%s\n' "$p" >> "$restored"
    fi
    git checkout -q "$BASE_SHA" -- "$p"
  done <<<"$keep_list"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if our_wins_path "$p" && ! grep -qxF -- "$p" <<<"$keep_list"; then git rm --sparse -q -f -- "$p"; printf '%s\n' "$p" >> "$restored"; fi
  done < <(git ls-files -- custom .github/pull_request_template.md CUSTOM.md CLAUDE.md .claude/skills | sort -u)

  # (c) the new base tag. Rehearsals against a branch or sha leave BASE alone.
  if [ "$TAG_IS_RELEASE" = true ]; then
    printf '%s\n' "$TAG" > custom/BASE
    git add --sparse -- custom/BASE
  fi

  # (d) lockfile: take upstream's, then let pnpm reconcile it with whatever package.json says.
  local lock_state=null lock_pending=false
  if [ -n "$(git ls-files -u -- pnpm-lock.yaml)" ]; then
    git checkout -q --theirs -- pnpm-lock.yaml 2>/dev/null || true
    git add --sparse -- pnpm-lock.yaml
    if [ -n "$(git ls-files -u -- package.json)" ] || [ "${DEFER_LOCKFILE:-0}" = 1 ]; then
      # Regeneration (regen_lockfile) ignores the pnpmfile and lifecycle scripts, but pnpm still reads package.json and
      # the workspace files. It is deferred to `finish` when package.json is itself conflicted, and in the model job,
      # where nothing from the repository may run before the model step.
      lock_pending=true
      lock_state='"theirs, regeneration pending until the merge is finished"'
    else
      regen_lockfile
      git add --sparse -- pnpm-lock.yaml
      lock_state='"theirs, then pnpm install --lockfile-only"'
    fi
  fi

  # (e) A conflicted file that no customization touched cannot hold a decision of ours, and a generated file must
  # not be hand-merged: take upstream's version. "Touched" is read from the stages (our_side_changed), not from
  # our-files.txt: that list has the old paths, and a file upstream moved carries our edit to its new path. Judged by path,
  # six moved files of v1.4.261 had our edits replaced by upstream's version without a word.
  local theirs_list="$SYNC_OUT/taken-from-upstream.txt"
  : > "$theirs_list"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if ! generated_path "$p" && { grep -qxF -- "$p" "$SYNC_OUT/our-files.txt" || our_side_changed "$p"; }; then continue; fi
    if [ -n "$(git ls-files -u -- "$p" | awk '$3 == 3')" ]; then
      git checkout -q --theirs -- "$p"
      git add --sparse -- "$p"
    else
      git rm --sparse -q -f --ignore-unmatch -- "$p"
    fi
    printf '%s\n' "$p" >> "$theirs_list"
  done < <(list_unmerged)

  # (f) Imports of files upstream moved. A merge moves a file but never rewrites an import, so every file of ours that imports
  # a moved file stops compiling (v1.4.263: 176 imports in 87 files, found only by typecheck, and a repair round sees at most
  # 7000 bytes of that output). The script repoints what it can prove; the rest is left to the agent and the gates.
  local repointed="$SYNC_OUT/repointed-imports.json" p_edit repoint_failed=false
  if ! node "$(dirname "$0")/repoint-moved-imports.mjs" --ours "$BASE_SHA" --old "$old_commit" --new "$UPSTREAM_SHA" --apply > "$repointed" 2> "$SYNC_OUT/repoint.err"; then
    # A convenience step must not end the sync: its half-written edits are unstaged, so the scope check of `finish` reverts them.
    repoint_failed=true
    printf '{"files":0,"repointed":0,"edited":[],"unresolved":[]}\n' > "$repointed"
  fi
  while IFS= read -r p_edit; do
    [ -n "$p_edit" ] || continue
    git add --sparse -- "$p_edit"
  done < <(jq -r '.edited[].path' "$repointed")

  # Resolution labels for everything the scripts settled.
  local remaining kind label
  remaining="$(list_unmerged)"
  local tmp_tsv="$SYNC_OUT/conflicts.tsv.new"
  : > "$tmp_tsv"
  while IFS="$(printf '\t')" read -r p kind hunks _; do
    [ -n "$p" ] || continue
    if grep -qxF -- "$p" <<<"$remaining"; then label=pending
    elif foreign_ci_path "$p"; then label="scripted: dropped upstream CI file"
    elif our_wins_path "$p"; then label="scripted: our side wins"
    elif [ "$p" = pnpm-lock.yaml ]; then label="scripted: upstream lockfile, regenerated"
    elif grep -qxF -- "$p" "$theirs_list"; then
      if generated_path "$p"; then label="scripted: generated file, upstream's version taken"; else label="scripted: no customization touches it, upstream's version taken"; fi
    else label="scripted"; fi
    printf '%s\t%s\t%s\t%s\n' "$p" "$kind" "$hunks" "$label" >> "$tmp_tsv"
  done < "$tsv"
  mv "$tmp_tsv" "$tsv"

  local outcome=clean
  [ "$merge_rc" -eq 0 ] || outcome=scripted
  [ -z "$remaining" ] || outcome=conflicts

  facts_set label "$(jq -Rn --arg v "$LABEL" '$v')"
  facts_set tag "$(jq -Rn --arg v "$TAG" '$v')"
  facts_set is_test "$IS_TEST"
  facts_set tag_is_release "$TAG_IS_RELEASE"
  facts_set branch "$(jq -Rn --arg v "$BRANCH" '$v')"
  facts_set base_branch "$(jq -Rn --arg v "$BASE_BRANCH" '$v')"
  facts_set base_sha "$(jq -Rn --arg v "$BASE_SHA" '$v')"
  facts_set old_base_tag "$(jq -Rn --arg v "$old_tag" '$v')"
  facts_set old_base_commit "$(jq -Rn --arg v "$old_commit" '$v')"
  facts_set upstream_sha "$(jq -Rn --arg v "$UPSTREAM_SHA" '$v')"
  facts_set link_sha "$(jq -Rn --arg v "$link" '$v')"
  facts_set upstream_commits "$(git rev-list --count "$BASE_SHA..$UPSTREAM_SHA")"
  facts_set our_files_count "$(wc -l < "$SYNC_OUT/our-files.txt" | tr -d ' ')"
  facts_set outcome "\"$outcome\""
  facts_set lockfile_pending "$lock_pending"
  facts_set conflicts "$(jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t")) | map({path: .[0], kind: .[1], hunks: (.[2] | tonumber), resolution: .[3]})' "$tsv")"
  facts_set scripted "$(jq -n -c --argjson removed "$removed" --argjson new "$ci_new" --argjson lock "$lock_state" \
    --argjson wins "$(jq -R -s -c 'split("\n") | map(select(length > 0))' "$restored")" \
    '{upstream_ci_removed: $removed, upstream_ci_new: $new, our_wins_restored: $wins, lockfile: $lock}')"
  facts_set caveats '[]'
  [ "$lock_state" = null ] || caveat "pnpm-lock.yaml conflicted: took upstream's file and ran pnpm install --lockfile-only. Check the lockfile diff."
  [ "$repoint_failed" = false ] || caveat "The import repoint script failed (repoint.err in the round-0 artifact); imports of files upstream moved were NOT repointed, so expect cannot-find-module errors."
  facts_set repointed "$(jq -c '{imports: .repointed, files: (.edited | length), unresolved: (.unresolved | length)}' "$repointed")"
  if [ "$(jq '.repointed' "$repointed")" -gt 0 ]; then
    caveat "A script (no model) repointed $(jq '.repointed' "$repointed") import(s) in $(jq '.edited | length' "$repointed") of our file(s) at files upstream moved; the list is repointed-imports.json in the round-0 artifact."
  fi
  if [ "$(jq '.unresolved | length' "$repointed")" -gt 0 ]; then
    caveat "$(jq '.unresolved | length' "$repointed") import(s) in our files name a file upstream moved or removed that the script could not follow (no exact rename, no single same-named new file); typecheck lists them. First: $(jq -r '[.unresolved[:5][] | "\(.path) imports \(.spec)"] | join("; ")' "$repointed")"
  fi
  local g
  while IFS= read -r g; do
    generated_path "$g" && caveat "Generated file $g conflicted: upstream's version was taken. If a customization changes its inputs, regenerate it with the matching pnpm run generate:* script."
  done < "$theirs_list"
  true

  gh_out outcome "$outcome"
  gh_out conflicts "$(printf '%s' "$remaining" | grep -c . || true)"
  log "merge outcome: $outcome (git merge exit $merge_rc; $removed upstream CI paths dropped; remaining conflicts: $(printf '%s' "$remaining" | grep -c . || true))"
  if [ "$outcome" != conflicts ]; then
    cmd_finish_core "$(subject_for_commit)"
  fi
}

subject_for_commit() { printf 'Merge upstream %s into %s' "$(facts_get .tag)" "$(facts_get .base_branch)"; }

# ---------------------------------------------------------------------------------------------- finish
# discard_agent_edits [--repair]: throw away everything the model step did and rebuild the pre-agent state. Used when
# `agent-round.sh run` found the API key in the round's output. The index still holds the merge as `start` left it
# (the model has no command that writes the index), so: files without a conflict go back to their staged content,
# conflicted files go back to their conflict markers, files the model created are removed. A repair round starts from a
# committed candidate, so it is simply that commit again.
# `git checkout -m` rebuilds each conflict from the three index stages. Git may split the hunks of a large file differently
# from the original `git merge` (seen on one file of a real sync: 1 hunk became 2) and it labels the markers ours/theirs;
# the conflict is the same. pick-round never prefers such a candidate to the merge job's own unresolved one.
discard_agent_edits() {
  local p
  if [ -n "${1:-}" ]; then
    git reset -q --hard HEAD
  else
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      git checkout -q -- "$p" 2>/dev/null || true
    done < <(git diff --name-only --diff-filter=u)
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      git -c merge.conflictStyle=zdiff3 checkout -q -m -- "$p" 2>/dev/null || git checkout -q --ours -- "$p" 2>/dev/null || rm -f -- "$p"
    done < <(list_unmerged)
  fi
  git clean -q -f -d
}

# cmd_finish_core SUBJECT [--repair]
cmd_finish_core() {
  local subject="$1" repair="${2:-}"
  sync_out
  set_git_identity
  local facts="$SYNC_OUT/sync-facts.json" base_sha link_sha branch upstream_sha
  base_sha="$(facts_get .base_sha)"; link_sha="$(facts_get .link_sha)"
  branch="$(facts_get .branch)"; upstream_sha="$(facts_get .upstream_sha)"

  # Files the agent may change. Resolve round: exactly the files the merge left conflicted. Repair round (after real
  # gate output): those plus the files our customization commits own. Never fork infrastructure (custom/**,
  # .github/**, our-wins paths) and never upstream CI, whatever the model says.
  local allowed="$SYNC_OUT/allowed-files.txt" allowed_edit="$SYNC_OUT/allowed-edit-files.txt"
  jq -r '.conflicts[] | select(.resolution == "pending" or .resolution == "agent" or .resolution == "unresolved") | .path' "$facts" | sort -u > "$allowed"
  cp "$allowed" "$allowed_edit"
  if [ -n "$repair" ]; then
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      if our_wins_path "$p" || foreign_ci_path "$p"; then continue; fi
      printf '%s\n' "$p" >> "$allowed_edit"
    done < "$SYNC_OUT/our-files.txt"
    sort -u -o "$allowed_edit" "$allowed_edit"
  fi

  # 0. The model step found the API key in this round's output (AGENT_KEY_LEAK=1, set by agent-round.sh finish): every
  #    edit is discarded, so nothing the model wrote, and no copy of the key, can reach the candidate. The round is
  #    unresolved whatever the files look like now.
  local key_leak=false
  if [ "${AGENT_KEY_LEAK:-0}" = 1 ]; then
    key_leak=true
    discard_agent_edits "$repair"
  fi

  # 1. Scope: anything else the model touched is reverted and recorded.
  local oos="$SYNC_OUT/out-of-scope.txt" p
  : > "$oos"
  local diff_against=""
  if [ -n "$repair" ]; then diff_against=HEAD; fi
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if ! grep -qxF -- "$p" "$allowed_edit"; then
      git checkout -q -- "$p" 2>/dev/null || git checkout -q HEAD -- "$p"
      printf '%s\n' "$p" >> "$oos"
    fi
  done < <(git diff --name-only --diff-filter=u $diff_against | sort -u)
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    rm -rf -- "$p"
    printf '%s\n' "$p" >> "$oos"
  done < <(git ls-files --others --exclude-standard)
  if [ -s "$oos" ]; then
    facts_set out_of_scope "$(jq -R -s -c 'split("\n") | map(select(length > 0))' "$oos")"
    caveat "The agent changed $(wc -l < "$oos" | tr -d ' ') file(s) it was not allowed to touch; they were reset: $(paste -sd' ' "$oos")"
  fi

  # 1b. Repair round: edits to files that were NOT conflicted must keep the file present, marker-free and valid. The ones that
  #     stay are recorded (facts.repair_edits, kept across rounds): the PR's resolution diff covers only the conflicted
  #     files, and a model can make a gate pass by weakening a test, so the reviewer is told which other files it changed.
  if [ -n "$repair" ]; then
    local kept="$SYNC_OUT/repair-edits.txt"
    : > "$kept"
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      grep -qxF -- "$p" "$allowed" && continue
      if [ ! -f "$p" ] || has_markers "$p" || { [[ "$p" == *.json ]] && ! jq empty "$p" >/dev/null 2>&1; }; then
        git checkout -q HEAD -- "$p"
        caveat "A repair edit to $p left it missing, with conflict markers or invalid JSON; the edit was reverted."
      else
        git add --sparse -- "$p"
        printf '%s\n' "$p" >> "$kept"
      fi
    done < <(git diff --name-only $diff_against | sort -u)
    facts_set repair_edits "$(jq -R -s -c --argjson prev "$(jq -c '.repair_edits // []' "$facts")" 'split("\n") | map(select(length > 0)) | $prev + . | unique' "$kept")"
  fi

  # 2. Resolution state of every file the merge left to a model/human.
  local unresolved=() kind res drop
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    kind="$(jq -r --arg p "$p" '.conflicts[] | select(.path == $p) | .kind' "$facts")"
    res=ok; drop=false
    if [ "$key_leak" = true ]; then res="the agent's output contained the API key; its edits were discarded"
    elif [ "$kind" != content ] && [ "$kind" != both-added ]; then
      # Modify/delete, and every other kind without markers (a rename conflict, a file placed by git): the file in the tree is one
      # side's version. The agent keeps it (untouched or edited to fit upstream), or replaces it with the delete sentinel; a file
      # that is already gone (a repair of a candidate that dropped it) stays dropped. No kind is left to a human.
      if [ ! -e "$p" ] || is_delete_request "$p"; then drop=true
      elif has_markers "$p"; then res="conflict markers remain"
      fi
    elif [ ! -f "$p" ]; then res="file is missing"
    elif is_delete_request "$p"; then res="$DELETE_SENTINEL was written to a file that upstream still has"
    elif has_markers "$p"; then res="conflict markers remain"
    elif [[ "$p" == *.json ]] && ! jq empty "$p" >/dev/null 2>&1; then res="no longer valid JSON"
    fi
    if [ "$res" = ok ]; then
      conflict_set "$p" agent
      if [ "$kind" != content ] && [ "$kind" != both-added ]; then conflict_decision "$p" "$([ "$drop" = true ] && echo deleted || echo kept)"; fi
    else
      conflict_set "$p" unresolved
      unresolved+=("$p")
      log "UNRESOLVED $p: $res"
    fi
    if [ "$drop" = true ]; then git rm --sparse -q -f --ignore-unmatch -- "$p"
    elif [ -e "$p" ]; then git add --sparse -- "$p"
    else git rm --sparse -q -f --ignore-unmatch -- "$p"; fi
  done < "$allowed"

  # Lockfile follow-up when package.json was part of the conflict.
  if [ "$(facts_get .lockfile_pending)" = true ] && [ "${#unresolved[@]}" -eq 0 ] && [ "$key_leak" != true ]; then
    regen_lockfile
    git add --sparse -- pnpm-lock.yaml
    facts_set lockfile_pending false
    caveat "pnpm-lock.yaml was regenerated after package.json was merged. Check the lockfile diff."
  fi

  local is_unresolved=false
  if [ "${#unresolved[@]}" -gt 0 ] || [ "$key_leak" = true ]; then
    is_unresolved=true
    printf 'This branch contains UNRESOLVED merge conflicts.\nDo not merge it. Resolve the files below, delete this file, commit and push.\n\n' > custom/UNRESOLVED-MERGE.txt
    if [ "$key_leak" = true ]; then printf 'The cloud agent output contained its API key, so every edit it made was discarded.\n\n' >> custom/UNRESOLVED-MERGE.txt; fi
    printf '%s\n' ${unresolved[@]+"${unresolved[@]}"} >> custom/UNRESOLVED-MERGE.txt
    git add --sparse -- custom/UNRESOLVED-MERGE.txt
    subject="Merge upstream $(facts_get .tag) into $(facts_get .base_branch) (UNRESOLVED conflicts, do not merge)"
  elif git cat-file -e "HEAD:custom/UNRESOLVED-MERGE.txt" 2>/dev/null; then
    git rm --sparse -q -f -- custom/UNRESOLVED-MERGE.txt # a repair round resolved what an earlier round left open
  fi
  facts_set unresolved "$is_unresolved"
  facts_set key_leak "$key_leak"
  facts_set unresolved_files "$(printf '%s\n' ${unresolved[@]+"${unresolved[@]}"} | jq -R -s -c 'split("\n") | map(select(length > 0))')"

  # 3. Commit: a merge commit with the same two parents, whatever route led here.
  write_commit_message "$SYNC_OUT/commit-message.txt" "$subject"
  local tree merge_sha
  tree="$(git write-tree)"
  merge_sha="$(git commit-tree "$tree" -p "$base_sha" -p "$link_sha" -F "$SYNC_OUT/commit-message.txt")"
  git reset -q --hard "$merge_sha"
  facts_set merge_sha "$(jq -Rn --arg v "$merge_sha" '$v')"

  # Files that differ from the upstream tag although no patch touched them (a rename that carried our edit,
  # a contributor change): informational, shown to the reviewer.
  local drift
  drift="$(git diff --name-only --no-renames "$upstream_sha" "$merge_sha" | sort -u \
    | grep -vxF -f "$SYNC_OUT/our-files.txt" | while IFS= read -r p; do foreign_ci_path "$p" || our_wins_path "$p" || printf '%s\n' "$p"; done || true)"
  facts_set drift "$(printf '%s\n' "$drift" | jq -R -s -c 'split("\n") | map(select(length > 0))')"

  # 4. Hand the commit to the next job: only objects that are new (upstream's and the base's are fetched there).
  git bundle create "$SYNC_OUT/merge.bundle" "$branch" "^$base_sha" "^$upstream_sha" >&2
  gh_out merge_sha "$merge_sha"
  gh_out unresolved "$is_unresolved"
  log "committed $merge_sha on $branch (unresolved=$is_unresolved)"
}

cmd_finish() {
  local repair=""
  [ "${1:-}" != "--repair" ] || repair=--repair
  [ -n "$repair" ] || [ -f "$(git rev-parse --git-path MERGE_HEAD)" ] || die "finish: not in the middle of the merge (run start first, or use --repair)"
  cmd_finish_core "$(subject_for_commit)" "$repair"
}

case "${1:-}" in
  start) cmd_start ;;
  finish) shift; cmd_finish "$@" ;;
  *) die "usage: sync-merge.sh start|finish [--repair]" ;;
esac
