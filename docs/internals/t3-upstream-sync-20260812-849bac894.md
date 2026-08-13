# T3 upstream sync through 849bac894

Status: locally verified integration candidate. This record does not authorize
a release or modify `release/stable`.

## Exact boundaries

- Owned repository: `ScientFactory/scient-desktop-next`
- Owned base: `6c6434233cbbdb9ed46e7168ed484abbf6c6a772`
- Previous literal T3 boundary:
  `2db08457f2f4eaaa713a067b2ea480ca2b583025`
- Official T3 target: `849bac8946c40420174b4187e36fcf17b5ea7cc4`
- Official tag at the target: `v0.0.34-nightly.20260812.1076`
- Exact donor range: `2db08457f..849bac894`, 11 commits
- History-preserving merge: `52834482d1cdbd4b543e9d4322ae4751f1c15b43`
- Integration branch: `agent/t3-sync-849bac89-20260812`
- Donor write boundary: the `upstream` push URL remains `DISABLED`

The target was freshly fetched from official `pingdotgg/t3code:main`. Every
received commit is official T3 `main` ancestry; no open pull-request head was
imported. Official T3 advanced afterward to `b73232bdd31e83914a8a943960c7dc4b6390b39b`;
that newer work is not part of this bounded update.

## Commit dispositions

| Commit      | Effect                                                     | Disposition                                                                                               |
| ----------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `f0b57ca23` | Open VSX community theme search and theme collections      | Adopt.                                                                                                    |
| `c196f422e` | Coordinated composer resize animation                      | Adopt.                                                                                                    |
| `52e5a75a8` | Compact sidebar footer actions                             | Adopt; existing Scient release-notes, provider-update, identity, and updater seams merge around it.       |
| `560d4a456` | Keep the desktop wordmark visible at minimum sidebar width | Adapt only the existing identity CSS: take the upstream visibility rule while rendering the Scient brand. |
| `d37a9b09b` | Mobile thread-title regeneration                           | Adopt.                                                                                                    |
| `63e6faef6` | Add a contributor to T3's repository trust list            | Retain ancestry but override the effect; Scient's trust list remains unchanged.                           |
| `5a8461480` | Align the composer model picker                            | Adopt the two upstream layout classes inside the existing Scient composer.                                |
| `e1378a1f4` | Keep Android ordered lists inside user-message bubbles     | Adopt.                                                                                                    |
| `b54bfc931` | Keyboard-accessible right-panel surface launcher           | Adopt.                                                                                                    |
| `6fd088af9` | Align the hosted mobile onboarding header                  | Adopt without enabling Scient cloud.                                                                      |
| `849bac894` | Preserve CLI OAuth parameters through browser sign-in      | Adopt; Scient's existing fail-closed cloud gate remains intact.                                           |

## Friction measurement and resolutions

Untouched history-preserving merge baseline before resolution:

- T3 paths changed: 46
- Same-path overlaps with Scient since the prior T3 boundary: 18
- Automatically merged overlapping paths: 15
- Content conflicts: three files, one region each
- Upstream paths with no Scient overlap: 28

Conflict resolutions were deliberately narrow:

1. `ChatComposer.tsx`: retained Scient voice, provider-lifecycle, fork, and
   General Chat behavior while applying T3's exact model-picker spacing.
2. `index.css`: adopted T3's minimum-width wordmark visibility while retaining
   Scient identity, typography, and stage styling at their existing seam.
3. `thread-sidebar.md`: retained General Chat guidance and added mobile title-
   regeneration guidance with Scient product wording.

The automatically merged Open VSX, OAuth, compact-footer, right-panel, mobile,
and onboarding implementations were not wrapped, forked, or refactored.
`.github/VOUCHED.td` remains byte-identical to the Scient parent because T3's
repository trust decisions do not confer trust in ScientFactory.

## Protected-boundary audit

- Scient identity, `scient-next` state roots, and desktop protocols are unchanged.
- The merged OAuth implementation retains `SCIENT_NEXT_CLOUD_ENABLED` as a
  fail-closed precondition; this update does not activate cloud or relay use.
- Scient's release workflow is byte-identical to the owned parent.
- Scient's contributor trust list is byte-identical to the owned parent.
- `upstream` remains fetch-only with push URL `DISABLED`.
- No release, cutover, publication, or `release/stable` movement occurred.

## Verification

Local verification on the exact merge tree completed with Node `v24.19.0` and
pnpm `11.10.0`:

- frozen-lockfile installation
- 206 focused Open VSX/theme, composer/voice, General Chat, right-panel,
  updater, mobile, and OAuth/cloud tests
- `pnpm exec vp fmt --check`
- `pnpm exec vp lint --report-unused-disable-directives`
- `pnpm run typecheck` (suggestions only; no errors)
- `pnpm run test` (all 18 tasks; 2,633 passing server tests and seven expected skips)
- `pnpm run build`
- `pnpm run test:desktop-smoke`
- `pnpm run release:smoke`
- `pnpm run brand:check`
- `pnpm run icons:check`
- `pnpm run lint:mobile` (native Swift/Kotlin linters unavailable locally and skipped)
- `git diff --check`

Hosted CI and manual UI acceptance remain PR gates and are not represented as
complete by this record.

## Recovery and publication boundary

This synchronization targets owned `main` only through a draft pull request.
Before any later release, recovery is a normal owned-history revert of the
integration PR followed by the same verification gate. This work does not
modify `release/stable`, publish desktop or mobile artifacts, enable T3 relay
deployment, or change Scient release authority.
