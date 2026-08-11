# T3 upstream sync through ac4780f4

Status: locally verified integration candidate. This record does not authorize
a release or modify `release/stable`.

## Exact boundaries

- Owned repository: `ScientFactory/scient-desktop-next`
- Owned base: `87774953d713d68fe0622fdf6be936f36bb4511c`
- Previous literal T3 boundary:
  `65b005f1e4bfccb6a404b3b1e5bfa363d534ac2a`
- Official T3 target: `ac4780f451f98c10d5b518f2bfa3d035b46645df`
- Latest official tag in ancestry: `v0.0.34-nightly.20260811.1067`
- Exact donor range: `65b005f1..ac4780f4`, four commits
- History-preserving merge: `f2c2b4159a33449b367bf9ed2ccc2138d5e555b7`
- Integration branch: `agent/t3-sync-ac4780f4-20260811`
- Donor write boundary: the `upstream` push URL remains `DISABLED`

The target was freshly fetched from official `pingdotgg/t3code:main`. Every
received commit is official T3 `main` ancestry; no open pull-request head was
imported by this range.

## User-facing advancements

1. `6676f9c83` / T3 PR #5986 stabilizes the mobile thread composer, live-feed
   following, pending-user-input layout, thread settings, and related
   interactions.
2. `c842c6f5b` / T3 PR #6170 adds an hourly past-24-hour usage view across the
   server, contracts, shared aggregation, web, and mobile surfaces.
3. `3da7f9c5c` / T3 PR #6177 guards mobile App Store release versions and adds
   the corresponding workflow support. Scient retains its fail-closed
   job-level publication guard, so this inherited workflow logic has no
   operational publication authority.
4. `ac4780f45` / T3 PR #6172 makes typography restore actions reset both font
   family and font size to their persisted defaults.

## Friction measurement and resolutions

The untouched history-preserving merge was run before resolving anything:

- T3 paths changed: 58
- Same-path overlaps with Scient since the prior T3 boundary: 7
- Overlapping paths merged automatically: 4
- Text-conflict files: 3
- Upstream paths with no Scient overlap: 51

The General Chat mobile overlap in `NewTaskDraftScreen.tsx` merged
automatically. The three conflicts were established Scient policy seams rather
than General Chat feature edits:

- `.github/workflows/mobile-eas-production.yml`: adopted the complete current
  upstream workflow while preserving Scient's job-level `if: false` publication
  guard.
- `pnpm-workspace.yaml` and `pnpm-lock.yaml`: adopted T3's LegendList 3.3.5
  patch while retaining Scient's newer `@ff-labs/fff-node` 0.10.3 dependency
  and patch.

The upstream typography test initially used `18` as a changed interface size,
but 18 is the contract default. The integration corrects the test input to 19;
the upstream product implementation is otherwise unchanged.

This result supports the prior friction reduction: no General Chat resolution
was required, and every conflict maps to an explicit protected repository or
release-policy boundary.

## Verification

Before publication, the exact merge completed:

- 99 focused mobile, usage, shared, and typography tests
- full monorepo typecheck
- repository formatting
- repository lint, with one pre-existing unused-disable warning in
  `ThemeEditorPanel.tsx`
- release smoke
- Scient brand check across 1,127 product-surface files
- frozen-lockfile installation and supply-chain policy validation
- `git diff --check`

The full test/build/desktop/mobile gate and hosted CI remain PR gates and are
not represented as complete by this record.

## Publication boundary

This synchronization targets owned `main` only. It does not modify or merge
`release/stable`, publish desktop/mobile artifacts, enable T3 relay deployment,
or change Scient release authority.
