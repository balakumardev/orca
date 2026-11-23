#!/usr/bin/env bash
# Where the cloud agent's shell commands run. The agent may run pnpm, vitest, tsc and oxfmt, which means running upstream's test code and
# its own edits. That code must never be able to reach the API key, so the agent works on a COPY of the checkout, as an unprivileged
# OS user with no sudo, and the key stays with the runner user (agent-round.sh run, agent-key-proxy.mjs). Neither the real work tree nor
# its .git is touched while the agent runs; only the CONTENTS of files are copied back, by this script, with no key present.
#
#   agent-sandbox.sh setup     in the work tree: create the user, install pnpm for it, copy the tree, install dependencies as that user
#   agent-sandbox.sh collect   in the work tree: copy back the files the agent changed, created or deleted
#
# Env: SYNC_OUT (receives sandbox.json and sandbox-collect.json), AGENT_SANDBOX_DIR (default /opt/agent-sandbox), AGENT_TOOLS_DIR
# (default /opt/agent-tools, root-owned: the agent cannot change what it holds), AGENT_USER (default agentrun), AGENT_SANDBOX_SUDO
# (default sudo; `none` skips every privilege change, for tests that only exercise the copy logic).
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${SYNC_OUT:?}"
AGENT_SANDBOX_DIR="${AGENT_SANDBOX_DIR:-/opt/agent-sandbox}"
AGENT_TOOLS_DIR="${AGENT_TOOLS_DIR:-/opt/agent-tools}"
AGENT_USER="${AGENT_USER:-agentrun}"
SUDO=()
[ "${AGENT_SANDBOX_SUDO:-sudo}" = none ] || SUDO=(sudo -n)
sync_out

as_root() { "${SUDO[@]+"${SUDO[@]}"}" "$@"; }

# The PATH the agent gets: our pnpm first, then the directory of the node that actions/setup-node installed (it also holds the CLI), then
# the system directories. Nothing from the runner user's home.
agent_path() { printf '%s' "$AGENT_TOOLS_DIR/bin:$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin"; }

as_agent() { # CMD...: run as the unprivileged user with an empty environment but what a build needs
  if [ "${#SUDO[@]}" -gt 0 ]; then
    "${SUDO[@]}" -u "$AGENT_USER" -H env -i PATH="$(agent_path)" HOME="/home/$AGENT_USER" LANG=C.UTF-8 TMPDIR=/tmp CI=true "$@"
  else
    env -i PATH="$(agent_path)" HOME="${HOME:-/tmp}" LANG=C.UTF-8 TMPDIR=/tmp CI=true "$@"
  fi
}

cmd_setup() {
  local repo sb pnpm_ver deps=true
  # A round with nothing for the model to do never calls it: no sandbox, no install.
  if [ "$(jq -r '.skip // false' "$SYNC_OUT/agent-plan.json" 2>/dev/null || echo false)" = true ]; then log "nothing for the agent to do; no sandbox"; return 0; fi
  repo="$(pwd -P)"
  [ -d "$repo/.git" ] || die "setup runs in the work tree"
  sb="$AGENT_SANDBOX_DIR/repo"

  if ! as_root id -u "$AGENT_USER" >/dev/null 2>&1; then as_root useradd --create-home --shell /bin/bash "$AGENT_USER"; fi

  # pnpm at the version the repo pins, installed by root under a root-owned prefix, so that the agent can run it but not replace it.
  pnpm_ver="$(jq -r '.packageManager // ""' package.json | sed -E 's/^pnpm@([^+]+).*/\1/')"
  case "$pnpm_ver" in ''|*[!0-9A-Za-z.+-]*) die "package.json does not pin a usable pnpm version: '$pnpm_ver'" ;; esac
  as_root env PATH="$PATH" npm install --global --prefix "$AGENT_TOOLS_DIR" --no-audit --no-fund "pnpm@$pnpm_ver" >&2

  as_root rm -rf "$AGENT_SANDBOX_DIR"
  as_root mkdir -p "$sb"
  as_root cp -a "$repo/." "$sb/"
  [ "${#SUDO[@]}" -eq 0 ] || as_root chown -R -h "$AGENT_USER:$AGENT_USER" "$AGENT_SANDBOX_DIR"

  # Dependencies, as the agent user: the install scripts and the pnpmfile of upstream's release run as a user that has no key, no sudo
  # and no write access to the runner's files. A failed install is not fatal: the agent can still edit and read.
  if ! as_agent bash -c 'cd "$1" && timeout 1200 sh -c "pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile"' _ "$sb" >&2; then
    deps=false
    log "dependencies did not install in the sandbox; the agent runs without the commands that need them"
  fi
  jq -n -c --arg user "$AGENT_USER" --arg repo "$sb" --arg path "$(agent_path)" --argjson deps "$deps" \
    '{user: $user, repo: $repo, path: $path, dependencies_installed: $deps}' > "$SYNC_OUT/sandbox.json"
  gh_out ready true
}

