# Scient-specific capability catalog

Status: Historical
Owner: Yaacov
Created: 2026-08-28
Last updated: 2026-08-28
Purpose: Catalogs Scient-specific desktop capabilities, implementation anchors, provenance, and exact snapshot boundaries for documentation-system migration and architecture review.
Doc type: Research evidence

Investigation snapshot: 2026-08-28

Checkout reviewed: `ScientFactory/scient-desktop`, `main`,
`aa23f1d3b96f6904dcc1a114cc33415fa267315a` (`feat(pdf): keep HTML exports
current (#187)`). The catalog is intentionally evidence-led: a capability is
listed as Scient-owned when the checkout contains Scient-owned code, a
Scient-owned contract, a deliberate product policy, or a deliberate change to
an inherited T3 seam. Pure T3 behavior received through an upstream merge is
not counted as Scient-specific merely because it is present in the app.

Post-snapshot reconciliation on 2026-08-28 reviewed remote `main` through
`c0baaab2cda29a84682b77b8384bb7542e59a8bd`. Merged PR #189 receives the
official T3 range through `c8aba2587d56edbf3b7872987719a12b42031f48` and
reconciles protected seams, but it does not add a new Scient-specific
capability family. Merged PR #190 also adds no new family, but changes defaults
within existing provider, privacy-presentation, browser-tool, and Sources
capabilities: provider settings open on Models when available; authenticated
provider email starts revealed while other sensitive values remain redacted by
default; and agent Browser plus project Sources access defaults on while
preserving explicit opt-out. Its seven-file implementation is in
`apps/web/src/components/settings/` and `packages/contracts/src/settings.ts`
with focused tests. Draft documentation PR #188 remains open and non-current.
The 39-item capability-to-foundation audit—38 named capabilities plus the
cross-cutting security/reliability family—rechecked this catalog and the
`aa23f1d3..d5ff08e7` delta. Read the detailed capability bodies below as the
exact #187 snapshot and this addendum as its current-main reconciliation.

This is the companion to:

- [Scient PR and evolution ledger](./scient-pr-and-evolution-ledger.md)
- [T3 divergence, integration, and retirements](./scient-t3-divergence-integration-and-retirements.md)

The detailed, living design records are in `docs/internals/`. This report
indexes them and records the cross-feature conclusions that are easy to miss
when reading one feature at a time.

## Executive inventory

The current `main` checkout contains these Scient-specific capability families:

1. Scient identity, product boundaries, release machinery, and development
   isolation.
2. Safe project initialization and compact onboarding.
3. Durable conversation forks, provider switching, and the separate
   projectless-thread retirement path.
4. Provider lifecycle management, assisted authentication, managed runtimes,
   capability-aware provider instructions, and provider-specific voice
   correction.
5. Local voice dictation with managed Whisper models.
6. Scient skills: reviewed built-ins, project-scoped skills, trust/digest
   policy, provider delivery, and skill authoring.
7. Scientific source management: local PDFs, Zotero intake, exact-identifier
   metadata enrichment, notes, citation formatting, and agent operations.
8. Research-oriented chat rendering: math, Mermaid diagrams, Vega-Lite,
   Plotly, workspace images, copy/export fallbacks, and BiDi/RTL handling.
9. Universal local-file opening and the file-surface family, including
   freshness/refresh behavior.
10. A local PDF reader and a browser-based HTML-to-PDF export pipeline.
11. Local LaTeX authoring, managed TinyTeX, build evidence, and verified
    SyncTeX forward/inverse navigation.
12. Scientific analysis/execution foundations, MATLAB discovery/run
    coordination, result promotion, and static artifact presentation.
13. A per-thread durable message queue with steer semantics.
14. Disabled-by-default first-party analytics with privacy controls.
15. Cross-cutting reliability, security, CI, and release fixes that make these
    features safe to ship and preserve their boundaries across T3 refreshes.

The following sections explain each family. “Current” means present in this
checkout’s `main`; “integration-only” means the work exists in a merged
feature branch or PR but is not part of this `main` snapshot; “retired” means
it was intentionally removed from the current product.

## 1. Product identity, boundaries, and delivery infrastructure

### Scient identity and the fork boundary — current

Scient started as a T3-derived candidate, but the visible product identity was
changed from the inherited candidate name to Scient and then completed as a
desktop repository cutover. The app keeps compatibility namespaces and
protocol/data identifiers where changing them would damage migration safety;
that is compatibility, not a second user-facing product identity.

What it does:

- presents the desktop app, wordmark, sidebar, release notes, and settings as
  Scient;
- keeps product-specific behavior in marked or separate Scient modules;
- records the official T3 donor and the refresh state instead of pretending the
  fork is an independent rewrite;
- preserves literal upstream ancestry so later T3 merges remain auditable.

Primary evidence and files:

- `UPSTREAM.md` — donor selection, integration rules, protected seams, and
  refresh history;
- `upstream-state.json` — integration base, reviewed T3 commit, verified
  baseline, bootstrap merge, and historical Quick Chat provenance;
- `docs/internals/scient-next-d4-bootstrap.md` — the D4 baseline and initial
  protected-divergence record;
- `apps/desktop/`, `apps/web/`, and product metadata — user-facing identity;
- `apps/web/src/assets/scient-symbol.svg`,
  `apps/web/src/assets/scient-symbol-strong.svg`, and
  `apps/web/src/components/ScientSymbol.tsx` — identity assets and rendering;
- `apps/web/src/scient/releaseNotes/` and the release-note entries under
  `docs/` — product-owned release communication;
- PRs #1, #5, #29, #57, #103, #124, #135, #173 and the upstream refresh PRs.

Why: Scient needs a stable product name and its own release/behavior policy
while continuing to receive upstream T3 improvements. The policy is “thin
fork, explicit ownership,” not “copy T3 and silently diverge.”

### Isolated development app and release lanes — current

Scient added a managed dev-app path and stable-launcher separation so a
candidate worktree cannot overwrite the stable app’s state. It also replaced
Blacksmith-dependent CI with GitHub-hosted runners and built release gates for
artifact assembly, platform assets, signing/unsigned exceptions, version
alignment, and stable promotion.

Notable behavior and safeguards:

- candidate and stable processes use distinct state roots;
- release assembly verifies the exact artifacts it will publish;
- the workflow can publish an already accepted candidate without rebuilding;
- unsigned Windows publication is an explicit approval path, not an implicit
  fallback;
