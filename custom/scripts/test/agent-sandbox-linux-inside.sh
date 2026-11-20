#!/usr/bin/env bash
# The part of test-agent-sandbox-linux.sh that runs INSIDE the throwaway ubuntu:24.04 container, as root. Not for a host.
#   provision   packages, node 24 under a hostedtoolcache-like dir, user `runner` with passwordless sudo, the stub model CLI
#   checks      reset the fixture, then checks A-E (every key and secret in here is a fake string)
# Actors: `runner` = the workflow step (holds the key in its environment); `agentrun` = the sandbox user. Both are reached with
# setpriv/sudo exactly the way the scripts do it. Output lines: ok / FAIL / GAP (a robustness hole that is not a leak) / info.
set -uo pipefail
[ "${ORCA_SANDBOX_TEST_CONTAINER:-}" = 1 ] || { echo "run test-agent-sandbox-linux.sh instead (needs docker)"; exit 2; }
export DEBIAN_FRONTEND=noninteractive
umask 022 # `docker exec` starts with umask 0, which would make every file this test creates world-writable

# Fresh random fakes each run, so no file of this test (or of the copied scripts) can contain them.
rnd() { head -c 40 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32; }
KEY="fake-key-$(rnd)"; F600="fake-file-secret-600-$(rnd)"; F644="fake-file-secret-644-$(rnd)"
HR=/home/runner; WS=$HR/work/orca/orca; REAL=$WS/repo; TOOLS=$WS/tools/custom/scripts; TMPD=$HR/work/_temp
OUT=$TMPD/out/round-1; FC=$TMPD/_runner_file_commands; GOUT=$FC/set_output_setup; LOG=/root/log; ATT=/root/attempts; NEEDLES=/root/needles
[ ! -f /etc/orca-test.env ] || . /etc/orca-test.env # NODE_VER
NODE_DIR=/opt/hostedtoolcache/node/${NODE_VER:-0}/${NODE_ARCH:-x64}/bin
RPATH=$HR/setup-pnpm/bin:$NODE_DIR:/usr/local/bin:/usr/bin:/bin
PNPM_VER="${PNPM_PIN#pnpm@}"; PNPM_VER="${PNPM_VER%%+*}"
OKS=0; FAILS=0; GAPS=0
ok() { printf 'ok   %s\n' "$*"; OKS=$((OKS + 1)); }
bad() { printf 'FAIL %s\n' "$*"; FAILS=$((FAILS + 1)); }
gap() { printf 'GAP  %s\n' "$*"; GAPS=$((GAPS + 1)); }
info() { printf 'info %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }
first_line() { sed -n '1p' "$1" | tr -d '\000-\037' | cut -c1-110; }

# A workflow step as the user `runner`, and the same step holding the key in its environment only (never an argv: `exec env` replaces itself).
as_runner() { setpriv --reuid=runner --regid=runner --init-groups env -i HOME=$HR USER=runner LOGNAME=runner PATH="$RPATH" LANG=C.UTF-8 "$@"; }
as_runner_key() { KEYENV="$KEY" setpriv --reuid=runner --regid=runner --init-groups bash -c \
  'exec env -i HOME=/home/runner USER=runner LOGNAME=runner PATH="$0" LANG=C.UTF-8 DEEPINFRA_API_KEY="$KEYENV" "$@"' "$RPATH" "$@"; }
as_agentrun() { setpriv --reuid=agentrun --regid=agentrun --init-groups env -i PATH="$APATH" HOME=/home/agentrun LANG=C.UTF-8 TMPDIR=/tmp "$@"; }
# What the workflow does for the agent: runner -> sudo -n -u agentrun -H env -i ... (stdin passes through)
agent_sh() { as_runner_key sudo -n -u agentrun -H env -i PATH="$APATH" HOME=/home/agentrun LANG=C.UTF-8 TMPDIR=/tmp CI=true bash -c "$1"; }
step_env=(SYNC_OUT="$OUT" TOOLS_DIR="$TOOLS" RUNNER_TEMP="$TMPD")

provision() {
  apt-get update -qq && apt-get install -y -qq --no-install-recommends sudo git jq curl ca-certificates procps psmisc strace gdb libcap2-bin iproute2 >/dev/null || exit 1
  cd /tmp && curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o sums || exit 1
  local f ver arch=x64; [ "$(uname -m)" = x86_64 ] || arch=arm64 # the container follows the host's architecture
  f="$(grep "linux-$arch.tar.gz\$" sums | awk '{print $2}')"
  curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$f" && grep " $f\$" sums | sha256sum -c - >/dev/null || { echo "node download failed"; exit 1; }
  ver="${f#node-v}"; ver="${ver%%-*}"
  mkdir -p "/opt/hostedtoolcache/node/$ver/$arch" && tar -xzf "$f" --no-same-owner -C "/opt/hostedtoolcache/node/$ver/$arch" --strip-components=1
  chmod 755 /opt/hostedtoolcache; printf 'NODE_VER=%s\nNODE_ARCH=%s\n' "$ver" "$arch" > /etc/orca-test.env
  id runner >/dev/null 2>&1 || useradd -m -u 1001 -s /bin/bash runner
  echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner; chmod 440 /etc/sudoers.d/runner
  NODE_VER="$ver"; NODE_DIR=/opt/hostedtoolcache/node/$ver/$arch/bin; RPATH=$HR/setup-pnpm/bin:$NODE_DIR:/usr/local/bin:/usr/bin:/bin
  as_runner npm install --global --prefix "$HR/setup-pnpm" --no-audit --no-fund "pnpm@$PNPM_VER" >/dev/null 2>&1 || { echo "runner pnpm install failed"; exit 1; }
  # The stub model CLI (behaviour from /opt/stub-mode, paths from /opt/stub-paths): it runs as agentrun inside the sandbox copy.
  cat > "$NODE_DIR/claude" <<'STUB'
#!/usr/bin/env bash
. /opt/stub-paths
mode="$(cat /opt/stub-mode)"; cat > /tmp/stub-prompt.txt
R=/tmp/stub-report.txt; : > "$R"; rep() { printf '%s\n' "$*" >> "$R"; }
result() { printf '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"stub done","usage":{"input_tokens":10,"output_tokens":5}}\n'; }
case "$mode" in
e2e)
  rep "whoami=$(id -un) pwd=$(pwd -P)"; env > /tmp/stub-env.txt
  rep "pnpm_exec=$(pnpm exec node -e 'console.log(1)' 2>&1)"; rep "pnpm_version=$(pnpm --version 2>&1)"
  printf 'edited by agent\n' > src/a.ts; printf 'new by agent\n' > src/new.ts; rm -f src/del.ts
  printf 'junk\n' > ignored.log; mkdir -p build && printf 'junk\n' > build/out.txt
  printf 'outside\n' > /tmp/agent-outside.txt && rep outside_tmp=written
  w() { if ( eval "$2" ) 2>/dev/null; then rep "$1=WRITTEN"; else rep "$1=denied"; fi; }
  w real_tree_append "echo x >> $REAL_TREE/src/a.ts"; w real_tree_create "touch $REAL_TREE/pwned"; w sync_out_create "touch $SYNC_OUT_DIR/pwned"
  w tools_dir_write "touch /opt/agent-tools/bin/pwned"; w toolchain_write "touch $NODE_BIN/pwned"
  if cat "$SYNC_OUT_DIR/agent-prompt.txt" >/dev/null 2>&1; then rep sync_out_read=readable; else rep sync_out_read=denied; fi
  rep "proxy_health=$(curl -s "$ANTHROPIC_BASE_URL/__health")"
  rep "upstream_https_status=$(curl -s -o /tmp/stub-upstream-body.txt -w '%{http_code}' --max-time 30 -X POST "$ANTHROPIC_BASE_URL/v1/messages" -H 'content-type: application/json' -H 'authorization: Bearer agent-own-token' -d '{}')"
  rep "other_path_status=$(curl -s -o /dev/null -w '%{http_code}' "$ANTHROPIC_BASE_URL/other")"
  mkdir -p "$CLAUDE_CONFIG_DIR" && printf 'state\n' > "$CLAUDE_CONFIG_DIR/state" && rep config_dir=writable
  (setsid sleep 300 >/dev/null 2>&1 &); rep leftover_started=yes; result ;;
file2dir) rm -f src/f.ts; mkdir -p src/f.ts; printf 'x\n' > src/f.ts/index.ts; result ;;
dir2file) rm -rf src/f.ts; printf 'f\n' > src/f.ts; rm -rf src/d; printf 'now a file\n' > src/d; result ;;
hostile)
  mkdir -p src/locked; printf 'in locked dir\n' > src/locked/x.ts; chmod 000 src/locked/x.ts src/locked
  ln -s /etc/passwd src/link-etc.ts; ln -s "$SYNC_OUT_DIR/agent-prompt.txt" src/link-prompt.ts; mkfifo src/fifo
  cp /bin/true src/suid; chmod 4755 src/suid; printf 'x\n' > "src/new
