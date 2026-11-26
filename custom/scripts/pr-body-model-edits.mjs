// Whether the edits of a model round are IN the candidate a sync PR publishes, for make-pr-body.mjs: the agent-resolved label, and the
// wording of a merge that needed no model but was then repaired by one. Every input is data: the chosen candidate's facts (its own
// `agent.rounds`, which each round copies from the candidate it started from and appends to) and the union of every round's records
// (agent-rounds.json, which also holds rounds whose candidate lost). Round 0 is the merge job, no model, so its facts carry no record.
//
// Why: after a clean merge with a red gate a model may repair it (custom-sync.yml, agent2's fourth case). If the repair won, the merge
// summary must not say that git made every decision; if it lost, round 0 is published and the union still lists the rounds, so the
// label and the model table would claim edits the PR does not contain.
const ran = (rounds) => (Array.isArray(rounds) ? rounds : []).filter((r) => r && r.skipped !== true)
const list = (rounds) =>
  [...new Set(rounds.map((r) => Number(r.round)))].sort((a, b) => a - b).join(', ')

export function modelEditsReport({ facts, agentRounds, state, fullDiffArtifact }) {
  const own = ran(facts.agent?.rounds)
  const all = ran(agentRounds)
  const repaired = (state === 'clean' || state === 'scripted') && own.length > 0
  const caveats = []
  if (own.length === 0 && all.length > 0) {
    caveats.push(
      `Model round(s) ${list(all)} ran in this sync, but none of their edits is in this PR: the candidate it carries was made without a model (the merge, which scored best). The model section below shows what those rounds did.`
    )
  }
  return {
    // The label says the published candidate holds a model's work, not that a model ran somewhere in the run.
    agentResolved: own.length > 0,
    summaryNote: repaired
      ? ` Then gates failed and a cloud model repaired the merge (round ${list(own)}): treat the files it edited (listed in the caveats) as unreviewed code.`
      : '',
    diffNote: repaired
      ? ` The model's repair edits are not in it: the caveats list them, and the full diff is in the \`${fullDiffArtifact}\` artifact.`
      : '',
    checklistItem: repaired
      ? 'Read the files the repair round(s) edited (listed in the caveats) in full. A model changed them after the merge.'
      : null,
    caveats
  }
}
