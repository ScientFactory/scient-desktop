# T3 upstream sync through bab4b6f02b

Status: locally verified integration candidate. This record does not authorize
a release, enable cloud or mobile publication, or modify `release/stable`.

## Exact boundaries

- Owned base: `a19da4962d01ae6c95b6f6ad6deca2b7b8244527`
- Previous literal T3 boundary:
  `6ae9662d8ed215476e697adc12403ce035500828`
- Integrated T3 target:
  `bab4b6f02b8bdaf15fd32636a97f69ff657cec50`
- Latest official tag observed: `v0.0.34-nightly.20260816.1110`
- Exact donor range: `6ae9662d8e..bab4b6f02b`, 98 commits
- Integration branch: `agent/t3-sync-bab4b6f02b-20260816`
- Isolated worktree:
  `/Users/yaacov/REPOs/ScientFactory-worktrees/scient-desktop-next-t3-sync-bab4b6f02b-20260816`
- Donor write boundary: the `upstream` push URL remains `DISABLED`

The merge has the exact owned base and official target as parents. No
cherry-picks, replayed donor commits, user-data copies, or feature-work commits
were introduced.

## Adopted behavior

- Workspace-wide file drops, improved file/path links, Markdown preservation,
  command-palette browse behavior, right-panel keybinding, and PR line requests.
- Bounded activity hydration, projected streaming tool payload persistence,
  SQLite writer waiting, receipt isolation, provider recovery, and long Git
  push handling.
- Preview zoom separation, hold-to-quit, browser mouse buttons, locale-aware
  timestamps, backend-readiness resilience, and mobile themes/accessibility
  fixes.
- SSH CLI-install diagnostics, with the existing Scient allowlist retained for
  lifecycle scripts.

## Protected-boundary resolutions

- **Identity and release:** retained Scient display name, bundle/protocol
  schemes, `scient-next` partitions and state isolation, approved release
  assets, updater policy, and disabled mobile publication. Generic launcher,
  locale, preview zoom, and DMG-layout improvements were adopted.
- **Quick Chat and forks:** retained projectless routing, project-aware PR
  opening, durable fork semantics, and Scient row mounts. The upstream shared
  change-request snapshot model was adopted.
- **Scientific media:** retained the generated-image ingestion path, rich-media
  file opening, BiDi/Math Markdown behavior, inline workspace images, and
  static MATLAB artifact mini-player support. Upstream file drops, safe raw
  HTML handling, line-break preservation, and preview anchoring coexist with
  those mounts.
- **Remote runtime:** adopted upstream failed-install diagnostics while keeping
  `--allow-scripts` restricted to Scient's approved native dependencies.

## Verification

Local non-visual verification on the exact merge candidate:

- Focused desktop, server ingestion, SSH, desktop-artifact, command-palette,
  timeline, Markdown, update, and Scient seam tests passed.
- `pnpm exec vp fmt --check`: passed across 3,347 files.
- `pnpm exec vp lint --report-unused-disable-directives`: passed with 13
  inherited warnings and no errors.
- `pnpm run typecheck`: passed across 25 workspace lanes with suggestion
  diagnostics only.
- `pnpm run build`: passed.
- `pnpm run test:desktop-smoke`: passed.
- `pnpm run release:smoke`: passed without publishing or signing.
- `pnpm run brand:check`: passed across 1,319 product-surface files.
- Quick Chat, analysis, and LaTeX seam verifiers passed.
- `git diff --check`: passed.

The complete `pnpm run test` run reached 3,249 passing tests and 11 documented
skips. Three environment-sensitive tests failed, and exact-parent rehearsals
proved they were not introduced by this merge:

- The incoming Git SSH-environment test fails identically on untouched official
  `bab4b6f02b` because its temporary log is read before it exists.
- Both installed-engine LaTeX output checks fail identically on untouched owned
  base `a19da4962d`, where compilation reports success but the test's observed
  output directory is empty.

No visual or manual GUI acceptance was performed.

## Publication boundary

This merge does not publish artifacts or enable T3 relay, cloud, hosted web,
mobile store, AUR, signing, updater, or release authority. `upstream` remains
fetch-only.
