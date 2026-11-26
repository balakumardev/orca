#!/usr/bin/env bash
# Where the cloud agent's shell commands run. The agent may run pnpm, vitest, tsc and oxfmt, which means running upstream's test code and
# its own edits. That code must never be able to reach the API key, so the agent works on a COPY of the checkout, as an unprivileged
# OS user with no sudo, and the key stays with the runner user (agent-round.sh run, agent-key-proxy.mjs). Neither the real work tree nor
# its .git is touched while the agent runs; only the CONTENTS of files are copied back, by this script, with no key present.
#
#   agent-sandbox.sh setup     in the work tree: create the user, install pnpm for it, copy the tree, install dependencies as that user,
#                              and install the stop check (agent-stop-check.sh) that Claude Code runs when the agent tries to end its turn
#   agent-sandbox.sh collect   in the work tree: copy back the files the agent changed, created or deleted
#   agent-sandbox.sh install-stop-hook [0|1]   only the stop check part of setup (1 = dependencies are installed, the default); prints the
#                              `stop_hook` object that setup puts in sandbox.json. The tests use it.
#
# Env: SYNC_OUT (receives sandbox.json and sandbox-collect.json), AGENT_SANDBOX_DIR (default /opt/agent-sandbox), AGENT_TOOLS_DIR
# (default /opt/agent-tools, root-owned: the agent cannot change what it holds), AGENT_USER (default agentrun), AGENT_SANDBOX_SUDO
# (default sudo; `none` skips every privilege change, for tests that only exercise the copy logic), AGENT_CLAUDE_MANAGED_DIR (default
# /etc/claude-code, root-owned: Claude Code's managed settings directory, where the stop check is registered).
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${SYNC_OUT:?}"
AGENT_SANDBOX_DIR="${AGENT_SANDBOX_DIR:-/opt/agent-sandbox}"
AGENT_TOOLS_DIR="${AGENT_TOOLS_DIR:-/opt/agent-tools}"
AGENT_USER="${AGENT_USER:-agentrun}"
AGENT_CLAUDE_MANAGED_DIR="${AGENT_CLAUDE_MANAGED_DIR:-/etc/claude-code}"
SCRIPTS_HERE="$(cd "$(dirname "$0")" && pwd)"
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