- platform packaging exposes the pinned package-manager/runtime dependency;
- release notes are bounded, explicit, and not inferred from commits.

Files and PRs: `scripts/`, `.github/workflows/`, `apps/desktop/`, release
documentation, PRs #2–#4, #10–#11, #29, #33, #38–#48, #52, #61–#62,
#65–#67, #72–#73, #78, #86, #91–#97, #110–#112, #131, #139, #140, #145,
#149, #168, #172–#173, and the package/release sections of `UPSTREAM.md`.

This family is mostly delivery infrastructure rather than user-facing
science, but it is Scient-specific because it controls how Scient’s extra
assets and policies are verified and released.

### Scient What's New — current

`apps/web/src/scient/releaseNotes/` supplies a local in-app “What’s New” card,
current-detail view, history, exact app-version association, and a persistent
sidebar affordance. Release entries contain a bounded 1–5 highlight list and
are versioned explicitly. The client stores only the last handled app version
under `scient:release-notes:v1`.

It does not fetch release notes, infer them from Git, publish them, or show
unapproved content. See `docs/internals/scient-release-notes.md`; PRs #37,
#61, #72, #78, #86, #111–#112, #131, #139, #145, and #173.

## 2. Project setup, onboarding, and navigation policy

### Safe project initialization — current

The project-init package creates only missing files:

- `PROJECT.md`;
- `AGENTS.md`;
- `.scient/project.json`;
- a temporary `.scient/project-init.json` transaction marker.

It preserves existing bytes, rejects symlinked targets, operates only on known
paths, coalesces same-root concurrent requests, records identity only after
the documents are in place, and removes the transaction marker after success.
Recovery can complete or safely clear interrupted initialization. It does not
touch `.scient/skills`, the skills lock, sources, or provider data.

Files: `packages/scient-project-init/src/`, `apps/server/src/scientProject/`,
`apps/web/src/components/ScientProjectInitializationDialog.tsx`,
`apps/web/src/hooks/useScientProjectInitialization.ts`,
`apps/web/src/lib/scientProjectInitialization.ts`, the project-opening seams
in `apps/web/`, and their tests. PR #9, with navigation/failure fixes in #76,
#85, #96, #100–#101, and #119.

### Compact getting-started flow — current

The onboarding surface is intentionally short and skippable:

1. choose an AI only when no provider is ready;
2. optionally personalize work kinds and a custom “Other” value;
3. start working, then add a project.

It uses canonical provider/project state as authority and persists only
Scient’s onboarding state (`scient:getting-started:v1` and
`scient:personalization:v1`). It does not add a fake compute-install step or
replace provider setup. Files are under `apps/web/src/scient/onboarding/` and
the onboarding integration in `apps/web/src/`. The full contract is in
`docs/internals/scient-onboarding.md`; PR #136.

### Editorial thread titles — current

Scient added bounded editorial rules for thread titles: short, scannable,
non-redundant, and stable enough for the sidebar. The rules are applied at the
product boundary rather than relying on a provider’s arbitrary title output.
PR #49 and the fork-title ownership sections of
`docs/internals/scient-fork-divergence.md`.

### File breadcrumbs, path copying, and viewer layout — current

Small but user-visible Scient additions include clickable file breadcrumbs,
full-path copying, resizable document viewers, and a narrow-sidebar wordmark
fix. These are not new storage models; they make Scient’s research/document
surfaces navigable and honest about the file being viewed. PRs #119, #124,
#126, #182, and the `apps/web/src/scient/layout/` and file-surface modules.

## 3. Conversations and thread lifecycle

### Durable assistant-boundary conversation forks — current

Scient’s fork is a durable, server-authoritative conversation copy. It can
fork at a selected user message or completed assistant response. A user-message
fork restores the clicked text and images as an unsent draft; it never silently
resends the clicked message. An assistant fork retains the response through
the selected boundary. The dialog can override the title and keeps worktree
mode explicit/off by default.

Architecture:

- the command carries only `originThreadId`, `newThreadId`, workspace mode,
  exactly one selected message ID, and an optional title override;
- the server resolves boundaries from SQL projection/read-model state rather
  than trusting client-supplied counts or transcript boundaries;
- `scient_thread_lineage` records origin/new-thread lineage and logical
  boundary data;
- an independent `scient_schema_migrations` ledger owns Scient migrations;
- a durable saga separates provisioning, visible client thread, and
  navigation milestones;
- attachments, transcript checkpoints, and optional worktrees are copied with
  deterministic IDs and retry-safe receipts;
- the first provider turn uses a one-time provider-neutral transcript bootstrap
  reservation; ambiguous provider sends are not reinjected automatically;
- failures abandon/quarantine safely rather than claiming exactly-once provider
  delivery.

Reliability details include restart-safe reactor work, checkpoint requirements
for worktree mode, same-workspace honesty, source bounds (120,000 characters
and 8 images), title recomputation, and a real-project requirement. The UI
continuity hook prevents a background fork from unexpectedly replacing the
currently viewed thread.

Files:

- server fork orchestration/persistence and migrations under
  `apps/server/src/orchestration/scient-fork/`, plus the reactor wiring in
  `apps/server/src/orchestration/Layers/ScientForkReactor.ts` and
  `apps/server/src/orchestration/Services/ScientForkReactor.ts`;
- `apps/web/src/components/chat/scient-fork/`;
- `apps/web/src/components/scient-fork/`;
- contracts and server/client runtime boundaries;
- `docs/internals/scient-fork-divergence.md`;
- PRs #12–#13, #19–#20, #99, #118, and #159.

The narrow inherited seams are intentional: fork command/event plumbing,
thread creation/navigation, and provider transcript handling remain T3-owned
or T3-shaped; the boundary resolver, lineage, saga, bootstrap, and product UI
are Scient-owned.

### Fork continuation with another provider — current

PR #159 extends a fork’s first turn to a selected provider/runtime while
retaining the same server-authoritative boundary and transcript bootstrap
rules. Provider switching is an explicit continuation choice, not silent
steering or a hidden model substitution. It consumes the provider lifecycle
contracts described below.

### Projectless General Chat / Quick Chat — retired

Scient first built a projectless General Chat, then renamed it to Quick Chat,
and later retired the product surface and projectless threads. The retirement
was deliberate: projectless conversations weakened source/file authority and
made durable lineage semantics less honest. PRs #35 and #57 created/owned the
boundary, #103 renamed it, and #146 removed it. See the retirement report for
the deleted modules, migration 010/043, and preserved historical T3
provenance.

