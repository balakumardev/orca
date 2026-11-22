#!/usr/bin/env node
// Build the sync PR title, body and metadata from FACTS ONLY (sync-facts.json, gates.json files and raw git output).
// Nothing a model wrote is used as a verification claim; model text appears only inside one block labelled as such.
//
// Usage: node make-pr-body.mjs --facts F --raw DIR --out DIR [--gates G1.json --gates G2.json ...] [--agent-rounds R.json]
// Env: PR_TITLE (base title from detect), RELEASE_URL, RUN_URL, REPO (owner/name), FULL_DIFF_ARTIFACT (name, optional),
//      RELEASE_WORKFLOW (path of custom-release.yml; default .github/workflows/custom-release.yml, relative to the cwd)
// Raw inputs in --raw: remerge.patch (restricted to files worth reviewing), numstat-old.txt, numstat-new.txt.
// Writes: pr-body.md, pr-title.txt, pr-meta.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname } from 'node:path'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const gateFiles = args.flatMap((a, i) => (a === '--gates' ? [args[i + 1]] : []))
const facts = JSON.parse(readFileSync(opt('--facts'), 'utf8'))
const rawDir = opt('--raw')
const outDir = opt('--out')
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

const BODY_LIMIT = 60000 // GitHub rejects bodies over 65536 characters
const GATE_ORDER = [
  'hygiene',
  'lint-caps',
  'hunk-survival',
  'install',
  'typecheck',
  'lint',
  'format',
  'unit',
  'unit-related',
  'localization',
  'e2e-ratchet',
  'e2e'
]
const REPO = process.env.REPO || 'balakumardev/orca'
const RUN_URL = process.env.RUN_URL || ''
const stripFence = (s) => s.replace(/~{4,}/g, '~~~')
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

// ---- gates -------------------------------------------------------------------------------------------------
const gates = gateFiles
  .map((f) => ({ f, g: JSON.parse(readFileSync(f, 'utf8')) }))
  .flatMap(({ f, g }) => g.gates.map((x) => ({ ...x, runner: g.runner?.os, source: f })))
  .sort((a, b) => GATE_ORDER.indexOf(a.id) - GATE_ORDER.indexOf(b.id))
const gatesRan = gates.length > 0
const failedGates = gates.filter((g) => g.status === 'fail')
const icon = { pass: '✅', fail: '❌', skip: '⏭' }
// custom-gates.yml uploads Playwright's screenshots and error context as `e2e-results-<round>` when the e2e gate failed. The
// round is in the name of the directory that holds this gate's gates.json (gates-<round>-e2e).
const evidenceArtifact = (g) => {
  const m =
    g.id === 'e2e' && g.source ? basename(dirname(g.source)).match(/^gates-(\d+|pr)-e2e$/) : null
  return m ? `e2e-results-${m[1]}` : ''
}

