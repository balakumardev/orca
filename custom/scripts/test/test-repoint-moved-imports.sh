#!/usr/bin/env bash
# Test for how sync-merge.sh start treats a release that RESTRUCTURES directories our customizations import from (v1.4.263 split
# tests/e2e/helpers and src/shared into domain folders): (1) files we added inside a directory upstream emptied stay where our code
# imports them (no "file location" conflict, which used to stop every agent round and every gate), and (2) the imports in our
# files that name a moved file are repointed by custom/scripts/repoint-moved-imports.mjs, never by a model.
# Run: bash custom/scripts/test/test-repoint-moved-imports.sh   (needs git, jq, node; no network, no pnpm).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
for tool in git jq node; do command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }; done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

# mkfile PATH [HEAD_LINE...]: 30 filler lines (so git pairs an edited, moved copy with its original) after the given head lines.
mkfile() {
  local f="$1"; shift
  mkdir -p "$(dirname "$f")"
  { [ "$#" -eq 0 ] || printf '%s\n' "$@"; seq 1 30 | sed "s#^#// $f filler #"; } > "$f"
}
edit_line() { awk -v t="$2" -v n="$3" 'NR == n { print t; next } { print }' "$1" > "$1.new" && mv "$1.new" "$1"; } # FILE TEXT LINENO

# Upstream 1.0.0 -> 1.0.1 restructures: exact moves (constants, note.md, Widget, the three test helpers), a move that also edits the
# file (other, util), a file that is removed (gone), a file replaced by two same-named files (dupe), and tests/helpers is emptied
# into two folders (the directory rename git would apply to a file we added there).
src="$tmp/source"
git init -q -b main "$src"
(
  cd "$src"
  mkfile src/shared/constants.ts "export const A = 1"
  mkfile src/shared/other.ts "export default 1"
  mkfile src/shared/note.md "note"
  mkfile src/lib/util.ts "export const util = 1"
  mkfile src/lib/gone.ts "export const gone = 1"
  mkfile src/dupe.ts "export const dupe = 1"
  mkfile src/widgets/chart.ts "export const chart = 1"
  mkfile src/renderer/src/components/Widget.tsx "export const Widget = 1"
  for f in orca-app terminal extra store; do mkfile "tests/helpers/$f.ts" "export const $f = 1"; done
  mkfile src/app/main.ts "import { A } from '../shared/constants'" "export const main = A"
  git add -A && git commit -q -m "upstream 1.0.0" && git tag v1.0.0
  git branch custom
  mkdir -p src/shared/core src/shared/misc src/lib/deep src/renderer/src/components/ui tests/fixtures/electron tests/fixtures/probes src/a src/b
  git mv src/shared/constants.ts src/shared/core/constants.ts
  git mv src/shared/note.md src/shared/core/note.md
  git mv src/shared/other.ts src/shared/misc/other.ts && edit_line src/shared/misc/other.ts "// other UPSTREAM" 15
  git mv src/lib/util.ts src/lib/deep/util.ts && edit_line src/lib/deep/util.ts "// util UPSTREAM" 15
  git rm -q src/lib/gone.ts
  git rm -q src/widgets/chart.ts && mkfile src/widgets/charts/chart.ts "export const chart = 2" && mkfile docs/examples/chart.ts "export const chart = 3"
  git rm -q src/dupe.ts && mkfile src/a/dupe.ts "export const dupe = 'a'" && mkfile src/b/dupe.ts "export const dupe = 'b'"
  git mv src/renderer/src/components/Widget.tsx src/renderer/src/components/ui/Widget.tsx
  for f in orca-app terminal extra; do git mv "tests/helpers/$f.ts" "tests/fixtures/electron/$f.ts"; done
  git mv tests/helpers/store.ts tests/fixtures/probes/store.ts
  edit_line src/app/main.ts "import { A } from '../shared/core/constants'" 1
  git add -A && git commit -q -m "upstream 1.0.1" && git tag v1.0.1
  git checkout -q custom
  mkdir -p src/feature custom
  cat > src/feature/ours.ts <<'EOF'
import { A } from '../shared/constants'
import { A as B } from '../shared/constants.js'
import other from '../shared/other'
import raw from '../shared/note.md?raw'
import { util } from '../lib/util'
import { gone } from '../lib/gone'
import { dupe } from '../dupe'
import { Widget } from '@/components/Widget'
import { chart } from '../widgets/chart'
export const x = [A, B, other, raw, util, gone, dupe, Widget, chart]
EOF
  cat > tests/helpers/ours.ts <<'EOF'
import { app } from './orca-app'
import { term } from './terminal'
import { store } from './store'
import { A } from '../../src/shared/constants'
export const o = [app, term, store, A]
EOF
  echo "import { o } from './helpers/ours'" > tests/ours.spec.ts
  mkfile src/lib/sibling.ts "export const s = 1"
  { echo "import { s } from './sibling'"; cat src/lib/util.ts; } > src/lib/util.ts.new && mv src/lib/util.ts.new src/lib/util.ts
  edit_line src/app/main.ts "import { A as AA } from '../shared/constants'" 1
  echo v1.0.0 > custom/BASE
  git add -A && git commit -q -m "our change

Orca-Custom-Patch: test"
)
BASE_SHA="$(git -C "$src" rev-parse custom)"
UPSTREAM_SHA="$(git -C "$src" rev-parse 'v1.0.1^{commit}')"

