# T3 upstream sync through 7e01d33f

Status: locally verified integration candidate. This record does not authorize
a release, enable cloud or mobile publication, or modify `release/stable`.

## Executive decisions

1. Receive the complete five-commit official T3 range as one bounded,
   history-preserving merge. Users gain Browser-panel favicons, fewer unusable
   local-server entries, quicker policy help, clearer update guidance, and a
   smaller Windows installation footprint.
2. Use T3's server-level browser-readiness probe as the generic foundation and
   retain only Scient's approved relevant-versus-other presentation. This
   removes the duplicate raw-port filtering assumption without losing the
   Scient workflow.
3. Preserve Scient's General Chat, Sources, identity, provider, PDF, and release
   seams. T3's narrower Windows packaging needed one explicit Scient adaptation:
   the existing `@napi-rs/canvas` PDF runtime remains external and unpacked.

## Authoritative gate and exact boundaries

- Owned base: `bd4bccca4424e51621325ea4f104c532a800e9e7`
- Previous literal T3 boundary:
  `5304f3e9d4c912bfa0eb2f5f41fa109b3646236b`
- Integrated T3 target: `7e01d33f0eeb9435299791392d546756cc09c5d3`
- Latest official tag observed: `v0.0.34-nightly.20260814.1090`
- Exact donor range: `5304f3e9..7e01d33f`, 5 commits
- Previously covered in this range: 0
- Newly dispositioned: 5
- Remaining undispositioned: 0
- History-preserving merge: `fb6266fc68e62aa7bb2cf36db530c59cb9f8850a`
- Integration branch: `agent/t3-sync-7e01d33f-20260814`
- Inspection time: 2026-08-14 10:50 Asia/Jerusalem / 07:50 UTC
- Donor write boundary: the `upstream` push URL remains `DISABLED`

The target was freshly fetched from official `pingdotgg/t3code:main`. The merge
commit has the exact owned base and official target as its two parents. Open
draft PR #81 was inspected before mutation; its math-rendering lane remains
independent of this synchronization.

## Complete commit ledger

| Commit     | User or operational effect                                                                                           | Quality                                                                     | Scient fit and disposition                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `59be6f78` | Shortens the desktop-managed server update banner.                                                                   | 4/5: clearer operational copy with no behavior change.                      | Adopted unchanged.                                                                              |
| `e15f655b` | Shows background policy tooltips after 200 ms.                                                                       | 4/5: small discoverability improvement.                                     | Adopted unchanged.                                                                              |
| `710fd0ee` | Captures, persists, and safely falls back Browser-panel favicons.                                                    | 5/5: cohesive desktop/web feature with validation and regressions.          | Adopted through T3's existing preview seams.                                                    |
| `9fd788b5` | Publishes only HTTP(S) servers that answer a browser-readiness probe, filtering raw TCP listeners and failed probes. | 5/5: fixes the problem at the server authority with focused tests.          | Adopted as the foundation; Scient's approved relevant/other grouping remains presentation-only. |
| `7e01d33f` | Bundles JavaScript dependencies into the Windows asar and unpacks only true native/runtime externals.                | 5/5: materially smaller, faster packages with a derived manifest and tests. | Adopted with `@napi-rs/canvas` added to the external authority for Scient PDF rendering.        |

## Friction measurement and resolutions

- T3 paths changed: 48
- Same-path overlaps with the owned branch: browser presentation, General Chat,
  server build policy, and update guidance
- Textual conflict paths: 8
- Product decisions required: 0

Conflict resolutions:

1. `apps/server/vite.config.ts`: adopted T3's centralized external-package
   authority while preserving Scient identity, cloud, and telemetry gates.
2. `ChatView.tsx`: adopted T3's memoized thread/project refs while preserving
   projectless General Chat and Scient's active new-thread target.
3. Browser discovery files: removed Scient's obsolete raw-listener assumptions,
   adopted T3's browser-ready results, and retained the approved relevant/other
   grouping plus backend exclusion.
4. `versionSkew.ts`: adopted T3's shorter generic desktop-update guidance.
5. `RightPanelTabs.test.tsx`: supplied the existing Scient Sources props to the
   new T3 regression harness; product behavior was unchanged.
6. Windows packaging: the production server bundle was inspected for dynamic
   native loading. `@napi-rs/canvas` and its platform packages are now covered
   by the same derived external/unpack authority as T3's native dependencies.

## Protected-boundary audit

- Scient identity, General Chat, Sources, PDF behavior, provider lifecycle,
  state roots, and release authority remain owned.
- T3 cloud, relay, hosted deployment, mobile publication, updater, and release
  capabilities remain subject to Scient's existing gates.
- No Scient package or workspace dependency was removed. The full workspace
  build includes the Scient Sources and PDF bundles.
- No live user data, production credential, installed app, or release branch
  was read or changed by this sync.
- `upstream` remains fetch-only with push URL `DISABLED`.

## Verification

Local non-visual verification on the exact merge candidate:

- Focused alignment regressions: 17 files and 300 tests passed; the packaging
  follow-up subset added 5 files and 80 passing tests.
- Full workspace tests: all 24 projects passed; server 2,877 tests, web 2,709,
  desktop 681, and the remaining package suites passed with documented skips.
- Full typecheck, format check, lint, brand, icon, General Chat seam, analysis
  seam, production build, server bundle, release smoke, and `git diff --check`
  passed.

The standalone local desktop-smoke helper launched Electron but did not exit
after its built-in timeout, both with the ordinary and an isolated state root.
The helper is unchanged from owned `main` and is not part of hosted CI; it was
stopped without touching the installed stable app. Hosted Windows CI remains
the authoritative runtime check for the incoming Windows packaging change.
No computer use, browser automation, screenshots, visual tests, or manual UI
acceptance were performed.

## Publication boundary

This synchronization targets owned `main` only through a draft pull request.
It does not merge that pull request, modify `release/stable`, publish artifacts,
or enable T3 relay, mobile, web, updater, signing, or release authority.