line.ts"; printf 'plain\n' > src/plain.ts; result ;;
sleep) (setsid sleep 300 >/dev/null 2>&1 &); sleep 300; result ;;
ignore-term) trap '' TERM; end=$((SECONDS + 120)); while [ "$SECONDS" -lt "$end" ]; do sleep 1; done; result ;;
relay) # a process that forks its successor every few ms and exits: always one live member, never in a pkill snapshot for long
  relay() { local n=${1:-0}; [ "$n" -lt 600 ] || return 0; sleep 0.001; setsid bash -c "$(declare -f relay); relay $((n + 1))" >/dev/null 2>&1 < /dev/null & }
  relay 0; sleep 1; result ;;
esac
STUB
  chmod 755 "$NODE_DIR/claude"
  echo "provisioned: node $ver, runner pnpm $PNPM_VER"
}

reset_fixture() { # a clean world every run: no agentrun, no sandbox, a fresh fixture work tree owned by runner, fresh copy of the scripts
  pkill -KILL -u agentrun 2>/dev/null; pkill -KILL -u runner 2>/dev/null; sleep 0.3
  userdel -r agentrun 2>/dev/null; rm -rf /opt/agent-tools /opt/agent-sandbox "$HR/work" "$HR/.npm" /root/.npm "$LOG" "$ATT" /tmp/stub-* /tmp/agent-outside.txt /tmp/ctl-canary
  chmod 750 "$HR"; mkdir -p "$LOG" "$ATT" "$FC" "$OUT" "$WS/tools" "$REAL/src"
  cp -r /stage/custom "$WS/tools/custom"
  printf 'REAL_TREE=%s\nSYNC_OUT_DIR=%s\nNODE_BIN=%s\n' "$REAL" "$OUT" "$NODE_DIR" > /opt/stub-paths
  jq -n --arg pm "$PNPM_PIN" '{name: "fixture", version: "1.0.0", private: true, packageManager: $pm, devDependencies: {"is-odd": "3.0.1"}}' > "$REAL/package.json"
  printf 'node_modules\nignored.log\nbuild/\n' > "$REAL/.gitignore"; printf 'export const a = 1\n' > "$REAL/src/a.ts"; printf 'export const d = 1\n' > "$REAL/src/del.ts"; printf 'f\n' > "$REAL/src/f.ts"; mkdir -p "$REAL/src/d"; printf 'i\n' > "$REAL/src/d/inner.ts"
  printf 'the prompt\n' > "$OUT/agent-prompt.txt"
  jq -n -c '{model: "m", tier: "flash", mode: "first", round: 1, wall_seconds: 60, files: 1, skip: false}' > "$OUT/agent-plan.json"
  printf 'GITHUB_OUTPUT-like file\n' > "$GOUT"
  chown -R runner:runner "$HR/work"
  as_runner bash -c "cd '$REAL' && pnpm install --lockfile-only >/dev/null 2>&1 && git init -q -b main . && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m base" || { echo "fixture failed"; exit 1; }
  printf '%s\n' "$KEY" "$(printf '%s' "$KEY" | base64 | tr -d '\n')" "$(printf '%s' "$KEY" | rev)" "${KEY:8}" > "$NEEDLES"
  printf 'NOTE %s\n' "$F600" > "$FC/note_600"; printf 'NOTE %s\n' "$F644" > "$FC/note_644"; chmod 600 "$FC/note_600"; chmod 644 "$FC/note_644"; chown runner:runner "$FC"/note_*
}
githash() { (cd "$REAL" && find .git -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); }
leaks_in() { grep -a -c -F -f "$NEEDLES" "$@" 2>/dev/null | awk '{s += $1} END {print s + 0}'; }

