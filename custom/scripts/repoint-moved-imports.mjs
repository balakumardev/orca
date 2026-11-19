#!/usr/bin/env node
// Repoint the imports in OUR files at the files upstream moved between two releases.
// Usage: node repoint-moved-imports.mjs --ours <commit> --old <commit> --new <commit> [--apply]   (run at the root of the merge's working tree)
//   --ours the base branch tip (the tree our imports were written against), --old / --new the two upstream releases.
// Prints one JSON object: { files, repointed, edited: [{path, count}], unresolved: [{path, spec, was}] }; without --apply nothing is written.
//
// Why: a merge moves a file with git's rename detection but never rewrites an import. When upstream restructures a
// release (v1.4.263 split src/shared and tests/e2e/helpers into domain folders), every file of ours that imports a moved
// file breaks and typecheck reports hundreds of identical TS2307 errors. That is mechanical, so a script does it, not a model.
// What it does: for each of OUR code files (differs from upstream, no conflict in it) and each relative or alias specifier that
// no longer resolves, resolve it in OUR tree (from the file's old directory too, when upstream moved the file), find where
// the target went and write the new specifier. Targets are matched without reading blobs (the sync clone is blobless): an exact
// rename (same object id), else the one file added by the release with the same base name. An ambiguous or deleted target is
// left alone and listed in `unresolved`, for the agent and the gates.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const STRIP_EXT = /(?:\.d\.ts|\.[cm]?[jt]s|\.[jt]sx|\.json)$/
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json']
const SCRIPT_TO_SOURCE = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
  '.jsx': ['.tsx']
}
const ALIASES = [
  ['@renderer/', 'src/renderer/src/'],
  ['@/', 'src/renderer/src/']
]
const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|unmock|importActual|importMock)\s*\(\s*|\bimport\s+)(['"])((?:\.{1,2}\/|@\/|@renderer\/)[^'"\n]*)\2/g

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 })
}

function treeEntries(rev) {
  const entries = new Map()
  for (const row of git('ls-tree', '-r', '-z', rev).split('\0')) {
    const tab = row.indexOf('\t')
    if (tab > 0) {
      entries.set(row.slice(tab + 1), row.slice(0, tab).split(' ')[2])
    }
  }
  return entries
}

function indexEntries() {
  const clean = new Map()
  const unmerged = new Set()
  for (const row of git('ls-files', '-s', '-z').split('\0')) {
    const tab = row.indexOf('\t')
    if (tab > 0) {
      const [, sha, stage] = row.slice(0, tab).split(' ')
      if (stage === '0') {
        clean.set(row.slice(tab + 1), sha)
      } else {
        unmerged.add(row.slice(tab + 1))
      }
    }
  }
  return { clean, unmerged }
}

// Exact renames only (same object id): no blob is read, so it costs nothing in a blobless clone.
function exactRenames(oldRev, newRev) {
  const moved = new Map()
  const tokens = git(
    'diff',
    '--name-status',
    '-z',
    '-M100%',
    '--diff-filter=R',
    oldRev,
    newRev
  ).split('\0')
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    moved.set(tokens[i + 1], tokens[i + 2])
  }
  return moved
}

function resolveIn(files, target) {
  if (files.has(target)) {
    return target
  }
  const ext = path.posix.extname(target)
  const bases = [
    target,
    ...(SCRIPT_TO_SOURCE[ext] ?? []).map((e) => target.slice(0, -ext.length) + e)
  ]
  for (const base of bases) {
    for (const e of ['', ...EXTENSIONS]) {
      for (const candidate of [base + e, `${base}/index${e}`]) {
        if (files.has(candidate)) {
          return candidate
        }
      }
    }
  }
  return null
}

function formatSpecifier(fromFile, target, original, alias) {
  const explicit = path.posix.extname(original).length > 0 && STRIP_EXT.test(original)
  let stripped = target.replace(STRIP_EXT, '')
  if (explicit) {
    const originalExt = path.posix.extname(original)
    const targetExt = target.slice(stripped.length)
    stripped += SCRIPT_TO_SOURCE[originalExt]?.includes(targetExt) ? originalExt : targetExt
  } else if (path.posix.basename(stripped) === 'index' && !original.endsWith('index')) {
    stripped = path.posix.dirname(stripped)
  }
  if (alias && stripped.startsWith(alias[1])) {
    return alias[0] + stripped.slice(alias[1].length)
  }
  const relative = path.posix.relative(path.posix.dirname(fromFile), stripped) || '.'
  return relative.startsWith('.') ? relative : `./${relative}`
}