// ---- does merging start a release? ----------------------------------------------------------------------------------
// Derived from the checked-out custom-release.yml, never assumed: today it is workflow_dispatch only, and the owner adds the
// `push:` trigger at the very end. 'yes' | 'no' | 'missing' (no such file) | 'unknown' (no YAML parser or unreadable file).
const RELEASE_WORKFLOW = process.env.RELEASE_WORKFLOW || '.github/workflows/custom-release.yml'
const yamlToJson = (path) => {
  const parsers = [
    [
      'python3',
      [
        '-I',
        '-c',
        'import sys, json, yaml\nprint(json.dumps(yaml.safe_load(open(sys.argv[1])), default=str))',
        path
      ]
    ],
    ['yq', ['-o=json', '.', path]]
  ]
  for (const [cmd, a] of parsers) {
    try {
      return JSON.parse(
        execFileSync(cmd, a, {
          encoding: 'utf8',
          timeout: 20000,
          stdio: ['ignore', 'pipe', 'ignore']
        })
      )
    } catch {
      /* parser missing or failed: try the next one */
    }
  }
  return undefined
}
// GitHub branch filter glob: `*` stays inside one path segment, `**` crosses segments. Everything else is literal.
const branchGlob = (pattern, name) => {
  const source = pattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((lit) => lit.replace(/[.+^${}()|[\]\\?]/g, '\\$&'))
        .join('[^/]*')
    )
    .join('.*')
  return new RegExp(`^${source}$`).test(name)
}
const releaseStartsOnPush = (path, branch) => {
  if (!existsSync(path)) {
    return 'missing'
  }
  const doc = yamlToJson(path)
  if (!doc || typeof doc !== 'object') {
    return 'unknown'
  }
  // YAML 1.1 parsers (PyYAML) read the key `on` as the boolean true, which JSON spells "true".
  const on = doc.on ?? doc.true ?? doc.True
  let push // undefined = no push trigger; null or an object = there is one
  if (typeof on === 'string') {
    push = on === 'push' ? null : undefined
  } else if (Array.isArray(on)) {
    push = on.includes('push') ? null : undefined
  } else if (on && typeof on === 'object') {
    push = 'push' in on ? on.push : undefined
  } else {
    return 'unknown'
  }
  if (push === undefined) {
    return 'no'
  }
  if (push && typeof push === 'object') {
    // A push trigger only counts when it can fire for a merge into the PR's base branch.
    if (Array.isArray(push.branches)) {
      let hit = false
      for (const b of push.branches.map(String)) {
        if (b.startsWith('!')) {
          if (branchGlob(b.slice(1), branch)) {
            hit = false
          }
        } else if (branchGlob(b, branch)) {
          hit = true
        }
      }
      return hit ? 'yes' : 'no'
    }
    if (Array.isArray(push['branches-ignore'])) {
      return push['branches-ignore'].some((b) => branchGlob(String(b), branch)) ? 'no' : 'yes'
    }
    if (push.tags || push['tags-ignore']) {
      return 'no'
    } // tag pushes only: a merge is a branch push
  }
  return 'yes'
}
const releaseState = releaseStartsOnPush(RELEASE_WORKFLOW, facts.base_branch || 'custom')
const handStart = `gh workflow run custom-release.yml --repo ${REPO} --ref custom`
const releaseSentence = {
  yes: 'Merging this PR publishes a release.',
  no: `Merging this PR does not publish by itself: start the release by hand with \`${handStart}\`.`,
  missing:
    'There is no `custom-release.yml` in this checkout, so merging this PR does not publish anything.',
  unknown: `Check the \`on:\` block of \`custom-release.yml\`: with a \`push:\` trigger a merge starts a release, otherwise start it by hand with \`${handStart}\`.`
}[releaseState]
const releaseChecklist = {
  yes: 'After the merge the release workflow publishes a build.',
  no: `After the merge, start the release by hand: \`${handStart}\`.`,
  missing:
    'There is no release workflow in this checkout, so nothing is published after the merge.',
  unknown: `After the merge, check whether the release started; if it did not, run \`${handStart}\`.`
}[releaseState]

// ---- what an agent round's exit means -------------------------------------------------------------------------------
// From the CLI's own numbers (exit code, stop reason, turn counts), never from the model's text. Whatever the exit, the round's
// edits are kept (scope-checked) and the gates judge the result; only a key leak throws them away.
const safeWord = (v) =>
  String(v ?? '')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .slice(0, 40)
const exitReason = (r) => {
  if (Number(r.key_leaks) > 0) {
    return 'the output contained the API key; edits discarded'
  }
  if (r.skipped === true) {
    return 'skipped; no file was left that a model may resolve'
  }
  if ([401, 402, 403].includes(Number(r.api_status))) {
    return `ended: the model API refused the call (HTTP ${Number(r.api_status)}); any edit made before that is kept`
  }
  if (r.stop === 'error_max_turns') {
    return 'ran out of turns; edits kept; gates decide'
  }
  if (r.exit_code === 124) {
    return 'hit the wall-clock limit; edits kept; gates decide'
  }
  if (r.output_parsed === false) {
    return `no readable output; edits kept; gates decide (exit ${safeWord(r.exit_code)})`
  }
  if (r.exit_code !== 0 || r.is_error) {
    return `ended with an error (exit ${safeWord(r.exit_code)}${r.stop ? `, ${safeWord(r.stop)}` : ''}); edits kept; gates decide`
  }
  return 'ok'
}
const exitCell = (r) =>
  exitReason(r) === 'ok' ? String(r.exit_code) : `${r.exit_code}: ${exitReason(r)}`