checks_a() {
  section "A. setup as runner"
  local t0 t1 rc=0
  t0=$(date +%s); as_runner env "${step_env[@]}" GITHUB_OUTPUT="$GOUT" bash -c "cd '$REAL' && bash '$TOOLS/agent-sandbox.sh' setup" > "$LOG/setup.log" 2>&1 || rc=$?; t1=$(date +%s)
  if [ "$rc" = 0 ] && [ -s "$OUT/sandbox.json" ]; then ok "A1 setup exits 0 in $((t1 - t0))s and writes sandbox.json"; else bad "A1 setup rc=$rc: $(tail -n 3 "$LOG/setup.log" | tr '\n' '|')"; return 1; fi
  APATH="$(jq -r .path "$OUT/sandbox.json")"
  if id agentrun >/dev/null 2>&1 && [ "$(id -u agentrun)" != 0 ]; then ok "A2 user agentrun exists (uid $(id -u agentrun), $(getent passwd agentrun | cut -d: -f6))"; else bad "A2 no agentrun user"; fi
  if [ "$(stat -c %U /opt/agent-tools)" = root ] && ! as_agentrun touch /opt/agent-tools/bin/pwned 2>/dev/null && ! as_agentrun sh -c 'echo x > /opt/agent-tools/lib/node_modules/pnpm/package.json' 2>/dev/null; then ok "A3 /opt/agent-tools is root-owned ($(stat -c %a /opt/agent-tools)) and agentrun cannot write into it"; else bad "A3 /opt/agent-tools writable by agentrun or not root"; fi
  if [ "$(stat -c %U /opt/agent-sandbox/repo)" = agentrun ] && [ "$(stat -c %U /opt/agent-sandbox/repo/node_modules)" = agentrun ] && [ -d /opt/agent-sandbox/repo/node_modules/is-odd ]; then ok "A4 sandbox copy and node_modules (with is-odd) owned by agentrun"; else bad "A4 sandbox copy or node_modules wrong: $(stat -c '%U' /opt/agent-sandbox/repo /opt/agent-sandbox/repo/node_modules 2>&1 | tr '\n' ' ')"; fi
  if jq -e '.user == "agentrun" and .repo == "/opt/agent-sandbox/repo" and .dependencies_installed == true' "$OUT/sandbox.json" >/dev/null && grep -q '^ready=true$' "$GOUT"; then ok "A5 sandbox.json says dependencies_installed and the step output has ready=true"; else bad "A5 sandbox.json/ready: $(cat "$OUT/sandbox.json") / $(tail -n 2 "$GOUT" | tr '\n' ' ')"; fi
  local d bad_dirs="" IFS_OLD="$IFS"; IFS=:; for d in $APATH; do
    [ -d "$d" ] || { info "A6 PATH entry does not exist: $d"; continue; }
    as_agentrun test -x "$d" 2>/dev/null && as_agentrun ls "$d" >/dev/null 2>&1 || bad_dirs="$bad_dirs $d"; done; IFS="$IFS_OLD"
  if [ -z "$bad_dirs" ]; then ok "A6 agentrun can enter and list every PATH directory: $APATH"; else bad "A6 agentrun cannot traverse:$bad_dirs"; fi
  local pv nv; pv="$(as_agentrun pnpm --version 2>&1)"; nv="$(as_agentrun node --version 2>&1)"
  if [ "$pv" = "$PNPM_VER" ]; then ok "A7 agentrun: pnpm --version = $pv (pinned $PNPM_VER), node --version = $nv, claude = $(as_agentrun sh -c 'command -v claude')"; else bad "A7 pnpm as agentrun printed: $pv"; fi
  if as_agentrun sh -c 'cd /opt/agent-sandbox/repo && pnpm exec node -e "require(\"is-odd\")"' >/dev/null 2>&1; then ok "A8 a dependency resolves for agentrun in the sandbox (pnpm exec node -e require is-odd)"; else bad "A8 installed dependency does not resolve"; fi
  info "A9 /home/runner as agentrun sees it: $(stat -c '%A %U:%G' $HR) -> $(as_agentrun ls $HR 2>&1 | cut -c1-80); setup log noise: $(grep -ci 'getcwd\|permission denied\|cannot access' "$LOG/setup.log") line(s)"
}

start_b_actors() {
  as_runner bash -c "cat > $TMPD/fake-upstream.mjs" <<'JS'
import fs from 'node:fs'
import http from 'node:http'
const [, , rec, portFile] = process.argv
http.createServer((req, res) => {
  const c = []
  req.on('data', (d) => c.push(d))
  req.on('end', () => {
    fs.appendFileSync(rec, JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(c).toString() }) + '\n')
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}')
  })
}).listen(0, '127.0.0.1', function () { fs.writeFileSync(portFile, String(this.address().port)) })
JS
  rm -f "$TMPD/fake.port" "$TMPD/proxy.port" "$TMPD/record.jsonl"
  as_runner bash -c "setsid node $TMPD/fake-upstream.mjs $TMPD/record.jsonl $TMPD/fake.port > /dev/null 2>&1 < /dev/null &"
  local i; for i in $(seq 1 50); do [ -s "$TMPD/fake.port" ] && break; sleep 0.1; done; FAKE_PORT="$(cat "$TMPD/fake.port")"
  # The proxy exactly as agent-round.sh run starts it (key on stdin through printf, env -i), only with the fake upstream.
  as_runner_key bash -c 'printf "%s\n" "$DEEPINFRA_API_KEY" | env -i PATH="$PATH" HOME="${HOME:-/tmp}" node "$1/agent-key-proxy.mjs" --upstream "$2" --listening-file "$3/proxy.port" > "$3/proxy.out" 2> "$3/proxy.err" &
    echo $! > "$3/proxy.pid"' _ "$TOOLS" "http://127.0.0.1:$FAKE_PORT/anthropic" "$TMPD"
  for i in $(seq 1 50); do [ -s "$TMPD/proxy.port" ] && break; sleep 0.1; done
  PROXY_PID="$(cat "$TMPD/proxy.pid")"; PROXY_PORT="$(cat "$TMPD/proxy.port")"
  # A long-running step shell with the key in its environment, and its child.
  as_runner_key bash -c 'setsid bash -c "sleep 3000; true" > /dev/null 2>&1 < /dev/null & echo $! > "$1/p1.pid"' _ "$TMPD"; sleep 0.3
  P1_PID="$(cat "$TMPD/p1.pid")"; P1_CHILD="$(pgrep -P "$P1_PID" | head -n 1)"
}

