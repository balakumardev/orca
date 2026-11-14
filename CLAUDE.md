@AGENTS.md

# This fork (balakumardev/orca)

Unofficial community fork of [stablyai/orca](https://github.com/stablyai/orca) (MIT). Not affiliated with or endorsed by Stably. The default branch `custom` is an upstream release tag plus our customizations plus the automation in `custom/` and `.github/workflows/custom-*.yml`. The upstream rules imported above still apply; this file only covers what differs here.

Before a task, load the matching skill from `.claude/skills/`:

- `fork-add-customization`: adding, changing or dropping a customization, and what each existing one does.
- `fork-release-and-sync`: upstream sync PRs, releases, signing, secrets, rehearsals, failed runs.

## Hard rules

- `custom` is never rebased, force-pushed or squash-merged. Squash and rebase merges are switched off for the repo: merge with a merge commit. Upstream release tags are merged in, never replayed.
- Land changes on `custom` only through a pull request (the branch requires one; force-push and deletion are blocked). In a fork `gh` defaults to the PARENT repo, so always pass `--repo balakumardev/orca` (`gh pr create --repo balakumardev/orca --base custom --head <branch>`). Never push to, open a PR on, or comment on stablyai/orca from here.
- Only workflows named `.github/workflows/custom-*.yml` exist. Every sync deletes upstream's workflows and `dependabot.yml`, so any other workflow file you add or edit is lost.
- Secrets: never print, log, commit or write a value. Refer to names only. Never use `pull_request_target`, never put untrusted `${{ }}` text inside a `run:` script (pass it through `env:`), and use only `actions/*` plus `pnpm/action-setup` (the repo's allow list).
- Every customization commit carries the trailer `Orca-Custom-Patch: <name>`. The sync and the agent prompt read it.
- Keep edits to existing upstream files tiny and put new logic in new, concretely named files: those edits are what conflict on every sync.

## Layout

- `custom/BASE`: the upstream release tag this branch is based on (the sync updates it).
- `custom/scripts/`: sync, gate, release and signing scripts (bash; each has a header comment). `custom/scripts/test/`: shell tests for them (run them by hand; CI does not). `custom/agent/prompt.txt`: the prompt of the conflict-resolution model. Every script runs under `set -euo pipefail` (`lib.sh`): never put `head`, `grep -q`, `sed ...q` or `awk ... exit` after a pipe, because the producer dies of SIGPIPE (exit 141) and the script stops. Use `trunc_bytes N` from `lib.sh`, a here-string, or capture the output first and cut it after. `test-trunc-bytes.sh` scans for it; a line whose producer is known to be tiny may carry a `pipe-ok: <why>` comment.
- `.github/workflows/`: `custom-sync` (poll upstream, merge, resolve, open a PR), `custom-agent` (one model round), `custom-gates` and `custom-pr-gates` (the quality gates), `custom-release` (build, sign, notarize, publish).
- `.github/pull_request_template.md`, `CLAUDE.md` and `.claude/skills/fork-*` are ours: the sync always keeps our version. That list is written once, as `OUR_WINS_PATTERNS` in `custom/scripts/lib.sh`; it also decides which commits the model sees as "our customizations" (commits that only touch it, or `.github/`, are left out).

## How a release happens

1. `custom-sync` runs every 3 hours (or by hand), finds a newer upstream release tag and merges it into a `sync/<tag>` branch. Scripts resolve what they can, a cloud model resolves the files our customizations own, scripts run every gate, and the workflow opens a PR into `custom` whose body lists the facts and the caveats to review.
2. A person reviews the PR and merges it with a merge commit.
3. `custom-release` builds the macOS arm64 app, signs it, notarizes it and publishes the release `v<base>+custom.<N>`. Today it is started by hand (`gh workflow run custom-release.yml --repo balakumardev/orca --ref custom`); check the `on:` block of `custom-release.yml` to see whether a merge into `custom` also starts it.

## Versions and updates

- The app version is `<upstream base>+custom.<N>`; `N` is global and only grows. Keep the `+` form: a `-` makes the app treat itself as a release-candidate build. Semver ignores the part after `+`, so compare `N` explicitly.
- Upstream's in-app updater is off for these builds (customization `disable-updater`); the `self-updater` customization updates them from this fork's releases instead.

## Verify before every PR

`pnpm tc`, `pnpm exec oxlint <files>`, `pnpm exec oxfmt --check <files>`, `pnpm test <files> --maxWorkers=2`, `pnpm run verify:localization-coverage`, `pnpm check:e2e-typecheck-ratchet`. Node 24 only. Line caps (oxlint): `.ts` 300 and `.tsx` 400 non-blank, non-comment lines. The PR gates (`gates / result`) run the same checks, plus every Playwright e2e spec your PR changes and the specs of our own customizations. When you run Electron tests from inside an Orca terminal, unset every `ORCA_*` variable first so the test cannot attach to your live app.
