## What and why

<!-- One or two plain sentences: the change first, then the reason. -->

## Checklist

- [ ] The change is small and touches only what it needs to
- [ ] `custom/**` and `.github/workflows/custom-*` are unchanged, or the change is explained above
- [ ] I ran the app and tried the change, or explained why that is not possible
- [ ] Tests cover the change, or I said why they cannot
- [ ] If this edits an upstream file, the change is as small as possible so the next upstream sync merges cleanly

Merge with a merge commit (squash is disabled). Whether a merge into `custom` starts a release depends on the `on:` block of `custom-release.yml`.
