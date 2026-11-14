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
    custom/*|.github/pull_request_template.md|CUSTOM.md) return 0 ;;
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

# Generated files are never merged by hand or by a model: upstream's version wins and the reviewer is told.
generated_path() {
  case "$1" in
    *.generated.*|*/generated/*) return 0 ;;
  esac
  return 1
}