### Per-thread message queue and steer — current

While a turn is running:

- plain Enter queues a message;
- Cmd/Ctrl+Enter steers immediately through the ordinary turn-start path;
- queued items auto-dispatch in order after the active turn settles;
- failed dispatch remains visible and blocks the pump until explicit retry;
- each item can be edited back into the composer, deleted, or reordered;
- text and image attachments survive restart and edit/restore.

The queue is deliberately not an orchestration event. The server persists a
validated pending-composer payload in
`<stateDir>/scient/thread-queue/<sha256(threadId)>.json`, with a 20-item and
64 MiB per-thread cap, atomic mode-0600 writes, serialized mutation lanes,
quarantine of corrupt/oversized files, and safe-filename migration. Removal
happens only after `thread.turn.start` succeeds. There are no queue migrations
or projection events, which makes future retirement to a native T3 queue
bounded.

Files: `packages/contracts/src/scientThreadQueue.ts`,
`apps/server/src/scient/threadQueue/`,
`packages/client-runtime/src/state/scientThreadQueueHttp.ts`,
`apps/web/src/scient/threadQueue/`, and marked seams in `ChatComposer.tsx` and
`ChatView.tsx`. PR #123 and `docs/internals/scient-thread-queue.md`.

## 4. Provider lifecycle and provider-specific behavior

### Capability-driven provider lifecycle — current

Scient models provider state as independent dimensions rather than one vague
“connected” boolean:

- enablement;
- runtime source and health;
- provider support/feature availability;
- authentication state;
- entitlement/subscription state;
- readiness/verification;
- maintenance/operation state.

`ProviderConnectionManager` and `ProviderRuntimeManager` share mechanics but
do not hide provider policy. They expose truthful actions such as Enable,
Install, Use Scient-managed, Update, Repair, Remove, Sign in, Submit code,
Cancel, and Sign out. State is server/provider authoritative; the UI derives
actions from advertised capability, not from a hardcoded button list.

Managed runtime safety includes unique staging, bounded HTTPS downloads,
digest checks, archive traversal/link/duplicate/size rejection, required-file
checks, smoke tests, atomic activation, recoverable operations, and local-only
mutation. Remote clients inspect server-owned paths and do not pretend those
paths are local.

The selection rule is custom executable > healthy explicit managed runtime >
healthy system runtime > legacy managed runtime > missing/repair. Managed
installation is the selection record; there is no second hidden preference
that can drift.

Provider coverage qualified in the reviewed source includes Codex, Claude,
Antigravity, Grok, Droid, and Cursor managed/assisted paths on reviewed
platforms, while OpenCode remains inherited/no Scient-managed catalog. Exact
platform exclusions and target qualification are in
`docs/internals/provider-lifecycle.md`.

Files: `packages/scient-provider-runtime/`,
`apps/server/src/scient/providerLifecycle/`, provider settings/composer
components, contracts, and `apps/web/src/scient/providerConnection/`. PRs
#27–#28, #46, #58, #130, #133, #138, #147–#151, #153–#157, #159,
#162–#167, #170–#180, plus the integration PR #150. PR #190 changes the
settings presentation defaults: shipped providers open to Models when that tab
exists, and authenticated account email begins visible through a narrowly
scoped `defaultRevealed` option rather than weakening the shared redaction
default.

### Codex runtime selection and authentication — current

Scient supervises Codex setup without taking ownership of Codex credentials.
It subscribes before login to `account/login/completed` and `account/updated`,
matches the login ID, then treats `account/read` as authoritative. Because
credential stores can lag notifications, the app-server process stays alive
while the read is retried in a bounded window. A fresh process with the same
executable, effective `CODEX_HOME`, arguments, environment, and working
directory must observe the account before Scient refreshes the provider
snapshot.

Runtime probing uses the effective Codex home and account API, not
`codex --version`. A custom executable remains authoritative; otherwise a
healthy Scient-managed runtime can win over PATH Codex. Diagnostics contain
only display coordinates, never tokens, passwords, or credential-file data.
Files: `apps/server/src/scient/providerLifecycle/Codex*`, Codex driver seam,
`docs/internals/scient-codex-runtime-auth.md`, and PRs #27, #58, #151, #166,
#174, and #180.

### Assisted provider connections — current

Scient adds provider-specific guided setup and recovery for:

- Claude subscription/Console login and revoked-auth recovery;
- Antigravity Google/device-oriented flow and managed-runtime handling;
- Grok ACP connection and cancellation behavior;
- Factory Droid ACP/device pairing and assisted connection;
- Cursor browser/assisted login and startup hardening;
- Codex app-server/browser/device-code style setup.

The providers remain responsible for their own protocols and credentials. The
shared Scient layer supplies action presentation, operation state, verification
and recovery. PRs #27–#28, #46, #130, #133, #138, #147–#150, #153–#180.

### Capability-aware Scient context — current

Scient’s provider awareness contract advertises only what a provider can
actually receive. The reviewed delivery matrix is:

- Codex: developer instructions;
- Claude: system preset;
- OpenCode: prompt system;
- Grok: `--rules`;
- Droid: `--append-system-prompt`;
- Cursor: no verified Scient system extension;
- Antigravity: no verified system extension.

Unsupported providers fail closed rather than receiving a hidden message
prefix, project-rule side channel, or misleading “Scient-aware” claim. The
same principle governs Mermaid, math, chart, source, and skill capability
discovery. Files: `apps/server/src/provider/ScientAwareness.ts`,
`apps/server/src/provider/ScientAwareness.test.ts`, and the modules under
`apps/server/src/scient/`;
PRs #137, #148, #161, and the provider docs.

Agent Browser and project Sources tool access are controlled together by the
server-authoritative `enableAgentBrowserAccess` setting. PR #190 changes the
decoding default to enabled for new and legacy configurations, retains an
explicit false opt-out, and updates the Integrations description to name both
capabilities. The server still gates provider-session capabilities; the setting
does not affect the user's own browser panel.

## 5. Local voice dictation

### Local Whisper transcription — current

Scient voice is a local, final-transcription pipeline. It owns model manifests,
download/verification, WAV validation, a whisper.cpp loopback helper, runtime
lifecycle, cancellation, timeouts, and provider-neutral contracts. Desktop
owns model selection and native lifecycle; web owns microphone capture and the
recording controller; server owns correction helpers and provider-specific
optional correction.