// ---- state -------------------------------------------------------------------------------------------------
const conflicts = facts.conflicts ?? []
const ciConflicts = conflicts.filter((c) =>
  c.resolution.startsWith('scripted: dropped upstream CI')
)
const otherConflicts = conflicts.filter(
  (c) => !c.resolution.startsWith('scripted: dropped upstream CI')
)
const roundsFile = opt('--agent-rounds')
const agentRounds =
  roundsFile && existsSync(roundsFile)
    ? JSON.parse(readFileSync(roundsFile, 'utf8'))
    : (facts.agent?.rounds ?? [])
const agentResolved = conflicts.filter((c) => c.resolution === 'agent')
const unresolved = facts.unresolved === true
const isTest = facts.is_test === true
const tag = facts.tag
const oldTag = facts.old_base_tag

let state = 'clean'
if (unresolved) {
  state = 'manual'
} else if (agentResolved.length > 0) {
  state = 'agent'
} else if (facts.outcome === 'scripted') {
  state = 'scripted'
}

const summary = {
  clean: `Clean merge: git merged upstream ${tag} into \`${facts.base_branch}\` without a single conflict.`,
  scripted: `Scripted merge: git reported ${conflicts.length} conflict(s), all settled by the deterministic rules in \`custom/scripts/sync-merge.sh\` (no model involved).`,
  agent: `Agent-resolved merge: ${agentResolved.length} file(s) were conflicted in a way scripts cannot settle and were resolved by a cloud model. Treat those files as unreviewed code.`,
  manual: `NEEDS A MANUAL MERGE: ${facts.unresolved_files?.length ?? 0} file(s) are still unresolved and are committed WITH conflict markers on purpose. This PR cannot be merged as it stands.`
}[state]

// ---- title / draft / labels --------------------------------------------------------------------------------
let title = process.env.PR_TITLE || `Sync upstream ${tag}`
if (state === 'manual') {
  title = `[needs manual merge] ${title}`
} else if (failedGates.length > 0) {
  title = `[gates failed] ${title}`
}
const draft = isTest || state === 'manual' || failedGates.length > 0
const caveats = [...(facts.caveats ?? [])]

