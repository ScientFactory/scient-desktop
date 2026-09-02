# T3 alignment through 70cd258d8

Status: qualified draft alignment receipt. The local automated gates passed;
the isolated desktop review and hosted pull-request checks are recorded before
this draft is considered ready. This record describes a proposed integration
boundary. It does not authorize a release, cloud activation, or mobile
publication.

Role: record the exact donor range, Scient compositions, and verification
boundary for this alignment. The ongoing procedure remains the
[alignment protocol](upstream-alignment-protocol.md), and current machine state
remains [upstream-state.json](../../upstream-state.json).

## Exact boundary

- Owned repository: `ScientFactory/scient-desktop`.
- Owned base: `a3e625a47fdb0902baf740fee8855adbd28b6acc`.
- Previous official boundary: `590a579f2e9292ce314c69e459e19620004578fe`.
- Official donor: `pingdotgg/t3code`.
- Frozen target: `70cd258d8aac43ea57494527b00bf36de3efa6c0`.
- Range: 66 commits; 595 donor-touched paths; 209 paths overlapping Scient
  work; 83 textual conflict/resolution paths.
- The target is tagged `v0.0.39-nightly.20260902.1257` in the donor repository.
- Branch: `codex/t3-sync-70cd258d-20260902`.
- History-preserving merge: `bcf3e099a7c75ca4c3eca7591124235191682396`.
  Its first parent is the owned base and its second parent is the frozen target.
- `origin` remains the writable Scient remote; `upstream` remains fetch-only,
  with push URL `DISABLED`.

Local `main` was clean and matched the exact owned base before the dedicated
worktree was created. Later upstream changes are outside this bounded range.

## Received behavior

- Desktop and mobile can preview host images and stream host videos, while the
  Files surface can open Markdown, HTML, and PDF files outside a workspace.
  HTML and PDF render in the file viewer, file breadcrumbs browse directories,
  and stale writes are rejected when a document closes or changes underneath
  an editor.
- Assistant responses gain inline citations and selection actions. Tool groups,
  error presentation, command scrolling, composer notices, draft preservation,
  code-block copying, list markers, and model details receive focused fixes.
- Provider work is bounded and more accurate: persisted-session lookups,
  OpenCode version probes, streaming projections, replay payloads, and client
  object churn are reduced; Claude composer-selected skills execute; Grok
  health, model switching, and stop-all behavior use the real CLI; removed
  custom models no longer remain selectable.
- Shared auto-settlement and other server preferences synchronize across
  connected environments. Project defaults, sticky new-thread models, and
  active-thread continuation across a server restart are reconciled without
  rewriting explicit user choices.
- A local CLI can ask a running Scient desktop app to open a project. A remote
  server hosted by an eligible desktop app can prepare an app update and hand
  installation back to that desktop without publishing or bypassing updater
  policy.
- Pull-request providers reuse bounded reads, accept legacy checkout results,
  expose checkout commands, and improve diff defaults, toast navigation, and
  Azure DevOps list handling. Mobile receives media presentation, composer and
  message overlap fixes, updated Ghostty integration, and related interaction
  repairs.

## Composition decisions

All 83 textual conflict paths and the automatically merged overlaps were
reviewed against both parents. The main seams were release and trust policy,
managed providers, assets and Files, desktop activation and update handoff,
thread replay, shared settings, chat presentation, and cross-client contracts.

### Files, attachments, and previews

Scient keeps generic desktop/web attachments without an extension allowlist;
preview support is not an upload permission boundary. Upstream's host media and
document reference is composed with Scient's rooted workspace authority,
range-capable PDF/media delivery, generated documents, analysis artifacts, and
compute outputs. Absolute host reads are explicit and read-only. Relative
workspace reads retain canonical-root and symlink containment, and editable
workspace files retain revision-aware compare-and-swap saves.

HTML runs inline in a sandboxed opaque-origin frame and can also be opened in
the integrated browser. A workspace HTML document may load authorized sibling
assets; an outside host file receives only exact-file authority. PDF continues
through Scient's reader by default, with an explicit browser escape. Scient's
lazy Files tree remains authoritative rather than adopting an eager full-tree
reset; upstream breadcrumbs and stale-save protection are composed around it.

### Providers and thread lifecycle

Upstream's bounded session, projection, replay, skill-dispatch, model, and
continuation work is retained. Scient's provider-specific driver wrappers stay
provider-specific because they also stamp assisted connection methods,
disconnect policy, and system-managed or Scient-managed runtime state; the new
generic identity helper is used where that extra lifecycle state is absent.
Passive status probes still do not open authentication, and managed install,
sign-in, repair, update, remove, and sign-out capabilities remain truthful per
provider.

Attachment cleanup now waits until command commitment, and active work can
continue after the server updater restarts the server. Scient's queue/steer,
fork hydration, citation compatibility, provider authentication errors, and
old-client replay remain intact. Migration `046` follows the already shipped
Scient migration `045`; no migration identifier is reused.

### Desktop, identity, and publication

The activation socket and remote-update control channel resolve Scient's
`scient-next` state roots and visible product copy. Ambient `T3CODE_HOME` does
not redirect a safety-enveloped Scient desktop. Remote update preparation is
available only when a desktop-spawned server has its authenticated telemetry
control channel and the existing updater is already eligible; it does not
enable a feed, signing, tagging, or publication.

Scient keeps its two-entry contributor trust list and owned manual release
workflow. The donor release version and removal of obsolete donor release
comments enter only as ancestry; T3 tag/nightly, npm, hosted, relay, and mobile
publication remain disabled. New public activation, update, and activity copy
uses Scient identity while protocol-compatible internal `t3-code` identifiers
remain unchanged.

The mobile release patch for `expo-sharing` is version-specific, so that
dependency is exact-pinned to `57.0.16`; a clean install cannot silently select
an unpatched later patch release. Deleted marketing assets and duplicate
analytics, terminal, state, and UI helpers were confirmed unused; live Scient
analytics, terminal routing, scientific surfaces, and owned state remain wired.

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

- Formatting, lint, typecheck, brand checks, whitespace and conflict-marker
  checks, the production build, desktop startup smoke, and exact clean-lock
  release smoke passed. Lint retains advisory diagnostics already present
  outside this alignment.
- The complete monorepo run passed across 26 projects. Web: 471 files and 4,653
  tests passed. Server: 385 files passed and 8 skipped; 4,565 tests passed and
  40 skipped. One earlier full run observed a single nondeterministic bootstrap
  404 in the unchanged server router harness; that complete 167-test file then
  passed five consecutive stress runs, and the final complete run was green, so
  no retry or weakened assertion was introduced.
- Focused desktop activation and update, host assets, workspace files, generic
  attachment, provider, shared-settings, citation, timeline, server-restart,
  and client-runtime suites passed. The native resource monitor passed 15
  tests.
- Scient analysis, onboarding, Skills, and LaTeX seam inventories passed.
  Mobile static checks passed; SwiftLint, ktlint, and detekt were unavailable
  and are therefore not claimed.
- Provenance is checked against the committed merge and exact official target.
  An isolated synthetic-state desktop candidate is reviewed before the pull
  request is marked ready.

The review does not perform a live provider login or turn, update installation,
native iOS/Android build, Windows runtime, remote-host update, or production
publication. Those are explicit non-claims, not inferred passes. Mobile
publication remains disabled.

## Publication boundary

This branch is intended for a reviewed pull request. Merging the alignment does
not authorize publishing a release, activating retained mobile features, or
merging any other task's work.
