#!/usr/bin/env bash
# Sourced by run-gates.sh and by custom/scripts/test/test-gate-details.sh; never run it. Needs lib.sh (strip_ansi, trunc_bytes).
#
# Why: the repair round of the sync agent used to see only the last 40 lines (3500 bytes) of a failing gate's log. For the
# Playwright gate that is a list of failing test NAMES; the assertion messages (`Expected ... Received ...`) sit above it. In PR #43
# the model could therefore not tell WHY an e2e spec failed, and a human fixed the sync by hand.
#
# gate_details ID LOGFILE: print a compact excerpt of a FAILING gate's log, for gates.json `details`. Text only, bounded:
#   - about GATE_DETAILS_TARGET bytes (8000), never more than GATE_DETAILS_MAX (12000); GATE_DETAILS_BYTES lowers the target (tests);
#   - ANSI colour, CR, NUL and other control bytes removed, malformed UTF-8 dropped (it goes through jq into JSON);
#   - one small extractor per tool (tsc, oxlint, oxfmt, vitest, Playwright), picked by gate id; each keeps what says WHY (the
#     assertion, the diff, the error text, the location) and drops what only shows where (code frames, tails of call logs);
#   - never worse than the old tail: when no extractor finds anything (a build error, a global-setup error, an install error) the
#     lines that look like errors are shown, and the last lines of the log always follow.
# Always returns 0 and prints nothing for an unreadable or empty log; the caller decides what to do with an empty result.

GATE_DETAILS_TARGET=8000
GATE_DETAILS_MAX=12000

# Clean text on stdout: no colour, no CR, no control bytes (tab and newline stay).
gate_details_clean() { strip_ansi | LC_ALL=C tr -d '\r\000-\010\013\014\016-\037\177'; }

# Valid UTF-8 only: malformed bytes are DROPPED (the byte cut can split a character, and the text goes through jq into JSON). Done with perl
# and not iconv: macOS's iconv rejected valid text whose characters straddled its read buffer. The input is already bounded (12000 bytes).
gate_details_utf8() {
  perl -MEncode -e 'binmode STDIN; binmode STDOUT; local $/; my $s = <STDIN>; $s = "" unless defined $s; print Encode::encode("UTF-8", Encode::decode("UTF-8", $s, sub { "" }));'
}