Important behavior:

- each recording owns its stream/audio graph;
- the final AudioWorklet frame is flushed;
- capture uses a 24 kHz AudioContext and area-filtered downsampling;
- stale operations are cancelled with generation tokens;
- inference is serialized and model mutation is guarded;
- the helper uses a random loopback port/path and an environment allowlist;
- model size/header/SHA checks, resumable downloads, and free-space preflight
  happen before activation;
- decoded audio is capped at 10 MiB and base64 is rejected before decode;
- transcript routing returns to the correct composer/thread.

The supported local model set is multilingual Small (~181 MiB, q5_1), Medium
(~514 MiB, q5_0), and Turbo (~547 MiB, q5_0), with hardware heuristics that
recommend Turbo/Medium/Small by logical CPUs and memory. Turbo was added and
then qualified in PRs #14, #41, #156, #160, and #164; routing was fixed in #60.

Files: `packages/scient-voice/`, `apps/desktop/src/scient/voice/`,
`apps/web/src/scient/voice/`, `apps/web/public/scient-voice-worklet.js`,
`apps/server/src/scient/voice/`, native helper staging scripts, and
`docs/internals/scient-voice.md`.

Open-source provenance: whisper.cpp v1.9.1 at commit
`f049fff95a089aa9969deb009cdd4892b3e74916`, with pinned platform archives and
its MIT license/receipt. The current feature is final transcription only;
live preview and benchmark/capability-probe prototype files were removed.

## 6. Scient skills

### Reviewed built-in and project-scoped skills — current

Scient’s skills system is a personal/project skill layer with explicit
authority and identity rules. It supports:

- reviewed release skills containing `SKILL.md` plus `scient.skill.json`;
- exact skill ID/version/origin/digest identity;
- rejection/quarantine of symlinks, non-regular files, malformed or loose
  payloads, and over-size content;
- byte snapshots and immutable per-turn skill sessions;
- project skills in `.scient/skills/<name>/SKILL.md`;
- exact project/worktree scope, trust, and lock/digest policy;
- settings inventory and category display;
- `skills:read`, `scient_skills_list`, `scient_skill_load`, and
  `scient_skill_read_resource` delivery surfaces;
- truthful provider support: full delivery to Codex, Claude, Droid, Grok, and
  OpenCode; fail-closed unsupported delivery for Cursor/Antigravity;
- native provider skill collision precedence over Scient-injected skills.

Current built-ins are:

- `workspace-readiness-review` — automatic;
- `improve-workspace-readiness` — explicit;
- `scient-skill-authoring` — automatic authoring guidance.

The authoring capability is intentionally guidance/data, not arbitrary code
execution. There is no add-on marketplace, executable script runner, personal
upload/import UI, or organization sync in phase one.

Files: `packages/scient-skills/`, `apps/server/src/scient/skills/`,
`apps/web/src/scient/skills/`, `apps/mobile/src/state/scientSkills.ts`,
the three built-in directories, and `docs/internals/scient-skills.md`. PRs
#161, #184, and #185.

The key divergence from a generic “scan some skill folders” implementation is
authority: visible paths do not automatically grant trust, and an inventory
count is not treated as proof that a provider has no skills.

## 7. Scientific sources and citations

### Local-first project source library — current

Scient stores canonical source records inside the project’s `.scient/sources/`
area:

```text
.scient/sources/
  records/                 versioned canonical JSON records
  files/sha256/            content-addressed PDF bytes
  history/<source-id>/     immutable metadata revisions
  operations/              operation receipts/state
  staging/                 import staging
```

The source record, not Zotero HTML or a provider presentation, is canonical.
It preserves provenance, normalized bibliographic fields, optional abstract,
source IDs, external Zotero identity, imported-file identity, hashes, and
revision history. PDF imports hash while copying and promote bytes before a
record can reference them. Atomic writes, exclusive creation, project
identity checks, explicit version decoding, safe removal, duplicate detection,
and optimistic concurrency protect the store.

### Intake and enrichment — current

The web/server surfaces support local PDF intake and read-only local Zotero
intake. Zotero uses its local API v3 at `127.0.0.1:23119`, with bounded
pagination (up to 500 references), flat collection selection, attachment
revalidation, and one deterministic PDF child. Scient never scans Zotero’s DB,
stores credentials, writes Zotero, uses Zotero cloud, or treats collections as
canonical source data.

Exact DOI/PMID enrichment uses bounded, exact-identifier lookups in a preferred
sequence of NCBI EFetch, Crossref `/works/{doi}`, and Europe PMC. The PDF
never leaves the machine for metadata enrichment. NCBI requests share a
serialized interval-limited lane. Journal icons are optional presentation and
cannot block source truth.

### Notes, citation formatting, and agent operations — current

Each source can have one project-owned note with optimistic revision checks.
Agents can use `scient_sources_get` and `scient_sources_note_update`; these
operations cannot write host paths, mutate Zotero, or create a competing notes
format. Citation rendering converts canonical records to CSL JSON and formats
Vancouver/APA7 through Citation.js/CSL. Rendered strings are not persisted as
source truth.

Deliberate non-capabilities: Zotero writeback/sync, record merge, fuzzy search,
OCR, full bibliography generation, mobile source UI, and Artifact Studio
integration. These exclusions prevent an intake library from becoming an
unbounded reference-management product.

Files: `packages/scient-sources/`, `packages/scient-citations/`,
`apps/server/src/scient/sources/`, `apps/web/src/scient/sources/`, source
contracts, and `docs/internals/scient-sources.md`. PRs #71, #75, #82, #114.

Open-source/service provenance: `parse5` for bounded HTML extraction;
Citation.js 0.8.2, `@citation-js/plugin-csl` 0.8.2, and `citeproc` 2.4.63;
CSL style definitions; Zotero local API; NCBI E-utilities, Crossref, and
Europe PMC public exact-identifier endpoints.

## 8. Scientific chat rendering and document presentation

### Math rendering — current

Scient adds a local KaTeX/remark-math pipeline at a single `ChatMarkdown.tsx`
seam. It recognizes model-authored `\(...\)`/`\[...\]`, fenced `math`,
guarded single-dollar math, and standard `$$` while protecting code, links,
paths, shell variables, prices, HTML attributes/comments, incomplete streaming
prefixes, and oversized formulas. Normalization is length-preserving so
offset-based task-list/file-preview behavior remains valid.

