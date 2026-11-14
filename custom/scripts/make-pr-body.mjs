#!/usr/bin/env node
// Build the sync PR title, body and metadata from FACTS ONLY (sync-facts.json, gates.json files and raw git output).
// Nothing a model wrote is used as a verification claim; model text appears only inside one block labelled as such.
//
// Usage: node make-pr-body.mjs --facts F --raw DIR --out DIR [--gates G1.json --gates G2.json ...] [--agent-rounds R.json]
// Env: PR_TITLE (base title from detect), RELEASE_URL, RUN_URL, REPO (owner/name), FULL_DIFF_ARTIFACT (name, optional)
// Raw inputs in --raw: remerge.patch (restricted to files worth reviewing), numstat-old.txt, numstat-new.txt.
// Writes: pr-body.md, pr-title.txt, pr-meta.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

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
const GATE_ORDER = ['hygiene', 'lint-caps', 'install', 'typecheck', 'lint', 'format', 'unit', 'unit-related', 'localization', 'e2e-ratchet', 'e2e']
const REPO = process.env.REPO || 'balakumardev/orca'
const RUN_URL = process.env.RUN_URL || ''
const stripFence = (s) => s.replace(/~{4,}/g, '~~~')
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

// ---- gates -------------------------------------------------------------------------------------------------
const gates = gateFiles
  .map((f) => JSON.parse(readFileSync(f, 'utf8')))
  .flatMap((g) => g.gates.map((x) => ({ ...x, runner: g.runner?.os })))
  .sort((a, b) => GATE_ORDER.indexOf(a.id) - GATE_ORDER.indexOf(b.id))
const gatesRan = gates.length > 0
const failedGates = gates.filter((g) => g.status === 'fail')
const icon = { pass: '✅', fail: '❌', skip: '⏭' }

// ---- state -------------------------------------------------------------------------------------------------
const conflicts = facts.conflicts ?? []
const ciConflicts = conflicts.filter((c) => c.resolution.startsWith('scripted: dropped upstream CI'))
const otherConflicts = conflicts.filter((c) => !c.resolution.startsWith('scripted: dropped upstream CI'))
const roundsFile = opt('--agent-rounds')
const agentRounds = roundsFile && existsSync(roundsFile) ? JSON.parse(readFileSync(roundsFile, 'utf8')) : (facts.agent?.rounds ?? [])
const agentResolved = conflicts.filter((c) => c.resolution === 'agent')
const unresolved = facts.unresolved === true
const isTest = facts.is_test === true
const tag = facts.tag
const oldTag = facts.old_base_tag

let state = 'clean'
if (unresolved) state = 'manual'
else if (agentResolved.length > 0) state = 'agent'
else if (facts.outcome === 'scripted') state = 'scripted'

const summary = {
  clean: `Clean merge: git merged upstream ${tag} into \`${facts.base_branch}\` without a single conflict.`,
  scripted: `Scripted merge: git reported ${conflicts.length} conflict(s), all settled by the deterministic rules in \`custom/scripts/sync-merge.sh\` (no model involved).`,
  agent: `Agent-resolved merge: ${agentResolved.length} file(s) were conflicted in a way scripts cannot settle and were resolved by a cloud model. Treat those files as unreviewed code.`,
  manual: `NEEDS A MANUAL MERGE: ${facts.unresolved_files?.length ?? 0} file(s) are still unresolved and are committed WITH conflict markers on purpose. This PR cannot be merged as it stands.`
}[state]

// ---- title / draft / labels --------------------------------------------------------------------------------
let title = process.env.PR_TITLE || `Sync upstream ${tag}`
if (state === 'manual') title = `[needs manual merge] ${title}`
else if (failedGates.length > 0) title = `[gates failed] ${title}`
const draft = isTest || state === 'manual' || failedGates.length > 0
const caveats = [...(facts.caveats ?? [])]

