# T3 upstream alignment — 2026-10-13

## Exact boundaries and qualification status

The history-preserving integration and final owned-main composition have passed
complete local qualification. Yaacov accepted the desktop candidate, authorized
MERGE delivery and explicitly deferred mobile visual review. The later Stop/queue
composition and the later history/native-helper catch-up passed proportional
native desktop interaction checks, most recently at
`72b423e95628b27cddab2e00ec15b3bd87bd5943`. The integration pointer identifies the
qualified frozen target. Exact final pushed-head CI, merge-group checks and actual
delivery remain separate requirements; release remains separate authorization.

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
- Landed Stop and queue owners from main
  `fded53330972f86c5f58fab1b1dddb63dae7c6c2` are retained by catch-up merge
  `1aedc78a13d32e169737d50ca652cc24de5dc24c`, with parents
  `89d11035e1bc47cfc6d52da9f6b3e8cdac3b4ba1` and that exact main. Independent
  server and web reviews found no source blockers. Eighteen of the 21 clean
  delta paths match landed-main blobs; the three composed web/documentation
  hosts were reviewed against both parents. Stop observes only ordinary local
  preparation before native admission. The owned acknowledgement composes the
  original authorized interrupt command with captured thread/run/attempt
  guards; queue retirement consumes only server user IDs. These source reviews
  were followed by the final composed behavioral qualification below.
- Landed early checks from owned main
  `f75556fcea6ce591fe526e0d25feb65a42125d2b` are retained by catch-up merge
  `d676e210aa58c33b7d65c32e9855c3078c20bd10`, with parents
  `f03b89a35221f857e39850e30a6a5cb8e862ad6c` and that exact main, tree
  `42e08f8d32f88e1ab89649a457aca3328b81e18d`. Seven of its eight delta paths
  match reviewed PR #521 and landed-main blobs; the package script alias
  preserves all incoming fields and `tsc-rs` 0.4.0. Independent review accepted
  the actual native-input witness, 49-suite mapping, selector and ownership
  entries. There is no product-runtime, dependency or test-setup body delta
  from `f03b89a3`. No unlanded sibling ancestry was imported.
- Earlier desktop acceptance candidate: `e27a7107ca34c6fde564e754a1dd15ff2cc321cc`, tree
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
the committed lockfile, isolated synthetic HOME and short private TMPDIR, scrubbed
credentials and client URL overrides. Browser executable caches are shared;
browser profiles and app data are not. Exact revision/diff hashes, commands,
timestamps, exits, logs and failed/cancelled attempts are retained outside the
product repository.

Final qualification at clean `d676e210aa58c33b7d65c32e9855c3078c20bd10`:

| Check                                             | Result and exact scope                                                                                                                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete `pnpm run test`                          | Exit 0, 3,169.269 s, 47 workspace tasks, zero task cache hits; before/after committed and working inputs identical.                                                                                                                                 |
| Server aggregate                                  | 932 files / 11,799 cases passed; 40 files / 129 cases skipped, plus three nested not-run cases in the existing disabled live suite. These exclusions do not qualify every real provider.                                                            |
| Web aggregate unit                                | 972 files / 11,978 cases passed.                                                                                                                                                                                                                    |
| Stronger native Pi input witness                  | Five actual native/RPC cases passed in 14.711 s, including complete Scient instructions and scoped capability input; authenticated model quality and managed/custom driver resolution remain outside this harness.                                  |
| Selector                                          | Eleven cases passed in 1.486 s.                                                                                                                                                                                                                     |
| Formatting / lint / workspace types / unused code | Passed in 1.299 / 6.999 / 20.461 / 45.599 s.                                                                                                                                                                                                        |
| Build / desktop smoke                             | Passed in 50.207 / 8.599 s.                                                                                                                                                                                                                         |
| Brand / provenance / all five seams / diff        | Passed in 0.865 / 0.447 / 4.185 / 0.066 s; seam classification is not behavior proof.                                                                                                                                                               |
| Mapped consumer bundle                            | 49 files / 1,010 cases, zero skips, 297.792 s at `f03b89a3`; the target-owned older native four-case body was then replaced by the stronger five-case witness above.                                                                                |
| Complete Chromium browser gate                    | 50 files / 401 cases passed in 105.229 s at `f03b89a3`; all browser/product runtime inputs unchanged by the later eight-path test/tool/maintainer-documentation catch-up.                                                                           |
| Native desktop final composition                  | Actual isolated Electron/backend at `d676e210`: visible Stopping status, physical streaming cancellation, retained queued input, explicit Resume, fresh completed responses and retired live queue controls. Exact ownership and shutdown verified. |