// ---- automatic caveats --------------------------------------------------------------------------------------
if (!gatesRan) {
  caveats.push(
    `No gates were run on this candidate${state === 'manual' ? ' (an unresolved merge is not worth testing).' : '.'}`
  )
}
for (const g of gates) {
  if (g.status === 'fail') {
    const evidence = evidenceArtifact(g)
    caveats.push(
      `Gate failed: ${g.name}. The output tail is in the gates section below.${evidence ? ` Playwright screenshots and error context: artifact \`${evidence}\` of${RUN_URL ? ` [this run](${RUN_URL})` : ' this run'} (kept 7 days).` : ''}`
    )
  }
  if (g.status === 'skip' && !/only runs on pull requests/.test(g.note || '')) {
    caveats.push(`Gate skipped: ${g.name}${g.note ? ` (${g.note})` : ''}.`)
  }
  for (const w of g.warnings ?? []) {
    caveats.push(g.id === 'lint-caps' ? `Near a lint cap: ${w}` : `${g.name}: ${w}`)
  }
}
if (conflicts.some((c) => c.path === 'src/renderer/src/components/sidebar/index.tsx')) {
  caveats.push(
    'src/renderer/src/components/sidebar/index.tsx was conflicted: where new upstream sidebar sections are placed in our stacked layout is not covered by any test. Open the app and look at the sidebar.'
  )
}
if (gatesRan && !gates.some((g) => g.id === 'e2e' && g.status === 'pass')) {
  caveats.push(
    'The Playwright e2e specs for our customizations did NOT pass or did not run. Do not rely on this PR for UI behaviour.'
  )
}
if ((facts.scripted?.upstream_ci_removed ?? 0) > 0) {
  caveats.push(
    `${facts.scripted.upstream_ci_removed} upstream CI file(s) under .github/workflows or dependabot config were removed again (the fork carries none; ${facts.scripted.upstream_ci_new ?? 0} new in ${tag}).`
  )
}
if ((facts.scripted?.our_wins_restored ?? []).length > 0) {
  caveats.push(
    `Upstream also changed these paths where our side always wins; upstream's change was discarded: ${facts.scripted.our_wins_restored.join(', ')}.`
  )
}
if ((facts.drift ?? []).length > 0) {
  caveats.push(
    `${facts.drift.length} file(s) differ from upstream ${tag} although no customization commit touched them (a rename that carried our edit, or a contributor change): ${facts.drift.slice(0, 15).join(', ')}${facts.drift.length > 15 ? ', ...' : ''}.`
  )
}
for (const r of agentRounds) {
  if (r.stop === 'error_max_turns') {
    caveats.push(
      `Agent round ${r.round} ran out of turns (${r.turns}/${r.max_turns}); its edits were kept and the gates judged the result.`
    )
  } else if (exitReason(r) !== 'ok' && Number(r.key_leaks) === 0) {
    caveats.push(`Agent round ${r.round} ${exitReason(r)}; see the model block.`)
  }
}
// A repair round may edit files that were not conflicted (the ones our customizations own). The resolution diff below covers
// only the conflicted files, and a model can make a gate pass by weakening a test, so the reviewer is pointed at these edits.
const repairEdits = Array.isArray(facts.repair_edits) ? facts.repair_edits : []
if (repairEdits.length > 0) {
  const isTest = (p) =>
    /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p) || p.startsWith('tests/')
  const tests = repairEdits.filter(isTest)
  const list = (a) =>
    `${a
      .slice(0, 12)
      .map((p) => `\`${p}\``)
      .join(', ')}${a.length > 12 ? `, and ${a.length - 12} more` : ''}`
  caveats.push(
    `Repair round(s) edited ${repairEdits.length} file(s) that were not conflicted: ${list(repairEdits)}. The resolution diff below does not show them; the full diff is in the \`${process.env.FULL_DIFF_ARTIFACT || 'sync-review'}\` artifact.${tests.length > 0 ? ` ${tests.length} of them ${tests.length === 1 ? 'is a test or spec' : 'are tests or specs'} (${list(tests)}): a model can turn a gate green by weakening a test, so read those edits first.` : ''}`
  )
}
// Key leaks, from two independent sources: the round records (they carry the file names) and the workflow's own job outputs
// (AGENT_KEY_LEAKS="1=0 2=3 3=", set by the run step, so they exist even when `finish` died and wrote no record).
// A value of "unknown" means the leak check itself did not complete.
const leakEnv = Object.fromEntries(
  (process.env.AGENT_KEY_LEAKS || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((kv) => kv.split('='))
)
const leaks = new Map()
for (const r of agentRounds) {
  if (Number(r.key_leaks) > 0) {
    leaks.set(Number(r.round), { files: Array.isArray(r.key_leak_files) ? r.key_leak_files : [] })
  }
}
for (const [round, value] of Object.entries(leakEnv)) {
  const n = Number(round)
  if (value === 'unknown') {
    leaks.set(n, { files: leaks.get(n)?.files ?? [], unknown: !leaks.has(n) })
  } else if (Number(value) > 0 && !leaks.has(n)) {
    leaks.set(n, { files: [] })
  }
}
const leakRounds = [...leaks.keys()].sort((a, b) => a - b)
if (leakRounds.length > 0) {
  caveats.push(
    `Key leak in agent round ${leakRounds.join(', ')}: see the warning at the top of this description.`
  )
}
// What the model rounds actually did, from the workflow's own job results (data, not model text).
const roundResults = Object.fromEntries(
  (process.env.AGENT_RESULTS || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((kv) => kv.split('='))
)
for (const [round, result] of Object.entries(roundResults)) {
  if (result === 'failure' || result === 'cancelled') {
    caveats.push(
      `Agent round ${round} did not finish (job result: ${result}). It could not start or it crashed; see the run. This PR carries the best candidate that exists without it.`
    )
  }
}
if (
  state === 'manual' &&
  agentRounds.length === 0 &&
  !Object.values(roundResults).some((r) => r === 'failure' || r === 'cancelled')
) {
  caveats.push(
    'The cloud agent did not run (skip_agent was set). The merge is exactly what the scripts could settle.'
  )
}
if (isTest) {
  caveats.push(
    `This is a TEST run: custom/BASE ${facts.tag_is_release ? `was set to ${tag}` : 'was left unchanged'}, and the PR is a draft against \`${facts.base_branch}\`.`
  )
}

// ---- key-leak banner: the first thing in the body ----------------------------------------------------------------
// Round numbers and file NAMES only. The names were chosen by the model, so they are stripped of control characters and
// backticks, capped, and shown as inline code; nothing the model wrote is shown here.
// Drops exactly U+0000-U+001F, U+007F and the backtick (the set the regex it replaced removed), without a control-character regex.
const isPlainChar = (ch) => ch !== '`' && ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f
const leakName = (n) => `\`${[...String(n)].filter(isPlainChar).join('').slice(0, 120)}\``
const confirmedLeaks = leakRounds.filter((n) => !leaks.get(n).unknown)
const unknownLeaks = leakRounds.filter((n) => leaks.get(n).unknown)
const leakBanner =
  leakRounds.length === 0
    ? ''
    : `> [!CAUTION]
${confirmedLeaks.length > 0 ? "> **The agent's output contained the API key; its edits were discarded. Rotate DEEPINFRA_API_KEY.**\n" : ''}${unknownLeaks.length > 0 ? `> **The agent's key-leak check did not complete${confirmedLeaks.length > 0 ? ' in another round' : ''}. Treat DEEPINFRA_API_KEY as exposed and rotate it.**\n` : ''}${leakRounds
        .map((n) => {
          const { files, unknown } = leaks.get(n)
          if (unknown) {
            return `> - Round ${n}: the leak check did not complete`
          }
          return `> - Round ${n}: ${files.length > 0 ? files.slice(0, 20).map(leakName).join(', ') : '(no file names recorded)'}${files.length > 20 ? `, and ${files.length - 20} more` : ''}`
        })
        .join('\n')}

`

// ---- model-written block -----------------------------------------------------------------------------------
let modelBlock = ''
if (agentRounds.length > 0) {
  const total = agentRounds.reduce((s, r) => s + Number(r.estimated_cost_usd || 0), 0)
  modelBlock += '### Cloud agent (model-written, unverified)\n\n'
  modelBlock +=
    '| Round | Mode | Model | Turns | Tokens in / out | Est. cost | Wall | Exit |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n'
  for (const r of agentRounds) {
    modelBlock += `| ${r.round} | ${r.mode} | \`${r.model}\` | ${r.turns}${r.max_turns ? `/${r.max_turns}` : ''} | ${r.input_tokens} / ${r.output_tokens} | $${Number(r.estimated_cost_usd).toFixed(3)} | ${r.wall_s}s | ${esc(exitCell(r))} |\n`
  }
  modelBlock += `\nEstimated total: $${total.toFixed(3)}, an upper bound (every input token, cached or not, priced at the full list rate: Flash $0.20 in / $0.60 out per million, Pro $1.30 in / $2.60 out).\n\n`
  const last = agentRounds.at(-1)
  const unsure = agentRounds.flatMap((r) =>
    (r.report || '')
      .split('\n')
      .filter((l) => /UNSURE:/i.test(l))
      .map((l) => stripFence(l.trim()))
  )
  modelBlock +=
    '> The text below was written by a language model. No script checked any statement in it. The scripted facts are the sections above.\n\n'
  if (unsure.length > 0) {
    modelBlock += `Flagged as unsure by the model (verbatim):\n\n~~~~text\n${unsure.join('\n')}\n~~~~\n\n`
  }
  modelBlock += `<details><summary>The model's own final report (round ${last.round}, unverified)</summary>\n\n~~~~text\n${stripFence(last.report || '(empty)')}\n~~~~\n\n</details>\n`
}