att() { # NAME SCRIPT: SCRIPT runs as agentrun through the real chain with the needles on stdin; the output must not carry a needle
  local n="$1" rc=0 hits
  agent_sh "$2" < "$NEEDLES" > "$ATT/$n.out" 2>&1 || rc=$?
  hits="$(leaks_in "$ATT/$n.out")"; ATT_RC=$rc; ATT_BYTES="$(wc -c < "$ATT/$n.out")"
  if [ "$hits" = 0 ]; then ok "B-$n: no key found ($ATT_BYTES bytes of output, rc=$rc; first line: $(first_line "$ATT/$n.out"))"; else bad "B-$n: KEY FOUND ($hits line(s)), see $ATT/$n.out"; fi
}
denied() { # NAME SCRIPT: SCRIPT (as agentrun) must print no line starting with WROTE/ALLOWED
  agent_sh "$2" > "$ATT/$1.out" 2>&1 < /dev/null
  if grep -q '^\(WROTE\|ALLOWED\)' "$ATT/$1.out"; then bad "B-$1: $(grep '^\(WROTE\|ALLOWED\)' "$ATT/$1.out" | tr '\n' ' ')"; else ok "B-$1: every attempt refused ($(grep -c . "$ATT/$1.out") message line(s), e.g. $(first_line "$ATT/$1.out"))"; fi
}

fs_isolation() { # LABEL: what agentrun can read and write of runner's files, for the current mode of /home/runner
  local label="$1" h; h="$(stat -c %a $HR)"
  local a_before; a_before="$(sha256sum "$REAL/src/a.ts" "$GOUT" "$OUT/agent-plan.json" | sha256sum)"
  agent_sh "cat $FC/note_600 $FC/note_644 2>&1; ls -la $HR $TMPD 2>&1 | head -n 6" > "$ATT/files-$label.out" 2>&1
  if grep -q "$F600" "$ATT/files-$label.out"; then bad "B-files-$label: the 600 file of runner was READ with /home/runner at $h"; else ok "B-files-$label: runner's 600 file not readable (home $h)"; fi
  if grep -q "$F644" "$ATT/files-$label.out"; then info "B-files-$label: a 644 file under runner's tree IS readable when /home/runner is $h"; else info "B-files-$label: a 644 file under runner's tree is not reachable when /home/runner is $h"; fi
  denied "writes-$label" "w() { ( eval \"\$2\" ) 2>&1 && echo \"WROTE \$1\"; }
    w real_append 'echo x >> $REAL/src/a.ts'; w real_create 'touch $REAL/pwned'; w real_rm 'rm -f $REAL/src/a.ts'; w real_git 'echo x >> $REAL/.git/config'
    w sync_out 'touch $OUT/pwned'; w sync_plan 'echo x >> $OUT/agent-plan.json'; w github_output_file 'echo evil=1 >> $GOUT'; w github_env 'echo X=1 >> $FC/set_env_x'
    w tools_dir 'touch /opt/agent-tools/bin/pwned'; w toolchain 'touch $NODE_DIR/pwned'; w usr_local 'touch /usr/local/bin/pwned'; w passwd 'echo x >> /etc/passwd'; w sudoers 'echo x >> /etc/sudoers.d/runner'"
  if [ "$a_before" = "$(sha256sum "$REAL/src/a.ts" "$GOUT" "$OUT/agent-plan.json" | sha256sum)" ] && [ ! -e "$REAL/pwned" ] && [ ! -e "$OUT/pwned" ]; then ok "B-state-$label: the real tree, SYNC_OUT and the GITHUB_OUTPUT-style file are byte-identical afterwards"; else bad "B-state-$label: runner's files changed"; fi
}

