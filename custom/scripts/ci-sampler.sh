#!/usr/bin/env bash
# Sample disk, swap and memory on a macOS runner while a build runs, then print the peaks.
#
#   ci-sampler.sh start <csv-file>     begin sampling every ${SAMPLE_SECS:-15} s in the background
#   ci-sampler.sh stop  <csv-file>     stop it (idempotent)
#   ci-sampler.sh report <csv-file>    print min free disk, peak swap and peak app memory
#
# Columns: epoch, free disk KB on the data volume, swap used MB, memory in use MB (active + wired + compressed).
# It exists to answer "did the hosted runner run out of disk or memory, and how close did it get".
set -euo pipefail

cmd="${1:?usage: ci-sampler.sh start|stop|report <csv-file>}"
csv="${2:?csv file}"
pidfile="${csv}.pid"

sample_once() {
  local now free_kb swap_mb used_mb
  now="$(date +%s)"
  free_kb="$(df -k /System/Volumes/Data 2>/dev/null | awk 'NR==2{print $4}')"
  swap_mb="$(sysctl -n vm.swapusage 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="used"){gsub("M","",$(i+2)); print int($(i+2))}}')"
  used_mb="$(vm_stat 2>/dev/null | awk '
    /page size of/ {gsub("[^0-9]","",$8); ps=$8}
    /Pages active/ {gsub("\\.","",$3); a=$3}
    /Pages wired down/ {gsub("\\.","",$4); w=$4}
    /occupied by compressor/ {gsub("\\.","",$5); c=$5}
    END {if (ps=="") ps=16384; printf "%d", (a+w+c)*ps/1048576}')"
  printf '%s,%s,%s,%s\n' "$now" "${free_kb:-0}" "${swap_mb:-0}" "${used_mb:-0}"
}

case "$cmd" in
  start)
    : >"$csv"
    (
      while :; do
        sample_once >>"$csv"
        sleep "${SAMPLE_SECS:-15}"
      done
    ) >/dev/null 2>&1 &
    echo $! >"$pidfile"
    disown || true
    echo "sampler started (pid $(cat "$pidfile")), writing $csv"
    ;;
  stop)
    if [ -f "$pidfile" ]; then
      kill "$(cat "$pidfile")" 2>/dev/null || true
      rm -f "$pidfile"
    fi
    ;;
  report)
    sample_once >>"$csv"
    awk -F, '
      NR==1 {first=$1; minfree=$2; maxswap=$3; maxmem=$4; startfree=$2}
      {if ($2 < minfree) {minfree=$2; tmin=$1}
       if ($3 > maxswap) maxswap=$3
       if ($4 > maxmem) maxmem=$4
       last=$1}
      END {
        printf "samples: %d over %d s\n", NR, last-first
        printf "free disk at start: %.1f GB, minimum: %.1f GB (peak disk use during the run: %.1f GB, at +%d s)\n", startfree/1048576, minfree/1048576, (startfree-minfree)/1048576, tmin-first
        printf "swap used, peak: %d MB\n", maxswap
        printf "memory in use (active+wired+compressed), peak: %d MB\n", maxmem
      }' "$csv"
    ;;
  *)
    echo "usage: ci-sampler.sh start|stop|report <csv-file>" >&2
    exit 2
    ;;
esac
