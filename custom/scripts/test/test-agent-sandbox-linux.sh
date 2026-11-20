#!/usr/bin/env bash
# MANUAL test (not run by CI): proves, in a real Linux container, that the cloud agent's sandbox keeps the API key out of reach and that the
# flow works end to end with a stub model CLI. The stub-based tests (test-agent-round-sandbox.sh, test-agent-sandbox-collect.sh) use a fake
# sudo and prove only the shell logic; they cannot prove the OS-user separation. This one can.
#
# Needs: docker running (OrbStack or Docker Desktop: `orbctl start`), network (apt, nodejs.org, the npm registry, and one request that
# carries a FAKE key to the real DeepInfra endpoint through the proxy), and about 1 to 2 minutes with a warm image cache (up to 5 on a cold one). It creates ONE container from ubuntu:24.04
# (pulling the image if it is missing) and removes that container when it ends, however it ends. It touches no other container, image or
# volume, and no real secret: every key in it is a fresh random fake. The container follows the host's CPU architecture.
#
# What runs inside (custom/scripts/test/agent-sandbox-linux-inside.sh): a `runner` user with passwordless sudo and node 24 in a
# hostedtoolcache-like directory, a small fixture git repo as the work tree, then
#   A setup (agent-sandbox.sh): the agentrun user, root-owned /opt/agent-tools, the sandbox copy, the install as agentrun
#   B isolation: ~40 attempts as agentrun to find the key (proc, ps, grep, ptrace, sudo, files, writes, kill, the proxy itself)
#   C agent-round.sh run + agent-sandbox.sh collect with a stub `claude`: edits, a new file and a deletion reach the real tree, .git is
#     untouched, ignored files and node_modules do not, no process is left, the proxy is gone, the key is in no file
#   C2 collect against chmod-000 dirs, symlinks, a fifo, a setuid file, a newline in a name, a file turned into a directory
#   D the wall clock (exit 124), a CLI that ignores SIGTERM, a process that outruns a single pkill (random: 0 to 3 of 10 rounds)
#   E umask, sudo's PATH, npm cache ownership, copy and chown timing
# Output: ok / FAIL / GAP / info lines. FAIL = something that must hold does not (exit 1). GAP = a robustness hole that is not a key leak.
#
# Run: bash custom/scripts/test/test-agent-sandbox-linux.sh        (KEEP_CONTAINER=1 leaves the container for debugging; it names it)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
command -v docker >/dev/null 2>&1 || { echo "missing tool: docker"; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker is not running (OrbStack: orbctl start)"; exit 2; }

pin="$(sed -n 's/^  "packageManager": "\(pnpm@[^"]*\)".*/\1/p' "$repo_root/package.json")"
[ -n "$pin" ] || { echo "package.json has no packageManager pin"; exit 2; }

name="orca-agent-sandbox-linux-$$"
cleanup() {
  if [ "${KEEP_CONTAINER:-0}" = 1 ]; then echo "container left running: docker rm -f $name"
  else docker rm -f "$name" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

inside() { docker exec -e ORCA_SANDBOX_TEST_CONTAINER=1 -e PNPM_PIN="$pin" "$name" bash /stage/custom/scripts/test/agent-sandbox-linux-inside.sh "$@"; }

t0="$(date +%s)"
echo "container $name (ubuntu:24.04, --init so killed processes are reaped)"
docker run -d --init --name "$name" ubuntu:24.04 sleep infinity >/dev/null
docker exec "$name" mkdir -p /stage
docker cp "$repo_root/custom" "$name:/stage/custom"

echo "provisioning (apt, node 24, runner user, pnpm $pin)..."
inside provision | sed 's/^/  /'
t1="$(date +%s)"
rc=0
inside checks || rc=$?
t2="$(date +%s)"

echo
echo "provisioning $((t1 - t0))s, checks $((t2 - t1))s, total $((t2 - t0))s"
if [ "$rc" = 0 ]; then echo "all required checks passed (GAP lines are robustness findings, see above)"; else echo "FAILED: see the FAIL lines above"; fi
exit "$rc"