checks_b() {
  section "B. the key cannot be reached from agentrun"
  start_b_actors
  [ -n "$PROXY_PORT" ] && [ -d "/proc/$PROXY_PID" ] && [ -d "/proc/$P1_PID" ] || { bad "B0 actors did not start"; return 1; }
  info "B0 yama ptrace_scope=$(cat /proc/sys/kernel/yama/ptrace_scope 2>&1); kernel $(uname -r); runner pids: step-shell $P1_PID, its child $P1_CHILD, proxy $PROXY_PID, port $PROXY_PORT"
  # Controls: the harness must be able to see the key where it IS reachable.
  if [ "$(as_runner sh -c "grep -a -c -F -f - /proc/$P1_PID/environ" < "$NEEDLES")" -ge 1 ]; then ok "B-control: runner CAN read the key from its own step shell's /proc/$P1_PID/environ (the harness detects it)"; else bad "B-control: the key is not even in the step shell's environment"; fi
  if [ "$(grep -a -l -F -f "$NEEDLES" /proc/"$PROXY_PID"/environ /proc/"$PROXY_PID"/cmdline 2>/dev/null | wc -l)" = 0 ]; then ok "B-proxy-env: the proxy's own environ and cmdline hold no key (it came on stdin)"; else bad "B-proxy-env: key in the proxy's environ/cmdline"; fi
  if [ "$(ps -eo args | grep -a -c -F -f "$NEEDLES")" = 0 ] && [ "$(cat /proc/[0-9]*/cmdline 2>/dev/null | grep -a -c -F -f "$NEEDLES")" = 0 ]; then ok "B-argv: no process on the machine has the key in its argv (checked as root)"; else bad "B-argv: key in some argv"; fi
  att environ 'for p in /proc/[0-9]*; do cat $p/environ 2>/dev/null; done; echo scanned'
  att cmdline 'for p in /proc/[0-9]*; do tr "\0" " " < $p/cmdline 2>/dev/null; echo; done'
  att ps 'ps eww -ef; ps aux; ps -eo pid,user,args e'
  printf 'canary %s\n' "$KEY" > /tmp/ctl-canary; chmod 644 /tmp/ctl-canary
  agent_sh 'grep -rasl -F -f - --exclude=mem --exclude=kcore /tmp' < "$NEEDLES" > "$ATT/canary.out" 2>&1
  if grep -q ctl-canary "$ATT/canary.out"; then ok "B-control: agentrun's filesystem grep finds a world-readable canary file with the key"; else bad "B-control: the grep harness did not find the canary"; fi
  rm -f /tmp/ctl-canary
  local gx='-rasl -F -f - --exclude=mem --exclude=pagemap --exclude=kcore'
  local ctl; ctl="$(as_runner sh -c "timeout 280 grep $gx /proc 2>/dev/null" < "$NEEDLES")" # (not `| grep -q`: SIGPIPE + pipefail)
  if grep -q "^/proc/$P1_PID/environ\$" <<<"$ctl"; then ok "B-control: the same /proc-wide grep, run as runner, lists /proc/$P1_PID/environ"; else bad "B-control: the /proc grep harness cannot even see runner's own key"; fi
  att fs-grep "timeout 280 grep $gx /proc /tmp /home /opt /var /run /etc /srv /mnt /usr/local 2>&1; echo scanned"
  if grep -q '^scanned$' "$ATT/fs-grep.out" && ! grep -q 'Killed' "$ATT/fs-grep.out"; then ok "B-fs-grep: the scan ran to the end over /proc /tmp /home /opt /var /run /etc /srv /mnt /usr/local"; else bad "B-fs-grep: the scan did not finish: $(first_line "$ATT/fs-grep.out")"; fi
  att mem-fd "for p in $PROXY_PID $P1_PID $P1_CHILD; do echo == \$p; ls -l /proc/\$p/fd 2>&1; cat /proc/\$p/maps 2>&1; timeout 5 cat /proc/\$p/mem 2>&1; timeout 5 cat /proc/\$p/fd/0 2>&1; readlink /proc/\$p/cwd 2>&1; done"
  att ptrace "timeout 10 strace -p $PROXY_PID -e trace=none -o /dev/null 2>&1; echo strace rc=\$?; timeout 30 gdb -batch -p $P1_PID -ex 'info proc' 2>&1; echo gdb rc=\$?"
  if grep -qi 'not permitted' "$ATT/ptrace.out"; then ok "B-ptrace: strace and gdb on runner's processes got 'Operation not permitted' (ptrace_scope $(cat /proc/sys/kernel/yama/ptrace_scope))"; else bad "B-ptrace: no EPERM in output"; fi
  att sudo-su 'sudo -n true 2>&1; echo "sudo true rc=$?"; sudo -n -l 2>&1; echo "sudo -l rc=$?"; timeout 5 su runner -c id < /dev/null 2>&1; echo "su rc=$?"; timeout 5 su -c id 2>&1 < /dev/null; echo "su root rc=$?"'
  if grep -q 'sudo true rc=0\|uid=1001\|uid=0' "$ATT/sudo-su.out"; then bad "B-sudo-su: agentrun got privileges: $(grep 'rc=0\|uid=' "$ATT/sudo-su.out" | head -n 2 | tr '\n' ' ')"; else ok "B-sudo-su: sudo -n true fails ($(grep -m1 -o 'a password is required\|not in the sudoers[^.]*' "$ATT/sudo-su.out")); su as runner and as root fail"; fi
  att own-env 'id; grep -E "^(CapEff|CapPrm|NoNewPrivs)" /proc/self/status; env | sort'
  grep -q '^CapEff:\s*0000000000000000' "$ATT/own-env.out" && ok "B-caps: agentrun has no capabilities (CapEff 0), its environment has no DEEPINFRA variable: $(grep -c '^DEEPINFRA' "$ATT/own-env.out")" || bad "B-caps: agentrun holds capabilities"
  info "B-setuid: setuid binaries on this image: $(find / -xdev -perm -4000 -type f 2>/dev/null | tr '\n' ' ')"
  fs_isolation home750
  chmod 755 "$HR"; fs_isolation home755; chmod 750 "$HR"
  # The proxy: allowed, but it must not hand the key back and must refuse other paths.
  att proxy-messages "curl -s -i -X POST 'http://127.0.0.1:$PROXY_PORT/v1/messages?beta=true' -H 'authorization: Bearer agent-own-token' -H 'x-api-key: agent-own-key' -H 'content-type: application/json' -d '{\"q\":1}'"
  grep -q '200 OK' "$ATT/proxy-messages.out" && ok "B-proxy-allowed: /v1/messages answered 200 through the proxy" || bad "B-proxy-allowed: no 200: $(first_line "$ATT/proxy-messages.out")"
  printf 'Bearer %s' "$KEY" > /root/bearer
  if jq -s -e --rawfile k /root/bearer '.[-1] | .headers.authorization == $k and (.headers | has("x-api-key") | not) and .url == "/anthropic/v1/messages?beta=true" and .headers.host == "127.0.0.1:'"$FAKE_PORT"'" and (tostring | contains("agent-own") | not)' "$TMPD/record.jsonl" >/dev/null; then
    ok "B-proxy-upstream: the fake upstream got Authorization: Bearer <the key>, no x-api-key, host rewritten, path /anthropic/v1/messages?beta=true; the agent's own token/key were dropped"; else bad "B-proxy-upstream: $(tail -n 1 "$TMPD/record.jsonl" | cut -c1-300)"; fi
  local n0; n0="$(wc -l < "$TMPD/record.jsonl")"
  att proxy-refuse "for t in /other / /__health/x /v2/messages /v1 /v1/../etc/passwd /v1/%2e%2e/x; do printf '%s -> ' \$t; curl -s --path-as-is -o /dev/null -w '%{http_code}\n' \"http://127.0.0.1:$PROXY_PORT\$t\"; done; printf 'health -> '; curl -s http://127.0.0.1:$PROXY_PORT/__health; echo"
  if [ "$(grep -c -- '-> 404' "$ATT/proxy-refuse.out")" = 7 ] && grep -q 'health -> ok' "$ATT/proxy-refuse.out" && [ "$(wc -l < "$TMPD/record.jsonl")" = "$n0" ]; then ok "B-proxy-refuse: 7 other/traversal paths got 404 and none reached the upstream; /__health answers ok"; else bad "B-proxy-refuse: $(tr '\n' ' ' < "$ATT/proxy-refuse.out") upstream_count $n0 -> $(wc -l < "$TMPD/record.jsonl")"; fi
  att proxy-absolute "curl -s --request-target 'http://evil.example/v1/messages' http://127.0.0.1:$PROXY_PORT -X POST -d '{}' -o /dev/null -w '%{http_code}\n'; curl -s --request-target '//evil.example/v1/x' http://127.0.0.1:$PROXY_PORT -o /dev/null -w '%{http_code}\n'"
  if [ "$(tail -n 2 "$TMPD/record.jsonl" | jq -s -r '[.[].headers.host] | unique | join(",")')" = "127.0.0.1:$FAKE_PORT" ]; then ok "B-proxy-absolute: absolute-form and //host request targets still went to the one configured upstream"; else bad "B-proxy-absolute: $(tail -n 2 "$TMPD/record.jsonl" | cut -c1-200)"; fi
  denied kill-runner "k() { kill -9 \$2 2>&1 && echo \"ALLOWED \$1\"; }; k step $P1_PID; k proxy $PROXY_PID; k child $P1_CHILD; pkill -9 -u runner 2>&1; kill -STOP $PROXY_PID 2>&1 && echo 'ALLOWED stop'"
  if kill -0 "$PROXY_PID" 2>/dev/null && kill -0 "$P1_PID" 2>/dev/null && [ "$(curl -s "http://127.0.0.1:$PROXY_PORT/__health")" = ok ]; then ok "B-kill-after: runner's step shell and the proxy are still alive and healthy"; else bad "B-kill-after: a runner process died"; fi
  cat "$TMPD/proxy.out" "$TMPD/proxy.err" > "$ATT/proxy-logs.out"; [ "$(leaks_in "$ATT/proxy-logs.out")" = 0 ] && ok "B-proxy-logs: the proxy's stdout/stderr (method, path, status) carry no key" || bad "B-proxy-logs: key in proxy logs"
  kill "$PROXY_PID" "$P1_PID" "$P1_CHILD" 2>/dev/null; pkill -u runner -f fake-upstream 2>/dev/null; sleep 0.3
  rm -f "$TMPD/record.jsonl" "$TMPD"/proxy.* "$TMPD"/p1.pid "$TMPD"/fake.port /root/bearer
}

stage_stub() { printf '%s\n' "$1" > /opt/stub-mode; chmod 644 /opt/stub-mode; }
run_round() { # [WALL]: agent-round.sh run as the workflow step (AGENT_SANDBOX=1, the key in its environment); sets RUN_RC
  if [ -n "${1:-}" ]; then jq -c --argjson w "$1" '.wall_seconds = $w' "$OUT/agent-plan.json" > "$OUT/p.tmp" && mv "$OUT/p.tmp" "$OUT/agent-plan.json"; chown runner:runner "$OUT/agent-plan.json"; fi
  RUN_RC=0; as_runner_key env "${step_env[@]}" ROUND=1 MODE=first TIER=flash AGENT_SANDBOX=1 GITHUB_OUTPUT="$FC/set_output_run" \
    bash -c 'cd "$1" && exec bash "$2" run' _ "$REAL" "$TOOLS/agent-round.sh" > "$LOG/run.log" 2>&1 || RUN_RC=$? # working-directory: repo, as in the workflow
}
kill_agent() { setpriv --reuid=agentrun --regid=agentrun --clear-groups kill -KILL -1 2>/dev/null; sleep 0.2; pkill -KILL -u agentrun 2>/dev/null; true; }
procs_of() { ps -u "$1" -o stat= 2>/dev/null | grep -c -v '^Z' || true; } # live processes (a zombie is only a name in the table)

checks_c() {
  section "C. end to end: agent-round.sh run (stub model) then agent-sandbox.sh collect"
  stage_stub e2e; local h0 h1; h0="$(githash)"
  run_round
  if [ "$RUN_RC" = 0 ] && jq -e '.exit_code == 0 and .key_leaks == 0' "$OUT/agent-run.json" >/dev/null; then ok "C1 run exits 0; agent-run.json: $(jq -c . "$OUT/agent-run.json")"; else bad "C1 run rc=$RUN_RC: $(tail -n 4 "$LOG/run.log" | tr '\n' '|')"; fi
  jq -e '.result == "stub done"' "$OUT/agent-out.json" >/dev/null 2>&1 && ok "C2 the CLI's JSON reached agent-out.json" || bad "C2 agent-out.json missing"
  local rep=/tmp/stub-report.txt
  if grep -q 'whoami=agentrun pwd=/opt/agent-sandbox/repo' $rep && grep -q '^pnpm_exec=1$' $rep && grep -q "^pnpm_version=$PNPM_VER\$" $rep; then ok "C3 the stub ran as agentrun in the sandbox copy, and pnpm exec node -e 'console.log(1)' printed 1 (pnpm $PNPM_VER)"; else bad "C3 stub report: $(tr '\n' '|' < $rep)"; fi
  if grep -q 'real_tree_append=denied' $rep && grep -q 'real_tree_create=denied' $rep && grep -q 'sync_out_create=denied' $rep && grep -q 'tools_dir_write=denied' $rep && grep -q 'toolchain_write=denied' $rep; then ok "C4 inside the run, writes to the real tree, SYNC_OUT, /opt/agent-tools and the toolchain dir were refused (SYNC_OUT readable by agentrun: $(grep -o 'sync_out_read=.*' $rep))"; else bad "C4 a write was allowed: $(grep '=WRITTEN' $rep | tr '\n' ' ')"; fi
  grep -q '^outside_tmp=written$' $rep && grep -q '^config_dir=writable$' $rep && ok "C5 /tmp and the CLI config dir /home/agentrun/.claude-round-1 are writable for the agent" || bad "C5 /tmp or config dir not writable"
  if [ "$(grep -c '^DEEPINFRA\|fake-key' /tmp/stub-env.txt)" = 0 ] && grep -q '^ANTHROPIC_AUTH_TOKEN=local-proxy-no-key$' /tmp/stub-env.txt && grep -q '^ANTHROPIC_BASE_URL=http://127.0.0.1:[0-9]*$' /tmp/stub-env.txt && grep -q 'proxy_health=ok' $rep; then ok "C6 the agent's environment has the dummy token and the proxy URL, no key; the proxy answered /__health"; else bad "C6 agent env: $(grep 'ANTHROPIC\|DEEPINFRA' /tmp/stub-env.txt | tr '\n' ' ')"; fi
  local st; st="$(grep -o 'upstream_https_status=.*' $rep | cut -d= -f2)"
  case "$st" in 401|403|400|404|422) ok "C7 through the proxy the real https upstream answered HTTP $st to a fake key (TLS path works); other path -> $(grep -o 'other_path_status=.*' $rep | cut -d= -f2)";; *) gap "C7 no answer from the real upstream through the proxy (status '$st'; no network?)";; esac
  [ "$(leaks_in /tmp/stub-upstream-body.txt)" = 0 ] && ok "C8 the upstream's reply to the agent holds no key" || bad "C8 key in the upstream reply"
  if [ "$(procs_of agentrun)" = 0 ]; then ok "C9 no agentrun process is left after run (the stub started a setsid sleep 300)"; else bad "C9 leftovers: $(pgrep -u agentrun -a | head -n 3 | tr '\n' '|')"; fi
  if [ "$(ps -eo args | grep -c '[a]gent-key-proxy')" = 0 ]; then ok "C10 the proxy process is gone after run"; else bad "C10 proxy still running"; fi
  as_runner env "${step_env[@]}" GITHUB_OUTPUT="$FC/set_output_collect" bash -c "cd '$REAL' && bash '$TOOLS/agent-sandbox.sh' collect" > "$LOG/collect.log" 2>&1 || bad "C11 collect rc=$?: $(tail -n 3 "$LOG/collect.log" | tr '\n' '|')"
  h1="$(githash)"
  local gs; gs="$(as_runner git -C "$REAL" status --porcelain | sort | tr '\n' ',')"
  if [ "$gs" = " D src/del.ts, M src/a.ts,?? src/new.ts," ]; then ok "C11 real tree: git status shows exactly the edit, the new file and the deletion ($(jq -c . "$OUT/sandbox-collect.json"))"; else bad "C11 git status: $gs"; fi
  if [ "$(cat "$REAL/src/a.ts")" = "edited by agent" ] && [ "$(cat "$REAL/src/new.ts")" = "new by agent" ] && [ ! -e "$REAL/src/del.ts" ] && [ "$(stat -c %U "$REAL/src/new.ts" "$REAL/src/a.ts" | sort -u)" = runner ]; then ok "C12 contents are right and the copied files belong to runner"; else bad "C12 content/owner wrong"; fi
  if [ ! -e "$REAL/node_modules" ] && [ ! -e "$REAL/ignored.log" ] && [ ! -e "$REAL/build" ] && [ ! -e "$REAL/pwned" ] && [ ! -e "$REAL/pnpm-lock.yaml.collect.tmp" ] && ! find "$REAL" -name '*.collect.tmp' | grep -q .; then ok "C13 not copied: node_modules, ignored.log, build/; no temp files left"; else bad "C13 an ignored/forbidden file reached the real tree"; fi
  if [ "$h0" = "$h1" ]; then ok "C14 the real tree's .git is byte-identical before and after run+collect (hash $h0, index included)"; else bad "C14 .git changed: $h0 -> $h1"; fi
  local hits; hits="$(grep -rasl -F -f "$NEEDLES" /home /opt /tmp /var /etc /run /srv 2>/dev/null | head -n 5 | tr '\n' ' ')"
  [ -z "$hits" ] && ok "C15 the key (plain, base64, reversed, tail) is in no file under /home (SYNC_OUT, RUNNER_TEMP, CLI config dirs), /opt (sandbox), /tmp, /var, /etc, /run, /srv" || bad "C15 key in files: $hits"
  [ "$(procs_of agentrun)" = 0 ] && ok "C16 collect left no agentrun process either" || bad "C16 agentrun processes after collect"
}