Rendering uses KaTeX with safe defaults, dimension/expansion limits, an LRU
cache, literal fallback on parse failure, and `data-markdown-copy` source
round-tripping. Wide display equations scroll inside their own container.
Math is bundled locally and lazily loaded; mobile intentionally keeps raw
delimiters readable because its Markdown pipeline is native/different.

Files: `apps/web/src/scient/math/`, the `ChatMarkdown.tsx` seam,
`apps/web/THIRD_PARTY_NOTICES.md`, and `docs/internals/scient-math.md`. PR #81
plus math follow-up fixes in #105 and #117.

Open source: KaTeX 0.16.47, remark-math 6.0.0, and local KaTeX fonts; all are
documented with licensing notices.

### BiDi/RTL content direction — current

Scient adds explicit `auto`, `rtl`, and `ltr` direction policy for conversation
Markdown and the Lexical composer. The transform is structural: paragraphs,
headings, quotes, lists, tables, and details receive direction metadata; list
and table aggregates remain coherent; nested content inherits deliberately;
flow arrows are normalized; code is untouched. Copy boxes preserve explicit
direction metadata and do not serialize a hidden prompt prefix.

Files: `apps/web/src/scient/bidi/`, the ChatMarkdown/composer seams, and
`docs/internals/scient-content-direction.md`. PRs #15–#17, #116–#117.

### Comfortable Scient typography — current

The product defaults to 18px interface text, 16px prompt text, 15px code/source
text, and 14px terminal text, with fixed tokens for workspace names/file
links/tooltips, diff metadata, and headers. The existing appearance pipeline is
retained; this is a compact token layer, not a renderer fork. Files:
`apps/web/src/scient/typography/`, CSS/theme seams, and
`docs/internals/scient-typography.md`; PR #31 and follow-up #59.

### Mermaid diagrams — current

Settled `mermaid` fences become lazy, local, sanitized diagram cards; streaming
fences stay ordinary code. Scient supports expanded viewing, source/error/
retry states, fit/zoom/scroll, SVG/PNG export, copy preservation, portable
filenames, and unique SVG ID rebasing for duplicated diagrams. Mermaid runs
strictly with callbacks disabled, source/edge bounds, no CDN/remote renderer,
and serialized global configuration. Older/mobile clients keep readable source
fences.

Files: `apps/web/src/scient/diagrams/`, one settled-fence branch in
`ChatMarkdown.tsx`, fixtures, server awareness, and
`docs/internals/scient-chat-diagrams.md`; PR #98 and #105.

Open source: Mermaid 11.16.1, locally bundled under the documented MIT notice.

### Vega-Lite charts — current

Scient renders bounded JSON/JSONC Vega-Lite fences as lazy interactive cards.
It uses the CSP-safe AST expression interpreter, local runtime, SVG/current
state export, inline/expanded live-view transfer, reset/source/export actions,
theme-state preservation, selections, tooltips, bound controls, linked views,
responsive width-only resize, nested composition fixes, unique selection
owners, and explicit warning/source/error states. The authored fence remains
canonical; only a disposable render plan is normalized. Network resources are
bounded and labeled rather than silently treated as local.

Files: `apps/web/src/scient/presentation/` (registry/adapters),
`apps/web/src/scient/visualizations/` (cards, dialogs, runtimes, exports, and
lifecycle helpers), the shared `ChatMarkdown.tsx` fence registry, provider awareness, tests, and
`docs/internals/scient-chat-visualizations.md`; PR #102 and #105.

Open source: Vega 6.3.1, Vega-Lite 6.4.3, vega-embed 7.1.0, and
vega-tooltip 1.0.0, locally bundled under BSD-3 notices.

### Plotly charts — current

Scient adds a CSP-safe complete Plotly strict distribution with lazy loading,
typed-array validation, 2D/3D/WebGL/map/financial/statistical/image/table/
hierarchy/flow trace support, bounded source/value/trace/frame limits, local
interaction controls, current-view export, clipboard/download, MathJax labels,
state preservation, and WebGL lifecycle management. A two-context activity
pool and mutation queue prevent long conversations from exhausting Chromium;
offscreen contexts are explicitly released. Remote images/topology/maps retain
normal Plotly network behavior and are labeled; no credential-bearing loader is
added.

Files share the presentation/fence registry with Vega and are covered by
`docs/internals/scient-chat-visualizations.md`; PR #109 and #105.

Open source: Plotly strict 3.7.0 and MathJax 3.2.2, lazily bundled.

Validation corpus: `docs/fixtures/scient-chat-diagrams.md`,
`docs/fixtures/scient-chat-images.md`, `docs/fixtures/scient-chat-plotly.md`,
`docs/fixtures/scient-chat-visualizations.md`, and the fixture assets under
`docs/fixtures/assets/`. These files are regression inputs for the rendered
surfaces; they are not additional runtime capabilities.

### Workspace image cards — current

Settled Markdown images resolving to supported workspace files receive a
Scient-owned card with renewable signed URLs, lazy decoding, zoom, source
opening, original download, PNG clipboard conversion, relative-path copying,
refresh, and automatic/light/dark backgrounds. PNG/SVG are important
scientific representations, but JPEG/WebP/GIF/AVIF/ICO follow the allowlist.
SVG is loaded only through an `img` and never injected as executable markup.
The Markdown/project file remains canonical; the card is not an artifact store.

Files: `apps/web/src/scient/images/`, image ChatMarkdown seam, asset-server
policy, and `docs/internals/scient-chat-images.md`; PRs #105 and #109.

### Static artifacts and generated-document foundation — current

Scient introduced typed document-artifact bindings, generated-document
publication, resource verification, asset copying, retention/identity rules,
and a static artifact presentation layer. These are foundations for future
Scientific Artifact Studio, not an invented second chat database. Source
Markdown or a producing run remains canonical; SVG/PNG/HTML/PDF are
representations with explicit provenance and bounded lifetime.

Files: `packages/scient-document-artifacts/`, `apps/server/src/scient/documentArtifacts/`,
`apps/desktop/src/scient/documentArtifacts/`, `apps/web/src/scient/artifacts/`,
and `docs/internals/scientific-artifact-studio.md`; PR #68, #87, #107, and the
compute integration PR #158 (the latter is integration-only for its richer
compute layer).

### Scient right-panel surface registry — current

