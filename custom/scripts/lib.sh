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

# branch_sha REPO BRANCH: the commit the branch points at, or nothing when it does not exist. For a missing branch `gh api` prints the
# 404 JSON on STDOUT (stderr only gets "gh: Not Found"), so `|| true` alone turns "missing" into a value; only a 40-hex sha is accepted.
branch_sha() {
  local out
  out="$(gh api "repos/$1/git/ref/heads/$2" --jq .object.sha 2>/dev/null)" || return 0
  if [[ "$out" =~ ^[0-9a-f]{40}$ ]]; then printf '%s' "$out"; fi
  return 0
}

# Refs and branch names that come from workflow inputs are untrusted text.
valid_ref() { [[ "$1" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] && [[ "$1" != -* ]] && [[ "$1" != *..* ]]; }

# semver_gt A B: true when A is a strictly higher version than B (leading v ignored).
semver_gt() {
  local a="${1#v}" b="${2#v}"
  [ "$a" != "$b" ] && [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -n 1)" = "$a" ]
}

# The one identity the automation commits and opens PRs as. Upstream's own release commits carry the same name and email (its
# release bot is github-actions too), so this identity alone never proves a commit is ours: see stale-sync-pr.sh.
# AUTOMATION_LOGIN_RE matches the login `gh` reports for it (a PR author is `app/github-actions`, a comment author `github-actions[bot]`).
AUTOMATION_NAME="github-actions[bot]"
AUTOMATION_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
AUTOMATION_LOGIN_RE='^(app/)?github-actions(\[bot\])?$'

# git identity for commits made by the automation (local config only).
set_git_identity() {
  git config user.name "$AUTOMATION_NAME"
  git config user.email "$AUTOMATION_EMAIL"
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

# Fork scaffolding: paths that are not product code, that upstream never owns, and where our side always wins a merge.
# ONE list, two uses, so they cannot drift apart: our_wins_path matches a file path against it with `case`, and
# customization_log_pathspecs turns it into git pathspecs (git's default pathspec matching lets `*` match `/`, like `case` does).
# test-scaffolding-paths.sh asserts that the two agree.
OUR_WINS_PATTERNS=('custom/*' '.github/pull_request_template.md' '.github/workflows/custom-*' 'CUSTOM.md' 'CLAUDE.md' '.claude/skills/fork-*')

# Does the file path match one of the "our side always wins" patterns?
our_wins_path() {
  local pat
  for pat in "${OUR_WINS_PATTERNS[@]}"; do
    # shellcheck disable=SC2254 # the pattern is meant to be a glob
    case "$1" in $pat) return 0 ;; esac
  done
  return 1
}

# release_edit_path_ok UPSTREAM_SHA PATH: may a repair round edit PATH because the hunk-survival check named it? Its hunk-survival.json
# comes from a gates artifact written by a job that also runs third-party install and test code, so it is not trusted: PATH must be a
# plain relative path, not fork scaffolding or upstream CI, and a FILE that exists in the new release's tree (git cat-file on the tree
# only, no blob is fetched). A made-up path therefore widens nothing. Never edits, only answers (0 = ok).
release_edit_path_ok() {
  local sha="$1" p="$2"
  case "$p" in
    '' | /* | ./* | ../* | */./* | */../* | */.. | */. | . | .. | .git | .git/* | */.git | */.git/* | *$'\n'* | *$'\r'*) return 1 ;;
  esac
  if our_wins_path "$p" || foreign_ci_path "$p"; then return 1; fi
  [ "$(git cat-file -t "$sha:$p" 2>/dev/null)" = blob ]
}

# Pathspecs (one per line) that keep fork scaffolding out of a git log of our customization commits: every our-wins pattern,
# plus all of .github (fork CI, and the upstream CI the fork drops). Pass them after `-- .` to `git log`.
customization_log_pathspecs() {
  printf ':(exclude)%s\n' "${OUR_WINS_PATTERNS[@]}" '.github/*'
}

# customization_log BASE_SHA: the customization commits (trailer Orca-Custom-Patch) reachable from BASE_SHA that change
# product code, newest first, as "- <hash>: <subject>" plus the body. Commits that only touch fork scaffolding are left out.
customization_log() {
  local -a excludes=()
  local x
  while IFS= read -r x; do excludes+=("$x"); done < <(customization_log_pathspecs)
  git log --no-merges --grep='^Orca-Custom-Patch:' --format='- %h: %s%n%b' "$1" -- . "${excludes[@]}"
}

# trunc_bytes N: copy at most the first N bytes of stdin to stdout and READ ALL of stdin. Use it instead of `| head -c N` in
# a script that runs with `set -o pipefail`: `head` exits once it has its N bytes, the producer then writes into a closed
# pipe and dies of SIGPIPE, pipefail turns that into exit 141, and `set -e` ends the script (the sync's model step died of
# exactly this when the customization log passed 6000 bytes). Here the producer always finishes, so a pipeline's status is
# the producer's real one. Bytes, not characters (a multibyte character can be cut), like head -c.
trunc_bytes() {
  head -c "$1"
  cat > /dev/null
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

# A model cannot delete a file (its tools can only read and edit). To drop a file of a modify/delete conflict (upstream deleted it, or
# we did) it replaces the WHOLE file with this one line, and sync-merge.sh finish removes it. Never honoured anywhere else.
DELETE_SENTINEL="DELETE-THIS-FILE"
is_delete_request() { # PATH
  [ -f "$1" ] && [ "$(wc -c < "$1" | tr -d ' ')" -le 64 ] && [ "$(tr -d '[:space:]' < "$1")" = "$DELETE_SENTINEL" ]
}

# round_score ALL_DIR N: print how bad round N's candidate is (lower wins); return 1 when the round left no candidate (no
# sync-facts.json or no merge.bundle, e.g. its job crashed). ALL_DIR holds the downloaded round-N/ and gates-N-*/ directories.
# Resolved merge: the number of failed gates; 1000 when its gates never reported. Unresolved merge: 1000 plus the number of files
# still carrying conflict markers (at least 1), so a candidate that resolved more of them wins and any candidate that really
# passed or failed its gates beats every unresolved one. 100000 when the round's output contained the API key (its edits were
# discarded): it loses to everything, even to a candidate with every file unresolved.
round_score() {
  local all="$1" n="$2" d score=1000 g
  local -a files=()
  d="$all/round-$n"
  [ -s "$d/sync-facts.json" ] && [ -s "$d/merge.bundle" ] || return 1
  if [ "$(jq -r '.unresolved' "$d/sync-facts.json")" != true ]; then
    for g in "$all"/gates-"$n"-*/gates.json; do if [ -s "$g" ]; then files+=("$g"); fi; done
    if [ "${#files[@]}" -gt 0 ]; then score="$(jq -s '[.[].gates[] | select(.status == "fail")] | length' "${files[@]}")"; fi
  else
    score=$((1000 + $(jq -r '[((.unresolved_files // []) | length), 1] | max' "$d/sync-facts.json")))
  fi
  if [ "$(jq -r '.key_leak // false' "$d/sync-facts.json")" = true ]; then score=100000; fi
  printf '%s\n' "$score"
}

# failing_gates_block TOTAL_BYTES GATES_JSON...: the text of the failing gates for a repair prompt, one "### <gate> (exit N)" section each.
# A gate's text is its `details` (the failure excerpt run-gates.sh records; cut from the START when too long) or, for a gates.json that has
# none, its `output_tail` (cut from the END, where the failure is). The budget is shared FAIRLY: gates are served shortest first and each
# may take at most an equal share of what is left, so a gate with little to say frees room for the others and one huge gate cannot starve
# the rest (with one shared budget the first gates filled it, and the e2e ratchet output never reached round 3 of v1.4.265). Everything is
# counted in BYTES, like the caller's trunc_bytes (which cuts the END of the block, i.e. the last gate in gate order: e2e-ratchet, e2e): each
# gate first sets aside the real size of its header, its cut marker and its newline, the rest is shared, and a cut falls on a character
# boundary. So the block is never over TOTAL_BYTES and every gate keeps a section (unless TOTAL_BYTES is below about 150 per gate).
failing_gates_block() {
  local total="$1"; shift
  jq -r -s --argjson total "$total" '
    def bytes: utf8bytelength;
    def head_fit($b): . as $s | if ($s | bytes) <= $b then $s else
      ({lo: 0, hi: ($s | length)} | until(.lo >= .hi; (((.lo + .hi + 1) / 2) | floor) as $m | if ($s[:$m] | bytes) <= $b then .lo = $m else .hi = ($m - 1) end) | $s[:.lo]) end;
    def tail_fit($b): . as $s | if ($s | bytes) <= $b then $s else
      ({lo: 0, hi: ($s | length)} | until(.lo >= .hi; (((.lo + .hi + 1) / 2) | floor) as $m | if ($s[-$m:] | bytes) <= $b then .lo = $m else .hi = ($m - 1) end) | if .lo == 0 then "" else $s[-(.lo):] end) end;
    [.[].gates[]? | select(.status == "fail")] as $g
    | ($g | length) as $n
    | if $n == 0 then empty else
        ($g | to_entries | map(.key as $i | .value as $v
          | (($v.details // "") != "") as $det
          | (($v.details // "") as $d | if $d != "" then $d else ($v.output_tail // "") end) as $t
          | ("### \($v.name) (exit \($v.exit_code))\(if $det then " - failure excerpt" else " - end of the log" end)\n") as $h
          | (if $det then "\n[... cut to fit; the rest is in the gates artifact]" else "[... start cut ...]\n" end) as $m
          | {i: $i, head: $h, mark: $m, detailed: $det, text: $t, tb: ($t | bytes), over: (($h | bytes) + ($m | bytes) + 1)})) as $e
        | (reduce ($e | sort_by(.tb))[] as $x ({rem: ([($total - ($e | map(.over) | add)), 0] | max), left: $n, out: []};
            ([$x.tb, ((.rem / .left) | floor)] | min) as $a
            | .out += [$x + {allow: $a}] | .rem -= $a | .left -= 1)).out
        | sort_by(.i)[]
        | . as $x
        | $x.head + (if $x.tb <= $x.allow then $x.text
                     elif $x.detailed then ($x.text | head_fit($x.allow)) + $x.mark
                     else $x.mark + ($x.text | tail_fit($x.allow)) end)
      end' "$@"
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
  pf="$(sed -n -E "s/^pnpmfile:[[:space:]]*[\"']?([^\"'#[:space:]]+).*/\\1/p" pnpm-workspace.yaml 2>/dev/null)"
  pf="${pf%%$'\n'*}" # the first match; taken after sed has finished, so sed can never be cut off by a closed pipe
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