repo="$tmp/repo"
git clone -q --no-hardlinks "$src" "$repo"; git -C "$repo" checkout -q custom
out="$tmp/out"
( cd "$repo" && env SYNC_OUT="$out" UPSTREAM_SHA="$UPSTREAM_SHA" BASE_SHA="$BASE_SHA" BASE_BRANCH=custom BRANCH=sync/test LABEL=test TAG=v1.0.1 \
    IS_TEST=true TAG_IS_RELEASE=false DEFER_LOCKFILE=1 bash "$scripts/sync-merge.sh" start > "$tmp/start.log" 2>&1 ) \
  || { bad "sync-merge.sh start ran"; sed 's/^/    /' "$tmp/start.log" | tail -n 20; exit 1; }
ok "sync-merge.sh start ran"

has() { grep -qxF -- "$2" "$repo/$1"; } # FILE LINE: the file holds exactly that line
unresolved_spec() { jq -e --arg s "$1" '.unresolved[] | select(.spec == $s)' "$out/repointed-imports.json"; }

echo "control: with git's default directory renames the file we added in the emptied directory IS relocated and flagged"
rm -rf "$tmp/control" && git clone -q --no-hardlinks "$src" "$tmp/control" && git -C "$tmp/control" checkout -q custom
link="$(git -C "$tmp/control" commit-tree "$UPSTREAM_SHA^{tree}" -p "$UPSTREAM_SHA" -p "$(git -C "$tmp/control" rev-parse v1.0.0^{commit})" -m link)"
git -C "$tmp/control" merge -X find-renames=30% --no-commit --no-ff "$link" > "$tmp/control.log" 2>&1 || true
check "the default merge reports CONFLICT (file location) for tests/helpers/ours.ts" grep -q 'CONFLICT (file location).*tests/helpers/ours.ts' "$tmp/control.log"

echo "the scripted merge keeps our files where our code imports them"
check "no conflict of kind other" bash -c "! awk -F'\t' '\$2 == \"other\"' '$out/conflicts.tsv' | grep -q ."
check "tests/helpers/ours.ts is still in tests/helpers" test -f "$repo/tests/helpers/ours.ts"
check "nothing was placed in the folder upstream emptied into" test ! -e "$repo/tests/fixtures/electron/ours.ts"
check "tests/ours.spec.ts is untouched: its import of our file still resolves" has tests/ours.spec.ts "import { o } from './helpers/ours'"

echo "imports of moved upstream files are repointed"
check "exact move, relative path" has src/feature/ours.ts "import { A } from '../shared/core/constants'"
check "exact move, explicit .js extension kept" has src/feature/ours.ts "import { A as B } from '../shared/core/constants.js'"
check "moved and edited (the one same-named file the release added)" has src/feature/ours.ts "import other from '../shared/misc/other'"
check "a ?raw query suffix is kept" has src/feature/ours.ts "import raw from '../shared/core/note.md?raw'"
check "moved and edited, deeper folder" has src/feature/ours.ts "import { util } from '../lib/deep/util'"
check "alias import" has src/feature/ours.ts "import { Widget } from '@/components/ui/Widget'"
check "several same-named new files: the one sharing the most folders with the old path" has src/feature/ours.ts "import { chart } from '../widgets/charts/chart'"
check "our helper: sibling moved to the folder that took most of the old ones" has tests/helpers/ours.ts "import { app } from '../fixtures/electron/orca-app'"
check "our helper: a second sibling moved there" has tests/helpers/ours.ts "import { term } from '../fixtures/electron/terminal'"
check "our helper: sibling moved to another folder" has tests/helpers/ours.ts "import { store } from '../fixtures/probes/store'"
check "our helper: import of a moved file outside its folder" has tests/helpers/ours.ts "import { A } from '../../src/shared/core/constants'"
check "a file upstream moved and we edited: our new import is relative to its OLD folder, repointed" has src/lib/deep/util.ts "import { s } from '../sibling'"

echo "what the script cannot prove is left alone and reported"
check "removed upstream: left as it was" has src/feature/ours.ts "import { gone } from '../lib/gone'"
check "removed upstream: listed as unresolved" unresolved_spec '../lib/gone'
check "replaced by two same-named files: left as it was" has src/feature/ours.ts "import { dupe } from '../dupe'"
check "replaced by two same-named files: listed as unresolved" unresolved_spec '../dupe'
check "a file with a conflict is not touched" bash -c "grep -q '^<<<<<<< ' '$repo/src/app/main.ts' && grep -qF \"'../shared/constants'\" '$repo/src/app/main.ts'"

echo "bookkeeping"
check "the edits are staged (the working tree equals the index)" git -C "$repo" diff --quiet -- src/feature/ours.ts tests/helpers/ours.ts src/lib/deep/util.ts
check "facts: 12 imports in 3 files, 2 unresolved" test "$(jq -c '.repointed' "$out/sync-facts.json")" = '{"imports":12,"files":3,"unresolved":2}'
check "a caveat says a script repointed imports" bash -c "jq -e '.caveats[] | select(startswith(\"A script (no model) repointed 12 import(s) in 3\"))' '$out/sync-facts.json'"
check "a caveat names the imports it could not follow" bash -c "jq -e '.caveats[] | select(contains(\"2 import(s) in our files name a file upstream moved or removed\"))' '$out/sync-facts.json'"
check "the one real conflict is the only pending file" test "$(jq -r '[.conflicts[] | select(.resolution == "pending") | .path] | join(",")' "$out/sync-facts.json")" = src/app/main.ts

exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
