#!/usr/bin/env bash
# Test for agent-sandbox.sh collect: what is copied back from the agent's scratch copy and what is not. No privilege changes
# (AGENT_SANDBOX_SUDO=none), so it runs anywhere. The user, the install and the key proxy are covered by the container test.
# Run: bash custom/scripts/test/test-agent-sandbox-collect.sh   (needs git, jq, find, cmp)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
for tool in git jq find cmp; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'chmod -R u+rwx "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

real="$tmp/real"; sbdir="$tmp/sandbox"; out="$tmp/out"
mkdir -p "$real/src/deep" "$real/custom" "$out"
cd "$real"
git init -q -b main .
printf 'ignored.log\ncache/\n' > .gitignore
printf 'a\n' > src/a.ts
printf 'b\n' > src/b.ts
printf 'c\n' > src/deep/c.ts
printf 'untouched\n' > src/untouched.ts
printf 'lock\n' > pnpm-lock.yaml
printf 's\n' > src/swap.ts                                    # tracked file the agent will turn into a directory
mkdir -p src/dirx && printf 'i\n' > src/dirx/inner.ts           # tracked directory the agent will turn into a file
printf 'secret-config\n' > custom/keep.txt
ln -s src/a.ts link-to-a
mkdir -p linked-dir-target && printf 'victim\n' > linked-dir-target/victim.txt
ln -s linked-dir-target real-symlink-dir
git add -A && git commit -q -m base

# The sandbox is a copy, as setup makes it; then the "agent" works in it.
mkdir -p "$sbdir"; cp -a "$real" "$sbdir/repo"
sb="$sbdir/repo"
printf 'a edited\n' > "$sb/src/a.ts"                       # modified
printf 'new\n' > "$sb/src/new-file.ts"                      # created
mkdir -p "$sb/src/newdir" && printf 'n\n' > "$sb/src/newdir/n.ts"  # created in a new directory
rm "$sb/src/b.ts"                                           # deleted
printf 'junk\n' > "$sb/ignored.log"                         # ignored by the real .gitignore
mkdir -p "$sb/cache" && printf 'junk\n' > "$sb/cache/x"     # ignored directory
mkdir -p "$sb/node_modules/pkg" && printf 'x\n' > "$sb/node_modules/pkg/index.js"
printf 'in git dir\n' > "$sb/.git/planted"
ln -s /etc/hostname "$sb/src/planted-link"                  # a symlink the agent made
rm "$sb/real-symlink-dir"; mkdir "$sb/real-symlink-dir"; printf 'through\n' > "$sb/real-symlink-dir/victim.txt"   # a real directory where the real tree has a symlink to one
printf 'x\n' > "$sb/link-to-a-new"; rm "$sb/link-to-a"; printf 'replaced a link\n' > "$sb/link-to-a"   # a file where the real tree has a symlink
printf 'locked\n' > "$sb/src/locked.ts"; chmod 000 "$sb/src/locked.ts"                      # unreadable until collect fixes it
printf 'exec\n' > "$sb/src/run.sh"; chmod 755 "$sb/src/run.sh"
rm "$sb/src/swap.ts"; mkdir "$sb/src/swap.ts"; printf 'inside\n' > "$sb/src/swap.ts/inside.ts"   # file -> directory
rm -r "$sb/src/dirx"; printf 'now a file\n' > "$sb/src/dirx"                                  # directory -> file
mkdir "$sb/src/lockeddir" && printf 'ld\n' > "$sb/src/lockeddir/file.ts"; chmod 000 "$sb/src/lockeddir"   # a directory nobody can read
printf 'edit\n' > "$sb/custom/keep.txt"
printf 'lock rewritten by the install\n' > "$sb/pnpm-lock.yaml"

cd "$real"
SYNC_OUT="$out" AGENT_SANDBOX_SUDO=none AGENT_SANDBOX_DIR="$sbdir" bash "$scripts/agent-sandbox.sh" collect >"$tmp/collect.log" 2>&1 || { cat "$tmp/collect.log"; bad "collect exited non-zero"; }

echo "collect"
check "a modified file is copied back" test "$(cat src/a.ts)" = "a edited"
check "a created file is copied back" test "$(cat src/new-file.ts)" = new
check "a file in a new directory is copied back" test "$(cat src/newdir/n.ts)" = n
check "a deleted tracked file is deleted" test ! -e src/b.ts
check "an untouched file stays" test "$(cat src/untouched.ts)" = untouched
check "an ignored file is not copied" test ! -e ignored.log
check "an ignored directory is not copied" test ! -e cache
check "node_modules is not copied" test ! -e node_modules
check "nothing from the sandbox's .git is copied" test ! -e .git/planted
check "a symlink the agent made is not copied" test ! -e src/planted-link -a ! -L src/planted-link
check "a write through a symlink of the real tree is refused" test "$(cat linked-dir-target/victim.txt)" = victim
check "a file the agent placed where the real tree has a symlink is refused" test -L link-to-a
check "a file the agent made unreadable is still copied" test "$(cat src/locked.ts)" = locked
check "the executable bit survives" test -x src/run.sh
check "a tracked file the agent turned into a directory is skipped, the real file stays" test "$(cat src/swap.ts)" = s
check "a tracked directory the agent turned into a file leaves no junk behind" test ! -e src/dirx/dirx.collect.tmp
check "a directory the agent made unreadable is opened up and its file copied" test "$(cat src/lockeddir/file.ts)" = ld
check "a changed fork file is copied too (finish enforces scope, not this script)" test "$(cat custom/keep.txt)" = edit
check "pnpm-lock.yaml is never copied back" test "$(cat pnpm-lock.yaml)" = lock
check "the real .git is untouched: the tracked list is the same" test "$(git ls-files | wc -l | tr -d ' ')" = 12
check "the summary counts what happened" jq -e '.copied >= 6 and .deleted >= 1 and .skipped >= 4' "$out/sandbox-collect.json"

echo "collect with nothing to do"
chmod -R u+rwx "$sbdir"; rm -rf "$sbdir"
rc=0; SYNC_OUT="$out" AGENT_SANDBOX_SUDO=none AGENT_SANDBOX_DIR="$sbdir" bash "$scripts/agent-sandbox.sh" collect >/dev/null 2>&1 || rc=$?
check "no sandbox copy: exits 0 and changes nothing" test "$rc" = 0 -a "$(cat src/a.ts)" = "a edited"

echo
if [ "$fails" -eq 0 ]; then echo "all checks passed"; else echo "$fails check(s) FAILED"; exit 1; fi
