#!/usr/bin/env bash
# Test for lib.sh's trunc_bytes, and a guard against the SIGPIPE class it exists for.
# Run: bash custom/scripts/test/test-trunc-bytes.sh      (needs bash, head, tr; no git, no network)
#
# The class: under `set -o pipefail` a pipeline whose LAST command stops reading early (`head -c N`, `grep -q`, `sed -n 'p;q'`,
# `awk ... exit`) kills a producer that still has output: the producer dies of SIGPIPE, the pipeline exits 141 and `set -e` ends
# the script. The sync's model step died of exactly this (`git log ... | head -c 6000`). Part 1 proves trunc_bytes (which reads
# ALL of its input) never does that, even for a 10 MB producer, and still reports a producer's REAL failure. Part 2 scans the
# scripts for an early-exit consumer after a pipe: a new one must be rewritten (trunc_bytes, a here-string, or capture first and
# cut afterwards), or, when the producer is known to be tiny, carry the marker `pipe-ok: <why>` on its line.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="${SCRIPTS_DIR:-$(cd "$here/.." && pwd)}"
repo_root="$(cd "$scripts/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# run_case NAME SNIPPET: run SNIPPET in a fresh bash with lib.sh sourced (set -euo pipefail comes from lib.sh); sets c_rc c_out.
# `producer` writes 10 MB and its status is that of its own pipeline, as `git log` and `jq` have theirs (141 when they are
# killed by SIGPIPE); it leaves a flag file only when it ran to the end. (Inside $(...) bash clears `set -e`, so the producer
# must report the failure through its status, not rely on errexit.)
run_case() {
  c_rc=0
  c_out="$(bash -c ". '$scripts/lib.sh'; flag='$tmp/flag-$1'; rm -f \"\$flag\"
    producer() { head -c 10485760 /dev/zero | tr '\\0' x && : > \"\$flag\"; }
    $2" 2>/dev/null)" || c_rc=$?
}

# ---- part 1: trunc_bytes ------------------------------------------------------------------------------------------------
run_case big 'x="$(producer | trunc_bytes 100)"; echo "${#x}"'
if [ "$c_rc" = 0 ] && [ "$c_out" = 100 ] && [ -f "$tmp/flag-big" ]; then ok "a 10 MB producer into trunc_bytes 100: exit 0, exactly 100 bytes, the producer ran to the end"
else bad "10 MB producer: rc=$c_rc out=[$c_out] producer-finished=$([ -f "$tmp/flag-big" ] && echo yes || echo no)"; fi

run_case control 'x="$(producer | head -c 100)"; echo "${#x}"'
if [ "$c_rc" != 0 ] && [ ! -f "$tmp/flag-control" ]; then ok "control: the same producer into head -c 100 dies (exit $c_rc) before it finishes"
else bad "control did not reproduce the SIGPIPE here: rc=$c_rc"; fi

run_case fail 'x="$({ echo partial; return 3; } | trunc_bytes 100)"; echo survived'
if [ "$c_rc" != 0 ] && [ "$c_out" != survived ]; then ok "a producer that really fails still fails the pipeline (exit $c_rc)"; else bad "producer failure was hidden: rc=$c_rc out=[$c_out]"; fi

run_case short 'printf "abc" | trunc_bytes 100'
if [ "$c_rc" = 0 ] && [ "$c_out" = abc ]; then ok "input shorter than the limit passes through unchanged"; else bad "short input: rc=$c_rc out=[$c_out]"; fi
run_case exact 'printf "12345" | trunc_bytes 3'
if [ "$c_rc" = 0 ] && [ "$c_out" = 123 ]; then ok "the cut is exactly N bytes"; else bad "exact cut: rc=$c_rc out=[$c_out]"; fi
run_case empty 'x="$(printf "" | trunc_bytes 10)"; echo "[${#x}]"'
if [ "$c_rc" = 0 ] && [ "$c_out" = "[0]" ]; then ok "empty input gives empty output and exit 0"; else bad "empty input: rc=$c_rc out=[$c_out]"; fi
printf 'file input 12345678' > "$tmp/in.txt"
run_case file "trunc_bytes 10 < '$tmp/in.txt'"
if [ "$c_rc" = 0 ] && [ "$c_out" = "file input" ]; then ok "stdin may be a file"; else bad "file input: rc=$c_rc out=[$c_out]"; fi

# ---- part 2: no early-exit consumer after a pipe -----------------------------------------------------------------------
# A line is flagged when, outside a comment, a pipe feeds head, grep -q/-m, sed with a quit command, or awk with exit.
scan() { # FILE...
  awk '
    FNR == 1 { carry = 0 }
    /^[[:space:]]*#/ { next }
    /pipe-ok:/ { carry = 0; next }
    {
      orig = $0
      line = $0
      gsub(/\|\|/, " OR ", line) # `a || grep -q x` is not a pipe
      if (carry) line = "| " line  # the previous line ended in a pipe, so this line starts the consumer
      carry = (line ~ /\|[[:space:]]*\\?[[:space:]]*$/)
    }
    line ~ /\|[[:space:]]*head([[:space:]]|$)/ { print FILENAME ":" FNR ": " orig; next }
    line ~ /\|[[:space:]]*grep[^|]*[[:space:]]-[a-zA-Z]*[qm][0-9]*([[:space:]]|$)/ { print FILENAME ":" FNR ": " orig; next }
    line ~ /\|[[:space:]]*grep[^|]*--(quiet|silent|max-count)/ { print FILENAME ":" FNR ": " orig; next }
    line ~ /\|[[:space:]]*sed[^|]*[0-9;{[:space:]]q([;} "\x27]|$)/ { print FILENAME ":" FNR ": " orig; next }
    line ~ /\|[[:space:]]*awk[^|]*exit/ { print FILENAME ":" FNR ": " orig; next }
  ' "$@"
}
files=("$scripts"/*.sh)
for w in "$repo_root"/.github/workflows/custom-*.yml; do [ ! -f "$w" ] || files+=("$w"); done
flagged="$(scan "${files[@]}")"
if [ -z "$flagged" ]; then ok "no script or custom workflow pipes into head, grep -q/-m, sed q or awk exit (${#files[@]} files scanned)"
else bad "early-exit consumers after a pipe (use trunc_bytes, a here-string, or capture first and cut after):"; printf '%s\n' "$flagged" | sed 's/^/    /'; fi
# the scanner itself must flag each shape
probe="$tmp/probe.sh"
printf '%s\n' 'a | head -c 10' 'b | grep -q x' 'c | grep -m1 x' 'd | sed -n "1p;q"' 'e | awk "NR==1{exit}"' 'j | sed 1q' \
  '# f | head -c 10' 'g | head -c 10 # pipe-ok: tiny' 'h | tail -n 1' 'i | grep -c x' 'k || grep -q x file' 'l | sed -n "s/x/q/p"' \
  'm |' '  head -c 5' 'n || true' > "$probe"
if [ "$(scan "$probe" | wc -l | tr -d ' ')" = 7 ]; then ok "the scanner flags the seven early-exit shapes (one with the consumer on the next line) and ignores comments, pipe-ok lines, tail, grep -c, || grep -q and a quoted q"
else bad "scanner self-check: $(scan "$probe" | tr '\n' '|')"; fi

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
