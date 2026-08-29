# T3 upstream sync through 660cddd3bc

Status: locally verified integration candidate. This record does not authorize
a release, enable cloud or mobile publication, or modify `release/stable`.

## Exact boundaries

- Owned base: `1d28d6299878f145681755996c1015f135012f3a`
- Previous literal T3 boundary:
  `c8aba2587d56edbf3b7872987719a12b42031f48`
- Integrated T3 target:
  `660cddd3bc9801e089afcabba11c62f41aeac5c3`
- Official tag at the target: none (nearest description:
  `v0.0.37-nightly.20260829.1219-3-g660cddd3b`)
- Exact donor range: `c8aba2587d..660cddd3bc`, 46 commits
- History-preserving merge:
  `9b10fe5a9aad4bc69985d0910d723dbc0da5a2f9`
- Integration branch: `codex/t3-sync-660cddd3-20260829`
- Donor write boundary: the `upstream` push URL remains `DISABLED`

The target was freshly fetched from official `pingdotgg/t3code:main`. The merge
commit has the exact owned base and official target as its two parents. No
donor commit was replayed, squashed, cherry-picked, or reimplemented as a
substitute for ancestry. `integrationBase` advances to the merged target;
`reviewedThrough` remains the separate product-review cursor.

## Adopted behavior

- Provider Settings receives T3's editor stabilization and cleanup while
  retaining Scient's assisted install, sign-in, repair, update, removal,
  diagnostics, redaction, and enabled-state behavior. Project defaults now
  apply consistently to new threads, and Codex exposes its sub-agent models.
- OpenCode receives child approval, stop, and model-catalog handling together
  with stronger managed-server ownership. Its provider-specific protocol stays
  outside generic lifecycle policy.
- Desktop receives local WSL runtime caching, hidden-preview battery protection,
  preview-host OAuth popups, and stricter preload verification while preserving
  Scient state roots, browser authorization, packaged native helpers, and local
  voice/PDF resources.
- Connection failures explain DPoP problems, initial thread sends can retry
  after failed bootstrap, automatic titles retry, and edited pull-request
  comments refresh in the client.
- The web client receives searchable project filtering, keyboard pinning,
  optional unpin confirmation, contained project pickers, small-screen task
  drawer fixes, pull-request browser fallback, keybinding settings rows, and
  the four upstream composer spacing corrections.
- An environment can publish a theme file. Scient keeps its own primary theme
  storage key and product theme while adopting the shared transport and
  environment synchronization mechanics.
- Mobile receives compiled semantic themes, Expo SDK 57, provider model-source
  presentation, restored composer surfaces, safer native headers, Android file
  actions, and related accessibility and layout maintenance. Existing Scient
  identity and publication holds remain unchanged.
- The generic server and web file-attachment machinery for PDFs, ZIPs, and
  other files is present in ancestry. Scient does not expose it yet because the
  corresponding enabled mobile producer/consumer support has not landed.

T3's release-preparation and nightly-scheduling commits remain literal
ancestry. They do not create a Scient release or enable T3's automated
publication authority.

## Conflict composition

The donor range touched 396 paths. The resulting merge changes 398 paths
relative to the owned base and produced 51 textual conflict paths. Every
conflict was compared with both parents; auto-merged overlapping paths were
also audited for semantic composition.

- Scient's manual, exact-commit stable release workflow remains authoritative.
  T3's nightly schedule, release bot, npm, hosted, relay, mobile, and tag
  publication paths were not activated.
- Scient analytics remains disabled by default and constrained by its reviewed
  allowlist and consent boundary. The incoming connected-client-platform event
  does not silently broaden runtime collection.
- The owner-set contributor trust list remains deliberate; the incoming VOUCHED
  entry was not adopted as Scient policy.
- Provider Settings keeps Scient's lifecycle host and assisted dialog as the
  behavior owners while taking T3's surrounding master/detail structure. The
  provider error headline now truthfully reports `Unavailable` after a failed
  manual probe, and account emails remain visible by default unless the user
  chooses redaction.
- WSL caching, desktop startup, and packaging preserve `scient-next` state
  roots and the Scient Whisper and SyncTeX resources alongside incoming Windows
  runtime resources.
- The environment-theme merge keeps `scient-next:theme` as Scient's intentional
  client storage key. Upstream's `t3code:theme` assertion was not allowed to
  redefine the existing persistence partition.
- Existing generated images are preserved when attachment state is composed.
  Scient conversation forks remain intentionally image-only and now reject
  unsupported non-image files before draft mutation. Queueing retains file
  identifiers instead of silently dropping them.
- Public metadata and modified operations documentation use Scient identity.
  T3 compatibility variable names remain only where they are part of inherited
  contracts.
