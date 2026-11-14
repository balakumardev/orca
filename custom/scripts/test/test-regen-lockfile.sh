#!/usr/bin/env bash
# Unit test for regen_lockfile in custom/scripts/lib.sh, with a stub `pnpm`. Run: bash custom/scripts/test/test-regen-lockfile.sh
#
# The sync scripts regenerate pnpm-lock.yaml in jobs that handle upstream-controlled files. The regeneration must not run
# the workspace's pnpmfile (JavaScript from the merged tree) or any lifecycle script. Ignoring the pnpmfile makes real
# pnpm drop `pnpmfileChecksum:` from the lockfile, and `pnpm install --frozen-lockfile` then refuses the lockfile, so the
# helper puts the line back. The stub reproduces that drop (measured with pnpm 12.14.0 on upstream v1.4.258).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
for tool in awk openssl base64 sed grep; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

mkdir "$tmp/bin"
cat > "$tmp/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
# Stub pnpm: records its arguments and, like pnpm with --ignore-pnpmfile, writes the lockfile without pnpmfileChecksum
# (the line and the blank line after it, as real pnpm lays the file out).
printf '%s\n' "$*" >> "$(dirname "$0")/argv.log"
awk '/^pnpmfileChecksum:/ { skip = 1; next } skip && $0 == "" { skip = 0; next } { skip = 0; print }' pnpm-lock.yaml > pnpm-lock.yaml.stub && mv pnpm-lock.yaml.stub pnpm-lock.yaml
STUB
chmod +x "$tmp/bin/pnpm"
export PATH="$tmp/bin:$PATH"

# A two-document lockfile shaped like pnpm 12's (an environment document, then the project's).
write_lock() {
  cat > pnpm-lock.yaml <<'EOF'
---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}

packages:

  pnpm@12.14.0:
    resolution: {integrity: sha512-x}

---
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

overrides:
  hono@>=4.12.4 <4.13.11: 4.13.11

packageExtensionsChecksum: sha256-AAAA

pnpmfileChecksum: sha256-STALE

patchedDependencies:
  ws@8.22.0: abc

importers:

  .:
    dependencies: {}

packages: {}
EOF
}

run_regen() { ( cd "$1" && bash -c ". '$scripts/lib.sh'; regen_lockfile" ); }
expected_sum() { printf 'sha256-%s' "$(openssl dgst -sha256 -binary "$1" | base64 | tr -d '\n')"; }

# 1. pnpmfile named in pnpm-workspace.yaml
mkdir -p "$tmp/a/config" && cd "$tmp/a"
printf 'packages:\n  - src/*\n\npnpmfile: config/pnpmfile.cjs\n' > pnpm-workspace.yaml
printf "'use strict'\nmodule.exports = { hooks: {} }\n" > config/pnpmfile.cjs
write_lock
run_regen "$tmp/a" > /dev/null 2>&1
argv="$(cat "$tmp/bin/argv.log")"
check "pnpm ran with --lockfile-only" grep -q -- '--lockfile-only' <<<"$argv"
check "pnpm ran with --ignore-scripts" grep -q -- '--ignore-scripts' <<<"$argv"
check "pnpm ran with --ignore-pnpmfile" grep -q -- '--ignore-pnpmfile' <<<"$argv"
check "the checksum line is back, exactly once" test "$(grep -c '^pnpmfileChecksum:' pnpm-lock.yaml)" = 1
check "the checksum is the sha256 of the pnpmfile" grep -qxF "pnpmfileChecksum: $(expected_sum config/pnpmfile.cjs)" pnpm-lock.yaml
check "the stale value is gone" test -z "$(grep -F 'STALE' pnpm-lock.yaml || true)"
check "it sits where pnpm writes it: after packageExtensionsChecksum, before patchedDependencies" \
  test "$(grep -n -A 3 '^packageExtensionsChecksum:' pnpm-lock.yaml | sed 's/^[0-9]*[-:]//' | tr '\n' '|')" = "packageExtensionsChecksum: sha256-AAAA||pnpmfileChecksum: $(expected_sum config/pnpmfile.cjs)||"
check "the first (environment) document is untouched" test "$(sed -n '1,14p' pnpm-lock.yaml | grep -c Checksum || true)" = 0

# 2. the same lockfile without any checksum line at all (the regenerated one): inserted before patchedDependencies
write_lock && grep -v '^pnpmfileChecksum:' pnpm-lock.yaml | awk 'NR > 1 && prev == "" && $0 == "" { next } { print; prev = $0 }' > l && mv l pnpm-lock.yaml
run_regen "$tmp/a" > /dev/null 2>&1
check "checksum inserted when the lockfile had none" test "$(grep -c '^pnpmfileChecksum:' pnpm-lock.yaml)" = 1
check "inserted before patchedDependencies" test "$(grep -A 2 '^pnpmfileChecksum:' pnpm-lock.yaml | tail -n 1)" = "patchedDependencies:"

# 3. default location .pnpmfile.cjs when pnpm-workspace.yaml names none
mkdir "$tmp/b" && cd "$tmp/b"
printf 'packages:\n  - src/*\n' > pnpm-workspace.yaml
printf 'module.exports = {}\n' > .pnpmfile.cjs
write_lock
run_regen "$tmp/b" > /dev/null 2>&1
check "default .pnpmfile.cjs is hashed" grep -qxF "pnpmfileChecksum: $(expected_sum .pnpmfile.cjs)" pnpm-lock.yaml

# 4. quoted path
mkdir -p "$tmp/c/cfg" && cd "$tmp/c"
printf "pnpmfile: 'cfg/hook.cjs'\n" > pnpm-workspace.yaml
printf 'module.exports = {}\n' > cfg/hook.cjs
write_lock
run_regen "$tmp/c" > /dev/null 2>&1
check "a quoted pnpmfile path is read" grep -qxF "pnpmfileChecksum: $(expected_sum cfg/hook.cjs)" pnpm-lock.yaml

# 5. no pnpmfile in the tree: no checksum line is invented
mkdir "$tmp/d" && cd "$tmp/d"
printf 'packages:\n  - src/*\n' > pnpm-workspace.yaml
write_lock
run_regen "$tmp/d" > /dev/null 2>&1
check "no pnpmfile, no checksum line" test "$(grep -c '^pnpmfileChecksum:' pnpm-lock.yaml || true)" = 0

# 6. nothing else in the scripts calls the regeneration bare
cd "$scripts"
check "no script runs a bare 'pnpm install --lockfile-only' except regen_lockfile" \
  test "$(grep -n -E '^[[:space:]]*pnpm install --lockfile-only' ./*.sh | cut -d: -f1 | sed 's#^\./##' | sort -u | tr '\n' ' ')" = "lib.sh "
check "sync-merge.sh calls regen_lockfile in both places" test "$(grep -c '^[[:space:]]*regen_lockfile$' sync-merge.sh)" = 2

echo
if [ "$fails" -eq 0 ]; then echo "all regen_lockfile checks passed"; else echo "$fails check(s) FAILED"; exit 1; fi
