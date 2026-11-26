// The key-leak part of a sync PR, for make-pr-body.mjs: its caveats and the banner at the top of the body. Every input is data, never
// model text: the round records (they carry the file NAMES), the leak counts of the agent jobs' run steps (AGENT_KEY_LEAKS="1=0 2=3 3=",
// set by the run step, so they exist even when `finish` died and wrote no record; "unknown" = the run step died before its check
// finished), the job results (AGENT_RESULTS) and the directory that holds the downloaded round-N/ artifacts (ROUNDS_DIR).
import { existsSync } from 'node:fs'

// "1=a 2=b 3=" -> { 1: 'a', 2: 'b', 3: '' }
export const roundPairs = (text) =>
  Object.fromEntries(
    (text || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((kv) => kv.split('='))
  )

// Round numbers and file NAMES only. The names were chosen by the model, so they are stripped of control characters and
// backticks, capped, and shown as inline code; nothing the model wrote is shown here.
// Drops exactly U+0000-U+001F, U+007F and the backtick (the set the regex it replaced removed), without a control-character regex.
const isPlainChar = (ch) => ch !== '`' && ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f
const leakName = (n) => `\`${[...String(n)].filter(isPlainChar).join('').slice(0, 120)}\``

export function keyLeakReport({ agentRounds, leakEnv, roundResults, roundsDir }) {
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
  // An unknown check of a round whose job failed and that uploaded NO artifact did not run because the round was killed first, and
  // nothing of that round left the runner (custom-agent.yml uploads nothing after a failed run step): say so, without telling anyone to
  // rotate the key (v1.4.274, PR #75, said "treat it as exposed" for a round that died with its runner). Without ROUNDS_DIR, or when the
  // round's artifact exists, the check stays "did not complete" with the rotate warning.
  const killed = (n) =>
    roundsDir !== '' &&
    ['failure', 'cancelled'].includes(roundResults[String(n)]) &&
    !existsSync(`${roundsDir}/round-${n}`)
  const rounds = [...leaks.keys()].sort((a, b) => a - b)
  const killedRounds = rounds.filter((n) => leaks.get(n).unknown && killed(n))
  const warnRounds = rounds.filter((n) => !killedRounds.includes(n))
  const caveats = []
  if (warnRounds.length > 0) {
    caveats.push(
      `Key leak in agent round ${warnRounds.join(', ')}: see the warning at the top of this description.`
    )
  }
  if (killedRounds.length > 0) {
    caveats.push(
      `The key-leak check of agent round ${killedRounds.join(', ')} did not run: the round was killed first, and nothing from it was uploaded or used. See the note at the top.`
    )
  }
  const confirmed = warnRounds.filter((n) => !leaks.get(n).unknown)
  const unknown = warnRounds.filter((n) => leaks.get(n).unknown)
  const caution =
    warnRounds.length === 0
      ? ''
      : `> [!CAUTION]
${confirmed.length > 0 ? "> **The agent's output contained the API key; its edits were discarded. Rotate DEEPINFRA_API_KEY.**\n" : ''}${unknown.length > 0 ? `> **The agent's key-leak check did not complete${confirmed.length > 0 ? ' in another round' : ''}. Treat DEEPINFRA_API_KEY as exposed and rotate it.**\n` : ''}${warnRounds
          .map((n) => {
            const { files, unknown: notDone } = leaks.get(n)
            if (notDone) {
              return `> - Round ${n}: the leak check did not complete`
            }
            return `> - Round ${n}: ${files.length > 0 ? files.slice(0, 20).map(leakName).join(', ') : '(no file names recorded)'}${files.length > 20 ? `, and ${files.length - 20} more` : ''}`
          })
          .join('\n')}

`
  const note =
    killedRounds.length === 0
      ? ''
      : `> [!NOTE]
> **The key-leak check of agent round ${killedRounds.join(', ')} did not run: the round's job ended (${killedRounds.map((n) => `round ${n}: ${roundResults[String(n)]}`).join(', ')}) before the check, so nothing from that round was uploaded or used in this candidate.**

`
  return { caveats, banner: caution + note }
}