- Unified patch files are marked `-whitespace` in `.gitattributes` so embedded
  diff context does not create false repository whitespace failures. Source
  and documentation whitespace checks remain unchanged.

The complete gate found two semantic issues that Git had auto-merged without a
textual conflict:

1. The Windows packaging test had replaced Scient's Whisper and SyncTeX
   expectations with T3's incoming resources. The composed expectation now
   covers both sets.
2. The environment-theme synchronization test asserted T3's storage key even
   though the retained Scient hook correctly writes `scient-next:theme`. The
   test now verifies the actual owned persistence contract.

These findings are why the maintained protocol requires semantic review of
auto-merged overlaps rather than treating a clean textual merge as proof.

## Temporary generic-file compatibility gate

`SCIENT_GENERIC_FILE_ATTACHMENTS_ENABLED` is explicitly `false` at both the
server and web compatibility boundaries. While false:

- the server does not advertise generic file attachments;
- the command normalizer rejects generic file attachment commands;
- the web picker and drag/drop entry points remain hidden; and
- retained unsupported generic draft files cannot be submitted.

Image attachments continue to work. The gate can be removed only after every
enabled producer and consumer—including mobile, desktop/web, persisted replay,
and the supported old-client boundary—accepts the same contract. A UI-only
hide is deliberately not treated as a safety boundary.

## Protocol hardening

This alignment adds the active
[T3 upstream alignment protocol](upstream-alignment-protocol.md) and links it
from `AGENTS.md`, `UPSTREAM.md`, and the internal documentation index. The
protocol makes the established practice explicit: freeze exact refs, preserve
literal ancestry, inventory and simulate before mutation, classify every
overlap, audit protected Scient seams, gate cross-client contracts at both
capability and command boundaries, run the complete repository gate, verify an
isolated candidate, write a dated receipt, and keep merge/publication authority
separate. It is a reviewed default that must be improved when implementation
evidence disproves an assumption; it is not permission to work around the
actual range.

## Protected-boundary audit

- Scient identity, protocols, `scient-next` storage compatibility, migrations,
  local state, onboarding, Sources, Skills, local voice, analysis, compute,
  LaTeX, PDF, rich chat, BiDi, forks, and project ownership remain intact.
- System-installed and Scient-managed provider paths remain supported. Assisted
  lifecycle actions stay capability-driven and provider-specific where the
  provider protocol differs. Passive status checks remain side-effect safe.
- Raw provider data, analytics, OTLP, cloud, relay, preview automation,
  service/updater authority, signing, notarization, mobile publication, and
  stable release remain behind their existing Scient boundaries.
- No stable application, production state, provider account, live OAuth flow,
  release branch, or unrelated feature worktree was modified.
- `upstream` remains fetch-only with push URL `DISABLED`.

## Verification

Local verification used Node `v24.19.0` and pnpm `11.10.0` on the exact merge
candidate:

- `pnpm install --frozen-lockfile` passed and left the lockfile unchanged.
- `pnpm exec vp fmt --check` passed across 3,872 files.
- `pnpm exec vp lint --report-unused-disable-directives` passed with advisory
  diagnostics only.
- `pnpm run typecheck` passed all 27 workspace targets.
- `pnpm run test` passed all 26 workspace targets. The complete server lane
  passed 370 files and 4,268 tests with 8 files and 40 tests skipped; web passed
  459 files and 4,204 tests; desktop passed 116 files and 793 tests; mobile
  passed 70 files and 683 tests with 10 tests skipped.
- `pnpm run build`, `pnpm run test:desktop-smoke`, and
  `pnpm run release:smoke` passed.
- `pnpm run lint:mobile` passed its repository checks. Optional local
  SwiftLint, ktlint, and detekt executables were not installed, so those native
  checks remain hosted-CI/platform gates.
- Brand, provenance, analysis, onboarding, Skills, LaTeX, generated-icon,
  conflict-marker, and Git whitespace gates passed. The provenance gate was
  rerun after this receipt and machine state advance and passed.

An isolated synthetic-state desktop candidate from the exact merge commit
started its renderer, backend, and desktop process successfully. Visual smoke
covered the new-thread composer and Appearance settings: Scient identity and
themes were intact, spacing rendered normally, and the unsupported generic-file
entry point was absent. Live provider lifecycle actions, OAuth, platform
packaging, and provider Settings acceptance were not exercised; those remain
manual review items before merge. The candidate is intentionally left running
for that review.

## Publication boundary

This synchronization is pushed only as a draft pull request to owned `main`.
It does not merge that pull request, modify `release/stable`, publish artifacts,
or enable T3 relay, cloud, hosted web, mobile store, signing, updater, npm, tag,
nightly, or release authority. Those remain explicit Scient gates.
