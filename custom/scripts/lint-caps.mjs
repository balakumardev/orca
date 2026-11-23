#!/usr/bin/env node
// Estimate how close files are to the repo's oxlint `max-lines` caps (non-blank, non-comment lines).
// Usage: node lint-caps.mjs FILE...   (paths relative to the current directory; missing files are skipped)
// Prints one JSON object: { checked, near: [{path, lines, cap}], over: [{path, lines, cap}] }.
// This is an ESTIMATE (a small tokenizer, not oxlint): the real verdict is the oxlint gate. "near" means within
// MARGIN lines of the cap. Caps mirror .oxlintrc.json overrides: tests 800, .tsx 400, .ts 300, .mjs 600.
// Files that .oxlintrc.json lists under `ignorePatterns` (generated code) are skipped, because oxlint never checks them either.
import { existsSync, readFileSync } from 'node:fs'

const MARGIN = 10

function ignoreRegex(pattern) {
  const body = pattern
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) => {
      if (part === '**/') {
        return '(?:.*/)?'
      }
      if (part === '**') {
        return '.*'
      }
      if (part === '*') {
        return '[^/]*'
      }
      return part.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${body}$`)
}

// A pattern ignores the path itself and everything under a matching directory, like oxlint's.
export function isOxlintIgnored(path, patterns) {
  const parts = path.split('/')
  return patterns.some((pattern) => {
    const re = ignoreRegex(pattern)
    return parts.some((_, i) => re.test(parts.slice(0, i + 1).join('/')))
  })
}

function oxlintIgnorePatterns() {
  try {
    const patterns = JSON.parse(readFileSync('.oxlintrc.json', 'utf8')).ignorePatterns
    return Array.isArray(patterns) ? patterns : []
  } catch {
    return []
  }
}

export function capFor(path) {
  if (/\.(test|spec)\.(ts|tsx|mts|cts)$/.test(path)) {
    return 800
  }
  if (path.endsWith('.tsx')) {
    return 400
  }
  if (/\.(ts|mts|cts)$/.test(path)) {
    return 300
  }
  if (path.endsWith('.mjs')) {
    return 600
  }
  return null
}

export function countCodeLines(source) {
  let inBlock = false
  let inTemplate = false
  let count = 0
  for (const line of source.split('\n')) {
    let hasCode = false
    let i = 0
    while (i < line.length) {
      const c = line[i]
      const n = line[i + 1]
      if (inBlock) {
        if (c === '*' && n === '/') {
          inBlock = false
          i += 2
        } else {
          i += 1
        }
        continue
      }
      if (inTemplate) {
        hasCode = true
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === '`') {
          inTemplate = false
        }
        i += 1
        continue
      }
      if (c === ' ' || c === '\t' || c === '\r') {
        i += 1
        continue
      }
      if (c === '/' && n === '/') {
        break
      }
      if (c === '/' && n === '*') {
        inBlock = true
        i += 2
        continue
      }
      hasCode = true
      if (c === '"' || c === "'") {
        i += 1
        while (i < line.length) {
          if (line[i] === '\\') {
            i += 2
            continue
          }
          if (line[i] === c) {
            i += 1
            break
          }
          i += 1
        }
        continue
      }
      if (c === '`') {
        inTemplate = true
      }
      i += 1
    }
    if (hasCode) {
      count += 1
    }
  }
  return count
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const near = []
  const over = []
  let checked = 0
  const ignored = oxlintIgnorePatterns()
  for (const path of process.argv.slice(2)) {
    const cap = capFor(path)
    if (cap === null || !existsSync(path) || isOxlintIgnored(path, ignored)) {
      continue
    }
    checked += 1
    const lines = countCodeLines(readFileSync(path, 'utf8'))
    if (lines > cap) {
      over.push({ path, lines, cap })
    } else if (lines >= cap - MARGIN) {
      near.push({ path, lines, cap })
    }
  }
  console.log(JSON.stringify({ checked, near, over }))
}
