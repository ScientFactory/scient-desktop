<!--
⚠️ READ BEFORE OPENING ⚠️

We are not actively accepting contributions right now.

You can still open a PR, but please do so knowing there is a high chance
we may close it without merging it, or never review it.

- Small, focused PRs are strongly preferred. Bug fixes are most likely to be merged.
- New features will most likely just annoy us.
- 1,000+ line PRs with a bunch of new features will probably get you banned from the repo.
-->

## What Changed

<!-- Describe the change clearly and keep scope tight. -->

## Why

<!-- Explain the problem being solved and why this approach is the right one. -->

## Documentation Impact

<!-- Keep one: None — reason | Updated — paths | Dependent PR — repository and link -->

Documentation impact:

## Platforms

<!-- Expected behavior on each, the checks that ran there, and what is still unproven.
     Lead with any difference between platforms. "Unaffected" needs its reason. -->

| Platform | Expected behavior | Checks run | Unproven |
| -------- | ----------------- | ---------- | -------- |
| macOS    |                   |            |          |
| Windows  |                   |            |          |
| Linux    |                   |            |          |

## UI Changes

<!-- Before/after screenshots of every changed screen, light and dark, checked against the
     UI checklist (docs/internals/web-ui.md#ui-checklist). Add a short video for motion or
     interaction. Delete this section if the PR changes no UI. -->

## Review

<!-- One tier, then its result and any skipped reviewer:
     None — docs, or UI appearance or copy with no logic change
     Light Codex — one pass of correctness findings, each verified, then one recheck of the fixes
     Codex high and a live test — data, migrations, security, release or alignment; the changed
     behavior run in a built app with synthetic state; then one recheck of the fixes
     Example: Review: Light Codex — 2 findings, 1 fixed, 1 rejected (reason); recheck clean -->

Review:

## Checklist

- [ ] This PR is small and focused
- [ ] I explained what changed and why
- [ ] Focused tests and typecheck pass on this head
- [ ] UI: before/after screenshots, light and dark, checked against the UI checklist (or no UI change)
- [ ] Every link a reader can follow that this PR adds was fetched and works
