# T3 alignment through 5b8445b7a

Status: qualified alignment receipt. Local automated gates and the isolated
desktop boundary are recorded before the pull request is considered ready.
This record does not authorize a release, cloud activation, or mobile
publication.

Role: record the exact donor range, Scient compositions, and verification
boundary for this alignment. The ongoing procedure remains the
[alignment protocol](upstream-alignment-protocol.md), and current machine state
remains [upstream-state.json](../../upstream-state.json).

## Exact boundary

- Owned repository: `ScientFactory/scient-desktop`.
- Owned base: `cb735ab0acf3c713ca3d2eeba0a68a0b63e468a1`.
- Previous official boundary: `70cd258d8aac43ea57494527b00bf36de3efa6c0`.
- Official donor: `pingdotgg/t3code`.
- Frozen target: `5b8445b7a777ab1070aa97b062b1618971073a96`.
- Range: 72 commits; 469 donor-touched paths; 153 paths overlapping Scient
  work; 55 textual conflict resolutions across three merge checkpoints.
- The exact donor tag is `v0.0.39-nightly.20260903.1267`.
- Branch: `codex/t3-sync-854541a0-20260903`.
- History-preserving merge checkpoints:
  - `1bc372d207b7cc5d4ed43cc26fa2900eefe4e2a6` through `854541a04`;
  - `53dbd9d98dfe2652b8e70fdac465c2ba1fcc7c8c` through `cf0bb4c35`;
  - `834a0196b0de62f6d00f6ff076b21593dc1dab66` through `5b8445b7a`.
- `origin` remains the writable Scient remote; `upstream` remains fetch-only,
  with push URL `DISABLED`.