# tsc and anything that prints `error TSnnnn` (pretty or not, with or without a project prefix): counts by code and file first,
# then each distinct error line with the indented lines that continue its message. The ratchet's own verdict lines come first.
gate_details_tsc() {
  local prog
  read -r -d '' prog <<'PERL' || true
my (%code, %file, @lines, %seen, @verdict, $open);
while (my $l = <STDIN>) {
  chomp $l;
  if ($l =~ /error (TS\d+):/) {
    my $c = $1;
    $open = undef;
    next if $seen{$l}++;
    my $f;
    if ($l =~ /^(?:\[[^\]]*\]\s*)?(.*?)\(\d+,\d+\): error/) { $f = $1 } elsif ($l =~ /^(?:\[[^\]]*\]\s*)?(.*?):\d+:\d+ - error/) { $f = $1 }
    $code{$c}++;
    $file{$f}++ if defined $f;
    push @lines, substr($l, 0, 400);
    $open = 0;
    next;
  }
  if ($l =~ /type error\(s\), baseline allows|, baseline \d+\.|baseline may only shrink/) { push @verdict, substr($l, 0, 300); next }
  if (defined $open && $open < 4 && $l =~ /^\s{2,}\S/ && $l !~ /^\s+\d+\s/ && $l !~ /^\s*[~^]+\s*$/) { push @lines, substr($l, 0, 400); $open++; next }
  $open = undef;
}
exit 0 unless @lines;
my $n = scalar keys %seen;
my @c = sort { $code{$b} <=> $code{$a} || $a cmp $b } keys %code;
my @f = sort { $file{$b} <=> $file{$a} || $a cmp $b } keys %file;
print "tsc: ", scalar(grep { /error TS\d+:/ } @lines), " distinct error(s) in ", scalar(@f), " file(s)\n";
print "by code: ", join(", ", map { "$_ x$code{$_}" } @c[0 .. ($#c > 9 ? 9 : $#c)]), "\n";
print "by file: ", join(", ", map { "$_ ($file{$_})" } @f[0 .. ($#f > 24 ? 24 : $#f)]), "\n" if @f;
print "$_\n" for @verdict;
print "\n", join("\n", @lines), "\n";
PERL
  perl -e "$prog"
}

# oxlint: the graphical report (`x rule: message` then `,-[path:line:col]`), the one-line report (`path:l:c: error rule: message`) and
# the GitHub annotation form (`::error title=rule,file=path,line=N,...::message`) all become one `path:line:col: message` line.
gate_details_oxlint() {
  local prog
  read -r -d '' prog <<'PERL' || true
my (@diag, %file, $pending, $summary);
while (my $l = <STDIN>) {
  chomp $l;
  my ($loc, $msg);
  if ($l =~ /^(\S.*?):(\d+):(\d+): (error|warning) (.+)$/) { my ($f, $ln, $c, $sev, $t) = ($1, $2, $3, $4, $5); $t =~ s/ help: .*$//; $loc = "$f:$ln:$c"; $msg = "$sev $t"; $file{$f}++ }
  elsif ($l =~ /^::(error|warning) (.*?)::(.*)$/) {
    my ($sev, $props, $text) = ($1, $2, $3);
    my %p = map { /^([a-zA-Z]+)=(.*)$/ ? ($1 => $2) : () } split /,(?=[a-zA-Z]+=)/, $props;
    $text =~ s/^\Q$p{file}\E:\d+:\d+: // if defined $p{file};
    $loc = "$p{file}:$p{line}:$p{col}"; $msg = "$sev " . ($p{title} // "") . ": $text"; $file{$p{file}}++ if defined $p{file};
  }
  elsif ($l =~ /^\s+(?:x|!|\xc3\x97) (.+)$/) { $pending = $1; next }
  elsif (defined $pending && $l =~ /^\s+,-\[(.+?):(\d+):(\d+)\]/) { $loc = "$1:$2:$3"; $msg = $pending; $file{$1}++; $pending = undef }
  elsif ($l =~ /^Found \d+ warnings? and \d+ errors?/) { $summary = $l; next }
  else { next }
  push @diag, substr("$loc: $msg", 0, 400);
}
exit 0 unless @diag;
my @f = sort { $file{$b} <=> $file{$a} || $a cmp $b } keys %file;
print "oxlint: ", scalar(@diag), " diagnostic(s) in ", scalar(@f), " file(s)", (defined $summary ? " ($summary)" : ""), "\n";
print "by file: ", join(", ", map { "$_ ($file{$_})" } @f[0 .. ($#f > 24 ? 24 : $#f)]), "\n" if @f;
print "\n", join("\n", @diag), "\n";
PERL
  perl -e "$prog"
}

# oxfmt --check: the list of files that differ from the formatter's output (a bare path per line, or `[warn] path`).
gate_details_oxfmt() {
  local prog
  read -r -d '' prog <<'PERL' || true
my (@files, @verdict, $on);
while (my $l = <STDIN>) {
  chomp $l;
  if ($l =~ /Checking formatting/) { $on = 1; next }
  if ($l =~ /^\s*(?:Format issues found|Finished in)/) { push @verdict, $l =~ s/^\s+//r; next }
  if ($l =~ /^\s*\[warn\]\s+(\S.*?)\s*$/) { push @files, $1 unless $1 =~ /^(?:Code style issues|Run Prettier)/; next }
  if ($on && $l =~ /^\s*(\S+\.[A-Za-z0-9]+)(?:\s+\(\d[\d.]*\s*m?s\))?\s*$/) { push @files, $1 }
}
exit 0 unless @files;
print "oxfmt --check: ", scalar(@files), " file(s) differ from the formatter's output. Fix with: pnpm exec oxfmt --write <file>\n";
print "$_\n" for @files[0 .. ($#files > 119 ? 119 : $#files)];
print "... and ", scalar(@files) - 120, " more\n" if @files > 120;
print "$_\n" for @verdict;
PERL
  perl -e "$prog"
}

# vitest (the default reporter): the summary, then every ` FAIL  <file> > <test>` block (error message, the expected/received diff,
# the first stack lines; the source frame is dropped) and the "Unhandled Errors" section up to the summary.
gate_details_vitest() {
  local prog
  read -r -d '' prog <<'PERL' || true
my (@blocks, @summary, $cur, $kept, $stack, $unhandled);
sub flush { push @blocks, join("\n", @$cur) if $cur && @$cur > 0; $cur = undef }
while (my $l = <STDIN>) {
  chomp $l;
  if ($l =~ /^\s*(Test Files|Tests|Errors|Type Errors)\s+\d/) { flush(); $unhandled = 0; my $s = $l; $s =~ s/^\s+//; push @summary, $s; next }
  if ($l =~ /^ FAIL  (.*)$/) { flush(); $unhandled = 0; $cur = [substr(" FAIL  $1", 0, 300)]; $kept = 0; $stack = 0; next }
  if ($l =~ /^(?:\xe2\x8e\xaf)+/) {
    if ($l =~ /Unhandled (?:Errors|Rejections?)/) { flush(); $unhandled = 1; $cur = ["Unhandled Errors"]; $kept = 0; $stack = 0; }
    elsif (!$unhandled) { flush() }
    next;
  }
  next unless $cur;
  next if $l =~ /^\s*$/ || $l =~ /^\s+\d+\|/ || $l =~ /^\s+\|/;
  if ($l =~ /^ \xe2\x9d\xaf /) { next if $stack++ >= 3 }
  next if $kept >= ($unhandled ? 40 : 24);
  push @$cur, substr($l, 0, 300);
  $kept++;
}
flush();
exit 0 unless @blocks;
print "vitest: ", join(" | ", @summary), "\n\n" if @summary;
print join("\n\n", @blocks), "\n";
PERL
  perl -e "$prog"
}

# Playwright (list and dot reporters print the same numbered failure blocks at the end): the summary, then every
# `  N) [project] > file:line:col > title` block with its error text, expected/received, the first call-log lines, the failing source
# line (the one marked `>`) and the first `at file:line` location. The rest of the code frame is dropped.
gate_details_playwright() {
  local prog
  read -r -d '' prog <<'PERL' || true
my (@blocks, @summary, $cur, $kept, $at);
sub flush { push @blocks, join("\n", @$cur) if $cur && @$cur > 0; $cur = undef }
while (my $l = <STDIN>) {
  chomp $l;
  if ($l =~ /^\s{0,4}\d+\) \[[^\]]+\] /) { flush(); my $h = $l; $h =~ s/^\s+//; $h =~ s/\s+$//; $cur = [substr($h, 0, 400)]; $kept = 0; $at = 0; next }
  if ($l =~ /^\s{0,4}(\d+ (?:failed|flaky|passed|skipped|did not run|interrupted)\b.*)$/) { flush(); push @summary, $1; next }
  next unless $cur;
  next if $l =~ /^\s*$/ || $l =~ /^\s+\d+ \|/ || $l =~ /^\s+\|/ || $l =~ /^\s+Error Context:/ || $l =~ /^\s+attachment #\d+/ || $l =~ /^\s+(?:\S*\/)?test-results\// || $l =~ /^\s*Retry #\d+/ || $l =~ /^\s*\xe2\x94\x80+\s*$/;
  if ($l =~ /^\s+at .*:\d+:\d+/) { next if $at++ >= 1 }
  next if $kept >= 26;
  my $s = $l; $s =~ s/^\s+//; $s =~ s/\s+$//;
  push @$cur, "  " . substr($s, 0, 300);
  $kept++;
}
flush();
exit 0 unless @blocks;
print "playwright: ", join(", ", @summary), "\n\n" if @summary;
print join("\n\n", @blocks), "\n";
PERL
  perl -e "$prog"
}

# The fallback and the second half of every excerpt: the first lines that look like an error, each cut to 300 bytes.
gate_details_error_lines() {
  local prog
  read -r -d '' prog <<'PERL' || true
my $n = 0;
while (my $l = <STDIN>) {
  next unless $l =~ /(?:^|[^A-Za-z])(?:error|err!|err_[a-z_]+|fail(?:ed|ure|s)?|fatal|panic|exception|cannot find|not found|enoent|eaddrinuse|timed out|timeout|unexpected|unresolved|over cap)(?:[^A-Za-z]|$)/i;
  chomp $l;
  print substr($l, 0, 300), "\n";
  last if ++$n >= 40;
}
PERL
  perl -e "$prog"
}

# gate_details ID LOGFILE
gate_details() {
  local id="$1" log="$2" want="${GATE_DETAILS_BYTES:-$GATE_DETAILS_TARGET}" clean body tail_text="" body_text cut=0 room found=1 tail_lines=6 tail_bytes=800
  case "$want" in ''|*[!0-9]*) want="$GATE_DETAILS_TARGET" ;; esac
  [ "$want" -le "$GATE_DETAILS_MAX" ] || want="$GATE_DETAILS_MAX"
  [ -s "$log" ] || return 0
  clean="$(mktemp)"; body="$(mktemp)"
  gate_details_clean < "$log" > "$clean" || true
  case "$id" in
    typecheck|e2e-ratchet) gate_details_tsc < "$clean" > "$body" || : > "$body" ;;
    lint) gate_details_oxlint < "$clean" > "$body" || : > "$body" ;;
    format) gate_details_oxfmt < "$clean" > "$body" || : > "$body" ;;
    unit|unit-related) gate_details_vitest < "$clean" > "$body" || : > "$body" ;;
    e2e) gate_details_playwright < "$clean" > "$body" || : > "$body" ;;
    *) : > "$body" ;;
  esac
  if [ ! -s "$body" ]; then
    # No extractor, or it found nothing (a build error, a global-setup error, an install error): error-looking lines, then a longer end of the log.
    found=0; tail_lines=25; tail_bytes=2500
    gate_details_error_lines < "$clean" > "$body" || : > "$body"
  fi
  tail_text="$(tail -n "$tail_lines" "$clean" | tail -c "$tail_bytes")" # the END of the log: tail -c keeps the last bytes (trunc_bytes would keep the first)
  # The end of the log always follows: what the tool printed last is often the reason for the exit code.
  room=$((want - ${#tail_text} - 120))
  [ "$room" -ge 500 ] || room=500
  if [ "$(wc -c < "$body" | tr -d ' ')" -gt "$room" ]; then cut=1; fi
  body_text="$(trunc_bytes "$room" < "$body")"
  rm -f "$clean" "$body"
  {
    [ "$found" -eq 1 ] || printf '%s\n' "(no recognised failure report in the log; error-looking lines first)"
    [ -z "$body_text" ] || printf '%s\n' "$body_text"
    [ "$cut" -eq 0 ] || printf '[... cut here; the whole log is in the gates artifact (logs/%s.log)]\n' "$id"
    printf '%s\n' "--- last lines of the log ---"
    printf '%s\n' "$tail_text"
  } | trunc_bytes "$GATE_DETAILS_MAX" | gate_details_utf8
  return 0
}
