# T3 alignment through `3fd5d643`

Status: automated qualification and final source review passed; pull-request publication is
authorized. No visual acceptance or release publication is claimed. This is one full,
history-preserving alignment from the previous official boundary through the exact official target.
It is not a split, cherry-pick, squash, or replay.

## Frozen history

- Owned starting point: `3073a904cd299fe9f6ac123a6d939a8eed6b225c` (`origin/main` when the
  isolated candidate was created).
- Previous official integration: `1ab2dfb5a7bd2996f79407b5d02cae6132a7626c`.
- Official target: `3fd5d6439d8fd49d173503ecda96500463a39bd2` (`v0.0.43-nightly.20260917.1880`
  nearest tag; 23 first-parent commits after the previous official integration).
- Alignment branch: `codex/t3-sync-3fd5d643-20260918`.
- Direct history-preserving merge: `0b541f80af4cadf1b5639f51aa12effcf9881c87`, with the
  owned starting point as first parent and the exact official target as second parent.
- Owned main advanced during qualification. `f6dd5203ba` (#304), `c343223d37` (#305), and
  `3f9e3c9c6e` (#307) were incorporated as ordinary history through merges
  `f753d69df9` and `108bb3c37e`, rather than being replayed into the alignment.
- The fetch-only `upstream` remote remains unchanged and its push URL is `DISABLED`.

## Adopted upstream behavior

The 23-commit official range brings the current pull-request, checkpoint, usage, composer,
mobile-settings, browser-panel, file-context-menu, keybinding, and activity-row improvements.
The most consequential changes for this fork are the pull-request files-viewed workflow,
right-click file actions, safer project/thread routing, bounded provider activity records,
checkpoint recovery for nested repositories, and the mobile settings decomposition. The final
owned-main additions also make workspace-relative links the preferred user-facing deliverable
path, add coverage for Unicode Windows-style HTML paths and preview-link wording, add the v0.6.14
release notes, and preserve composer submission intent while voice processing is pending.

## Conflict composition and first-principles decisions

- **Migrations remain immutable.** Scient's existing migration history through `055` was kept
  literal. Upstream's pull-request-files-viewed migration was registered as Scient `056`, and
  the compatibility test now asserts the new table and exact manifest. No migration was
  renumbered, reused, or removed to match T3's counter.
- **Scient's file browser remains the authority.** The lazy project tree, project-directory view,
  source-opening policy, read-only decorations, and scientific controls were retained. Upstream's
  generic file context-menu actions were layered into that existing architecture instead of
  replacing it with upstream's older directory-entry implementation.
- **Shared navigation keeps both policies.** Upstream's settled-thread behavior and current-thread
  pull-request context were composed with Scient's navigation guards, project-first routing, and
  provider/browser semantics. No projectless path or local queue authority was reintroduced.
- **Provider, workspace, browser, scientific, identity, release, cloud, and publication seams
  remain Scient-owned.** Generic upstream behavior was adopted at shared seams; no unsupported
  update channel, cloud activation, mobile publication, or release workflow was enabled.
- **Documentation and dependencies were composed, not duplicated.** Scient's existing guidance
  and exports were retained, upstream documentation was added at its own paths, and the lockfile
  was regenerated from the composed manifests.
- **The latest owned-main changes were folded without textual conflicts.** Their agent guidance,
  preview-link schema, Windows/Unicode HTML path test, release notes, and voice-aware composer
  submission behavior are preserved as ordinary main history.

## Qualification

- `pnpm exec vp fmt --check`: passed.
- `pnpm exec vp lint --report-unused-disable-directives`: passed with the repository's existing
  non-blocking warning set.
- `pnpm run typecheck`: passed with existing TypeScript suggestion diagnostics only.
- Focused alignment tests: 12 files / 422 tests passed.
- Full warmed test matrix after the upstream range: web 690 files / 8,031 tests, mobile 176 /
  1,637, desktop 115 / 1,414 with 4 files / 43 tests skipped, relay 30 / 284, server 503 /
  7,157 with 15 files / 63 tests skipped, plus all shared and Scient package suites passed.
- After owned-main #307 was incorporated, the affected citation/composer tests passed: 2 files /
  180 tests, including 7 citation-editor tests. The complete web suite was rerun; 689 files /
  8,033 tests passed and one existing host-sensitive performance sample exceeded its normal
  non-strict threshold. The isolated performance test was rerun immediately and passed all 5
  tests, so no threshold or production code was changed.
- `pnpm run build`: passed. The build emitted existing third-party `eval`, chunk-size, and
  optional-platform import warnings only.
- `pnpm run test:desktop-smoke`: passed.
- `pnpm run brand:check`: passed across 2,106 product-surface files.
- Analysis, onboarding, skills, and LaTeX protected-seam checks: passed against the exact
  `origin/main...HEAD` candidate range and official `upstream/main` target.
- `pnpm run upstream:provenance:check`: passed at official integration base `3fd5d643`.
- Conflict markers and unmerged index entries: none. The candidate worktree is clean after the
  documentation/state receipt commit.
- No computer-use or visual manual review was performed; this is the handoff point for owner
  manual review.

## Manual review focus

1. Review Pull Requests: viewed-file state, progressive diffs, comments, stacks, search, and
   right-click file actions; confirm Scient project/workspace behavior remains intact.
2. Review Files: lazy project-tree loading, directories versus files, source opening, and the
   new context-menu actions, including a Unicode Windows-style path.
3. Review chat and composer: settled-thread navigation, current-thread pull-request actions,
   voice citation comments, submission while voice processing is active, and the new v0.6.14
   release-note content.
4. Review mobile settings and activity changes where a native client is available.
5. Recheck Scient providers, custom models, scientific surfaces, browser/HTML/PDF behavior,
   update policy, release identity, cloud/publication guards, and migration-safe startup.