# The stop check (agent-stop-check.sh): a command hook that Claude Code runs when the agent tries to end its turn and that refuses the stop
# while a cheap deterministic check is red (its own bounds are in that script). Files and registration are ROOT-OWNED, so the agent (another
# OS user, no sudo) can neither edit the script, its inputs nor the registration; only its state directory is the agent's.
#   - the hook directory $AGENT_TOOLS_DIR/stop-hook: the script, lib.sh, gate-details.sh, lint-caps.mjs, files.tsv (the files the round may
#     edit, written by agent-round.sh prepare) and hook.conf (state dir, whether dependencies exist, the upstream commit);
#   - the registration: $AGENT_CLAUDE_MANAGED_DIR/managed-settings.json. NOT `--settings`: the run uses --safe-mode, which switches off every
#     hook that comes from `--settings` (measured with the pinned CLI, 2.1.325), while the managed settings, which --safe-mode documents as
#     still applying, do run hooks.
# It never fails the setup: a problem leaves the agent without the stop check and the reason in sandbox.json.
install_stop_hook_core() { # DEPS(0|1): prints the stop_hook object, or the reason on a failure
  local deps="$1" hook_dir="$AGENT_TOOLS_DIR/stop-hook" state_dir="$AGENT_SANDBOX_DIR/stop-hook-state" settings="$AGENT_CLAUDE_MANAGED_DIR/managed-settings.json"
  local stage up="" f
  case "$hook_dir$state_dir$settings" in *[!A-Za-z0-9_./-]*) echo "an unsafe character in a path"; return 1 ;; esac
  if as_root test -e "$settings"; then echo "a managed settings file already exists at $settings"; return 1; fi
  stage="$(mktemp -d)"
  for f in agent-stop-check.sh lib.sh gate-details.sh lint-caps.mjs; do cp "$SCRIPTS_HERE/$f" "$stage/$f" || { echo "cannot read $f"; return 1; }; done
  if [ -s "$SYNC_OUT/stop-check-files.tsv" ]; then cp "$SYNC_OUT/stop-check-files.tsv" "$stage/files.tsv"; else : > "$stage/files.tsv"; fi
  up="$(jq -r '.upstream_sha // ""' "$SYNC_OUT/sync-facts.json" 2>/dev/null || true)"
  [[ "$up" =~ ^[0-9a-f]{40}$ ]] || up=""
  # RUN_AS: the managed settings apply to every claude on the machine, so the hook does nothing unless it runs as the sandbox user (empty when
  # the privilege changes are switched off, in tests). REPO: the sandbox copy it checks, whatever directory the session is in.
  printf 'STATE_DIR=%s\nDEPS=%s\nUPSTREAM=%s\nREPO=%s\nRUN_AS=%s\n' "$state_dir" "$deps" "$up" "$AGENT_SANDBOX_DIR/repo" "$([ "${#SUDO[@]}" -eq 0 ] || printf '%s' "$AGENT_USER")" > "$stage/hook.conf"
  chmod 755 "$stage/agent-stop-check.sh"
  as_root rm -rf "$hook_dir" && as_root mkdir -p "$hook_dir" && as_root cp -R "$stage/." "$hook_dir/" || { echo "cannot install $hook_dir"; return 1; }
  [ "${#SUDO[@]}" -eq 0 ] || as_root chown -R root:root "$hook_dir"
  as_root chmod -R u=rwX,go=rX "$hook_dir"
  as_root mkdir -p "$state_dir" || { echo "cannot create $state_dir"; return 1; }
  [ "${#SUDO[@]}" -eq 0 ] || as_root chown "$AGENT_USER:$AGENT_USER" "$state_dir"
  jq -n -c --arg cmd "$hook_dir/agent-stop-check.sh" '{hooks: {Stop: [{hooks: [{type: "command", command: $cmd, timeout: 1500}]}]}}' > "$stage/managed-settings.json"
  as_root mkdir -p "$AGENT_CLAUDE_MANAGED_DIR" && as_root cp "$stage/managed-settings.json" "$settings" || { echo "cannot write $settings"; return 1; }
  [ "${#SUDO[@]}" -eq 0 ] || as_root chown root:root "$settings"
  as_root chmod 644 "$settings"
  rm -rf "$stage"
  as_agent sh -c 'test -x "$1" && test -r "$2" && test -w "$3"' _ "$hook_dir/agent-stop-check.sh" "$settings" "$state_dir" || { echo "the agent user cannot run the hook or write its state"; return 1; }
  jq -n -c --arg hook "$hook_dir/agent-stop-check.sh" --arg settings "$settings" --arg state "$state_dir" '{installed: true, hook: $hook, settings: $settings, state_dir: $state}'
}
install_stop_hook() { # DEPS(0|1): the stop_hook object of sandbox.json, always
  local out
  if out="$(install_stop_hook_core "${1:-1}")" && jq -e '.installed == true' <<<"$out" >/dev/null 2>&1; then printf '%s\n' "$out"
  else
    log "the stop check was not installed: ${out:-unknown reason}"
    jq -n -c --arg why "$(printf '%s' "${out:-unknown reason}" | tr -d '\000-\037' | trunc_bytes 300)" '{installed: false, why: $why}'
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
  local stop_hook
  stop_hook="$(install_stop_hook "$([ "$deps" = true ] && echo 1 || echo 0)")"
  jq -n -c --arg user "$AGENT_USER" --arg repo "$sb" --arg path "$(agent_path)" --argjson deps "$deps" --argjson stop "$stop_hook" \
    '{user: $user, repo: $repo, path: $path, dependencies_installed: $deps, stop_hook: $stop}' > "$SYNC_OUT/sandbox.json"
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
  install-stop-hook) install_stop_hook "${2:-1}" ;;
  *) die "usage: agent-sandbox.sh setup|collect|install-stop-hook [0|1]" ;;
esac
