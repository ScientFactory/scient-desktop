# T3 upstream sync through 2db08457f

Status: locally verified integration candidate. This record does not authorize
a release or modify `release/stable`.

## Exact boundaries

- Owned repository: `ScientFactory/scient-desktop-next`
- Owned base: `2dd015aa27326d31ebc3102c9ca56792000c06de`
- Previous literal T3 boundary:
  `ac4780f451f98c10d5b518f2bfa3d035b46645df`
- Official T3 target: `2db08457f2f4eaaa713a067b2ea480ca2b583025`
- Latest official tag in ancestry: `v0.0.34-nightly.20260811.1068`
- Exact donor range: `ac4780f4..2db08457f`, nine commits
- History-preserving merge: `b29ac7d1af203831954877aa4ca9e73248873977`
- Follow-up formatting commit: `e83800822cc808113ca14be532c90456ffef2f1c`
- Integration branch: `agent/t3-sync-2db08457f-20260811`
- Donor write boundary: the `upstream` push URL remains `DISABLED`

The target was freshly fetched from official `pingdotgg/t3code:main`. Every
received commit is official T3 `main` ancestry; no open pull-request head was
imported by this range.

## Commit dispositions

| Commit      | Effect                                                  | Disposition                                                                                                                              |
| ----------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `b30a9bc41` | Theme-aware environment stage artwork                   | Adapt: keep Scient's minimal composition and brand watermark while consuming upstream's theme-owned stage colors and focus-ring offsets. |
| `6befe42eb` | Normalize bare Windows drive roots                      | Adopt.                                                                                                                                   |
| `220e573b1` | Detect Azure DevOps SSH remotes (`ssh.dev.azure.com`)   | Adopt.                                                                                                                                   |
| `44621c345` | PR and Usage sidebar footer Back buttons                | Adopt; preserve Scient release-notes and brand mounts in the same footer/header.                                                         |
| `1e355a2a3` | Render dropdowns above toasts                           | Adopt.                                                                                                                                   |
| `57b105267` | Thread error-banner dismiss survives reconnect/rerender | Adopt.                                                                                                                                   |
| `35172010b` | Clearer pull action icon                                | Adopt.                                                                                                                                   |
| `083fa4ab2` | OKLCH theme palettes and theme pipeline updates         | Adopt; preserve Scient typography profile import and Scient stage CSS while taking OKLCH/theme-id stage token overrides.                 |
| `2db08457f` | Upload icon for disabled push action                    | Adopt.                                                                                                                                   |

## Friction measurement and resolutions

Untouched history-preserving merge baseline before resolution:

- T3 paths changed: 32
- Same-path overlaps with Scient since the prior T3 boundary: 12
- Content conflicts: 5
- Upstream paths with no Scient overlap: 20

Conflict resolutions:

1. `SidebarStageBackdrop.tsx` / test: retained Scient stage art (`data-scient-stage`,
   Scient watermark) while mapping T3's reviewed Dev/Nightly palette contract
   into the Scient composition. Both sidebar triggers consume upstream's
   palette-specific focus-ring offsets without adopting T3 SVG scenes.
2. `AppSidebarLayout.tsx` and `SidebarChrome.tsx`: retained Scient
   `sidebar-stage-trigger` / `SidebarBrand` styling. Adopted T3 PR/Usage Back
   buttons that merged cleanly in the footer.
3. `ThemeEditorPanel.tsx`: adopted upstream removal of the sidebar-artwork
   editor toggle (artwork remains theme-definition owned). Scient stage art
   continues to render through the existing stage component seam.
4. `index.css`: kept Scient typography import and stage presentation while
   wiring it to upstream's per-theme-id OKLCH tokens, so future palette
   refreshes flow through the stable Scient presentation seam.

No General Chat, voice, provider-lifecycle, release-workflow, or identity
files required conflict resolution in this range.

## Protected-boundary audit

- Scient identity / `scient-next` state roots / desktop schemes unchanged.
- Mobile production workflow remains fail-closed (`if: ${{ false }}`,
  `workflow_dispatch` only).
- `upstream` push URL remains `DISABLED`.
- Brand check passed across 1,127 product-surface files.
- No release, cutover, cloud, or `release/stable` movement.

## Verification

Local verification on the exact merge parents completed:

- frozen-lockfile installation
- 105 focused theme/stage/shared/path/source-control/composer/error-banner tests
- 48 focused stage/theme correction tests
- `pnpm --filter @t3tools/web typecheck`
- `pnpm --filter @t3tools/web build`
- `pnpm exec vp fmt --check`
- `pnpm exec vp lint --report-unused-disable-directives`
- `pnpm run typecheck` (suggestions only; no errors)
- `pnpm brand:check`
- `git diff --check`

Hosted CI, full monorepo test/build, and manual UI acceptance remain PR gates
and are not represented as complete by this record.

## Publication boundary

This synchronization targets owned `main` only through a draft pull request.
It does not modify or merge `release/stable`, publish desktop/mobile artifacts,
enable T3 relay deployment, or change Scient release authority.