The final aggregate reuses its own synthetic prerequisite cache: the actual
Tectonic 0.17.0 command fetched public resources and generated a PDF in 105.383 s
before the run. No live cache or credentials were copied; the existing 25-second
real-engine test limits remain intact. Explicit offline frozen installation
reused three packages, downloaded none and left tracked inputs unchanged. Two
initial dependency preflights failed before tests; the test environment now uses
the installed public store and refuses automatic installation when verification
fails. These failed attempts remain recorded.

Browser startup initially encountered an unrelated listener on default port 63315. An external wrapper imports the original configuration and changes only
root/project API ports; suites, provider, setup, assertions and timeouts remain
unchanged. A subsequent Playwright route-collection transport failure is retained;
one unchanged complete retry passed. Neither this retry nor earlier passes prove
a permanent framework repair. Unrelated listeners were preserved.

The following table records earlier range-specific evidence. It is not a second
claim of final-candidate qualification; unaffected native/platform inputs remain
identical after the reviewed main catch-ups.

| Check                                          | Observed result and scope                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Earlier external Phase 1 consumer bundle       | 45 files / 990 cases, 217.083 s; production-composed consumers, not just changed test files. PR #521 tooling was external at that revision; it subsequently landed through owned main as recorded above.     |
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

The final native check reused only the candidate's synthetic profile and exact
owned lifecycle. Its native window, distinct bundle identity, bundled backend,
listener process ancestry and source head were verified. A real Scient Agent
stream was stopped while a follow-up remained held; explicit Resume produced two
fresh completed loopback responses and retired the live queue region. A second
physical Stop captured the visible `Stopping…` status followed by Resume. The
retry action intentionally remains available. These UI witnesses supplement
the exact-attempt/replacement/descendant suites; those guarantees are not inferred
from markup. The observed prior GPT-6-Luna selection was restored without a
real-provider request. The service, runner, Electron/backend processes and all
candidate ports were verified absent after shutdown. Profiles and apps remain
preserved; no installed or unrelated app was targeted.

Local qualification is complete. Final hosted PR-head and merge-group checks
must still qualify the exact delivered revision. A later landed-main delta must
be reviewed and its affected evidence refreshed before delivery. Yaacov's earlier
desktop acceptance is supplemented by this proportional native composition
review; renewed user visual acceptance is not claimed. Mobile visual review
remains explicitly deferred. Queue admission, actual MERGE delivery, public-main
ancestry and release are separate milestones. The integration cursor advances
to the qualified upstream target; actual alignment delivery remains pending.
No broader qualification-policy change was adopted.

## Alignment improvement evidence

Early production-composed checks gave useful feedback in about 3m37s and exposed
a genuine credential composition defect with a before/after witness. Narrow
owners reduced overlap without replacing product decisions. Neither result
establishes a 5× end-to-end improvement or an under-ten-minute cold full suite.
The earlier successful aggregate took 36m47s; the final composed run took 52m49s,
including a 2,999.54-second server step. Managed Python has a separate earlier
12m30s measurement. Different inputs and conditions prevent a causal slowdown
claim from those totals. Earlier server file intervals sum to 1,611.428 s within
a 2,098.530-second server wall clock; residual time is not attributed by summing
file durations. No full-suite or end-to-end speedup has been demonstrated.

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
Final composed evidence in the same directory:
`alignment-phase1-owned-main-commit.json`,
`pr534-final-qualification-composed-summary.json`,
`pr534-composed-d676-full-tests-01.json`,
`pr534-final-browser-05.json`, `pr534-final-tex-prerequisite-01.json`,
`pr534-native-final-composition-review.json` and
`pr534-native-final-stop.json`. Per-command receipts retain inputs, times, exits
and logs without importing transcript or provider history.

## Later owned-main catch-up to `6aeba59ce205`