do_collect() { COLLECT_RC=0; as_runner env "${step_env[@]}" GITHUB_OUTPUT="$FC/set_output_collect" bash -c "cd '$REAL' && bash '$TOOLS/agent-sandbox.sh' collect" > "$LOG/collect2.log" 2>&1 || COLLECT_RC=$?; }
checks_c2() {
  section "C2. collect against a hostile or unusual sandbox (real OS users, real permissions)"
  stage_stub hostile; run_round; rm -f "$OUT/sandbox-collect.json"; do_collect
  if [ "$COLLECT_RC" = 0 ] && [ -s "$OUT/sandbox-collect.json" ]; then ok "C2-1 collect exits 0 after the agent made chmod-000 files and dirs, symlinks, a fifo, a setuid file and a newline in a name: $(jq -c . "$OUT/sandbox-collect.json")"; else bad "C2-1 collect rc=$COLLECT_RC: $(tail -n 2 "$LOG/collect2.log" | tr '\n' '|')"; fi
  [ "$(cat "$REAL/src/locked/x.ts" 2>/dev/null)" = "in locked dir" ] && ok "C2-2 a file inside a chmod-000 directory was still collected (root made it readable)" || bad "C2-2 the locked file did not arrive"
  if [ -z "$(find "$REAL" -path "$REAL/.git" -prune -o \( -type l -o -type p \) -print)" ] && [ ! -e "$REAL/src/link-etc.ts" ]; then ok "C2-3 no symlink and no fifo reached the real tree (/etc/passwd and SYNC_OUT links not followed)"; else bad "C2-3 a link/fifo arrived: $(find "$REAL" -path "$REAL/.git" -prune -o \( -type l -o -type p \) -print | tr '\n' ' ')"; fi
  if [ -f "$REAL/src/suid" ] && [ ! -u "$REAL/src/suid" ] && [ "$(stat -c %U "$REAL/src/suid")" = runner ]; then ok "C2-4 the setuid file arrived as a plain runner-owned file (mode $(stat -c %a "$REAL/src/suid"))"; else gap "C2-4 setuid file in the real tree: mode $(stat -c %a "$REAL/src/suid" 2>&1) owner $(stat -c %U "$REAL/src/suid" 2>&1)"; fi
  [ "$(cat "$REAL/src/plain.ts" 2>/dev/null)" = plain ] && ! find "$REAL" -name '*.collect.tmp' | grep -q . && ok "C2-5 normal files still collected, no temp file left" || bad "C2-5 plain.ts missing or a .collect.tmp left"
  stage_stub file2dir; run_round; rm -f "$OUT/sandbox-collect.json"; do_collect
  if [ "$COLLECT_RC" = 0 ] && [ -s "$OUT/sandbox-collect.json" ] && [ -f "$REAL/src/f.ts" ] && [ ! -d "$REAL/src/f.ts" ]; then ok "C2-6 the agent turned a tracked file into a directory: collect exits 0, writes its summary, and the real file stays a file"
  else gap "C2-6 the agent turned a tracked file (src/f.ts) into a directory: collect exits $COLLECT_RC, sandbox-collect.json written: $([ -s "$OUT/sandbox-collect.json" ] && echo yes || echo no), real src/f.ts is a $(stat -c %F "$REAL/src/f.ts" 2>&1) ($(grep -v '^$' "$LOG/collect2.log" | tail -n 1 | cut -c1-120))"; fi
  stage_stub dir2file; run_round; rm -f "$OUT/sandbox-collect.json"; do_collect
  if [ "$COLLECT_RC" = 0 ] && [ -d "$REAL/src/d" ] && [ -z "$(find "$REAL" -name '*.collect.tmp')" ]; then ok "C2-7 the agent turned a tracked directory into a file: collect exits 0, the real directory stays, no temp file is left"
  else gap "C2-7 the agent turned a tracked directory (src/d/) into a file: collect exits $COLLECT_RC, real src/d is a $(stat -c %F "$REAL/src/d" 2>&1), stray files: $(find "$REAL" -name '*.collect.tmp' | tr '\n' ' ')"; fi
  kill_agent
}

