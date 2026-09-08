# Upstream sync review through `349ce301`

Status: local implementation and automated review complete; human interaction review, commit,
PR, CI, and merge remain pending. This is one in-progress history-preserving merge, not two syncs.

## Frozen boundary

- Scient base and reverified `origin/main`: `4d4d53d80595de0f0da2308ce9b25259e094d0c8`
- Previous upstream receipt: `223ff4490f764a74ff911589e97b9bbcd595fee8`
- Upstream target / `MERGE_HEAD`: `349ce3014233352e073a5fc1b3f12bd786160913`
- Range: 138 official commits
- Branch: `codex/t3-sync-349ce301-20260908`
- Initial conflicts: 70; first phase resolved 40, final phase resolved 30; no unmerged paths remain.
- Upstream push URL: `DISABLED`

No upstream commit was cherry-picked, replayed, or squashed. The merge is not committed yet;
`upstream-state.json` deliberately retains the last integrated boundary. Advance it only after
the literal merge commit and applicable gate exist, as the alignment protocol requires.

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

Nothing has been pushed, merged, or published by this pass. This receipt does not authorize those
actions or advance the integrated upstream boundary.
