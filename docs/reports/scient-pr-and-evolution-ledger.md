# Scient PR and evolution ledger

Status: Historical
Owner: Yaacov
Created: 2026-08-28
Last updated: 2026-08-28
Purpose: Reconciles every live Scient Desktop pull-request record with integration status, feature evolution, retirements, and exact snapshot limits.
Doc type: Research evidence

Investigation snapshot: 2026-08-28

Source of the PR inventory: GitHub repository `ScientFactory/scient-desktop`,
queried with `gh pr list --state all --limit 300` and checked against the
current checkout. In the observed #1–#187 range, the exact PR-number gaps are
#25, #80, #142, #143, #144, and #183; those numbers were not invented or
silently filled.

Post-snapshot reconciliation on 2026-08-28 found 184 live GitHub PR records
through #190. The original ledger below accounts for all 181 records through
#187; the final range table adds draft documentation PR #188, merged
upstream-alignment PR #189, and merged settings-default PR #190. Current remote
`main` is `c0baaab2cda29a84682b77b8384bb7542e59a8bd`. The original capability and
divergence reports remain exact snapshots at `aa23f1d3`; the later architecture
audit verifies that the `aa23f1d3..d5ff08e7` delta adds no new Scient-specific
capability family. The subsequent #190 delta changes defaults inside existing
capabilities rather than adding a new family.

Status vocabulary:

- **main** — merged to the original checkout's `main`, or to current remote
  `main` where the post-snapshot addendum says so;
- **main via chain** — merged into a feature branch first, but its merge
  commit is an ancestor of the current `main` history;
- **integration** — merged to a long-lived feature/integration branch and
  either included through a parent integration PR or not yet on current
  `main`;
- **open** — still open at the relevant snapshot or final reconciliation;
- **closed/replaced** — closed without being the final landed change.

The detailed behavior/files/architecture for major features is in
[Scient-specific capability catalog](./scient-specific-capabilities.md). T3
syncs and deliberate deviations are in
[T3 divergence, integration, and retirements](./scient-t3-divergence-integration-and-retirements.md).

## Quick timeline

