# T3 upstream alignment — 2026-10-13

## Exact boundaries and qualification status

This is an interim review receipt. The history-preserving integration, prior
complete local aggregate and automated mobile native qualification exist.
Yaacov accepted the desktop candidate and explicitly deferred mobile visual
review. Final owned-main catch-up and qualification of that composition remain
pending. `upstream-state.json` and the current `UPSTREAM.md` pointer remain at
the previous qualified official boundary. User-authorized MERGE delivery still
requires the final gates; release remains separate.

- Original owned base: `43779ee83b358cb929e32cafa1a3e53f7eb147cd`.
- Previous official integration: `f23d0084b6e023ffb1af9e332d8666affc99d542`.
- Frozen official target: `b03534fa7b847e8403322e416189c6293e6846e0`.
- Literal upstream merge: `3846a7fd443e0fc53d8ba520e7a82748cffcc67d`, tree
  `db3c91dfbbe444bdac4962409e27c0b91d1b6855`. Its exact parents are the original
  owned base and frozen official target. All 99 ordinary donor commits remain
  ancestors; no replay, squash, cherry-picking, or selective donor omission.
- Inventory: 779 incoming paths with renames disabled, 131 same-path overlaps,
  42 initially unmerged paths and 90 marker regions. Clean overlaps and untouched
  Scient consumers were included in the semantic review.
- Branch: `codex/t3-sync-b03534fa7b-20261013`; upstream push URL: `DISABLED`.
- The preceding alignment PR #530 actually landed as owned main
  `deaa13dab54724a198a81cbbdd424f52e8c60e48`. Subsequent catch-up merge
  `95159279b6be37efd7ccf9375242e93a6866bb63` retains that exact main as second
  parent. It preserves the original upstream merge and includes the landed
  project-initialization guide correction. No unlanded implementation lane was
  imported. Public main was reverified at this exact commit during app review.
- Runtime candidate: `e27a7107ca34c6fde564e754a1dd15ff2cc321cc`, tree
  `a01c8016c9e126929f150b0806894a1ff6f38328`. Its change from aggregate-tested
  `3fd6f9b513dab6cec3f1c9378c9f71b59469cd63` affects one browser-only test file;
  production, aggregate-unit, build and desktop-smoke inputs are identical.

## Integrated behavior and narrow Scient owners

The complete official range includes native mobile pull-request browsing and
reviews, Enriched Markdown, MCP app sandbox composition, Claude 5.1 assistant
updates, Muse 1.4.6 native subagents, settings and provider configuration,
reader/selection controls, server cleanup, telemetry authentication, dependency
updates and faster type checking. Scient's product identity, compatibility
storage and migration identities, enabled-provider policy, native authority,
publication holds and privacy decisions remain owned.

Settings retain upstream's single credential visitor and persistence loop.
Scient's usage-accounting source and immutable key policy use the existing
feature helper. Actual filesystem witnesses cover replacement/deletion and
rollback. A narrow credential availability owner refuses unresolved saved
secrets and schema-declared redaction placeholders before native construction.
It does not reject ordinary nonempty credentials with redaction metadata or
turn empty non-secret settings into errors. Reconciliation still applies
authoritative disable/removal and retires existing scopes. A controlled
production-composed watched-settings → hydration → registry → native-construction
witness failed before repair and passed afterward; locator checks alone were
not used as behavior proof.

One identity-derived Scient renderer-origin list composes CORS and upstream
cookie authentication. Scient schemes remain accepted and T3 schemes refused.
The tested development-cookie exports accept the declared origin and refuse
undeclared default and sibling origins before local or upstream delivery.
Same-app-cookie negative cases distinguish origin refusal from bad credentials;
canonical renderers, same-origin requests and configured allowed origins retain
their separate existing policy. Signed assets
retain immutable identity, bounded inline MCP HTML, Range, download and CSP
behavior. Owned HTTP assertions accidentally omitted during initial composition
were restored before the source merge and independently reviewed.