// ---- automatic caveats --------------------------------------------------------------------------------------
if (!gatesRan) caveats.push('No gates were run on this candidate' + (state === 'manual' ? ' (an unresolved merge is not worth testing).' : '.'))
for (const g of gates) {
  if (g.status === 'fail') caveats.push(`Gate failed: ${g.name}. The output tail is in the gates section below.`)
  if (g.status === 'skip') caveats.push(`Gate skipped: ${g.name}${g.note ? ` (${g.note})` : ''}.`)
  for (const w of g.warnings ?? []) caveats.push(`Near a lint cap: ${w}`)
}
if (gatesRan && !gates.some((g) => g.id === 'e2e' && g.status === 'pass')) caveats.push('The Playwright e2e specs for our customizations did NOT pass or did not run. Do not rely on this PR for UI behaviour.')
if ((facts.scripted?.upstream_ci_removed ?? 0) > 0) caveats.push(`${facts.scripted.upstream_ci_removed} upstream CI file(s) under .github/workflows or dependabot config were removed again (the fork carries none; ${facts.scripted.upstream_ci_new ?? 0} new in ${tag}).`)
if ((facts.scripted?.our_wins_restored ?? []).length > 0) caveats.push(`Upstream also changed these paths where our side always wins; upstream's change was discarded: ${facts.scripted.our_wins_restored.join(', ')}.`)
if ((facts.drift ?? []).length > 0) caveats.push(`${facts.drift.length} file(s) differ from upstream ${tag} although no customization commit touched them (a rename that carried our edit, or a contributor change): ${facts.drift.slice(0, 15).join(', ')}${facts.drift.length > 15 ? ', ...' : ''}.`)
if (agentRounds.some((r) => r.exit_code !== 0 || r.is_error)) caveats.push('At least one agent round ended with an error or a non-zero exit; see the model block.')
if (agentRounds.some((r) => r.key_leaks > 0)) caveats.push('The API key leak check fired in an agent round; rotate DEEPINFRA_API_KEY.')
if (isTest) caveats.push('This is a TEST run: custom/BASE ' + (facts.tag_is_release ? `was set to ${tag}` : 'was left unchanged') + `, and the PR is a draft against \`${facts.base_branch}\`.`)

// ---- model-written block -----------------------------------------------------------------------------------
let modelBlock = ''
if (agentRounds.length > 0) {
  const total = agentRounds.reduce((s, r) => s + Number(r.estimated_cost_usd || 0), 0)
  modelBlock += '### Cloud agent (model-written, unverified)\n\n'
  modelBlock += '| Round | Mode | Model | Turns | Tokens in / out | Est. cost | Wall | Exit |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n'
  for (const r of agentRounds) {
    modelBlock += `| ${r.round} | ${r.mode} | \`${r.model}\` | ${r.turns}/${r.max_turns} | ${r.input_tokens} / ${r.output_tokens} | $${Number(r.estimated_cost_usd).toFixed(3)} | ${r.wall_s}s | ${r.exit_code}${r.is_error ? ' (error)' : ''} |\n`
  }
  modelBlock += `\nEstimated total: $${total.toFixed(3)}, an upper bound (every input token, cached or not, priced at the full list rate: Flash $0.20 in / $0.60 out per million, Pro $1.30 in / $2.60 out).\n\n`
  const last = agentRounds[agentRounds.length - 1]
  const unsure = agentRounds.flatMap((r) => (r.report || '').split('\n').filter((l) => /UNSURE:/i.test(l)).map((l) => stripFence(l.trim())))
  modelBlock += '> The text below was written by a language model. No script checked any statement in it. The scripted facts are the sections above.\n\n'
  if (unsure.length > 0) modelBlock += `Flagged as unsure by the model (verbatim):\n\n~~~~text\n${unsure.join('\n')}\n~~~~\n\n`
  modelBlock += `<details><summary>The model's own final report (round ${last.round}, unverified)</summary>\n\n~~~~text\n${stripFence(last.report || '(empty)')}\n~~~~\n\n</details>\n`
}

// ---- sections ----------------------------------------------------------------------------------------------
const gatesTable = gatesRan
  ? `| | Gate | Seconds | Runner | Note |\n| --- | --- | --- | --- | --- |\n${gates.map((g) => `| ${icon[g.status]} | ${esc(g.name)} | ${g.seconds} | ${g.runner ?? ''} | ${esc(g.note || '')} |`).join('\n')}\n`
  : '_Not run._\n'
const failTails = failedGates.map((g) => `<details><summary>${esc(g.name)}: output tail (exit ${g.exit_code})</summary>\n\n~~~~text\n${stripFence(g.output_tail || '')}\n~~~~\n\n</details>`).join('\n\n')

const conflictRows = otherConflicts.map((c) => `| \`${c.path}\` | ${c.kind} | ${c.hunks} | ${esc(c.resolution)} |`)
if (ciConflicts.length > 0) conflictRows.push(`| ${ciConflicts.length} upstream CI file(s) (\`.github/workflows/*\`, modify/delete) | deleted-by-us | - | scripted: dropped (the fork carries no upstream CI) |`)
const conflictTable = conflicts.length > 0 ? `| File | Kind | Hunks | Resolution |\n| --- | --- | --- | --- |\n${conflictRows.join('\n')}\n` : '_No conflicts._\n'