// ---- sections ----------------------------------------------------------------------------------------------
const gatesTable = gatesRan
  ? `| | Gate | Seconds | Runner | Note |\n| --- | --- | --- | --- | --- |\n${gates.map((g) => `| ${icon[g.status]} | ${esc(g.name)} | ${g.seconds} | ${g.runner ?? ''} | ${esc(g.note || '')} |`).join('\n')}\n`
  : '_Not run._\n'
const failTails = failedGates
  .map(
    (g) =>
      `<details><summary>${esc(g.name)}: output tail (exit ${g.exit_code})</summary>\n\n~~~~text\n${stripFence(g.output_tail || '')}\n~~~~\n\n</details>`
  )
  .join('\n\n')

const conflictRows = otherConflicts.map(
  (c) =>
    `| \`${c.path}\` | ${c.kind} | ${c.hunks} | ${esc(c.resolution)}${c.decision ? ` (${esc(c.decision)} the file)` : ''} |`
)
if (ciConflicts.length > 0) {
  conflictRows.push(
    `| ${ciConflicts.length} upstream CI file(s) (\`.github/workflows/*\`, modify/delete) | deleted-by-us | - | scripted: dropped (the fork carries no upstream CI) |`
  )
}
const conflictTable =
  conflicts.length > 0
    ? `| File | Kind | Hunks | Resolution |\n| --- | --- | --- | --- |\n${conflictRows.join('\n')}\n`
    : '_No conflicts._\n'

