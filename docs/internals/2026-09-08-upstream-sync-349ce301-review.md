# Upstream sync review through `eb115063`

Status: the reviewed `349ce301` implementation has a local history-preserving checkpoint.
The additional 22 commits through `eb115063` are composed in the same candidate. Automated
review of the extension and the owner-approved native question-attachment fork fix is complete.
The final combined automated gate passed; the candidate is ready for manual acceptance.
Manual acceptance, PR, CI, and publication remain separate gates.

## Frozen boundary

- Original Scient base: `4d4d53d80595de0f0da2308ce9b25259e094d0c8`
- Refreshed Scient main: `507b8f1f80ca6eb24cdeabb46f849a949cf0b2b4` (PR #264),
  merged without conflict as `e75f483f05`; canonical local main fast-forwarded to the same main.
- Previous upstream receipt: `223ff4490f764a74ff911589e97b9bbcd595fee8`
- Original upstream target: `349ce3014233352e073a5fc1b3f12bd786160913`
- Original range: 138 official commits; extended range: 160 through `eb115063`
- Branch: `codex/t3-sync-349ce301-20260908`
- Initial conflicts: 70; first phase resolved 40, final phase resolved 30; no unmerged paths remain.
- Upstream push URL: `DISABLED`

No upstream commit was cherry-picked, replayed, or squashed. The original merge is now
`c482622f09`, with `349ce301` as its literal second parent. Extension merge `c680824fe2` has
`eb115063634c416c6362cc407f8572cb0c136ddf` as its literal second parent in the same
branch and eventual PR. `upstream-state.json` deliberately retains the last qualified boundary
until the extended candidate passes its gate.

## Composition and review

### Runtime, persistence, and clients

Adopted upstream's Effect RC112 and TypeScript 7 baseline. Scient-only tagged errors and package
typecheck commands use the current APIs and compiler; no old compiler compatibility shim remains.

Adopted persisted active-thread ordering across commands, projections, snapshots, web, and mobile.
Incoming migration 49 became 52 because Scient's shipped migration IDs through 51 are immutable.
Workspace-root and fork-lineage fields remain in active and archived snapshots.

Mobile uses upstream's durable task outbox while preserving project-only creation and live-activity
arming. Removed the superseded direct creation hook. Shared asset resources retain every Scient
issuer, including analysis, compute, documents, attachments, media, and native icons.

### Sidebar and composer

Used upstream's single drag context, optimistic ordering, insertion motion, and section transitions.
Scient draft sessions, project labels, target-picker behavior, settlement ordering, and snooze
behavior remain. Removed the obsolete second row renderer rather than maintaining two drag systems.

Combined upstream interrupt handling and composer-overlay clearance with Scient identity,
queue/edit/delete controls, token-limit feedback, and rich-output state. Composer collapse remains
off by default. The removed upstream blur-collapse setting was not restored.

### Providers

Adopted shared provider-instance naming and badge helpers. Disabled instances no longer create a
false multiple-account badge; the shared helper accepts enabled state, with a regression test.
Scient provider ordering, model-first settings, assisted connection, managed installation,
repair/update, reasoning selection, and instance-scoped credentials remain.

Fixed a stale `SettingsSection.description` use: provider status now has an explicit rendered slot,
and the unused property was removed. Removed an unused Antigravity auth reader. Codex usage-limit
context and Claude failure hints coexist with Scient image, citation, and reauthentication handling.

Scient's Windows managed-runtime cleanup now retains separate structured Effect operation and
cleanup causes, rather than relying on lossy aggregate-error squashing.

### SnapShots and onboarding

Adopted upstream SnapShots as an opt-in desktop feature in Settings, including shortcut setup,
permissions, capture recovery, accessibility details, and native helper packaging. It remains off by
default. Integrations stays immediately after Projects; Keybindings stays below Scientific Computing.

The phase-one note suggesting capture setup inside onboarding was provisional, not a user decision.
The earlier approved onboarding placement concerned project import, not window capture. No extra
capture-onboarding flow was invented.

Local Scient onboarding, managed-provider setup, project import, and reliable project-opening
behavior remain. The hosted wizard adopts upstream multi-computer selection and repository grouping
without enabling cloud. Its CLI examples use an explicitly selected Scient server archive, not the
upstream npm distribution. Removed the obsolete forced-dark onboarding tests because no production
caller or implementation remains; normal theme behavior continues to be tested.

### Images and floating previews

SnapShot details extend Scient's existing image gallery and expanded-image dialog. Normal images
still use full-image containment and the common copy/download/expand path; no parallel thumbnail
gallery was added.

The floating preview uses one shared store and renderer. Browser previews retain upstream
source-aspect sizing and composer clearance. Static Scient artifacts retain independent dimensions,
document-level positioning, copy/download, and side-panel handoff. Keyboard movement, resize,
Escape, and pointer cancellation remain supported.

Added component-level tests for a browser session arriving after the first render, free artifact
resizing, keyboard movement, panel handoff, and portal cleanup. The late-session case exposed and
fixed an observer lifecycle gap. Existing layout and store tests cover aspect ratios, clamping,
content changes, and stale gesture rejection.

### Native identity and release

The launcher combines upstream's external fallback environment file with Scient's one-shot
environment handoff, PID ownership, click-to-relaunch command, and development signing identity.
A cached launch refreshes environment values without rewriting the signed executable. Companion
scripts are refreshed only when changed. Removed an auto-merged ad hoc re-sign that could overwrite
Scient's development signature.

Scient's PNG clipboard path now uses Electron 44's asynchronous ClipboardItem API, matching
upstream's browser-copy mechanism. Tests cover successful decoded data, empty images, and rejected
writes.

Linux portal identity uses Scient's existing desktop entry. GNOME's allowed clients match those
production/development identities, with an explicit identity test. Its extension UUID and D-Bus
service are Scient-specific, and native helper installations/backups have Scient-specific locations,
so setup does not replace T3's helpers. Protocol-internal native executable names remain unchanged.

Release changes are limited to native capture build resources and cache reuse. Scient's exact-source
stable candidate, approval, signing/notarization, artifact validation, voice/SyncTeX staging, and
publication gates remain. No nightly workflow, release, cloud, telemetry, or background-service
activation was performed.

## Automated qualification

Checks run on this macOS candidate using repository-declared Node and pnpm:

- All workspace typechecks pass.
- Web: 621 test files, 6,802 tests pass.
- Server: 453 test files pass, 6,218 tests pass; 15 files / 63 tests intentionally skipped.
- Desktop: 107 test files pass, 1,329 tests pass; 4 files / 43 tests intentionally skipped.
- Remaining workspace packages, mobile, scripts, and lint plugin: 5,023 tests pass; 2 skipped.
- Full production build passes.
- Isolated automated Electron startup smoke passes; no UI interaction was performed.
- Python compute bridge: 85 tests pass. Resource-monitor Rust: 17 tests pass.
- Rust formatting passes for the incoming KDE and Hyprland helpers.
- Formatter, lint (warnings remain), brand check, and unused-code gates pass.
- Analysis, onboarding (against the exact target), Skills, LaTeX, and provenance guards pass.
- Application/package staged and unstaged whitespace checks pass. Inherited `.repos/` whitespace
  remains untouched; reference repositories are not product edits.

The test command was initially stopped by desktop failures; after correcting them, all workspace
groups were run to completion separately. No failing suite was excluded from the reported total.

The startup smoke used a fresh temporary Scient home. It is a startup check, not proof of feature
behavior or native permissions. No persistent dev app was left running.

## Follow-up findings and qualification limits

1. Resolved the Droid teardown gap observed after the server suites. Tracing corrected the initial
   attribution: the surviving agents came from background-generation revocation tests, not catalog
   discovery. Removing a model connection or rotating its key closes the transport, which wakes the
   request and cancels its settings watcher before that watcher finishes closing the runtime scope.
   The Scient runtime factory now protects that teardown from interruption; request execution remains
   cancellable. Both regression cases failed against the old implementation because the child was
   still running after request completion. They now assert termination before fixture cleanup and
   verify that the replacement request also releases its process. All 92 tests across the six affected
   Droid runtime, provider, adapter, and text-generation suites pass. Test-only fallback cleanup owns
   exact process handles so a regression failure cannot leave additional agents behind. This is a
   synthetic real-process qualification, not a claim of live-provider or native Windows acceptance.
2. TypeScript/Effect migration suggestions and existing React compiler warnings remain. Address
   them in a separate evidence-driven pass; do not mix broad mechanical rewrites into this merge.
3. Native Windows and Linux capture interaction has not been exercised on this Mac. Hosted/native
   platform qualification remains required. Android ktlint/detekt are not installed locally;
   the mobile static command reports those skipped tools rather than claiming they passed.
4. Visual acceptance and real-provider behavior remain the user's review gate. Automated markup
   tests do not establish visual quality, and synthetic providers do not establish live compatibility.

## Manual review focus

- Sidebar: pin/reorder/unpin; move active/settled/snoozed threads; drafts remain visible and scoped.
- Composer: start/stop, queued message editing, provider setup, and reopening an existing project.
- Images: ordinary attachments plus SnapShots; expanded details; copy/download; browser and static
  floating previews, resize/move, close, and side-panel handoff.
- Settings: provider readiness/actions, selected-instance stability, preserved ordering and defaults.
- SnapShots: optional setup, capture other windows, app-text on/off, cancel/retry, and restart recovery.
- Import: optional local onboarding, existing/new project import, retry, and late shell arrival.

Nothing has been pushed or merged to main, and no release has been published by this pass.

## Additional upstream range: `349ce301..eb115063`

The owner approved receiving these 22 commits in the same history-preserving PR. There were
14 textual conflict paths; automatic merges were also reviewed for Scient consumers.

- Question answers accept image/file uploads per question, preserve separate prompt drafts,
  wait for uploads, retain retry sources, and record attachments in history. The server claims
  pending uploads in the executing environment, rejects historical thread files as uploads,
  and supplies saved paths through existing provider answer protocols. Revert/bootstrap cleanup
  accounts for activity-held files and has its own retry cursor. No mobile publication is enabled.
- Completed provider turns receive a full idle window before session reaping.
- Pull-request merge defaults are per project; repository/user merge authority is unchanged.
- Usage-limit account columns stay aligned when individual windows are absent.
- Composer banner clearance, previous/next-turn minimap navigation, Ctrl+Insert terminal copying,
  sidebar row stability, and project-icon consistency are adopted.
- The macOS installer adopts upstream's aurora artwork and updated geometry with Scient labels.
  Signing, release channels, approval, and publication controls are unchanged.
- Server export classification and its CI check are adopted. Private Scient helpers no longer
  expose unused named exports. Canonical Effect construction remains explicitly public.
  Three upstream exports still used by Scient tests remain exported: provider registry fixtures,
  the Antigravity release version, and the privacy-preserving startup heartbeat.
- Mobile's source version advances to 1.1.1; store/OTA workflows remain disabled.

### Conflict composition

Question attachment schemas coexist with Scient's exported upload schema for the thread queue.
Normalizer cleanup covers both turn and question attachments while retaining Scient's inline-image
cleanup option. Composer question preparation uses per-question keys while preserving managed-runtime
update blocking and voice busy state. Persisted answers coexist with scientific skill activity labels.

The project-icon refactor uses the full project record throughout the palette, sidebar, drafts,
and Project Skills. Grouped display labels do not replace the actual title used to choose an icon.
The folder-picker Enter/keyboard-highlight fixes remain unchanged.

The owner chose to retain current Settings behavior rather than adopt upstream's flat-only list.
The existing section navigation and visibility helper moved under `scient/settings`, leaving one
hook and one rendering slot in the inherited sidebar, plus the existing Settings page-root
attribute used for visibility observation. The semantic review restored that attribute after Git
automatically accepted its upstream removal. Tests cover explicit expansion, route changes,
returning to the chosen page, mobile dismissal, local scrolling, and hash-navigation fallback.
The root-marker contract and observer cleanup on route changes also have a regression check.

Analytics retains Scient's consent/configuration gates and disabled layer. The export-classification
conflict does not restore upstream identity collection or network delivery.

### Resolved review finding: submitted question attachments in forks

The previous fork pipeline retained message records and copied their files. T3 stores native
question-answer attachments in `user-input.answer-submitted` activity records instead. Those
activity-only files were retained in the original thread, but the fork path did not copy them
or seed their answer text into the new provider's transcript. Message-mode question responses already
use ordinary messages and their files follow the existing fork copy path.

This follows from `retainPrefixMessages`/`forkThread`, the fork availability check's message-only
source list, and `ForkContextBootstrap`'s message transcript. It is a code-review finding, not a
claimed live-provider reproduction. The native answer-transcript omission predates this feature;
the new activity-only files make the consequence more visible.

The owner approved preserving submitted answers and files while retaining existing unsent-draft
behavior. The targeted fix uses one Scient-owned selector for admission, copying, and bootstrap.
History remains activity records with fresh activity/request/turn/file identities. Existing
copy/recovery machinery provisions independent files; provider bootstrap encodes separate answer
records within the existing context budgets. T3 submission, rendering, schema, and cleanup are
unchanged, as are completed boundary counts and ordinary draft/queue behavior.

The 165-test fork suite passed, including a new real-SQL/event-store/file-copy test covering copy
retry, original deletion, fork revert, replay, provider context, and fork-of-fork. Additional
regressions cover admission with missing question files, earlier boundaries, pending/message-mode
exclusion, malformed or unscoped records, independent identities, and context/attachment limits.
This is synthetic backend evidence, not a live-provider or visual acceptance claim.

The fix checkpoint is `5307bd237d`. Full typechecking subsequently corrected a test-only
unknown-payload spread to use the decoded answer fixture; error wording was also made accurate
for both pre-fork admission and an already-created fork's bootstrap. The focused suite was
rerun on those corrections. Main's already-approved analytics notice was merged unchanged;
this alignment does not introduce a separate analytics activation decision.

### Extended candidate automated qualification

- Full workspace test run: 19,636 passed and 108 skipped. After the final web-only root-marker
  correction, the complete web suite was rerun: 6,822 passed in 623 files (one additional test).
  The unchanged server portion passed 6,233 tests in 455 files; 63 tests were skipped.
- Focused attachment suite: 85 passed across five files, including the added historical-file
  ownership rejection check. Settings navigation and visibility: ten tests across two files.
- Workspace typechecks, production build, non-visual Electron startup smoke, formatting, lint,
  server export enforcement, branding, and whitespace checks passed. Lint/typecheck advisory
  warnings remain; passing does not mean warning-free.
- Analysis, onboarding, Skills, LaTeX, and upstream provenance checks passed. The provenance
  check still uses the previous qualified integration boundary; literal ancestry of this
  candidate is checked separately. The integration cursor is not advanced before manual
  acceptance.
- Mobile native static inventory completed, but SwiftLint, ktlint, and detekt were unavailable
  on this host and skipped. No Windows/Linux, mobile-device, or live-provider qualification is
  claimed by this extension.

No computer use or visual review was performed. No remote push, PR, main merge, release, or
development-profile cleanup/restart was performed. The unrelated ProviderInstanceCard changes
already present in this shared candidate remain outside this pass's commit scope.

Product diff whitespace checks pass. A whole-history whitespace scan also reports inherited
whitespace in `.repos` reference snapshots; those read-only donor files remain unchanged by
the fork fix rather than being reformatted during alignment.

### Final fork fix and main refresh qualification

- Full workspace run passed: 19,643 tests, with 108 skipped. Its server phase passed 6,239
  tests in 456 files. After incorporating main's analytics-notice PR, the complete web suite
  passed again: 6,820 tests in 623 files (that PR removes two gate-specific tests).
- The corrected fork suite passed again: 165 tests across 13 files. Latest workspace typechecks,
  lint, production build, non-visual Electron startup, formatting, export enforcement, branding,
  onboarding seam, provenance, and product whitespace checks passed. Existing diagnostic
  warnings and the previously stated platform/visual limitations remain.
- Literal ancestry includes both `eb115063` and refreshed main `507b8f1f80`. The qualified
  integration cursor remains unchanged until manual acceptance; no remote publication is implied.
- The shared candidate's unrelated ProviderInstanceCard edits were preserved and exercised by
  the web suite, but not committed as part of this fork fix or alignment extension.

Manual review should use a rebuilt candidate backend: submit an agent-question attachment,
fork its completed response, inspect the retained answer/file and use it with the new provider.
Also fork an earlier response and confirm that later answers/files are excluded. No dev app
was restarted during this pass, and no live-provider success is claimed by the automated tests.
