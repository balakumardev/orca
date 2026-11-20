#!/usr/bin/env bash
# Install the oxfmt version the merged lockfile pins, OUTSIDE the work tree, for `finish` to format our files with
# (format-our-files.sh). Runs after the model step and has no API key. It never reads a config the model could have written:
# a fresh HOME, no user or global npm config, the public registry, no lifecycle scripts.
#
# Env: SYNC_OUT (holds oxfmt-version.txt, written by agent-round.sh prepare), OXFMT_DIR (where to install).
# Output: the step output `bin` (the formatter's path). No version, or an install that does not work, prints nothing and exits
# 0: the format gate then decides, as it did before this step existed.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${SYNC_OUT:?}" "${OXFMT_DIR:?}"
ver="$(cat "$SYNC_OUT/oxfmt-version.txt" 2>/dev/null || true)"
if [ -z "$ver" ]; then log "no oxfmt version recorded; files are not formatted"; exit 0; fi
case "$ver" in *[!0-9A-Za-z.+-]*) log "unexpected oxfmt version text; files are not formatted"; exit 0 ;; esac

mkdir -p "$OXFMT_DIR/home"
(
  cd "$OXFMT_DIR"
  [ -f package.json ] || printf '{"private":true}\n' > package.json
  env -i PATH="$PATH" HOME="$OXFMT_DIR/home" npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null \
    npm install --no-audit --no-fund --ignore-scripts --registry https://registry.npmjs.org/ "oxfmt@$ver" >&2
) || { log "oxfmt $ver did not install; files are not formatted"; exit 0; }

bin="$OXFMT_DIR/node_modules/.bin/oxfmt"
if [ -x "$bin" ] && "$bin" --version >/dev/null 2>&1; then
  log "formatter: oxfmt $ver at $bin"
  gh_out bin "$bin"
else
  log "oxfmt $ver installed but does not run; files are not formatted"
fi
exit 0