Scient adds a typed right-panel registry for its non-chat surfaces rather than
letting each feature invent tab identity. It normalizes and titles Sources,
source PDFs, static artifacts, generated PDFs, and environment files; surface
IDs are stable for the logical document/artifact while renewable URLs and
revision details stay in surface state. The registry supplies matching icons
and rejects malformed persisted surface values.

Files: `apps/web/src/scient/rightPanel/surfaces.ts`,
`apps/web/src/scient/rightPanel/ScientRightPanelSurfaceIcon.tsx`, their tests,
and the right-panel host seam. This is the connective tissue behind the
Sources, artifact, generated-PDF, and universal-file capabilities above.

## 9. Universal files, PDFs, and HTML export

### Universal file opening — current

Chat file clicks open inside Scient through a server-side `prepareFileOpen`
classification and a set of file-surface adapters. Workspace files use the
inherited editor; absolute outside-workspace files open in the right panel;
HTML receives the integrated Browser path. The server canonicalizes symlinks,
requires a regular file, inspects bounded bytes, recognizes PDF/image/content
signatures, then decodes UTF-8/BOM UTF-16 with extension fallback. Text ranges
are capped at 2 MiB.

Supported surface classes include workspace files, images/SVG, PDF, Markdown,
source, HTML, audio/video, and unknown binary. HTML keeps JavaScript but
rejects traversal, symlinks, hidden sibling resources, and unsafe directory
behavior. Exact signed caps differ between one-file and HTML-directory assets.
Remote paths are labeled honestly as server paths.

Files: `apps/server/src/scient/fileOpening/`, `apps/web/src/scient/fileOpening/`,
`apps/web/src/scient/fileSurfaces/`, shared file-preview seams, and
`docs/internals/scient-universal-file-opening.md`; PRs #30, #64, #74, #76,
#84–#85, #96, #100–#101, #106, #119, #126, #186.

### Preview and workspace-file freshness — current

Markdown/HTML previews open by default, and Scient prevents writes from
truncated previews. Later freshness work adds file-change observation,
auxiliary controls, explicit “Reload file from disk”/refresh behavior, and
coalesced updates while preserving inherited viewer placement. It is a
manual/authoritative refresh contract rather than an invisible mutation of the
user’s work.

Files: `apps/web/src/scient/fileOpening/`, `fileSurfaces/`, the inherited
`FilePreviewPanel` seam, and PRs #30, #64, #74, #186.

### Scient PDF reader — current

The local PDF reader uses bundled PDF.js 6.2.108 worker/maps/fonts/codecs and
annotation assets. It supports virtualized thumbnails, lazy outline/search,
debounced search prewarm, durable sessions keyed by authority and logical
document identity (not expiring signed URL), a 100-session bound, and native
streamed atomic “Save Copy.” It keeps session state across remounts and
revalidates exact signed range/HEAD capabilities.

The scope deliberately excludes annotation editing and OCR. Files:
`packages/scient-pdf-validation/`, `apps/web/src/scient/pdf/`, server PDF
asset/validation modules, desktop document-copy support, and
`docs/internals/scient-pdf-reader.md`; PRs #32, #34, #94, #126.

Open source: PDF.js 6.2.108, locally staged rather than fetched from a CDN.

### Browser HTML-to-PDF export — current

Scient exports the live rendered browser DOM through Chromium
`webContents.printToPDF()`, not by rebuilding Markdown in a different
renderer. It serializes printing, captures the exact live main-frame URL,
rejects loading/navigation/tab-loss races, waits within bounded font/image and
two-frame readiness windows, applies print CSS and deterministic 1/6-inch
margins, and validates the generated PDF structurally with PDF.js.

Generated documents have a bounded local store (500 MiB / 100 revisions). A
local HTML source watcher records exact source/revision changes, coalesces
updates, and offers explicit manual Update without stealing focus. Saving uses
the reader’s native copy path. PRs #68, #134, #186, #187; files under
`apps/desktop/src/scient/documentExport/`, `apps/server/src/scient/documentArtifacts/`,
`apps/web/src/scient/documentExport/`, and `apps/web/scripts/scientPdfAssets.ts`;
the detailed contract is in
`docs/internals/scient-browser-pdf-export.md`.

Deferred items include current appearance/page-control integration, Attach Chat,
and binary uploads over 64 MiB. The browser is a live-document presenter, not
a general server-side HTML execution service.

## 10. LaTeX authoring and navigation

### Local LaTeX build workflow — current

Scient compiles, previews, and edits LaTeX side by side in one local workflow.
It resolves `% !TEX root=` only within bounded initial bytes, enforces project
containment, coalesces builds, limits concurrent compiles, tracks
supersession generations, kills timed-out process trees, preserves the last
good PDF on failure, and publishes only exit-0 PDFs. It captures `.fls`
dependencies and SHA-256 evidence so a source/dependency change triggers the
next build while an unchanged source remains stable.

The compiler runs outside the workspace under `<state>/latex/builds/`; the
workspace never receives aux/output files. Diagnostics include clickable
workspace-relative file/line information, package/install distinction, and
bounded transcripts. Build state is explicit (`queued`, `running`,
`publishing`, `succeeded`, `failed`, `cancelled`).

Toolchain order is system `latexmk`, then Tectonic, then the user-requested
managed TinyTeX install. System TeX is never modified. TinyTeX is pinned to
the reviewed `v2026.08` asset and digest, installed through staging,
verification, smoke test, atomic activation, optional recommended collections,
and recoverable superseded-root cleanup. Downloads use HTTPS and an explicit
host allowlist.

Files: `apps/server/src/scient/latex/`, `apps/web/src/scient/latex/`,
`packages/scient-pdf-validation/` where shared, `scripts/` staging/build
helpers, `.github/workflows/scient-latex-managed-install.yml`,
`scient-latex-seams.json`, and `docs/internals/scient-latex.md`.
PRs #63, #89, #110–#113, #126, #128.

### SyncTeX forward and inverse navigation — current

Every successful LaTeX build may publish an exact-revision SyncTeX index.
Forward search starts from the source editor and maps to the current PDF
revision; inverse search starts from a PDF selection and opens a workspace
source line. Scient preserves ordered candidates, uses safe point coordinates,
handles BiDi/RTL geometry without inventing precision, carries a page hint,
refuses stale/evicted revisions, and fails truthfully when the helper or
workspace target is unavailable.