checks_d() {
  section "D. wall clock"
  stage_stub sleep; run_round 5
  if jq -e '.exit_code == 124 and .wall_s <= 8 and .key_leaks == 0' "$OUT/agent-run.json" >/dev/null; then ok "D1 wall_seconds=5 with a stub that sleeps 300: agent-run.json $(jq -c . "$OUT/agent-run.json")"; else bad "D1 $(cat "$OUT/agent-run.json" 2>&1)"; fi
  [ "$(procs_of agentrun)" = 0 ] && [ "$(ps -eo args | grep -c '[a]gent-key-proxy')" = 0 ] && ok "D2 no agentrun process and no proxy survive (also not the setsid sleep 300 the stub started)" || bad "D2 survivors: $(pgrep -u agentrun -a | head -n 3 | tr '\n' '|')"
  stage_stub ignore-term; run_round 5; local ws; ws="$(jq -r .wall_s "$OUT/agent-run.json")"
  # timeout -k 30: SIGTERM at 5 s, SIGKILL at 35 s. A CLI that ignores SIGTERM must still be gone well before the stub's own 120 s.
  if [ "$ws" -ge 30 ] && [ "$ws" -le 45 ]; then ok "D3 a CLI that ignores SIGTERM is killed 30 s after the wall clock (wall_seconds=5, ran ${ws}s; timeout -k 30)"; else gap "D3 a CLI that ignores SIGTERM ran ${ws}s with wall_seconds=5; expected 30 to 45 s (SIGTERM, then SIGKILL after the 30 s grace of timeout -k 30)"; fi
  kill_agent
  stage_stub relay; local s_run=0 s_collect=0 s_fix=0 i n=10
  for i in $(seq 1 $n); do
    run_round 3; [ "$(procs_of agentrun)" = 0 ] || s_run=$((s_run + 1))
    as_runner env "${step_env[@]}" GITHUB_OUTPUT="$FC/set_output_collect" bash -c "cd '$REAL' && bash '$TOOLS/agent-sandbox.sh' collect" > /dev/null 2>&1; [ "$(procs_of agentrun)" = 0 ] || s_collect=$((s_collect + 1))
    as_runner sudo -n -u agentrun kill -KILL -1 2>/dev/null; sleep 0.2; [ "$(procs_of agentrun)" = 0 ] || s_fix=$((s_fix + 1)); kill_agent
  done
  if [ "$s_run" = 0 ]; then ok "D4 a process that forks its successor every few ms never outlived run's pkill ($n rounds)"
  else gap "D4 (random, rerun if clean) a pid-chasing relay process outlived 'sudo pkill -KILL -u agentrun': after run in $s_run/$n rounds, still after collect's second pkill in $s_collect/$n; 'sudo -n -u agentrun kill -KILL -1' (atomic in the kernel) left $s_fix/$n alive"; fi
}