# Copy back what the agent changed. Regular files only, and only their content: a symlink is never copied or followed, a path that goes
# through a symlink of the real tree is skipped, ignored files (build output, caches) are skipped, node_modules and .git are not
# looked at. Runs with no key and does not trust the sandbox: it reads, it never executes anything from it.
# Does a directory component of R (relative, in the real work tree) exist as a symlink? Only components that exist can be one.
path_has_symlink() {
  local dir part cur="$real_phys" IFS=/
  dir="$(dirname -- "$1")"
  [ "$dir" != . ] || return 1
  for part in $dir; do
    cur="$cur/$part"
    [ -e "$cur" ] || [ -L "$cur" ] || return 1
    [ ! -L "$cur" ] || return 0
  done
  return 1
}

cmd_collect() {
  local real real_phys sb files ign todo safe copied=0 deleted=0 skipped=0 r src dst parent want t
  real="$(pwd -P)"; real_phys="$real"
  sb="$AGENT_SANDBOX_DIR/repo"
  if [ ! -d "$sb" ]; then log "no sandbox copy; nothing to collect"; return 0; fi
  # Whatever the agent left running is stopped, and every file becomes readable for the copy (the agent may have chmod'ed its own files).
  # Both as the agent user, never as root: root would be walking a tree the agent controls (a symlink swapped in by a process that
  # outlived the CLI), and the agent only needs to undo its own chmods. `kill -KILL -1` is one atomic signal to all of its processes.
  # Directories are changed one by one (-exec ... ;) so that a mode-000 directory is opened up BEFORE find tries to read it.
  if [ "${#SUDO[@]}" -gt 0 ]; then "${SUDO[@]}" -u "$AGENT_USER" kill -KILL -1 >/dev/null 2>&1 || true; fi
  as_agent find "$sb" \( -name node_modules -o -name .git \) -prune -o \( -type d -exec chmod a+rx {} \; \) -o \( -type f -exec chmod a+r {} + \) 2>/dev/null || true

  files="$(mktemp)"; ign="$(mktemp)"; todo="$(mktemp)"; safe="$(mktemp)"
  # One path per line. A path with a newline in it cannot be told apart from two paths: it is skipped, with a count. So is an unsafe path
  # and one that goes through a symlink of the real work tree (git check-ignore refuses the whole batch for such a path).
  while IFS= read -r -d '' r; do
    r="${r#./}"
    case "$r" in *$'\n'*) skipped=$((skipped + 1)); continue ;; esac
    [ "$r" != pnpm-lock.yaml ] || continue # the dependency install may rewrite it; no model edit of it is allowed anyway
    printf '%s\n' "$r"
  done < <(cd "$sb" && find . \( -name node_modules -o -name .git \) -prune -o -type f -print0) > "$files"
  while IFS= read -r r; do
    case "$r" in /*|..|../*|*/..|*/../*) skipped=$((skipped + 1)); log "skipped an unsafe path"; continue ;; esac
    if [ -L "$real/$r" ] || path_has_symlink "$r"; then skipped=$((skipped + 1)); log "skipped $r: a symlink in the work tree"; continue; fi
    printf '%s\n' "$r"
  done < "$files" > "$safe"
  # Ignored by the real work tree's rules (tracked files are never reported as ignored).
  { git check-ignore -z --stdin < <(tr '\n' '\0' < "$safe") 2>/dev/null || true; } | tr '\0' '\n' > "$ign"
  { grep -vxF -f "$ign" "$safe" || true; } > "$todo"

  while IFS= read -r r; do
    src="$sb/$r"; dst="$real/$r"
    if [ -f "$dst" ] && cmp -s -- "$src" "$dst"; then continue; fi
    # The agent turned a directory into a file, or a file into a directory: leave it to the reviewer, do not write into the wrong place.
    if [ -d "$dst" ]; then skipped=$((skipped + 1)); log "skipped $r: a directory in the work tree"; continue; fi
    if ! mkdir -p -- "$(dirname -- "$dst")" 2>/dev/null; then skipped=$((skipped + 1)); log "skipped $r: its parent is a file in the work tree"; continue; fi
    parent="$(cd "$(dirname -- "$dst")" && pwd -P)"
    want="$real_phys"; [ "$(dirname -- "$r")" = . ] || want="$real_phys/$(dirname -- "$r")"
    if [ "$parent" != "$want" ]; then skipped=$((skipped + 1)); log "skipped $r: the path goes through a symlink"; continue; fi
    cp -p -- "$src" "$dst.collect.tmp" && mv -f -- "$dst.collect.tmp" "$dst"
    copied=$((copied + 1))
  done < "$todo"

  # A tracked file the agent removed is removed here too (finish decides whether that is allowed).
  while IFS= read -r -d '' t; do
    if [ -f "$real/$t" ] && [ ! -L "$real/$t" ] && [ ! -e "$sb/$t" ] && [ ! -L "$sb/$t" ]; then
      rm -f -- "$real/$t"
      deleted=$((deleted + 1))
    fi
  done < <(git ls-files -z)

  jq -n -c --argjson copied "$copied" --argjson deleted "$deleted" --argjson skipped "$skipped" \
    '{copied: $copied, deleted: $deleted, skipped: $skipped}' > "$SYNC_OUT/sandbox-collect.json"
  rm -f "$files" "$ign" "$todo" "$safe"
  log "sandbox: copied back $copied file(s), deleted $deleted, skipped $skipped"
}

case "${1:-}" in
  setup) cmd_setup ;;
  collect) cmd_collect ;;
  *) die "usage: agent-sandbox.sh setup|collect" ;;
esac