The bundled SyncTeX reader is built from official MIT-licensed source commit
`82f46b64283b299b045a0295a09aadc11c644e1f` (CLI 1.7/parser 1.31) with pinned
zlib 1.3.2. Source archives and resulting binaries receive SHA/size receipts;
production never falls back to arbitrary `synctex` on PATH. PR #128.

## 11. Scientific computation and analysis foundations

### Analysis/execution runtime foundation — current but deliberately bounded

Scient separates a language-neutral execution state machine from an analysis
specialization:

- `packages/scient-execution` defines run/output/state-machine contracts and a
  simulator;
- `packages/scient-analysis` defines profiles, adapters, source revisions,
  run actions, receipts, stream events, and analysis-specific contracts;
- server analysis coordination owns adapter inspection, lifecycle,
  cancellation races, output bounds, journals, recovery, history, and RPC;
- result promotion turns a successful run into a portable manifest with
  redaction and provenance;
- web presents run state, files, diagnostics, and promoted artifacts.

The MATLAB adapter discovers explicit/PATH/conventional installations, verifies
startup within a bounded window, uses a static `-batch` runner in matlabroot,
and supports `SCIENT_MATLAB_RUNNER`/`SCIENT_MATLAB_ENTRYPOINT`. Output is
bounded (4 MiB, 256 KiB chunks, 25 ms/64-event cadence); history and artifact
retention are bounded; PNG/FIG capture is capped. MException diagnostics,
clickable stacks, stale-source refusal, duplicate-run refusal, cancellation,
lost-run recovery, and exact-file watching are explicit.

The foundation is local and provider-neutral, not a cloud compute platform.
The reviewed scope does not yet include section/variable extraction, rich
format support, MCP/Jupyter/general agent initiation, or broad output
discovery. The mainline MATLAB work originated in #70, was completed for the
first run/history/figure workflow in #79, and added reproducible result
promotion in #87; the larger stateful compute integration is tracked
separately below.

Files: `packages/scient-execution/`, `packages/scient-analysis/`,
`apps/server/src/scient/analysis/`, `apps/web/src/scient/analysis/`, result
promotion/artifact modules, and `docs/internals/scient-analysis-runtime-foundation.md`.
PRs #70, #79, and #87.

### Stateful compute / rich-output integration — integration-only

PR #129 is an open long-lived integration branch, not current `main`. It
contains a language-neutral `ComputeSession`, Python/Jupyter bridge, RPC and
client folding, file-first Python Code/Split/Results, cells/history/live
variables, PNG/SVG figure output, figure following, “Run in session,” and later
isolated-run work. PR #158, merged into the compute branch, adds typed
representation bundles, append-only display facts, bounded Jupyter retention,
content hashes/resource verification, and reuse of Results/figure-following
surfaces.

Do not describe these as shipped mainline capabilities. The exact branch/head,
scope, exclusions, and integration gates are recorded in the PR ledger and
the T3/integration report.

## 12. Analytics and product measurement

### Disabled first-party analytics runtime — current, disabled by default