Restart continuation remains disabled by default and limited to three calls
when enabled. Settled/snoozed threads, outstanding requests, unavailable secrets,
provider terminal outcomes, and existing queue holds remain blockers. Explicit
Resume and captured attempts retain their existing authority. Claude 5.1 text
conversion uses the current item and message without replacing Scient's workflow,
member, usage, EOF, Stop, or replacement owners.

The desktop bulk-update host calls existing Scient policy owners: providers,
servers, then local install last, with fresh capability/identity/version checks
and the existing ready notice. It does not introduce another update engine or
change publication authority. Scientific reader/save/close ownership remains
separate from generic host mechanics.

Mobile adopts Enriched while retaining Scient's full/partial copy, UTF-16 ranges,
occurrence identity, Windows/entity behavior, context actions, screenshot
dependencies and Skills. Its projection moves to the existing
`ScientMarkdownProjection` owner; generic `markdownDocument` shrinks from 430 to
162 lines without asynchronous no-op work or a value cycle. The original pinned
archive is unchanged. Only an unshipped Robolectric test SDK annotation changes
36 → 35, supported by the pinned Robolectric 4.14.1; shipped migration bodies,
identities, ledgers and loaders remain byte-identical to owned main.

Four declared host files add 758 lines relative to the frozen official target,
versus 1,171 at the original owned base. This measure includes generic upstream
composition and is not wholly attributable to extraction. The separately pinned
`43779ee83b` → `3846a7fd44` advisory inventory interval reduces scoped debt
findings 138 → 96; it is neither
a new ratchet nor behavior or speed proof. Scient comments/registry ownership
were maintained at the touched seams, without a blanket marker rewrite.

Publication guard coverage includes the actual new settings helper and affected
provider consumers. Existing missing-qualification refusals remain strict. A
tarball test now parses the exact generated patch metadata rather than assuming
the old filename. Activation, signing, cloud, relay, updater and mobile-publication
controls remain held. Package names, state paths, licenses and opaque protocol
values remain compatibility boundaries.

## Qualification and repair evidence

One root owner coordinates heavy checks. Commands use Node 24.19.0, pnpm 11.10.0,
the committed lockfile, isolated synthetic HOME and a fresh short private TMPDIR
per command, scrubbed
credentials and client URL overrides. Browser executable caches are shared;
browser profiles and app data are not. Exact revision/diff hashes, commands,
timestamps, exits, logs and failed/cancelled attempts are retained outside the
product repository.

| Check                                          | Observed result and scope                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| External Phase 1 affected-consumer bundle      | 45 files / 990 cases, 217.083 s; production-composed consumers, not just changed test files. PR #521 tooling remains external; no sibling ancestry import.                                                   |
| Complete `pnpm run test`, aggregate05          | Exit 0, 2,206.897 s at clean `3fd6f9`; 47 workspace tasks, zero task cache hits.                                                                                                                             |
| Server aggregate                               | 930 files passed / 40 skipped; 11,789 cases passed / 129 skipped. Three further not-run cases are nested under the existing disabled Scient Agent/OMP live suite. This does not qualify every real provider. |
| Web aggregate unit                             | 970 files / 11,965 cases passed.                                                                                                                                                                             |
| Complete Chromium browser gate                 | 50 files / 400 cases passed, 59.174 s at clean `e27a7107`, with this worktree's prior browser cache retained externally and a fresh cache used.                                                              |
| Formatting, lint, workspace types, unused code | Complete gates passed; 49 type-check tasks. Subsequent fixture changes passed affected types/format/lint.                                                                                                    |
| Build / desktop smoke                          | Exit 0, 37.550 / 8.786 s at production-identical `3fd6f9`.                                                                                                                                                   |
| Brand, provenance and all five seams           | Passed on the exact composed candidate. Seam classification is not behavior proof.                                                                                                                           |
| Electron SVG / Mermaid / PDF pagination        | Real Electron checks passed, 6.552 / 3.732 / 1.865 s.                                                                                                                                                        |
| Native fork stress / V2 wire                   | Seven files / 27 cases passed, including enabled scale cases, 74.378 s; wire checks passed, 6.149 s.                                                                                                         |
| Python bridge / actual kernel                  | 128 stdlib tests run, two skipped, 2.623 s; private Python 3.12 real-kernel four files / 14 cases passed, 45.274 s.                                                                                          |
| Sealed managed Python product                  | Two real live cases passed, 750.367 s at clean `e27a7107`: all toolkit combinations, actual scientific work, updates, retained kernels and corruption rejection. No recipe seal was changed.                 |
| Rust resource monitor                          | 17 tests passed, 6.638 s; all three Rust formatting checks passed.                                                                                                                                           |
| Release smoke / frozen dependencies            | Passed, 30.136 / 1.388 s. These checks do not authorize publication.                                                                                                                                         |

