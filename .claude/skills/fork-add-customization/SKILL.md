---
name: fork-add-customization
description: "Use when adding, changing, fixing or dropping a customization (patch) in this fork of Orca, when a customization conflicts after an upstream sync, or when asked what this fork changes and why."
---

# Add or change a customization

This fork is upstream Orca plus a small set of customizations. Each one is ordinary commits on `custom` that carry the trailer `Orca-Custom-Patch: <name>`. They are merged by pull request and never rebased.

## How upstream releases reach our changes

A sync computes "our changes" as the diff between the old base tag (`custom/BASE`) and the tip of `custom`, and replays exactly that on top of the new upstream tag. Consequences for every change you make:

- The files you edit in upstream's tree are the conflict surface of every future sync. Keep those edits tiny.
- New logic goes in new files with concrete names (upstream's own rule: no `utils`, `helpers`, `common`). New files never conflict.
- A file you did not touch is always taken from upstream, so never rely on a side effect of an untouched upstream file.

## Recipe

1. Branch from the current `custom`: `git switch -c feature/<name> <remote>/custom`. Work tree clean first.
2. Read `AGENTS.md` (upstream's rules: reuse before reimplementing, naming, comments, cross-platform, remote hosts, mobile).
3. Make the change. Respect the oxlint line caps: `.ts` 300 and `.tsx` 400 non-blank, non-comment lines. Several registry files sit within a few lines of the cap, so new shortcut definitions go in `definitions-core-4.ts` or a new file.
4. Verify locally (Node 24): `pnpm tc`, `pnpm exec oxlint <files>`, `pnpm exec oxfmt --check <files>`, `pnpm test <files> --maxWorkers=2`. A new user-visible string needs `pnpm run sync:localization-catalog` (adds `en.json` only) and `pnpm run verify:localization-coverage`. `pnpm tc` does not typecheck `tests/`, so also run `pnpm check:e2e-typecheck-ratchet`.
5. Commit with the trailer on its own line: `Orca-Custom-Patch: <name>` (reuse the name of the customization you are changing, or pick a short kebab-case name for a new one).
6. Open the PR: `gh pr create --repo balakumardev/orca --base custom --head <branch>`. The PR gates run the same checks as the sync (`gates / result`); fix what they report. Merge with a merge commit.
7. In the same PR, update the index below: one entry per customization with what it does and which upstream files it edits.

Changing an existing customization: add a new commit on top with the same trailer (fix forward). Never amend or rebase `custom`, and never force-push it.

Dropping one (for example because upstream now ships the same behaviour): remove it in a PR, keep upstream's version, delete its index entry. Compare against upstream's version before the next sync, because the sync cannot tell that two implementations do the same job.

## Run an Electron e2e spec by hand

CI runs the specs in scope (the ones your PR changes plus our own) on a macOS runner in `custom-gates`. To run one locally without touching a live Orca:

```
VITE_EXPOSE_STORE=true npx electron-vite build --mode e2e   # replaces out/; exposes window.__store
ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 npx playwright test tests/e2e/<spec> \
  --config tests/playwright.config.ts --project=electron-headless --workers=1 --trace=off
```

Unset every `ORCA_*` environment variable first when you work inside an Orca terminal (they point at your live app). Use `npx playwright` directly: `pnpm run test:e2e` runs `ensure:electron-runtime`, which can rebuild native modules. The e2e build replaces `out/`, so rebuild production output afterwards.

## Index of customizations

Trailer values you will also see on infrastructure commits: `fork-neutralize`, `fork-scaffold`, `release-workflow`, `sync-workflow`. They are the automation, not product changes.

- `activity-title`: Activity cards show the agent session name instead of the last prompt (a port of stablyai/orca#31802). Highest churn: upstream keeps reworking Activity titles, so it conflicts first. Candidate to drop: upstream's `getAgentRowConversationName` already carries part of the rule, so compare before the next sync.
- `disable-updater`: upstream's updater is off when `app.getVersion()` contains `+custom.`, through `isAutoUpdateDisabledForBuild` (early returns in the download, menu-check, scheduling, setup and nudge code, plus one status setter). Without it upstream's updater would offer upstream's newer base and fail the signature check, because that is a different team.
- `self-updater`: a `+custom` build updates itself from this fork's GitHub Releases. About 90 s after start and then every 4 h (or from the menu or Settings) it picks the newest eligible `+custom.N` with a valid `manifest.json`, downloads `Orca-<version>-arm64-mac.zip`, verifies it (sha256, a lone real `Orca.app`, bundle id and version, one `codesign -R` requirement for team `KHD36T7C97`, Gatekeeper `Notarized Developer ID`, stapler) and stages it through Electron's native Squirrel.Mac. The card's restart button then runs upstream's own install path; nothing quits by itself. All logic is new files in `src/main/updater/custom/`. It edits two upstream files by a few lines: `updater-install-execution.ts` (the native install call moved into the overridable `invokeNativeQuitAndInstall`) and `updater-service.ts` (builds `CustomUpdaterSetup`, a subclass in `custom/custom-updater-setup.ts` that asks the module first for check, download and restart and starts it after upstream's setup, instead of `UpdaterSetup`); `updater-setup.ts` itself is untouched, so it never conflicts. It depends on the release contract that `custom/scripts/package-release.sh` writes (asset name, `ditto --keepParent` zip with `Orca.app` at the top, `manifest.json` fields) and on the team constant `CUSTOM_UPDATE_TEAM_ID`; change them together. `custom/scripts/verify-app.sh` asserts the same `codesign -R` requirement on the signed build in the release job (`custom-update-verify-app-script.test.ts` keeps the two strings equal). The release job also holds the zip to the app's size rule: `custom/scripts/update-size-limits.sh` (called by `package-release.sh`) fails a zip that expands over 3.5 times, holds over 150,000 entries or is over 900 MiB, and `custom-update-size-limits-script.test.ts` fails when its copies of the app's limits (`EXTRACTED_SIZE_FACTOR`, `MAX_ARCHIVE_ENTRIES`, `CUSTOM_UPDATE_MAX_ZIP_BYTES`) drift. The workflow refuses `publish=true` unless the run signs and notarizes, and the publish job requires `signed`, `notarized` and our team in the manifest; `next-version.sh` fails when `custom/BASE` is lower than a base that already has a release (the app would never offer such a build). The app keeps what it learned about releases for 30 days in `custom-update-state.json` in the user data folder (`custom-update-state.ts`): releases it set aside (also skipped by a person's check), strike counts for failures that prove nothing alone (staging, a tool time-out) and the free space at which a release did not fit (it is retried once 1 GiB more is free). The extraction keeps 1 GiB free and stops `ditto` with one `statfs` every 10 ms; `removeTree` strips ACLs (`chmod -R -N`) before it deletes, because a deny-delete ACL in a zip's `._*` entries survives `ditto`. Known gap: a real stage, quit and swap has not been seen end to end before the first release that contains it.
- `build-identity`: the env var `ORCA_BUILD_COMMIT` overrides `git rev-parse HEAD` in `build-source-commit.mjs`, so skill-install pins point at the real upstream tag commit instead of a fork commit that does not exist upstream.
- `release-signing-team`: the env var `ORCA_MAC_TEAM_ID` overrides the Developer ID team constant in `config/electron-builder.config.cjs`. Release-mode builds fail the terminal-host team check for any other team.
- `activity-shortcuts`: three registry actions, customizable in Settings > Shortcuts or `~/.orca/keybindings.json` (`Mod` is Cmd on macOS): `sidebar.activity.previousAgent` (`Mod+Shift+Semicolon`), `sidebar.activity.nextAgent` (`Mod+Shift+Quote`) and `sidebar.activity.toggle` (`Mod+Shift+L`). The cycle walks the visible Activity rows (collapsed groups skipped), wraps at both ends, reuses the row-click `selectThread` and works with a terminal focused. Known gap: no firing while an embedded browser guest or a text input has focus. It edits registry and command-handler files (`app-command-handlers.ts`, `use-global-keybindings.ts`, `keybinding-title-copy.ts`, `definitions-core-4.ts`, `en.json` and the Activity list files); its new files never conflict.
- `sidebar-layout`: the left sidebar shows the workspace list on top and the Activity list below it at the same time, split by a draggable splitter (ArrowUp and ArrowDown resize it). The bell switch is gone; `sidebar.activity.toggle` now shows or hides the Activity pane, and the cycle chords work whenever the sidebar is open and the pane is visible. `sidebarBody` stays `'workspaces'` on purpose (upstream's reveal actions do nothing in `'agents'`); the store flag `activityPaneOpen` drives the pane. Selecting an agent also expands and scrolls its workspace in the list (we delete `revealInSidebar: false` in `activity-thread-actions.ts` so upstream's own reveal runs). Search, Tasks, Artifacts, Skills, Automations, Agent Dashboard and Orca Mobile moved into a "Quick links" popover opened from a titlebar button (`sidebar-nav-popover.tsx`). Activity cards hide the description line by default; a "Show description" checkbox in the Activity options menu turns it on (localStorage key `orca-custom.activity.showDescription`). Highest conflict surface: `sidebar/index.tsx` and `SidebarHeader.tsx`, then `TitlebarLeftControls.tsx`, the Activity list, row and options-menu files, `ui-slice-*` files and `en.json`. Known gaps at last review: the onboarding tour step anchored on `sidebar-navigation` points into a closed popover, five older upstream e2e specs still look for the removed sidebar buttons (`github-project-board`, `floating-terminal-tab-rename-focus`, `modal-scene-blur`, `activity-agent-pane-isolation`, `tooltip-dropdown-trigger-stability`), and dark theme and embedded-browser focus were not checked.

Files near their line cap: the `lint-caps` gate flags any file within 10 lines of its cap in the PR body. Past offenders: `use-global-keybindings.ts`, `app-command-handlers.ts`, `ui-slice-preference-actions.ts`, `activity-thread-list-pane.tsx`.

## When a customization conflicts after a sync

The sync resolves the conflicts of files that none of our customizations touch by taking upstream's version. For files we own, a cloud model proposes a resolution and the PR body shows exactly what it decided; a person reviews it. Read the conflicting hunk against the intent in the index above before accepting it, and check the sidebar by eye: no test covers where a new upstream sidebar section lands.
