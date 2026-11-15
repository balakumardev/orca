// Why: a PR clone of this fork has no upstream release tags (`git rev-parse v1.4.229` fails), so these tests cannot resolve their refs.
// Set by .github/workflows/custom-gates.yml for pull requests only; a local run and the sync gates still run them.
export const FORK_PR_GATE_TEST_EXCLUDES =
  process.env.ORCA_FORK_PR_GATE === '1' ? ['tests/e2e/cross-version-wire/**'] : []