// numstat footprint: our change relative to the old base vs relative to the new tag
const parseNumstat = (text) => {
  const map = new Map()
  for (const line of text.split('\n')) {
    const [a, d, ...rest] = line.split('\t')
    if (rest.length === 0) {
      continue
    }
    map.set(rest.join('\t'), [a === '-' ? 0 : Number(a), d === '-' ? 0 : Number(d)])
  }
  return map
}
const oldStat = parseNumstat(read(`${rawDir}/numstat-old.txt`))
const newStat = parseNumstat(read(`${rawDir}/numstat-new.txt`))
const footprintPaths = [...newStat.keys()].filter((p) => oldStat.has(p))
const sum = (m, keys, i) => keys.reduce((s, k) => s + (m.get(k)?.[i] ?? 0), 0)
const changed = footprintPaths.filter((p) => oldStat.get(p).join() !== newStat.get(p).join())
let footprint = `Our files that still exist: ${footprintPaths.length}. Lines we add / remove relative to upstream: **+${sum(newStat, footprintPaths, 0)} / -${sum(newStat, footprintPaths, 1)}** now, +${sum(oldStat, footprintPaths, 0)} / -${sum(oldStat, footprintPaths, 1)} on ${oldTag}.\n`
if (changed.length > 0) {
  footprint += `\nFiles where the size of our change moved (${changed.length}):\n\n| File | On ${oldTag} | Now |\n| --- | --- | --- |\n`
  footprint += changed
    .slice(0, 40)
    .map(
      (p) =>
        `| \`${p}\` | +${oldStat.get(p)[0]} / -${oldStat.get(p)[1]} | +${newStat.get(p)[0]} / -${newStat.get(p)[1]} |`
    )
    .join('\n')
  if (changed.length > 40) {
    footprint += `\n| ... ${changed.length - 40} more | | |`
  }
  footprint += '\n'
} else {
  footprint +=
    '\nThe size of our change is identical in every file: upstream did not move anything we depend on.\n'
}
const missing = [...oldStat.keys()].filter(
  (p) => !newStat.has(p) && !/^\.github\/|^custom\//.test(p)
)
if (missing.length > 0) {
  footprint += `\nFiles our patches changed that no longer differ from upstream (the customization is now redundant or was dropped): ${missing
    .slice(0, 20)
    .map((p) => `\`${p}\``)
    .join(', ')}.\n`
}

const handDecisions = state === 'agent' || state === 'manual' || otherConflicts.length > 0
const checklist = [
  state === 'manual'
    ? 'Resolve the files listed above locally (see "How to resolve"), delete `custom/UNRESOLVED-MERGE.txt`, push, mark the PR ready and rename it.'
    : null,
  handDecisions
    ? 'Read the "Merge resolution diff" section: it is exactly what the resolution decided (the merge commit against git\'s own auto-merge).'
    : null,
  'Check the customization footprint table: a changed row means upstream moved code our patches sit on.',
  failedGates.length > 0
    ? 'Look at every failed gate output before anything else.'
    : 'Gates are green; they are scripts, not opinions.',
  agentResolved.length > 0
    ? 'Read the agent-resolved files in full. A model decided those hunks.'
    : null,
  handDecisions
    ? 'Run the app from this branch if a conflicted file is user-visible (sidebar, Activity, shortcuts).'
    : null,
  `Merge with a MERGE COMMIT. ${releaseChecklist}`
]
  .filter(Boolean)
  .map((l) => `- [ ] ${l}`)
  .join('\n')

const resolveRecipe =
  state === 'manual'
    ? `