function main() {
  const args = process.argv.slice(2)
  const value = (flag) => args[args.indexOf(flag) + 1]
  const apply = args.includes('--apply')
  const [oursRev, oldRev, newRev] = [value('--ours'), value('--old'), value('--new')]
  if (!oursRev || !oldRev || !newRev) {
    throw new Error(
      'usage: repoint-moved-imports.mjs --ours <commit> --old <commit> --new <commit> [--apply]'
    )
  }

  const ourFiles = new Set(treeEntries(oursRev).keys())
  const releaseOld = new Set(treeEntries(oldRev).keys())
  const upstream = treeEntries(newRev)
  const { clean, unmerged } = indexEntries()
  const newFiles = new Set([...clean.keys(), ...unmerged])
  const renamed = exactRenames(oldRev, newRev)
  const renamedFrom = new Map([...renamed].map(([from, to]) => [to, from]))

  // Files the release added or removed, by base name: the fallback when a moved file was also edited (no exact rename).
  const byName = (paths) => {
    const names = new Map()
    for (const f of paths) {
      names.set(path.posix.basename(f), [...(names.get(path.posix.basename(f)) ?? []), f])
    }
    return names
  }
  const added = byName([...newFiles].filter((f) => upstream.has(f) && !releaseOld.has(f)))
  const removed = byName([...releaseOld].filter((f) => !upstream.has(f) && !renamed.has(f)))
  const unique = (names, f) =>
    names.get(path.posix.basename(f))?.length === 1 ? names.get(path.posix.basename(f))[0] : null

  const whereIsNow = (oldPath) => {
    if (newFiles.has(oldPath)) {
      return oldPath
    }
    const moved = renamed.get(oldPath) ?? unique(added, oldPath)
    return moved && newFiles.has(moved) ? moved : null
  }
  const whereWasThen = (file) =>
    ourFiles.has(file) ? file : (renamedFrom.get(file) ?? unique(removed, file))

  const ours = [...clean]
    .filter(([f, sha]) => CODE_FILE.test(f) && upstream.get(f) !== sha)
    .map(([f]) => f)
  const edited = []
  const unresolved = []
  let repointed = 0
  for (const file of ours) {
    const text = readFileSync(file, 'utf8')
    const oldPath = whereWasThen(file)
    const currentDir = path.posix.dirname(file)
    const oldDirs = [...new Set([...(oldPath ? [path.posix.dirname(oldPath)] : []), currentDir])]
    const edits = []
    for (const match of text.matchAll(SPECIFIER)) {
      const original = match[3]
      const query = original.search(/[?#]/)
      const bare = query < 0 ? original : original.slice(0, query)
      const alias = ALIASES.find(([prefix]) => bare.startsWith(prefix))
      const target = (dir) =>
        alias ? alias[1] + bare.slice(alias[0].length) : path.posix.join(dir, bare)
      if (resolveIn(newFiles, target(currentDir))) {
        continue
      }
      let was = null
      for (const dir of oldDirs) {
        was = resolveIn(ourFiles, target(dir))
        if (was) {
          break
        }
      }
      const now = was && whereIsNow(was)
      if (!now) {
        if (was) {
          unresolved.push({ path: file, spec: original, was })
        }
        continue
      }
      const replacement =
        formatSpecifier(file, now, bare, alias) + (query < 0 ? '' : original.slice(query))
      if (replacement !== original) {
        edits.push({ at: match.index + match[1].length + 1, length: original.length, replacement })
      }
    }
    if (edits.length > 0) {
      let result = text
      for (const edit of edits.toReversed()) {
        result = result.slice(0, edit.at) + edit.replacement + result.slice(edit.at + edit.length)
      }
      if (apply) {
        writeFileSync(file, result)
      }
      edited.push({ path: file, count: edits.length })
      repointed += edits.length
    }
  }
  process.stdout.write(`${JSON.stringify({ files: ours.length, repointed, edited, unresolved })}\n`)
}

main()