// numstat footprint: our change relative to the old base vs relative to the new tag
const parseNumstat = (text) => {
  const map = new Map()
  for (const line of text.split('\n')) {
    const [a, d, ...rest] = line.split('\t')
    if (rest.length === 0) continue
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
  footprint += changed.slice(0, 40).map((p) => `| \`${p}\` | +${oldStat.get(p)[0]} / -${oldStat.get(p)[1]} | +${newStat.get(p)[0]} / -${newStat.get(p)[1]} |`).join('\n')
  if (changed.length > 40) footprint += `\n| ... ${changed.length - 40} more | | |`
  footprint += '\n'
} else footprint += '\nThe size of our change is identical in every file: upstream did not move anything we depend on.\n'
const missing = [...oldStat.keys()].filter((p) => !newStat.has(p) && !/^\.github\/|^custom\//.test(p))
if (missing.length > 0) footprint += `\nFiles our patches changed that no longer differ from upstream (the customization is now redundant or was dropped): ${missing.slice(0, 20).map((p) => `\`${p}\``).join(', ')}.\n`

const checklist = [
  state === 'manual' ? 'Resolve the files listed above locally (see "How to resolve"), delete `custom/UNRESOLVED-MERGE.txt`, push, mark the PR ready and rename it.' : null,
  'Read the "Merge resolution diff" section: it is exactly what the resolution decided (the merge commit against git\'s own auto-merge).',
  'Check the customization footprint table: a changed row means upstream moved code our patches sit on.',
  failedGates.length > 0 ? 'Look at every failed gate output before anything else.' : 'Gates are green; they are scripts, not opinions.',
  agentResolved.length > 0 ? 'Read the agent-resolved files in full. A model decided those hunks.' : null,
  'Run the app from this branch if a conflicted file is user-visible (sidebar, Activity, shortcuts).',
  'Merge with a MERGE COMMIT. After the merge the release workflow publishes a build.'
].filter(Boolean).map((l) => `- [ ] ${l}`).join('\n')

const resolveRecipe = state === 'manual' ? `
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
` : ''

const testNote = isTest ? `
> **TEST RUN.** Opened by a rehearsal dispatch (ref \`${tag}\`, base \`${facts.base_branch}\`). Close this PR and delete branch \`${facts.branch}\` when done. To exercise the model job, dispatch **custom-sync** from \`custom\` with \`ref=<upstream ref>\`, \`base_branch=<a throwaway branch>\`: jobs that use environment \`agent\` run only from \`custom\`.
` : ''

// ---- diff section with a size budget -----------------------------------------------------------------------
const remerge = read(`${rawDir}/remerge.patch`)
const fixed = [summary, caveats.join('\n'), gatesTable, failTails, conflictTable, footprint, modelBlock, checklist, resolveRecipe, testNote].join('\n').length + 4000
const diffBudget = Math.max(2500, Math.min(28000, BODY_LIMIT - fixed))
let diffSection
if (state === 'manual') diffSection = '_The conflicted files are committed with their conflict markers, so there is no resolution to diff. Resolve them as described below._\n'
else if (!remerge.trim()) diffSection = state === 'clean' ? '_Clean merge: git made every decision, so there is no resolution diff._\n' : '_No resolution diff (nothing was resolved by hand or by the agent)._\n'
else {
  const cut = remerge.length > diffBudget
  const shown = cut ? `${remerge.slice(0, diffBudget).replace(/\n[^\n]*$/, '')}\n... [truncated: ${remerge.length - diffBudget} more characters]\n` : remerge
  diffSection = `\`git show --remerge-diff <merge commit>\` restricted to the files that were conflicted (lines starting with \`-\` come from git's auto-merge, \`+\` is what the resolution kept).${cut ? ` **Truncated** to ${diffBudget} characters; the full diff, including every file, is in the \`${process.env.FULL_DIFF_ARTIFACT || 'sync-review'}\` artifact of [this run](${RUN_URL}).` : ''}\n\n~~~~~~diff\n${shown.replace(/~{6,}/g, '~~~~~')}\n~~~~~~\n`
}

const upstreamLink = process.env.RELEASE_URL || `https://github.com/stablyai/orca/commit/${facts.upstream_sha}`
const compareLink = facts.tag_is_release ? `https://github.com/stablyai/orca/compare/${oldTag}...${tag}` : ''
const body = `**Merge with a MERGE COMMIT (squash is disabled). Merging this PR publishes a release.**
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

**Merge with a MERGE COMMIT (squash is disabled). Merging this PR publishes a release.**

<sub>Generated by [custom-sync](${RUN_URL}) from facts only. PRs opened with the workflow token do not trigger other workflows, so the gates above were run by the sync run itself.</sub>
`

writeFileSync(`${outDir}/pr-body.md`, body)
writeFileSync(`${outDir}/pr-title.txt`, `${title}\n`)
const labels = ['upstream-sync']
if (agentResolved.length > 0 || agentRounds.length > 0) labels.push('agent-resolved')
if (state !== 'clean' || caveats.length > 0 || failedGates.length > 0) labels.push('needs-review')
writeFileSync(
  `${outDir}/pr-meta.json`,
  JSON.stringify({
    state, draft, labels, title,
    gates_status: state === 'manual' || failedGates.length > 0 ? 'failure' : !gatesRan ? 'pending' : 'success',
    gates_failed: failedGates.map((g) => g.id),
    unresolved, body_chars: body.length
  })
)
console.error(`PR body: ${body.length} characters, state=${state}, draft=${draft}`)