Local `main` was clean and matched the exact owned base before the dedicated
worktree was created. Upstream PR
[`#9325`](https://github.com/pingdotgg/t3code/pull/9325), which proposes
installer-ownership checks for provider updates, remained open when this range
was frozen and was not cherry-picked. Later upstream changes are outside this
bounded range.

## Received behavior

- Provider settings receive the redesigned instance editor and model list,
  workspace-wide skill discovery, OpenCode reasoning controls, safer provider
  removal presentation, and fixes to settings watching and model persistence.
- Browser sessions gain named profiles, close confirmation for
  agent-controlled tabs, profile choices in the empty launcher, and a setting
  for opening links in the integrated or default browser.
- Projects can pull a clean default branch automatically and use customizable
  icons. Environment labels consistently show local, SSH, or hosted-machine
  identity, and SSH host fields suggest known hosts.
- Pull-request tabs gain durable shared state, labels, file trees, path-copy
  actions, clearer state icons, improved checkout controls, responsive actions,
  cached chrome, wider layouts, and corrected settlement behavior.
- File and media previews share one cross-client model. Document attachments
  open in the file viewer, mobile file references expose copy/open actions, and
  native application and browser icons appear in work logs.
- The web composer can collapse when resting, move its model and mode controls
  into the context strip, collapse again during timeline scrolling, and retain
  attachment visibility. Page navigation, panel animations, proactive panels,
  right-panel closing, diff display persistence, and chat/timeline behavior are
  refined.
- Mobile receives correct press/disabled pseudo-state handling, expanded tool
  group sizing, Android code overflow fixes, and an exact-pinned patched
  `expo-sharing` dependency.
- The context-compaction feature added within this donor range was reverted by
  upstream before the frozen target; this alignment does not expose it.

## Composition decisions

Every textual conflict and automatically merged overlap was reviewed against
both parents. The main seams were managed providers, projectless threads,
Files/media authority, browser identity, persisted settings and migrations,
the composer, pull-request state, and publication policy.

### Composer and provider controls

Upstream owns the resting-composer state machine, scroll gesture, compact
surface, relocated controls, selection handling, and layout measurements.
Scient's assisted-provider behavior remains the control content inside that
layout: a missing or disconnected provider opens `Choose your AI`, reconnect
uses the provider-specific assisted surface, managed-runtime updates expose
their truthful status and footer, and provider switching retains the existing
fork and busy-state safeguards. The editor keeps Scient's bidi direction
plugin while adopting upstream's visible-selection detection.

Projectless threads still do not claim a project diff or terminal target.
Scient's checkpoint-aware fork availability remains authoritative, while the
new hidden context strip mounts only to measure and host resting controls. No
provider authentication is started by mount, refresh, or status probing.

### Providers and lifecycle

Upstream's provider editor, model list, workspace skill discovery, settings
watching, Cursor permission handling, OpenCode reasoning control, and provider
runtime fixes are retained. Scient's provider-specific wrappers continue to
stamp assisted connection methods, disconnect policy, and system-managed or
Scient-managed runtime state. Existing install, sign-in, repair, update,
remove, sign-out, and system-installation flows remain capability-driven and
provider-specific where necessary.

PR #9325 is useful follow-up input, not released behavior. Adopting a draft
implementation outside official ancestry would make provenance and future
conflict resolution less reliable, so it remains for a later official sync or
an independently reviewed Scient change.

### Files, media, browser, and identity

The unified preview work is composed with Scient's generic attachments,
rooted workspace authority, generated documents, analysis artifacts, compute
outputs, range-capable PDF/media delivery, rich Markdown, and sandboxed HTML.
Preview support does not narrow accepted file types. Relative reads remain
canonically contained; explicit host-file reads remain exact and read-only;
editable workspace documents retain revision-aware compare-and-swap saves.

Browser profile storage derives its persistent and ephemeral partition names
from Scient's desktop identity. Public link-setting copy says `Scient`, while
protocol-compatible internal identifiers remain unchanged. Agent-controlled
browser close confirmation and the default-browser escape are retained without
bypassing existing browser authorization.

### State, migrations, and publication

The donor's three new migrations were renumbered after Scient's already
shipped `045` and `046` migrations:

- `047_ProjectionProjectsAutoPull`;
- `048_RepairAutomaticSettlementTimestamps`;
- `049_ProjectionProjectIcon`.

Their order and semantics are unchanged, and migration identifiers are not
reused. The associated tests begin from the immediately preceding composed
migration. macOS skill tests compare canonical real paths so `/var` and
`/private/var` do not create a false failure.

Upstream's lint-rule audit also made 12 Scient `no-control-regex` suppression
comments obsolete. Only the unused comments were removed; the NUL-rejecting
schemas and filename sanitization remain unchanged and covered by their
existing contract suites.

The Vite+ `0.3.0` upgrade exposed a latent desktop-test fixture error on two
independent hosted runners. The helper's “non-development” mode disabled the
Vite URL but still constructed an unpackaged development environment, so the
one-mebibyte bounded-output fixture was mirrored to captured stdout and Vitest
`4.1.11` stalled. The fixture now makes packaged state the inverse of its
development flag, matching its existing name and callers. Production logging,
the one-mebibyte bound, the Test job topology, and its timeout are unchanged.

Scient keeps its owned contributor trust list, product identity, state roots,
manual release workflow, updater feed policy, signing, notarization, and
publication boundaries. Donor nightly tags, hosted services, relay behavior,
and mobile publication remain ancestry only and are not activated.

## Protected boundaries

Scient product identity, `scient-next` storage roots, immutable migrations,
Sources, Skills, voice, analysis, compute, PDF, LaTeX, generated documents,
rich chat, content direction, browser authorization, generic attachments, and
managed/system provider lifecycle remain intact.

No workflow, contributor trust, service registration, signing, notarization,
tagging, updater feed, release, hosted web, mobile publication, analytics
delivery, OTLP, cloud, or relay authority is enabled. Other worktrees and live
user data were untouched.

## Verification

Local checks use Node `24.19.0` and pnpm `11.10.0`.

- Formatting, lint, typecheck, brand and seam inventories, whitespace and
  conflict-marker checks, production build, desktop startup smoke, exact
  clean-lock release smoke, and the native resource monitor pass. Lint retains
  advisory diagnostics already permitted by the repository.
- The complete monorepo suite passes. The final web project reports 479 files
  and 4,779 tests passed; mobile reports 137 files and 1,136 tests passed. The
  server reports 389 files passed and 8 skipped, with 4,636 tests passed and 40
  skipped.
- Focused provider lifecycle, migration, skill discovery, asset/file/media,
  browser, projectless-thread, pull-request, composer, timeline, desktop, and
  mobile checks pass.
- Mobile static checks pass; SwiftLint, ktlint, and detekt were unavailable and
  are therefore not claimed.
- Provenance is checked against the committed merge chain and exact official
  target. The isolated candidate starts with synthetic state, but native visual
  capture is unavailable while the host Mac is locked; desktop smoke and the
  complete renderer tests are the automated acceptance boundary for this pass.

The review does not perform a live provider login or turn, runtime update
installation, native iOS/Android build, Windows runtime, remote-host update, or
production publication. Those are explicit non-claims, not inferred passes.

## Publication boundary

This branch is intended for a reviewed pull request. Merging the alignment does
not authorize publishing a release, activating retained mobile features, or
merging any other task's work.