Owned main subsequently advanced to
`6aeba59ce205a1fcf1ec560fad07c33d090b7184` (#537, #539 and #551),
removing #534 from the merge queue because its branch conflicted. This pass
merges that exact landed commit into the existing alignment; the official
target remains `b03534fa7b847e8403322e416189c6293e6846e0` and the
literal official merge `3846a7fd443e0fc53d8ba520e7a82748cffcc67d` is preserved.
It does not adopt the later upstream tip.

The two textual regions in `MessagesTimeline.tsx` retain the upstream
prompt-link icon while using Scient's extracted trace-icon owner, and remove
the redundant raw position writer in favor of `useSaveReadingPosition`.
That writer retains geometry, disclosures, message/run identity and ongoing
follow, and guards paint-only views, restoration and pending placement.
Clean overlaps in chat, markdown, reader restoration and storage require
semantic review as well. The removed legacy reducer has no live callers; the
three removed fork checkpoint cases retain their deciding fixtures and
assertions in the feature-owned replacement suite. The new conversation
package export adds no dependency version change; the lockfile is unchanged
from the previously qualified candidate.

The affected local matrix subsequently passed on receiving commit
`8301dd95794b85ae5d6e08ce7733882acaed643d`: 979 web unit files/11,999 cases,
148 client files/2,376 cases, 13 conversation files/109 cases, and 106 shared
files/1,782 cases (one existing shared file/case skipped). All 50 browser
files/406 cases passed in 179.008 s with files run serially. Two parallel
attempts stopped in Vitest/Playwright mock-route callbacks and remain recorded;
no assertion, timeout, or server concurrency was weakened, and a permanent
parallel-runner repair is not claimed. Formatting, lint, all typechecks, unused
code, build, desktop smoke, branding, provenance and five seams passed.
Unaffected server/mobile results were reused only after an exact source,
configuration, dependency and consumer audit under the existing subsequent-change
rule. No new full aggregate or cold-suite speedup at `8301dd9` is claimed.

The native app at that exact commit closed the real loopback stream on Stop,
held the queued prompt, and completed the continuation and queued request only
after explicit Resume. The reader/PDF stayed present and the queue/composer
settled. Startup events were verified in the owned desktop trace; an initial
helper timeout from checking only the console log is preserved. The owning
app and model server were stopped with processes, ports and service absence
verified. No renewed user visual acceptance or real-account/model-quality
qualification is claimed. Independent source review found no composition
regression; inherited source-spelling test guards remain separate policy debt.

Evidence: `reviews/pr-merge-readiness-20261013/` contains
`pr534-main-6aeba-source-composition.json`, `pr534-main-6aeba-index-seams.json`
and the independent receiving-tree review. Failed attempts and actual timing
receipts remain preserved. Mobile visual review remains explicitly deferred;
release is not authorized.

## Later owned-main catch-up to `f8cda428aca3`

Owned main then landed #552's retained-history references and #495's native
file-exchange packaging at `f8cda428aca3a0d2b36a658d2a306bfd13a77c9d`.
The existing alignment carries that exact landed commit through an ordinary
owned-main merge, preserving the original official target and literal merge.
Both new source families received independent review on staged tree
`658fed30c3a97824aabc23ec676c914f79b3b7b8`. No production composition regression
was demonstrated. Two inherited test defects were repaired: the queued
provider-switch case again proves delivery of all three earlier Codex answers,
and native-helper staging tests execute only a universal or host-compatible
binary while still inspecting every slice. The full provider-switch file passed
65 cases in 78.040 s with both restored assertions.

Receiving merge `72b423e95628b27cddab2e00ec15b3bd87bd5943` has exact parents
`8301dd95794b85ae5d6e08ce7733882acaed643d` and that landed main, and tree
`5c7b58bea59dd0d12a186557d0549f08c1b082ab`. Shared contracts, persistence and
desktop resources invalidated the earlier server reuse audit. A complete new
local `pnpm run test` passed on clean, unchanged inputs in 2,483.902 s: server
936 files/11,835 cases, web unit 979 files/11,999 cases, desktop 283 files/2,530
cases and all other applicable workspace suites. Existing skips remain,
including 40 server files/129 cases and disabled nested suites. This is a
successful candidate run, not a measured cold-suite or end-to-end speedup.

Formatting, lint, all typechecks, unused-code checks, build, desktop smoke,
branding, provenance and all five seams passed. The maintained early selector
ran affected consumers and actual native Pi witnesses in 215.929 s; six added
history/source API suites passed 85 cases in 7.918 s. All 50 browser files/406
cases passed locally in 169.213 s with serial files and unchanged assertions
and timeouts. The credential-free local Git rehearsal passed real push,
stale-push refusal, rename and fresh-read checks. Its lost acknowledgement is
explicitly simulated; Cloud review metadata and actual network loss remain
unverified.

Exact-head hosted CI run `38451391866` passed on its second attempt. The first
attempt retained one keyboard-popover assertion failure and two macOS ARM
runner-allocation cancellations before any steps ran. Only failed jobs and
their dependents were retried. A passing unchanged-head layout retry does not
prove a permanent repair of that intermittent failure; its independent triage
and original result remain preserved.

The exact native app used fresh bundled server code and only its own synthetic
profile and loopback model. Stop closed the physical stream, showed the stopping
acknowledgement and held the queue. Explicit Resume completed both continuation
and queued request; the scientific source and two-page PDF remained present,
and live queue, Stop/Resume and composer settled. The owned ARM helper passed
the shipped resource-layout validator and physically swapped synthetic files,
preserving displaced bytes. That resource container is not a signed desktop
release artifact. The app and fixture server were stopped; all five captured
PIDs, four listeners and the exact service were verified absent. This review
does not invent renewed user visual acceptance or real-account/model-quality
qualification. Mobile visual review remains explicitly deferred.

Evidence under `reviews/pr-merge-readiness-20261013`:
`pr534-72b-final-qualification-summary.json`, `pr534-f8-independent-source-reviews.json`,
`pr534-composed-72b-*`, `pr534-native-72b-*`, `pr534-native-resource-72b.json`
and `pr534-72b-ci-retry-success.json`. Final metadata-only updates reuse this
runtime evidence after inspecting their exact diff; final pushed-head CI,
merge-group checks and actual delivery remain separate. No new official target,
release, qualification-policy substitution, live-profile access or OOM incident
repair is performed.

## Later owned-main catch-up to `ff9bdf8512d4`

Main subsequently landed Muse lifecycle work and portable NUL-schema patterns
at `ff9bdf8512d43915b424279ddb260edfa5444221`. The existing alignment retains
that exact main through an ordinary merge; the official target remains frozen.
Independent server and client reviews accepted source composition at raw tree
`da746b88d38e8af672f5b09268e5d44aabbc764d`. All seven clean overlaps preserve
both inputs. The Muse account/generation concerns recorded by reviewers are
unchanged from landed main, not demonstrated alignment regressions; they remain
separate follow-ups, without a claim that every Muse flow is qualified.

Qualification of this later composition is pending. The complete `72b423e9`
gate remains evidence only for unchanged inputs; fresh shared-lifecycle,
provider, schema/document and affected-client checks are required before the
receipt/cursor can identify this main as qualified. The early full typecheck
passed in 19.744 s. Evidence: `reviews/pr-merge-readiness-20261013/pr534-ff9-*`.
No unrelated feature fix, test weakening, publication or profile access is
part of this catch-up. The isolated app remains verified stopped.

## Later owned-main catch-up to `ad35cc25320e`

Main then landed its fork reliability/separation batch at
`ad35cc25320e9e326a63fbf781c9ec9af23aef6e`. This ordinary owned-main merge
preserves the original official merge and frozen target. At receiving tree
`861119ba9c65e0b15000f9346e87396014cec1b6`, all 26 changed code/test blobs
match landed main; only the divergence document combines both parents.
Independent server and web reviews found no composition-caused regression.
Snapshot contracts, capture transactions, outbox effects and retirement helpers
retain narrow Scient owners; the host keeps the execution and transaction
boundaries. Main's saved-history fallback never adopts the source run.
Replaced refusal assertions now check acknowledged text, saved prompts, frozen
SQL reopen results, source continuation, and receipt/outbox ownership.

The full shared/app typecheck passed on unchanged staged inputs in 24.635 s.
Further affected qualification is pending, including native fork/lifecycle
witnesses, execution/session/event consumers, packages, clients and browser
coverage. The cancelled prior-head browser run has no success receipt; its
partial log and cancellation remain preserved. Earlier completed checks are
evidence only for inputs they actually qualify. The notice is an options
snapshot retained on retry, without a claim that every later workspace-loss UI
race has a deciding fixture. No cursor advance, new official target, independent
feature fix, gate waiver, live-profile use or publication is performed here.
Evidence: `reviews/pr-merge-readiness-20261013/pr534-ad35-*`.