checks_e() {
  section "E. surprises"
  local sp; sp="$(as_runner sudo -n -u agentrun printenv PATH 2>&1)"; info "E1 sudo secure_path: a bare 'sudo -u agentrun' runs with PATH=$sp (the scripts pass PATH through 'env -i', which is why it works)"
  info "E2 modes: /home/runner $(stat -c %a $HR), /home/agentrun $(stat -c %a /home/agentrun), /opt/agent-sandbox $(stat -c %a /opt/agent-sandbox), /opt/agent-tools $(stat -c %a /opt/agent-tools); useradd HOME_MODE $(awk '/^HOME_MODE/ {print $2}' /etc/login.defs)"
  local npm_owner; npm_owner="$(stat -c %U $HR/.npm 2>/dev/null) / root's: $(ls -ld /root/.npm 2>&1 | awk '{print $3}')"
  if [ "$(find $HR/.npm -user root 2>/dev/null | wc -l)" = 0 ]; then ok "E3 npm cache of runner stays runner-owned after setup ($npm_owner)"; else bad "E3 root wrote into runner's npm cache ($(find $HR/.npm -user root | wc -l) root-owned entries): later npm runs by runner hit EACCES"; fi
  local w; w="$(cd "$REAL" && as_agentrun sh -c 'echo cwd-ok' 2>&1 | tr '\n' ' ')"; info "E4 sudo -u agentrun from a cwd it cannot enter (the checkout under a 750 home): $w"
  # umask: setup run again under the strictest common umask
  as_runner env "${step_env[@]}" GITHUB_OUTPUT="$FC/set_output_umask" bash -c "umask 077; cd '$REAL' && bash '$TOOLS/agent-sandbox.sh' setup" > "$LOG/setup-umask.log" 2>&1; local pv; pv="$(as_agentrun pnpm --version 2>&1 | head -n 1)"
  if [ "$pv" = "$PNPM_VER" ] && as_agentrun sh -c 'cd /opt/agent-sandbox/repo && pnpm exec node -e "1"' >/dev/null 2>&1; then ok "E5 setup under a runner umask of 077 still leaves pnpm and the sandbox usable by agentrun"; else gap "E5 with the runner's umask at 077 agentrun cannot use pnpm/the sandbox (pnpm says: $pv); the workflow runner's umask is 022, so this is only a self-hosted risk"; fi
  # sizes: a tree with as many files as the real repo (38k tracked files, about 80 MB)
  rm -rf /opt/e-src /opt/e-dst; mkdir -p /opt/e-src/files /opt/e-src/.git/objects; local t0 t1 t2
  "$NODE_DIR/node" -e 'const fs = require("fs"); for (let i = 0; i < 38000; i++) { const d = "/opt/e-src/files/d" + (i % 400); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(d + "/f" + i, Buffer.alloc(2048)) }
    for (let i = 0; i < 20000; i++) { const d = "/opt/e-src/.git/objects/" + (i % 256).toString(16).padStart(2, "0"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(d + "/o" + i, Buffer.alloc(3000)) }'
  mkdir -p /opt/e-dst; t0=$(date +%s.%N); cp -a /opt/e-src/. /opt/e-dst/; t1=$(date +%s.%N); chown -R -h agentrun:agentrun /opt/e-dst; t2=$(date +%s.%N)
  info "E6 cp -a of 58k files (~140 MB): $(awk -v a="$t0" -v b="$t1" 'BEGIN {printf "%.1f", b - a}')s, chown -R: $(awk -v a="$t1" -v b="$t2" 'BEGIN {printf "%.1f", b - a}')s (the real repo's .git here is 1.9 GB, a blobless CI clone is far smaller)"
  rm -rf /opt/e-src /opt/e-dst
}

case "${1:-}" in
  provision) provision ;;
  checks)
    : "${PNPM_PIN:?}"
    reset_fixture
    checks_a && { checks_b; checks_c; checks_c2; checks_d; checks_e; }
    section "SUMMARY"; printf '%s ok, %s FAIL, %s GAP\n' "$OKS" "$FAILS" "$GAPS"
    [ "$FAILS" = 0 ] ;;
  *) echo "usage: provision|checks"; exit 2 ;;
esac