The full aggregate was not started while source was still being composed. Earlier
aggregate attempts remain recorded: mobile fixtures (52.154 s), publication
fixtures (55.323 s), Markdown editor fixtures (112.738 s), and a 445.821-second
cancelled attempt after an explicit OTLP origin-fixture failure. Only proven
owned executor processes were interrupted; unrelated apps remained running.

Seven Markdown editor interaction promises moved faithfully from happy-dom to
native Chromium after actual CodeMirror selection reentrancy prevented that
environment from exercising them. Native pointer/edit/keyboard, undo, source and
rich context menus, reopening identity, failed editor creation in write/read
modes and same-slot retry remain covered.
No editor runtime, selection shim, timeout or assertion was weakened.

Browser qualification also exposed a citation fixture race: normal autosave can
legitimately make the selected source saved rather than draft. The fixture now
holds and acknowledges its actual write intent, checks draft origin while the
write is pending, then saved origin after completion with the same native editor.
Historical Playwright route-collection/transport failures remain unexplained.
Bounded external instrumentation did not reproduce that error, and logging can
perturb timing. Both an unchanged uninstrumented complete run and the final cold
complete run passed; this is not a claim of a permanent framework fix.

## App review and remaining gates

The reviewed candidate ran in an isolated macOS Electron app with a distinct
bundle ID, ports and fresh synthetic profile. The authenticated native
`scient-next-dev://app/` window, actual bundled backend and listener ancestry
were verified. Scient is first in onboarding; a fresh managed Scient Agent 0.1.0
installs under the candidate's own state. No real account or credential was
copied. Native Markdown math, Hebrew/Arabic text, tables, local images, Mermaid
and Vega-Lite were inspected. Actual source edits survive save, Reload without
Cmd-S, and a return to rendered mode; byte comparisons preserve all original
source bytes. The ordinary Tectonic path compiled a two-page LaTeX fixture; native
page navigation and page two at 60% zoom survived renderer reload in the PDF
layout. Yaacov subsequently accepted the desktop alignment and requested its
shutdown. The owning service, captured processes and ports were verified stopped;
stable and unrelated apps, candidate state and worktrees were preserved.

A controlled loopback model exercised the actual Scient Agent process and native
app. Stop closed a streaming connection and retained queued work; explicit Resume
started a new request. The initial small-context fixture triggered native
post-turn compaction and explicitly nonterminal signals. After changing only the
synthetic model context window, two actual prompt results reported completed and
session-settled, with terminal/yield flags true; the queue drained and the UI
returned idle. The bounded bridge/adapter owners are byte-identical to owned
main. No terminal authority was overridden. The low-context native edge remains
recorded; this is neither authenticated model-quality nor universal provider
qualification. The title fixture's required JSON response was repaired outside
product code.

Automated mobile qualification used the normal managed device tooling, an owned
iOS 26.5 simulator, Xcode/SDK 27.0 with Swift 6.4, Java 21 and the Android SDK.
The iOS app build initially failed because compiler version alone enabled
SDK 27.1 UIKit hinge APIs. A pod-target SDK condition now composes with both
existing compiler guards; runtime availability, hinge capability and metrics
bodies remain unchanged. Podspec metadata probes cover SDK 26.5/27.0 excluded
and 27.1/28.0 enabled. The actual SDK 27.0 app build/install passed in 275.424 s;
a newer-SDK build is not claimed. Regenerate Pods after changing selected Xcode.