| Period        | Evolution                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-08-06    | D4 bootstrap, managed dev app, GitHub-hosted CI, removal of Blacksmith, visible Scient identity.                                                                                                             |
| 2026-08-07–08 | First T3 refreshes; safe project setup; durable fork prototype; local voice; RTL/heading/table/arrow fixes.                                                                                                  |
| 2026-08-09–10 | Server-authoritative fork hardening; disabled analytics; guided Codex/Claude; release v0.6 machinery; Markdown/HTML preview; typography; PDF reader; General Chat.                                           |
| 2026-08-11–12 | What’s New; release hardening; fork/title/provider seams; generated PDF foundation; MATLAB foundation; Sources; docs/CI fast path.                                                                           |
| 2026-08-13–15 | Sources completion; file previews; math; analysis results; LaTeX foundation; parallel CI; PDF state; Mermaid; reliable forks; Vega-Lite; Quick Chat rename; universal file opening; Plotly; LaTeX authoring. |
| 2026-08-16–19 | LaTeX correctness and agent PDF operations; BiDi restoration; editable fork dialog; breadcrumbs; T3 refreshes; queue/steer; document viewer polish; SyncTeX.                                                 |
| 2026-08-20–23 | Provider integrations (Droid, Antigravity, Grok), HTML→PDF, repository cutover, onboarding, provider awareness, Quick Chat retirement, assisted Cursor/Droid, lifecycle integration.                         |
| 2026-08-24–25 | Provider lifecycle unification and managed runtime qualification; skills phase one; compute/rich-output integration branches; voice Turbo/correction; final reviewed T3 refresh.                             |
| 2026-08-27    | Provider-skills UI polish; built-in skill authoring; project skills; HTML/file preview freshness; current main at PR #187.                                                                                   |
| 2026-08-28    | Draft file/artifact documentation reconciliation (#188); T3 alignment through `c8aba2587d` (#189), with protected Scient seams preserved and no new Scient-specific capability family.                       |

The evolution is not a single linear feature list. It has four recurring
patterns: build a capability in a Scient-owned package, narrow its T3 seam,
add failure/limit tests, then refresh T3 while preserving only the product
boundary that remains deliberate. Some branches (compute and Overleaf) are
valuable but are not current mainline capabilities.

## Complete PR ledger

### Bootstrap, identity, and delivery: #1–#11

|                                                             PR | Status | Title                                                 | Scient contribution                                                                                        |
| -------------------------------------------------------------: | ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
|   [#1](https://github.com/ScientFactory/scient-desktop/pull/1) | main   | `chore: bootstrap Scient Next D4 candidate`           | Creates the D4 candidate from the selected T3 baseline; establishes the product fork and provenance.       |
|   [#2](https://github.com/ScientFactory/scient-desktop/pull/2) | main   | `chore: add managed Scient Next dev app`              | Adds the managed candidate dev-app launcher/state isolation.                                               |
|   [#3](https://github.com/ScientFactory/scient-desktop/pull/3) | main   | `ci: use GitHub-hosted runners`                       | Moves CI to GitHub-hosted runners.                                                                         |
|   [#4](https://github.com/ScientFactory/scient-desktop/pull/4) | main   | `ci: remove remaining Blacksmith runners`             | Removes the remaining Blacksmith dependency.                                                               |
|   [#5](https://github.com/ScientFactory/scient-desktop/pull/5) | main   | `feat: present the desktop candidate as Scient`       | Establishes visible Scient identity.                                                                       |
|   [#6](https://github.com/ScientFactory/scient-desktop/pull/6) | main   | `chore: refresh T3 foundation`                        | T3 receipt; review baseline rather than a Scient feature.                                                  |
|   [#7](https://github.com/ScientFactory/scient-desktop/pull/7) | main   | `chore: refresh T3 foundation (2026-08-07)`           | T3 receipt and provenance refresh.                                                                         |
|   [#8](https://github.com/ScientFactory/scient-desktop/pull/8) | main   | `chore: receive latest T3 foundation updates`         | T3 receipt and provenance refresh.                                                                         |
|   [#9](https://github.com/ScientFactory/scient-desktop/pull/9) | main   | `feat(projects): add safe Scient project setup`       | Safe initialization of `PROJECT.md`, `AGENTS.md`, and `.scient/project.json` with recovery/identity rules. |
| [#10](https://github.com/ScientFactory/scient-desktop/pull/10) | main   | `chore(dev): separate stable launcher from worktrees` | Prevents candidate launchers from colliding with stable app state.                                         |
| [#11](https://github.com/ScientFactory/scient-desktop/pull/11) | main   | `fix(dev): preserve stable app state root`            | Fixes the stable-state-root handoff.                                                                       |

### Forks, voice, direction, and the first product foundations: #12–#20

|  PR | Status | Title                                                           | Scient contribution                                                                       |
| --: | ------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| #12 | main   | `chore: refresh T3 foundation for conversation forks`           | T3 receipt selected to support fork work.                                                 |
| #13 | main   | `feat(fork): add durable assistant-boundary conversation forks` | Initial durable fork capability and lineage boundary.                                     |
| #14 | main   | `feat: add reliable local voice dictation`                      | Local Whisper dictation foundation.                                                       |
| #15 | main   | `feat(web): robust conversational RTL direction`                | Explicit conversation direction and structural BiDi transformation.                       |
| #16 | main   | `fix(web): keep tables and headings directionally coherent`     | RTL table/list/heading correction.                                                        |
| #17 | main   | `fix(web): keep flow arrows correct in RTL prose`               | Direction-aware flow-arrow correction.                                                    |
| #18 | main   | `chore: refresh T3 foundation through 89ee692b`                 | T3 refresh; later fork seam reconciliation.                                               |
| #19 | main   | `refactor(fork): move boundary resolution to the server`        | Removes client boundary authority; server resolves SQL projection boundaries.             |
| #20 | main   | `refactor(fork): normalize lineage persistence and migrations`  | Scient migration ledger, normalized lineage, lifecycle guards, and persistence hardening. |

### Analytics, provider setup, release, files, and PDF: #21–#49

|  PR | Status                   | Title                                                                | Scient contribution                                                                                            |
| --: | ------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| #21 | main                     | `feat(analytics): add disabled first-party runtime`                  | Adds the disabled-by-default analytics contract/runtime.                                                       |
| #22 | main                     | `refactor(analytics): move delivery off the server event loop`       | Worker/outbox delivery boundary.                                                                               |
| #23 | main via analytics chain | `feat(analytics): measure bounded product outcomes`                  | Product-event branch merged into the analytics chain; bounded outcome signals are ancestors of current `main`. |
| #24 | main via analytics chain | `feat(analytics): add privacy controls and bounded UI signals`       | Privacy controls/UI signals merged through the analytics chain; the runtime remains disabled by default.       |
| #26 | main                     | `chore: refresh T3 foundation through 1a003e38`                      | T3 receipt.                                                                                                    |
| #27 | main                     | `feat(providers): add guided Codex setup and lifecycle`              | Codex guided setup, auth observation, lifecycle actions, and runtime policy.                                   |
| #28 | main                     | `feat(providers): add guided Claude setup and lifecycle`             | Claude setup/auth/lifecycle path.                                                                              |
| #29 | main                     | `feat(release): add gated Scient v0.6 machinery`                     | Versioned, gated Scient release machinery.                                                                     |
| #30 | main                     | `feat(web): preview Markdown and HTML by default`                    | Default Markdown/HTML preview surfaces.                                                                        |
| #31 | main                     | `feat(web): use comfortable Scient typography defaults`              | Product typography tokens/defaults.                                                                            |
| #32 | main                     | `fix(server): keep PDF files in workspace index`                     | Ensures PDFs remain discoverable in the workspace index.                                                       |
| #33 | main                     | `fix(release): harden immutable publication`                         | Immutable artifact publication checks.                                                                         |
| #34 | main                     | `feat: add Scient PDF reader`                                        | Local PDF.js reader, sessions, search/outline, and native Save Copy.                                           |
| #35 | main                     | `feat(chat): add General Chat`                                       | Projectless General Chat product surface; later renamed and retired.                                           |
| #36 | main                     | `chore: refresh Scient from latest T3 main`                          | T3 receipt.                                                                                                    |
| #37 | main                     | `feat(web): add Scient What's New release notes`                     | In-app release notes model/UI.                                                                                 |
| #38 | main                     | `ci(release): allow explicitly approved unsigned Windows`            | Explicit unsigned Windows release gate.                                                                        |
| #39 | main                     | `docs(release): define v0.6.0 migration rehearsal`                   | Migration rehearsal/release documentation.                                                                     |
| #40 | main                     | `fix(release): make release workflow dispatchable`                   | Manual/dispatchable release workflow path.                                                                     |
| #41 | main                     | `fix(build): extract Windows whisper archives safely`                | Safe Windows Whisper archive extraction.                                                                       |
| #42 | main                     | `fix(build): omit bundled server workspace dependencies`             | Corrects packaged server dependency assembly.                                                                  |
| #43 | integration              | `chore(release): promote main to stable`                             | Stable branch promotion; branch target was `release/stable`.                                                   |
| #44 | main                     | `fix(release): use Bash for version alignment on all platforms`      | Cross-platform version alignment.                                                                              |
| #45 | main                     | `fix(release): expose pinned pnpm to server packaging`               | Makes the pinned package-manager runtime available to packaging.                                               |
| #46 | main                     | `fix(claude): enable subscription login by default`                  | Corrects default Claude subscription-login behavior.                                                           |
| #47 | main                     | `fix(release): install assembly dependencies`                        | Release assembly dependency installation.                                                                      |
| #48 | main                     | `fix(release): harden artifact assembly verification`                | Artifact assembly verification.                                                                                |
| #49 | main                     | `fix(titles): tighten thread-title editorial rules for scannability` | Scient title/editorial policy.                                                                                 |

### T3 refresh and product-boundary ownership: #50–#69

|  PR | Status | Title                                                        | Scient contribution                                                     |
| --: | ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| #50 | main   | `chore: refresh Scient from T3 through v0.0.33 prep`         | T3 receipt and conflict review.                                         |
| #51 | main   | `refactor(upstream): prepare Scient for T3 PR center merge`  | Prepares provenance/PR-center reconciliation.                           |
| #52 | main   | `ci(release): publish accepted candidate without rebuilding` | Release immutability/reproducibility path.                              |
| #53 | main   | `Merge T3 upstream through f5fce741`                         | T3 refresh; retains Scient provider/identity/project boundaries.        |
| #54 | main   | `Sync T3 upstream through 65b005f1`                          | T3 refresh; preserves Scient interaction changes.                       |
| #55 | main   | `chore(upstream): sync T3 through ac4780f4`                  | T3 refresh; conflict review.                                            |
| #56 | main   | `chore(upstream): sync T3 through 2db08457f`                 | T3 refresh; theme/provider/sidebar review.                              |
| #57 | main   | `feat: own General Chat product boundary`                    | Makes the projectless product boundary explicit; later retired by #146. |
| #58 | main   | `fix(codex): stabilize runtime selection and sign-in`        | Codex effective runtime/auth proof and recovery.                        |
| #59 | main   | `fix(web): preserve theme alpha in hex picker`               | Fixes theme alpha preservation.                                         |
| #60 | main   | `Fix voice composer transcript routing`                      | Routes voice result to the correct composer/thread.                     |
| #61 | main   | `chore(release): add v0.6.1 notes`                           | Release note entry.                                                     |
| #62 | main   | `fix(release): normalize artifact digest format`             | Digest normalization.                                                   |
| #63 | main   | `docs(scient): add PDF export implementation plan`           | Browser/PDF export architecture plan.                                   |
| #64 | main   | `fix(web): prevent writes from truncated Markdown previews`  | Prevents destructive writes from incomplete previews.                   |
| #65 | main   | `ci: add docs-only fast path`                                | Fast path for docs-only validation.                                     |
| #66 | main   | `docs: explain CI fast path`                                 | Documents the fast path.                                                |
| #67 | main   | `ci: make docs formatter standalone`                         | Standalone docs formatting lane.                                        |
| #68 | main   | `Add generated PDF artifact foundation`                      | Generated-document/artifact binding and publication foundation.         |
| #69 | main   | `chore(upstream): sync T3 through 849bac89`                  | T3 refresh.                                                             |

### Analysis, Sources, previews, math, and LaTeX: #70–#98

|  PR | Status                | Title                                                                            | Scient contribution                                                                                             |
| --: | --------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| #70 | main                  | `feat(analysis): run saved MATLAB files on a reusable execution foundation`      | MATLAB adapter and reusable analysis/execution foundation.                                                      |
| #71 | main                  | `feat(sources): add project-owned reference library`                             | Canonical local source records, PDFs, metadata, and UI.                                                         |
| #72 | main                  | `docs(release): add Scient 0.6.2 notes`                                          | Release note entry.                                                                                             |
| #73 | main                  | `ci(release): prepare nightly stable candidates`                                 | Nightly/stable release candidate lane.                                                                          |
| #74 | main                  | `Open file previews without the explorer by default`                             | File-first preview behavior.                                                                                    |
| #75 | main                  | `feat(sources): complete reference intake and agent awareness`                   | Zotero intake, enrichment, agent source awareness.                                                              |
| #76 | main                  | `Prevent restored non-PDF file tabs from crashing Scient`                        | Restored-file-tab safety.                                                                                       |
| #77 | main                  | `chore(upstream): sync T3 through 5015d7cf`                                      | T3 refresh.                                                                                                     |
| #78 | main                  | `docs(release): add Scient 0.6.3 notes`                                          | Release note entry.                                                                                             |
| #79 | main via MATLAB chain | `Complete the MATLAB run, history, and figure workflow`                          | Merged through the MATLAB foundation branch; current `main` contains the completed run/history/figure workflow. |
| #81 | main                  | `feat(web): render TeX math in chat markdown`                                    | Local KaTeX/remark math pipeline and guarded dollar tokenizer.                                                  |
| #82 | main                  | `feat(sources): harden library workflows and notes`                              | Source corrections, notes, concurrency, duplicate/removal hardening.                                            |
| #83 | main                  | `chore(upstream): align T3 through 97db94c9`                                     | T3 refresh.                                                                                                     |
| #84 | main                  | `fix(web): keep browser suggestions relevant`                                    | Browser suggestion relevance.                                                                                   |
| #85 | main                  | `fix(web): open project folders on the first Enter`                              | Project-opening interaction fix.                                                                                |
| #86 | main                  | `docs(release): add approved v0.6.4 notes`                                       | Release note entry.                                                                                             |
| #87 | main                  | `Save reproducible analysis results to projects`                                 | Promotes analysis results to project-owned portable artifacts.                                                  |
| #88 | main                  | `chore(upstream): sync T3 through 5304f3e9`                                      | T3 refresh.                                                                                                     |
| #89 | main                  | `feat: compile, preview, and edit LaTeX side by side with a one-click toolchain` | Local LaTeX build/editor/PDF workflow and toolchain setup.                                                      |
| #90 | main                  | `chore: align T3 through 7e01d33f`                                               | T3 refresh; browser/local-server/PDF asset review.                                                              |
| #91 | main                  | `ci: run test suites in parallel lanes`                                          | Parallel test lanes.                                                                                            |
| #92 | main                  | `server: isolate Scient RPC tests and make provider refresh race-free`           | Server test isolation and provider refresh concurrency fix.                                                     |
| #93 | main                  | `ci: parallelize and harden CI lanes`                                            | CI reliability.                                                                                                 |
| #94 | main                  | `fix: preserve PDF reader state across remounts`                                 | PDF reader session/remount preservation.                                                                        |
| #95 | main                  | `test(grok): bound completion-drain cancellation waits`                          | Cancellation-drain bound for Grok.                                                                              |
| #96 | main                  | `fix(web): open project action previews reliably`                                | Project action preview reliability.                                                                             |
| #97 | main                  | `fix(ci): isolate stateful server test shards`                                   | Stateful server test-shard isolation.                                                                           |
| #98 | main                  | `feat(web): render rich Mermaid diagrams in chat`                                | Local lazy Mermaid cards/export/accessibility.                                                                  |

### Rich chat, files, Plotly, LaTeX completion: #99–#119

|   PR | Status          | Title                                                                                 | Scient contribution                                                               |
| ---: | --------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
|  #99 | main            | `feat: make conversation forks reliable and continuous`                               | Restart-safe fork saga, visible-thread readiness, provider bootstrap, continuity. |
| #100 | main            | `fix: open workspace files without persisted chats`                                   | File opening independent of persisted chats.                                      |
| #101 | main            | `Fix project opening navigation races`                                                | Navigation race hardening.                                                        |
| #102 | main            | `feat: render interactive Vega-Lite charts in chat`                                   | Local lazy Vega-Lite chart cards and interactions.                                |
| #103 | main            | `Rename General Chat to Quick Chat throughout Scient`                                 | Renames the projectless surface before its later retirement.                      |
| #104 | main            | `merge: align T3 through 8c628f14`                                                    | T3 refresh.                                                                       |
| #105 | main            | `fix(chat): make rich media reliable and copyable`                                    | Unified rich-fence registry, source-preserving copy, reliability/export fixes.    |
| #106 | main            | `feat(files): open local files from chat inside Scient`                               | Universal file-opening classifier/surfaces.                                       |
| #107 | main            | `docs: add Scientific Artifact Studio roadmap`                                        | Future artifact architecture and representation boundary.                         |
| #108 | main            | `merge: align T3 through 6ae9662d8e`                                                  | T3 refresh.                                                                       |
| #109 | main            | `feat(web): add CSP-safe interactive Plotly charts`                                   | Local Plotly strict runtime, typed arrays, WebGL lifecycle, export.               |
| #110 | closed/replaced | `docs(release): add LaTeX workflow note`                                              | Closed; superseded by #111/#112.                                                  |
| #111 | main            | `docs(release): add LaTeX workflow note`                                              | Final LaTeX release note.                                                         |
| #112 | main            | `docs(release): keep v0.6.4 notes within highlight limit`                             | Release-note bound correction.                                                    |
| #113 | main            | `feat(latex): complete local authoring workflow`                                      | Build evidence, managed TinyTeX, diagnostics, freshness, authoring completion.    |
| #114 | main            | `feat(sources): let agents add and attach project PDFs`                               | Agent source-PDF addition/attachment operations.                                  |
| #115 | main            | `chore: align official T3 through bab4b6f02b`                                         | T3 refresh; rich chat/source/PDF conflict review.                                 |
| #116 | main            | `fix: restore Scient BiDi, issue routing, and Quick Chat workspace after the T3 sync` | Restores protected Scient seams after upstream merge.                             |
| #117 | main            | `fix(web): thicken thin RTL flow arrows without boxing every glyph`                   | RTL arrow visual correction.                                                      |
| #118 | main            | `Add an editable single-card fork confirmation`                                       | Editable fork title/confirmation card.                                            |
| #119 | main            | `feat: add clickable file breadcrumbs and full-path copying`                          | File breadcrumbs and path copying.                                                |

### Queue, SyncTeX, providers, onboarding, and retirement: #120–#152

|   PR | Status | Title                                                                 | Scient contribution                                                                                                                        |
| ---: | ------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| #120 | main   | `Sync official T3 through c7e6d711d3`                                 | T3 refresh; tooltip/PR/browser/context seams.                                                                                              |
| #121 | open   | `feat(overleaf): add manual bidirectional sync`                       | Open integration proposal; private Git mirror, explicit push/pull/reconciliation, no polling. Not current main.                            |
| #122 | main   | `Sync official T3 through f2d5fc91e3`                                 | T3 refresh; lifecycle/release/provider conflict review.                                                                                    |
| #123 | main   | `feat(thread-queue): Scient message queue + steer`                    | Durable per-thread queue, steer shortcut, reorder/edit/delete/auto-pump.                                                                   |
| #124 | main   | `fix(sidebar): keep the Scient wordmark inside the narrowest sidebar` | Sidebar identity/layout fix.                                                                                                               |
| #125 | main   | `Sync official T3 through beab6886f4`                                 | T3 refresh; queue/voice/provider/PDF/fork review.                                                                                          |
| #126 | main   | `fix(web): refine resizable document viewers`                         | Viewer resizing/layout behavior.                                                                                                           |
| #127 | main   | `Sync official T3 through be7d35aaeb`                                 | T3 refresh; CI parallelization and file/preview conflict review.                                                                           |
| #128 | main   | `feat(latex): ship verified SyncTeX navigation runtime`               | Pinned, receipt-verified SyncTeX helper and exact-revision navigation.                                                                     |
| #129 | open   | `feat(compute): add stateful scientific computing`                    | Open long-lived compute integration; language-neutral sessions, Python/Jupyter, figure following, Results, isolated run. Not current main. |
| #130 | main   | `feat(providers): add Factory Droid integration`                      | Droid ACP/device setup.                                                                                                                    |
| #131 | main   | `docs(release): add v0.6.5 What's New entry`                          | Release note entry.                                                                                                                        |
| #132 | main   | `Merge official T3 through dedcd99a9d`                                | T3 refresh.                                                                                                                                |
| #133 | main   | `feat(provider): add managed Antigravity integration`                 | Antigravity managed/integration path.                                                                                                      |
| #134 | main   | `feat: add high-fidelity browser HTML to PDF export`                  | Live-browser HTML-to-PDF export.                                                                                                           |
| #135 | main   | `chore(scient): complete desktop repository cutover`                  | Completes visible repository/product cutover.                                                                                              |
| #136 | main   | `feat(web): add compact onboarding flow`                              | Compact skippable getting-started flow.                                                                                                    |
| #137 | main   | `feat(provider): add capability-aware Scient context`                 | Provider capability discovery and truthful system/context delivery.                                                                        |
| #138 | main   | `feat(provider): add assisted Grok connection`                        | Grok assisted connection.                                                                                                                  |
| #139 | main   | `docs(release): align v0.6.6 notes with current main`                 | Release note alignment.                                                                                                                    |
| #140 | main   | `fix(ci): always report protected checks`                             | Protected-check reporting.                                                                                                                 |
| #141 | main   | `chore: align with T3 through b1670ac7d9`                             | T3 refresh.                                                                                                                                |
| #145 | main   | `docs(release): improve v0.6.6 overview copy`                         | Release-note copy correction.                                                                                                              |
| #146 | main   | `Retire Quick Chats and projectless threads`                          | Removes Quick Chat UI/contracts/tests and migrates/quarantines projectless lineage.                                                        |
| #147 | main   | `feat(provider): add assisted Droid connection`                       | Droid assisted setup.                                                                                                                      |
| #148 | main   | `feat(providers): add assisted Cursor connection`                     | Cursor assisted login/setup.                                                                                                               |
| #149 | main   | `docs(release): include assisted Cursor setup`                        | Release documentation.                                                                                                                     |
| #150 | main   | `Provider lifecycle unification integration`                          | Parent integration landing the long-lived provider lifecycle branch into main; controlled checkpoints and provenance guard.                |
| #151 | main   | `fix(codex): install complete managed runtime package`                | Codex managed runtime package completeness.                                                                                                |
| #152 | main   | `chore: align with T3 through e6a109b9f7`                             | T3 refresh.                                                                                                                                |

### Provider lifecycle, skills, currentness, and latest main: #153–#187

|   PR | Status                         | Title                                                         | Scient contribution                                                                                         |
| ---: | ------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| #153 | integration via #150           | `PR 1A: characterize managed provider lifecycle`              | Lifecycle characterization and managed-runtime state.                                                       |
| #154 | integration via #150           | `PR 1B: scope provider lifecycle manager shutdown`            | Shutdown scoping.                                                                                           |
| #155 | integration via #150           | `PR 2: share provider connection primitives`                  | Shared provider connection primitives.                                                                      |
| #156 | main                           | `feat(voice): add managed local model choices`                | Small/Medium managed model choice and verification.                                                         |
| #157 | integration via #150           | `refactor(provider-lifecycle): unify assisted frontend setup` | Common assisted setup model.                                                                                |
| #158 | integration via compute branch | `feat(compute): add durable rich-output foundation`           | Representation bundles, display facts, bounded Jupyter retention, hashes/resource checks; not current main. |
| #159 | main                           | `feat(forks): continue conversations with another provider`   | Explicit provider-switching continuation for durable forks.                                                 |
| #160 | main                           | `feat(voice): add multilingual turbo model`                   | Adds/qualifies the local Turbo voice model.                                                                 |
| #161 | main                           | `feat: add Scient skills phase one`                           | Reviewed built-ins, trust/digest/session/provider delivery core.                                            |
| #162 | integration via #150           | `feat(providers): unify assisted setup presentation`          | Shared assisted provider presentation.                                                                      |
| #163 | integration via #150           | `feat(providers): unify Settings lifecycle actions`           | Shared Settings lifecycle actions.                                                                          |
| #164 | main                           | `feat(voice): add language-aware transcript correction`       | Provider-aware language correction after local transcription.                                               |
| #165 | main                           | `chore: align with T3 through 99960383d0`                     | T3 refresh.                                                                                                 |
| #166 | integration via #150           | `Phase 4: qualify managed runtime and enablement handoffs`    | Managed runtime/enablement handoff qualification.                                                           |
| #167 | integration via #150           | `Unify Antigravity provider management`                       | Antigravity lifecycle unification.                                                                          |
| #168 | main                           | `test(web): stabilize session activity benchmark`             | Benchmark stability.                                                                                        |
| #169 | main                           | `chore: align with T3 through 1a4a7596c2`                     | T3 refresh.                                                                                                 |
| #170 | integration via #150           | `docs(providers): establish lifecycle documentation`          | Lifecycle documentation.                                                                                    |
| #171 | integration via #150           | `fix(providers): harden lifecycle verification`               | Verification hardening.                                                                                     |
| #172 | main                           | `test(web): make session activity coverage deterministic`     | Deterministic activity tests.                                                                               |
| #173 | main                           | `docs(release): add v0.6.7 What's New`                        | Release note entry.                                                                                         |
| #174 | integration via #150           | `fix(provider): recover revoked Claude authentication`        | Claude revoked-auth recovery.                                                                               |
| #175 | integration via #150           | `fix(cursor): harden assisted login startup`                  | Cursor assisted-login startup safety.                                                                       |
| #176 | integration via #150           | `fix(providers): clarify pending lifecycle checks`            | Truthful pending lifecycle state.                                                                           |
| #177 | integration via #150           | `Refresh reviewed Droid and Antigravity runtimes`             | Reviewed runtime refresh.                                                                                   |
| #178 | integration via #150           | `Update Scient-managed Claude to 2.1.245`                     | Managed Claude runtime update.                                                                              |
| #179 | open                           | `docs(provider): propose safe managed runtime updates`        | Documentation-only proposal; no runtime/manifest/workflow/UI behavior.                                      |
| #180 | main                           | `fix(cursor): harden external runtime lifecycle`              | Cursor external-runtime redaction/lifecycle safety.                                                         |
| #181 | main                           | `chore: align with T3 through 082e6ea521`                     | Prior reviewed T3 refresh; superseded as the current integration tip by #189.                               |
| #182 | main                           | `style(web): halve provider skills scrollbar thickness`       | Small provider-skills UI polish.                                                                            |
| #184 | main                           | `Add built-in Scient Skill Authoring`                         | Adds the automatic built-in skill-authoring capability.                                                     |
| #185 | main                           | `feat(skills): add project-scoped skills`                     | Adds project `.scient/skills` discovery/lock/trust/activation.                                              |
| #186 | main                           | `feat(files): keep previews current`                          | File preview freshness and explicit reload controls.                                                        |
| #187 | main                           | `feat(pdf): keep HTML exports current`                        | HTML export source watcher/revision freshness and Update behavior.                                          |

### Documentation alignment, current upstream, and settings defaults: #188–#190

|   PR | Status     | Title                                                  | Scient contribution                                                                                                                                                                                                                                                                                   |
| ---: | ---------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #188 | open/draft | `docs: align file and artifact implementation records` | Reconciles file viewing, LaTeX, PDF export, analysis, and Artifact Studio documentation against current/open implementation. Head `33cfee24`; still behind current main and not authority.                                                                                                            |
| #189 | main       | `chore(upstream): align with T3 through c8aba2587d`    | Receives the exact T3 range, updates `UPSTREAM.md`, `upstream-state.json`, one dated integration receipt, affected help/internal docs, and protected seams; no new Scient capability.                                                                                                                 |
| #190 | main       | `feat(settings): improve provider and agent defaults`  | Opens provider settings on Models when available, initially reveals authenticated provider email without changing the shared sensitive-text default, and enables agent Browser plus project Sources access by default with explicit opt-out. Seven settings/contract files; no new capability family. |

## Integration overview

### Bootstrap and upstream ancestry

The selected official T3 donor is recorded in `UPSTREAM.md` and
`upstream-state.json`. The verified baseline is T3
`a2ca89aa10f13a2222e08afd98c66285121d5ba2`
(`v0.0.32-nightly.20260806.1012`). Scient keeps ordinary T3 history in the
graph and adds its own commits. The bootstrap merge is
`3e8f7bc0e18be4a42c23b021e68bf30e3690bc4d`.

The current reviewed T3 integration point is
`c8aba2587d56edbf3b7872987719a12b42031f48`; PR #189 is the corresponding
mainline refresh at `d5ff08e7`. PR #181 and its `082e6ea521` checkpoint remain
the prior historical tip recorded by the original snapshot. `UPSTREAM.md`
records each refresh, conflict rationale, and protected seam. The integration
policy is not “take any upstream commit”: it preserves the T3 ancestry, reviews
divergent behavior, and keeps Scient’s identity/provider/PDF/project/thread
policies explicit.

### Long-lived feature integrations

#### Provider lifecycle — landed through #150

PRs #153–#155, #157, and #162–#178 were deliberately built against
`feat/provider-lifecycle-unification` so a cross-provider state machine could
be characterized, tested, and integrated as a controlled unit. PR #150 is the
mainline integration parent. Individual child PRs therefore have
`baseRefName != main`, but their accepted work is part of the landed provider
lifecycle program. PR #179 is a follow-up proposal only and remains open.

#### MATLAB/compute — split between current main and integration-only work

PR #70/#79/#87 landed the bounded MATLAB runtime, run/history/figure workflow,
and reproducible-result promotion on main. PR #129 is an open
long-lived compute integration branch; #158 was merged into that compute branch
with durable rich-output foundations. Their own bodies explicitly say not to
merge directly to main until integration gates are satisfied. This distinction
is why the capability catalog labels the language-neutral stateful compute and
Jupyter surfaces “integration-only.”

#### Overleaf — open, not current mainline

PR #121 is an open manual bidirectional-sync proposal. It uses a private Git
mirror under server state, explicit preflight/reconciliation/push/pull, saved
host accounts, conflict repair/disconnect, askpass safety, and no automatic
polling. It is not part of the current shipped product and is not counted as a
current capability.

#### Analytics — disabled and bounded

PRs #21–#24 split the analytics runtime, background delivery, outcome signals,
and privacy controls across branches. The resulting code is present but
disabled by default. Presence of the runtime is not evidence that telemetry is
enabled for a user.

### The feature-to-PR relationship

The headline features are cumulative rather than isolated:

- fork #13 became server-authoritative in #19–#20 and restart-safe in #99;
- General Chat #35/#57 became Quick Chat in #103 and was retired in #146;
- voice #14 gained routing, safe packaging, model choice, Turbo, and language
  correction in #41, #60, #156, #160, and #164;
- sources #71 expanded through #75, #82, and #114;
- LaTeX #89 expanded through #113 and #128;
- rich chat #81/#98/#102/#109 was unified/reliabilized by #105;
- file/PDF behavior #30/#32/#34/#64/#74/#94/#100/#106/#119/#126 was extended
  through #134 and freshness #186–#187;
- provider setup #27/#28/#130/#133/#138/#147/#148 was consolidated by #150
  and received presentation/access-default refinements in #190;
- skills #161 was extended by built-in authoring #184 and project skills #185.

This is the evolution to preserve when reviewing future upstream merges: a
later PR may look small because it changes only a seam, but the protected
behavior was built over the preceding chain.

## PR review conclusion

All 184 live PR records through #190 were accounted for as of the final
2026-08-28 query, including upstream-refresh, release/docs, test/CI, mainline
feature, integration-branch, open, and closed/replaced PRs. The six absent
numbers remain #25, #80, #142, #143, #144, and #183. The next report reconciles
these records with exact T3 divergence and the things Scient intentionally
removed or deferred.
