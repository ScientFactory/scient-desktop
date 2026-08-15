# T3 upstream sync through 6ae9662d8e

Status: locally verified integration candidate. This record does not authorize
a release, enable cloud or mobile publication, or modify `release/stable`.

## Decision

Receive the complete remaining official T3 range after the previous
integration base. This adopts T3's dark-mode selected-theme restore without
changing a Scient-owned product seam.

The official tip is one commit past nightly
`v0.0.34-nightly.20260815.1098`. There is no newer stable tag than `v0.0.33`.

## Exact boundaries

- Owned base: `2e4c5ee4c61cd321e27968cec985b5efce1a2497`
- Previous literal T3 boundary:
  `8c628f14993cb159d467e7a0f8c52578dde77005`
- Integrated T3 target: `6ae9662d8ed215476e697adc12403ce035500828`
- Latest official tag observed: `v0.0.34-nightly.20260815.1098`
  (the integrated tip is `1098-1-g6ae9662d8e`)
- Exact donor range: `8c628f14..6ae9662d8e`, one commit
- Previously covered in this range: 0
- Newly dispositioned: 1
- Remaining undispositioned: 0
- History-preserving merge: `e06b78ac25e77ee10612b274bf9c07ad7a4b2148`
- Integration branch: `agent/t3-sync-6ae9662d8e-20260815`
- Isolated worktree:
  `/Users/yaacov/REPOs/ScientFactory-worktrees/scient-desktop-next-t3-sync-6ae9662d8e-20260815`
- Inspection time: 2026-08-15 11:05 Asia/Jerusalem / 08:05 UTC
- Donor write boundary: the `upstream` push URL remains `DISABLED`

The merge commit parents are the exact owned `origin/main` head and the exact
official T3 tip. Open draft PR #89 was inventoried before mutation and remains
untouched. Earlier T3-sync worktrees through `5304f3e9`, `7e01d33f`, and
`8c628f14` were treated as historical evidence only; this alignment used a
fresh worktree from current `origin/main`.

## Complete commit ledger

| Commit     | User or operational effect                                                                                             | Scient disposition                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `6ae9662d` | Restores selected appearance themes in dark mode after the global stylesheet cleanup lowered theme-bridge specificity. | Adopted unchanged. The selector is now `html[data-theme-id], html.dark[data-theme-id]`. No Scient-owned overlap. |

## Friction measurement and resolutions

The merge produced zero textual conflicts. Git auto-merged
`apps/web/src/index.css` with the `ort` strategy.

A clean merge is not proof of product correctness. The resulting stylesheet
was inspected:

- T3's dark-mode selector is present at the theme-token bridge.
- Scient's typography profile import remains the second line of `index.css`.
- Scient stage artwork, wordmark, and theme-id stage palettes remain.
- No file under `apps/web/src/scient`, `packages/scient-*`,
  `apps/server/src/scient`, or the owned release/voice seams changed.
- No T3 branding, AUR workflow, updater, or publication authority entered
  this range.

## Protected-boundary audit

- Scient identity, Quick Chat, Sources, PDF/document foundations, math,
  Mermaid, Vega-Lite, RTL, local voice, provider lifecycle, analysis/MATLAB
  mounts, sidebar/right-panel Scient mounts, `scient-next` state isolation,
  and release/signing/updater authority remain owned.
- T3 cloud, relay, hosted deployment, AUR, mobile publication, updater, and
  release capabilities remain subject to Scient's existing gates. This range
  did not touch those files.
- No live user data, production credential, installed stable app, or
  `release/stable` was changed.
- `upstream` remains fetch-only with push URL `DISABLED`.

## Unwanted donor behavior

None in this range. The previous sync's AUR neutralization and publication
gates remain in force.

## Verification

Local non-visual verification on the exact merge candidate:

- Focused and complete web unit suite: 343 files / 3,024 tests passed
- Full `pnpm test`: all workspace lanes passed; server 281 files / 2,940
  tests passed with 2 skipped files and 9 documented skips
- `pnpm exec vp fmt --check`: 3,216 files passed
- `pnpm exec vp lint --report-unused-disable-directives`: passed with
  inherited warnings only
- `pnpm run typecheck`: passed across 25 workspace lanes with inherited
  suggestion diagnostics only
- `pnpm run build`: passed
- `pnpm run release:smoke`: passed
- `pnpm run test:desktop-smoke`: passed
- `pnpm run brand:check`: 1,266 product-surface files passed
- `pnpm run icons:check`: 25 generated icon assets current
- Upstream provenance, Quick Chat seams, and analysis seams passed
- `git diff --check`: passed

No computer use, browser automation, screenshots, visual tests, or manual UI
acceptance were performed. A short visual checklist is included for the
reviewer: select a non-default theme, toggle dark mode, and confirm canvas,
chrome, and sidebar colors follow the theme rather than the neutral dark
defaults.

## Publication boundary

This record does not modify `release/stable`, publish artifacts, or enable T3
relay, cloud, mobile, web, AUR, signing, updater, or release authority.