### How to resolve

The branch holds a real merge commit (parents: \`${facts.base_branch}\` and a link commit that carries upstream ${tag}) whose conflicted files still contain conflict markers. Finish it in place, do not start a new merge, and never force-push:

\`\`\`bash
gh pr checkout <this PR number> --repo ${REPO}
# edit the files listed in custom/UNRESOLVED-MERGE.txt until no <<<<<<< / ||||||| / ======= / >>>>>>> lines remain
git rm custom/UNRESOLVED-MERGE.txt
git add -A && git commit -m "Resolve upstream ${tag} conflicts"
git push
\`\`\`

Then mark the PR ready for review and remove the \`[needs manual merge]\` prefix from the title. Unresolved files:
${(facts.unresolved_files ?? []).map((f) => `- \`${f}\``).join('\n')}
`
    : ''

const testNote = isTest
  ? `
> **TEST RUN.** Opened by a rehearsal dispatch (ref \`${tag}\`, base \`${facts.base_branch}\`). Close this PR and delete branch \`${facts.branch}\` when done. To exercise the model job, dispatch **custom-sync** from \`custom\` with \`ref=<upstream ref>\`, \`base_branch=<a throwaway branch>\`: jobs that use environment \`agent\` run only from \`custom\`.
`
  : ''

// ---- diff section with a size budget -----------------------------------------------------------------------
const remerge = read(`${rawDir}/remerge.patch`)
const fixed =
  [
    leakBanner,
    summary,
    caveats.join('\n'),
    gatesTable,
    failTails,
    conflictTable,
    footprint,
    modelBlock,
    checklist,
    resolveRecipe,
    testNote
  ].join('\n').length + 4000
const diffBudget = Math.max(2500, Math.min(28000, BODY_LIMIT - fixed))
let diffSection
if (state === 'manual') {
  diffSection =
    '_The conflicted files are committed with their conflict markers, so there is no resolution to diff. Resolve them as described below._\n'
} else if (!remerge.trim()) {
  diffSection =
    state === 'clean'
      ? '_Clean merge: git made every decision, so there is no resolution diff._\n'
      : '_No resolution diff (nothing was resolved by hand or by the agent)._\n'
} else {
  const cut = remerge.length > diffBudget
  const shown = cut
    ? `${remerge.slice(0, diffBudget).replace(/\n[^\n]*$/, '')}\n... [truncated: ${remerge.length - diffBudget} more characters]\n`
    : remerge
  diffSection = `\`git show --remerge-diff <merge commit>\` restricted to the files that were conflicted (lines starting with \`-\` come from git's auto-merge, \`+\` is what the resolution kept).${cut ? ` **Truncated** to ${diffBudget} characters; the full diff, including every file, is in the \`${process.env.FULL_DIFF_ARTIFACT || 'sync-review'}\` artifact of [this run](${RUN_URL}).` : ''}\n\n~~~~~~diff\n${shown.replace(/~{6,}/g, '~~~~~')}\n~~~~~~\n`
}

const upstreamLink =
  process.env.RELEASE_URL || `https://github.com/stablyai/orca/commit/${facts.upstream_sha}`
const compareLink = facts.tag_is_release
  ? `https://github.com/stablyai/orca/compare/${oldTag}...${tag}`
  : ''
const body = `${leakBanner}**Merge with a MERGE COMMIT (squash is disabled). ${releaseSentence}**
${testNote}
## ${state === 'manual' ? 'Needs a manual merge' : 'Upstream sync'}: ${tag}

${summary}

- Upstream: [${tag}](${upstreamLink})${compareLink ? ` ([compare ${oldTag}...${tag}](${compareLink}))` : ''}, commit \`${String(facts.upstream_sha).slice(0, 12)}\`
- Upstream commits merged: **${facts.upstream_commits}** (\`git rev-list --count ${String(facts.base_sha).slice(0, 8)}..${String(facts.upstream_sha).slice(0, 8)}\`)
- \`custom/BASE\`: ${oldTag} -> ${facts.tag_is_release ? tag : `${oldTag} (unchanged, not a release tag)`}
- Merge commit \`${String(facts.merge_sha).slice(0, 12)}\`, parents: \`${facts.base_branch}\` ${String(facts.base_sha).slice(0, 8)} and the link commit \`${String(facts.link_sha).slice(0, 8)}\` (tree identical to ${tag}; it only makes ${oldTag} the merge base)
- Our files (diff of ${oldTag} against ${facts.base_branch}): ${facts.our_files_count}

## Caveats to review

${caveats.length > 0 ? caveats.map((c) => `- ${c}`).join('\n') : '- None found by the scripts.'}

## Gates

Real exit codes from \`custom/scripts/run-gates.sh\`, run by a script on the merge commit (not by a model).

${gatesTable}
${failTails}

## Conflicted files

${conflictTable}
## Merge resolution diff

${diffSection}
## Customization footprint

${footprint}
${modelBlock ? `\n## What the model did\n\n${modelBlock}\n` : ''}${resolveRecipe}
## How to review

${checklist}

**Merge with a MERGE COMMIT (squash is disabled). ${releaseSentence}**

<sub>Generated by [custom-sync](${RUN_URL}) from facts only. PRs opened with the workflow token do not trigger other workflows, so the gates above were run by the sync run itself.</sub>
`

writeFileSync(`${outDir}/pr-body.md`, body)
writeFileSync(`${outDir}/pr-title.txt`, `${title}\n`)
const labels = ['upstream-sync']
if (agentResolved.length > 0 || agentRounds.length > 0) {
  labels.push('agent-resolved')
}
if (state !== 'clean' || caveats.length > 0 || failedGates.length > 0) {
  labels.push('needs-review')
}
writeFileSync(
  `${outDir}/pr-meta.json`,
  JSON.stringify({
    state,
    draft,
    labels,
    title,
    gates_status:
      state === 'manual' || failedGates.length > 0 ? 'failure' : !gatesRan ? 'pending' : 'success',
    gates_failed: failedGates.map((g) => g.id),
    unresolved,
    body_chars: body.length
  })
)
console.error(`PR body: ${body.length} characters, state=${state}, draft=${draft}`)