The existing native clipboard test specification now declares its required C++
runtime. Its HTML fixture reads through UIKit's typed data API and asserts both
payload and decoded HTML are present before retaining the context-exclusion
assertion. Production pasteboard code and the original pinned archive are
unchanged. Exact patch identities remain pinned in the lockfile and build-script
allowlist; no allowlist widening. Four actual Objective-C XCTest cases passed,
zero skips, in a 70.887-second build/test command, corroborated by the result
bundle. Six production Kotlin clipboard cases passed, zero skips, on the pinned
Robolectric Android 35 runtime in a 79.455-second command. The arm64 development
APK built in 398.722 s. These are separate measured commands, not cold-suite
speedup or physical Android gesture proof. The owned iOS simulator was shut down;
Android was not booted. Mobile visual/gesture review is explicitly deferred by
Yaacov; device profiles and existing apps remain preserved.

Earlier unavailable-tool, failed build/link/reader and disk-full Android attempts
remain retained. The failed native reader run completed all four cases before
its idle finalizer was interrupted through the exact owned executor. Only task-
owned completed generated outputs/download caches were removed for disk space;
source, receipts/results, shared caches, SDKs and profiles were preserved.

Local KDE tests compile but five pass and six fail because `dbus-daemon` is absent
on this macOS host; Hyprland tests were not run. These native crate inputs are
byte-identical to owned main. Completed Linux CI at that exact main qualifies
those unchanged Linux inputs only; it does not establish candidate CI or macOS
D-Bus support.

Final review must compose actually landed owned main, qualify and review that
exact composition, and record final hosted PR-head and merge-group checks.
Desktop acceptance applies to the reviewed runtime; assess later deltas before
reusing it. Mobile visual review remains explicitly deferred. Queue admission,
actual MERGE delivery, public-main ancestry and release are separate milestones.
No cursor advance or alignment merge has occurred; the requested development
app shutdown is complete. No broader qualification-policy change was adopted.

## Alignment improvement evidence

Early production-composed checks gave useful feedback in about 3m37s and exposed
a genuine credential composition defect with a before/after witness. Narrow
owners reduced overlap without replacing product decisions. Neither result
establishes a 5× end-to-end improvement or an under-ten-minute cold full suite.
The successful aggregate still takes 36m47s, and managed Python adds a separately
measured 12m30s. Server file intervals sum to 1,611.428 s within a 2,098.530-second
server wall clock; residual time is not attributed by summing file durations.

The next improvements should remain small and measured: maintain the existing
affected-consumer mapping, move faithful native interaction checks to supported
environments, refresh completed CI weights, attribute collection/import/setup and
teardown costs, and pilot isolated extra CI shards without weakening serial
integration ownership. A small receipt/resumption runner is a separate proposal.
Exact-candidate CI replacing complete local qualification remains unadopted.

Detailed local evidence is retained under the workspace review directory
`reviews/alignment-owner-handoff-20261012/next-alignment-execution-20261013`:
`frozen-plan.json`, `source-merge.json`, independent family reviews,
`phase1-composed-bundle-summary.json`, `final-full-tests-05.json`,
`final-layout-cold-10.json`, `final-managed-python-product-01.json`,
`native-document-save-reload.json` and `native-stop-queue-before-resume.json`.
These references preserve limits without copying transcripts or provider history
into the product repository.

Mobile completion and current delivery evidence is retained in
`reviews/pr-merge-readiness-20261013`: `mobile-sdk-correction-review.json`,
`mobile-ios-native-ensure-02.json`, `mobile-ios-clipboard-04.json`,
`mobile-ios-clipboard-04-xcresult-summary.json`,
`mobile-android-clipboard-02-xml-summary.json`,
`mobile-android-app-build-artifact.json` and `alignment-app-stop.json`.
The existing native settlement review owns the fixture diagnosis and its limits.
