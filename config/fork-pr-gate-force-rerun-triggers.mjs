// Why: vitest selects EVERY test file when a changed path matches a forceRerunTrigger, so `vitest related` on a PR that
// touches config/scripts runs the whole suite (7538 files) and cannot finish inside the PR gate's cap.
// With FORK_PR_GATE=1 (set by custom-gates.yml for pull requests only) the module graph picks the tests instead.
// Why no ORCA_ prefix: custom/scripts/run-gates.sh unsets every ORCA_* variable before it starts vitest.
const WHOLE_SUITE_TRIGGERS = ['**/config/**']

/**
 * @param {string[]} triggers
 * @returns {string[]}
 */
export function forkPrGateForceRerunTriggers(triggers) {
  return process.env.FORK_PR_GATE === '1'
    ? triggers.filter((trigger) => !WHOLE_SUITE_TRIGGERS.includes(trigger))
    : triggers
}