Scient built a first-party analytics contract/runtime/outbox/worker with
privacy controls and bounded product signals. Delivery is moved off the
server event loop, uses explicit event schemas, and has a disabled default so
analytics cannot silently become a product dependency. The branch history
contains the product-event/privacy branch (#23/#24), which is now an ancestor
of current `main` through the analytics chain (#21/#22).

Files: `packages/scient-analytics/`, `apps/web/src/scient/analytics/`, server
runtime/worker and settings, PRs #21–#24, plus the privacy/product docs. The
feature is infrastructure present in the codebase, not permission to claim
that telemetry is enabled in a given installation.

## 13. Cross-cutting security, reliability, and maintenance capabilities

These changes are easy to omit from a feature list because they do not add a
new button. They are still Scient-specific work when they establish a
Scient-owned safety contract or protect a Scient capability:

- immutable release artifact publication and digest normalization (#33, #48,
  #62);
- safe Windows Whisper archive extraction and dependency packaging (#41–#42);
- provider refresh race isolation and server RPC test isolation (#92);
- stateful server test shard isolation and deterministic activity benchmarks
  (#97, #168, #172);
- PDF reader remount/session preservation (#94);
- restored-file-tab crash prevention (#76);
- file-open/project-navigation race fixes (#85, #96, #100–#101);
- provider lifecycle cancellation/verification and external-runtime redaction
  (#153–#180);
- HTML/PDF readiness, signed asset, URL renewal, and stale-preview guards
  (#64, #106, #134, #186–#187);
- upstream provenance and seam verifiers (`scient-upstream-provenance.yml`,
  `scient-latex-seams.json`, and feature-specific static seam tests);
- documentation-only CI fast paths that keep the large internal design record
  cheap to validate (#65–#67).

The recurring architecture is consistent: authoritative server state, bounded
resources, explicit failure states, local-first data, immutable source
identity, and a narrow marked seam into T3’s host components.

## Current source/package map

### Concrete file-system anchors

These are the recurring implementation and integration locations found in the
checkout. Co-located `*.test.ts`, `*.test.tsx`, seam tests, and fixtures are
part of the capability unless noted otherwise.

| Layer                      | Scient-owned paths                                                                                                                                                                                                                    | What they contain                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contracts           | `packages/contracts/src/scient*.ts`, `packages/contracts/src/orchestration.ts`, `packages/contracts/src/environmentHttp.ts`                                                                                                           | schemas and HTTP/RPC exports for forks, queue, LaTeX, analysis, artifacts, provider lifecycle, skills, and voice                                                            |
| Shared product helpers     | `packages/shared/src/scientForkTitle.ts`, `packages/shared/src/scientRelease.ts`, `packages/shared/src/scientDesktopIdentity.ts`                                                                                                      | product identity, title, and release contracts shared across app layers                                                                                                     |
| Client runtime             | `packages/client-runtime/src/state/scient*`, `packages/client-runtime/src/state/scient-*`                                                                                                                                             | typed HTTP/state clients and subpath exports                                                                                                                                |
| Scient packages            | `packages/scient-*`                                                                                                                                                                                                                   | source/project-init/provider-runtime/voice/skills/PDF/artifact/execution/analysis/analytics/citation libraries                                                              |
| Server orchestration       | `apps/server/src/orchestration/scient-fork/`, `apps/server/src/orchestration/Layers/ScientForkReactor.ts`, `apps/server/src/orchestration/Services/ScientForkReactor.ts`                                                              | fork decider/read models/lineage/migrations/reactor/bootstrap                                                                                                               |
| Server scientific services | `apps/server/src/scient/analysis/`, `documentArtifacts/`, `fileOpening/`, `latex/`, `providerLifecycle/`, `skills/`, `sources/`, `threadQueue/`, `voice/`, `apps/server/src/scientProject/`                                           | authoritative services, stores, adapters, runtime operations, diagnostics                                                                                                   |
| Server provider awareness  | `apps/server/src/provider/ScientAwareness.ts`, `apps/server/src/provider/ScientAwareness.test.ts`                                                                                                                                     | capability advertisement and provider delivery decisions                                                                                                                    |
| Web scientific surfaces    | `apps/web/src/scient/`                                                                                                                                                                                                                | math, BiDi, diagrams, visualizations, images, files, PDF, LaTeX, analysis, sources, skills, onboarding, provider connection, queue, artifacts, release notes, layout, voice |
| Web host seams             | `apps/web/src/components/chat/ChatMarkdown.tsx`, `ChatComposer.tsx`, `ChatView.tsx`, `apps/web/src/components/files/FilePreviewPanel.tsx`                                                                                             | deliberately small Markdown/composer/thread/file-viewer mounts                                                                                                              |
| Fork UI                    | `apps/web/src/components/chat/scient-fork/`, `apps/web/src/components/scient-fork/`                                                                                                                                                   | fork action/dialog and continuity/navigation state                                                                                                                          |
| Desktop surfaces           | `apps/desktop/src/scient/documentArtifacts/`, `documentExport/`, `voice/`                                                                                                                                                             | browser PDF publication, asset copy, native voice bridge                                                                                                                    |
| Mobile boundary            | `apps/mobile/src/state/scientSkills.ts`                                                                                                                                                                                               | native-client skills state compatibility only; no rich web renderer fork                                                                                                    |
| Native/build/release       | `apps/web/public/scient-voice-worklet.js`, `apps/web/scripts/scientPdfAssets.ts`, `scripts/stage-whisper-runtime.ts`, `scripts/stage-synctex-runtime.ts`, `scripts/lib/scient-*`, `.github/workflows/scient-*`, `scient-*-seams.json` | browser/native helpers, packaging, release, and upstream seam gates                                                                                                         |
| Durable project data       | `.scient/project.json`, `.scient/sources/`, `.scient/skills/`, server state `scient/` subdirectories                                                                                                                                  | project identity, source library, project skills, queue, analysis/LaTeX/artifact state                                                                                      |
| Living design/evidence     | `docs/internals/scient-*.md`, `docs/internals/provider-lifecycle.md`, `docs/internals/providers.md`, `docs/internals/provider-lifecycle-capability-audit.md`, `docs/user/`, `UPSTREAM.md`, `upstream-state.json`                      | maintenance contracts, user-facing behavior, rationale, provenance, and retirement conditions                                                                               |
| Regression and user docs   | `docs/fixtures/scient-chat-*.md`, `docs/fixtures/assets/`, `docs/user/`                                                                                                                                                               | rendered-surface regression corpus and user-facing capability descriptions                                                                                                  |

Some small corrective PRs intentionally modify inherited T3 files (for
example, a single `ChatMarkdown.tsx`, `FilePreviewPanel.tsx`, sidebar, or
release workflow line). Those changes are still captured in the PR ledger and
the upstream-refresh records; the presence of a file outside `src/scient`
does not make the whole file Scient-owned.

The following package directories are explicit Scient-owned units in the
reviewed checkout:

| Package                              | Responsibility                             | Key dependencies/source       |
| ------------------------------------ | ------------------------------------------ | ----------------------------- |
| `packages/scient-project-init`       | safe project files and recovery            | Effect/test tooling           |
| `packages/scient-provider-runtime`   | managed archive/runtime lifecycle          | `tar`, `yauzl`, `jszip` tests |
| `packages/scient-voice`              | voice contracts/runtime boundary           | local helper orchestration    |
| `packages/scient-skills`             | catalog, lock, trust, session, documents   | YAML/project-init             |
| `packages/scient-sources`            | canonical source model/store/normalization | Effect, `parse5`              |
| `packages/scient-citations`          | CSL conversion and formatting              | Citation.js, citeproc         |
| `packages/scient-pdf-validation`     | local PDF.js worker/runtime validation     | `pdfjs-dist` 6.2.108          |
| `packages/scient-document-artifacts` | typed artifact bindings and asset copy     | Effect                        |
| `packages/scient-execution`          | language-neutral run state machine         | Effect                        |
| `packages/scient-analysis`           | analysis adapters/receipts/simulator       | execution package             |
| `packages/scient-analytics`          | contract/outbox/worker                     | Effect/runtime                |

The current web Scient tree additionally includes `analysis`, `analytics`,
`artifacts`, `bidi`, `diagrams`, `documentArtifacts`, `documentExport`,
`fileOpening`, `fileSurfaces`, `images`, `latex`, `layout`, `math`,
`onboarding`, `pdf`, `presentation`, `providerConnection`, `releaseNotes`,
`rightPanel`, `skills`, `sources`, `threadQueue`, `typography`,
`visualizations`, and `voice`. The server tree includes corresponding
analysis, artifacts, file-opening, LaTeX, provider lifecycle, skills, sources,
thread queue, voice, and project-init modules.

As a completeness check, the snapshot contains 11 explicit `packages/scient-*`
package directories with 132 tracked files, 24 `apps/web/src/scient/*` roots
with 328 tracked files, and 10 `apps/server/src/scient/*` roots with 144
tracked files. Those counts exclude shared contract/client-runtime files,
fork orchestration, desktop/native files, migration files, workflows, and
documentation; they are inventory checks, not a claim that all Scient work is
confined to those globs.

## What “not inherited from T3” means here

Scient still deliberately inherits the T3 host for the following classes of
behavior: provider driver transport and session machinery, ordinary
orchestration/event sourcing, standard project/workspace UI, native Markdown
host rendering outside the marked adapters, standard editor/terminal
surfaces, and the upstream release/runtime foundation. Scient-specific means
the added policy, contracts, modules, assets, tests, documentation, or marked
seam behavior documented above—not every line that happens to execute in a
Scient build.

For a PR-by-PR accounting, status of every pull request, all upstream refresh
checkpoints, and the complete retirement/defer list, see the companion reports.
