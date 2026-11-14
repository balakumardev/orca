#!/usr/bin/env bash
# Shared helpers for custom/scripts/*. Source it; never run it.
# Conventions: every script runs with the checked-out repo as the current directory, reads
# plain environment variables (never `${{ }}` text pasted into a command) and writes its
# machine-readable state to $SYNC_OUT (a directory outside the working tree).

set -euo pipefail

UPSTREAM_REPO="stablyai/orca"
UPSTREAM_URL="https://github.com/${UPSTREAM_REPO}.git"
# Only desktop releases: `mobile-android-v0.0.64` and friends are never merged.
export TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

log() { printf '%s\n' "$*" >&2; }
die() { printf '::error::%s\n' "$*" >&2; exit 1; }
notice() { printf '::notice::%s\n' "$*" >&2; }
warn() { printf '::warning::%s\n' "$*" >&2; }

# gh_out NAME VALUE: step output (stdout when not running in Actions, so tests can read it).
gh_out() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  else
    printf 'OUTPUT %s=%s\n' "$1" "$2"
  fi
}

# Refs and branch names that come from workflow inputs are untrusted text.
valid_ref() { [[ "$1" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] && [[ "$1" != -* ]] && [[ "$1" != *..* ]]; }

# semver_gt A B: true when A is a strictly higher version than B (leading v ignored).
semver_gt() {
  local a="${1#v}" b="${2#v}"
  [ "$a" != "$b" ] && [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -n 1)" = "$a" ]
}

# git identity for commits made by the automation (local config only).
set_git_identity() {
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
}

sync_out() { : "${SYNC_OUT:?SYNC_OUT must point at a directory outside the working tree}"; mkdir -p "$SYNC_OUT"; }

# facts_set KEY JSON_VALUE: set one top-level key in $SYNC_OUT/sync-facts.json.
facts_set() {
  sync_out
  local f="$SYNC_OUT/sync-facts.json" tmp
  [ -s "$f" ] || printf '{"schema":1}\n' > "$f"
  tmp="$(mktemp)"
  jq --arg k "$1" --argjson v "$2" '.[$k] = $v' "$f" > "$tmp" && mv "$tmp" "$f"
}

# facts_get JQ_EXPR: read from the facts file.
facts_get() { jq -r "$1" "$SYNC_OUT/sync-facts.json"; }

# Fetch upstream objects without blobs (the clone is blobless and stays that way).
fetch_upstream() {
  git remote get-url stablyai >/dev/null 2>&1 || git remote add stablyai "$UPSTREAM_URL"
  local spec
  for spec in "$@"; do
    git fetch --no-tags --filter=blob:none --quiet stablyai "$spec"
  done
}

# Does the file path match one of the "our side always wins" patterns?
our_wins_path() {
  case "$1" in
    custom/*|.github/pull_request_template.md|CUSTOM.md|CLAUDE.md|.claude/skills/fork-*) return 0 ;;
    .github/workflows/custom-*) return 0 ;;
  esac
  return 1
}

# Workflow files and dependabot config that upstream owns and the fork must not carry.
foreign_ci_path() {
  case "$1" in
    .github/workflows/custom-*) return 1 ;;
    .github/workflows/*|.github/dependabot.yml|.github/dependabot.yaml) return 0 ;;
  esac
  return 1
}

# strip_ansi: remove terminal colour codes from stdin (CI logs keep them).
strip_ansi() { perl -pe 's/\e\[[0-9;?]*[A-Za-z]//g'; }

# Conflict markers in a file. count_markers counts conflict HUNKS (one `<<<<<<<` start line per hunk; the `>>>>>>>` end
# line of the same hunk is not a second one). has_markers is the detection: any marker line at all, including the
# `|||||||` ancestor line of the zdiff3 style.
count_markers() { grep -a -c -E '^<<<<<<< ' -- "$1" 2>/dev/null || true; }
has_markers() { grep -a -q -E '^(<<<<<<<|>>>>>>>|\|\|\|\|\|\|\|) ' -- "$1" 2>/dev/null; }

# round_score ALL_DIR N: print how bad round N's candidate is (lower wins); return 1 when the round left no candidate (no
# sync-facts.json or no merge.bundle, e.g. its job crashed). ALL_DIR holds the downloaded round-N/ and gates-N-*/ directories.
# Score = number of failed gates. 1000 when the merge is unresolved or its gates never reported (any candidate that really
# passed or failed its gates beats it); 1001 when the round's output contained the API key (its edits were discarded).
round_score() {
  local all="$1" n="$2" d score=1000 g
  local -a files=()
  d="$all/round-$n"
  [ -s "$d/sync-facts.json" ] && [ -s "$d/merge.bundle" ] || return 1
  if [ "$(jq -r '.unresolved' "$d/sync-facts.json")" != true ]; then
    for g in "$all"/gates-"$n"-*/gates.json; do if [ -s "$g" ]; then files+=("$g"); fi; done
    if [ "${#files[@]}" -gt 0 ]; then score="$(jq -s '[.[].gates[] | select(.status == "fail")] | length' "${files[@]}")"; fi
  fi
  if [ "$(jq -r '.key_leak // false' "$d/sync-facts.json")" = true ]; then score=1001; fi
  printf '%s\n' "$score"
}

# Generated files are never merged by hand or by a model: upstream's version wins and the reviewer is told.
generated_path() {
  case "$1" in
    *.generated.*|*/generated/*) return 0 ;;
  esac
  return 1
}

# regen_lockfile: reconcile pnpm-lock.yaml with package.json, run from the repository root. Upstream's pnpmfile
# (config/pnpmfile.cjs, .pnpmfile.cjs) is JavaScript that pnpm executes during resolution (measured: a hostile pnpmfile
# runs under a plain `--lockfile-only`), so it is ignored, together with lifecycle scripts. pnpm still READS package.json
# (including `packageManager`), pnpm-workspace.yaml (including configDependencies) and .npmrc from the merged tree.
# Ignoring it makes pnpm drop the `pnpmfileChecksum:` line from the lockfile, and `pnpm install --frozen-lockfile`
# (the install gate, the release build) refuses a lockfile whose checksum does not match the pnpmfile. So the line is
# put back, computed here: pnpm's value is `sha256-` + base64 of the sha256 of the file's bytes.
regen_lockfile() {
  pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile --no-frozen-lockfile >&2
  local pf sum
  pf="$(sed -n -E "s/^pnpmfile:[[:space:]]*[\"']?([^\"'#[:space:]]+).*/\\1/p" pnpm-workspace.yaml 2>/dev/null | head -n 1)"
  [ -n "$pf" ] || pf=.pnpmfile.cjs
  [ -f "$pf" ] || return 0
  sum="sha256-$(openssl dgst -sha256 -binary "$pf" | base64 | tr -d '\n')"
  # The lockfile can hold several YAML documents; the project's is the last one. The line goes before the first of the
  # keys pnpm writes after it, with a blank line after it, exactly where pnpm itself writes it.
  awk -v sum="$sum" '
    { line[NR] = $0; if ($0 ~ /^lockfileVersion:/) last = NR }
    END {
      for (i = 1; i <= NR; i++) {
        if (i > last && line[i] ~ /^pnpmfileChecksum:/) { print "pnpmfileChecksum: " sum; done = 1; continue }
        if (!done && i > last && line[i] ~ /^(patchedDependencies|importers|packages|snapshots):/) { print "pnpmfileChecksum: " sum; print ""; done = 1 }
        print line[i]
      }
    }' pnpm-lock.yaml > pnpm-lock.yaml.new && mv pnpm-lock.yaml.new pnpm-lock.yaml
}
