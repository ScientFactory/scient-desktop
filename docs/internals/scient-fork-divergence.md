# Scient conversation fork: design, provenance, and T3 divergence

This document is the maintenance contract for Scient's conversation-fork
feature. It records what the feature promises, which parts Scient owns, and the
small set of T3-owned seams that an upstream merge may touch.

## Product behavior

From the Fork action beside either a sent user message or a completed assistant
response, a user can create a new conversation at that exact point. The origin
conversation continues independently. `/fork` captures the running turn when
one is active, otherwise it selects the latest completed assistant response.

- Forking an assistant response retains the transcript through that response.
  The destination waits for the user's next message.
- Forking a user message retains only the completed transcript before that
  message. The selected text and images are restored as an unsent, persisted
  destination composer draft so the user can edit or send it deliberately.
  The server never sends the clicked message. The origin answer and all later
  history are excluded.

Every path opens one confirmation form. It proposes the server's next automatic
fork title, which the user may replace. Leaving the proposal untouched keeps
title allocation on the server, so concurrent forks still receive a
collision-safe number. **New worktree** is off by default. Turning it on creates
a dedicated Git worktree at the selected historical checkpoint, or a frozen
current-file snapshot for a running-turn fork. It is available only when that
baseline can be captured safely. Leaving it off
keeps the conversation branch independent while using the origin project's
current workspace; it does not rewind local files.

The new conversation shows the retained transcript prefix. Its first provider
turn uses a native Codex fork only when Scient can prove that the source session
contains the entire retained history and can fork at the selected boundary.
Otherwise, it starts a fresh provider session and receives bounded context from
the saved transcript. The provider session tip alone does not establish a safe
historical fork boundary.

The client navigates to the new conversation only after durable provisioning
has completed. A failed fork is returned as an error instead of exposing a
half-ready conversation as successful.

The destination also inherits safe, durable right-panel intent: files, diffs,
pull requests, Agents, Sources, source PDFs, and portable Scient artifacts.
Live terminal sessions are intentionally dropped. Live browser tab identities
are replaced by one fresh browser surface rather than reusing another thread's
session. Workspace-backed or attachment-backed transient artifact surfaces are
dropped. Open attachment previews use the server's durable copy receipt to
switch to fork-owned attachment IDs; attachments outside the retained prefix,
or without a verifiable mapping from an older server, are omitted. This receipt
survives client reloads with the pending fork attempt.

PDF reading state belongs to the thread as well as the document. The fork copies
the origin's current reading state once, then the two conversations navigate
independently even in a shared workspace. For a separate worktree, the client
freezes file-PDF viewports at handoff and seeds the destination paths before
mounting their viewers. Seeding happens when the fork is created, before the
client switches to it, because a PDF viewer records its own position as soon
as it opens. If the fork's folder is not yet known then (for example after a
reload), only that fork's right panel is held until its positions are applied,
once. Other threads and later folder changes never hide or remount the panel. Repeated restoration never overwrites a destination's
newer position. Continuity is best-effort and cannot make a provisioned fork fail.

The fork lifecycle has three separate readiness milestones:

1. **Server provisioning complete:** the durable fork workflow has created and
   verified the destination thread, retained transcript, attachments, and
   requested workspace substrate.
2. **Route selected:** after the server receipt, the client opens the destination
   route. The route may still be loading its authoritative detail subscription.
3. **Thread visible:** the destination detail has reached the client store and
   the route renders the conversation.

These milestones must not be collapsed into a fixed delay or treated as
interchangeable. There is no five-second visibility deadline. An absent sidebar
entry is not evidence that a thread is missing: only an explicit deletion from
the detail subscription permits the missing-thread redirect. This also permits
opening archived originals through the lineage marker.

The clicked message ID is the public boundary. The server validates its role
and durable projection, then resolves the completed conversation boundary and
checkpoint authoritatively; the client never supplies those implementation
details. A first user message legitimately resolves to a synthetic turn-zero
boundary and becomes the destination's unsent draft. Internal turn-zero baselines also
remain valid when re-forking an inherited transcript. A user can fork a sent
message or the latest completed response while a newer turn is active. Git
checkpoint availability only decides whether the independent-worktree choice
is eligible; same-workspace conversation forks also work in non-Git projects.
Explicitly addressed archived origins remain readable for this decision;
deleted origins do not.

## Preserved Claude provenance

Claude's implementation remains intact in Git; it was not squashed or rewritten.

- Prototype commit: `8ca683819caa7c956a5013a1e47707d52a04a401`
- Permanent archive branch: `archive/claude-fork-prototype-20260808`
- Scient base used by the prototype: `4138d41362cce474ef08f3fefc6e1ec1e41a847d`
- Official T3 head merged before hardening:
  `4eaf5ef8bb47b870397d5c61cd216b1a6bdd1510`
- Dedicated initial T3 merge commit:
  `b4ccca5038cf400533c5de58dc12cac2d80d98be`
- Fork hardening commit: `a851a0ae0611f7c9cbf2381d1e6e240d0657b2ae`
- Prior official T3 head verified and merged after hardening:
  `ed886fe1814890da30ae73c77f9e894ddc9bd481`
- Prior T3 merge commit: `d2bc490731e778cf6c3a05822452768b8403455a`
- Explicit workspace-choice UI commit: `29ea5973c1bc0ba348ae67447ba0b6aab85a7290`
- T3 integration head at implementation time:
  `2c7267ad43a05cf3e30343400c76fd9ac47698e7`
- Current T3 merge commit: `13e33f1ba9614fdc4490de1526d4d16a3f91ad7f`

The hardened implementation descends from the prototype and the dedicated T3
merge. Future changes must keep the prototype commit and archive branch
reachable even if publication later uses a different presentation strategy.

## Reliability model

Forking is a durable, restart-safe saga:

1. The event-sourced decider resolves the requested assistant or user message
   to an authoritative completed conversation boundary; allocates fresh thread,
   turn, message, and attachment identities; emits the new thread
   plus retained transcript as one immutable turn-zero baseline; and records
   immutable lineage.
2. The Scient lineage projector inserts a durable `pending` record.
3. The Scient fork reactor claims the record, copies fork-owned attachment
   files, establishes the selected checkpoint baseline, and creates the
   worktree when requested.
4. Deterministic branch, ref, worktree, and internal command identifiers make a
   retry idempotent. Startup recovery resumes `pending`, `provisioning`, and
   retryable `failed` records. The durable completion receipt also self-enqueues
   its lineage row, so a missed live wake-up cannot strand an accepted fork.
   A repeated command with the same identity reuses its accepted receipt and
   retries a failed provisioning record without a server restart. The worker
   deduplicates queued/in-flight destination IDs, so live delivery and receipt
   recovery do not accidentally retry the same failure twice.
5. The reactor records `ready` only after every required substrate is verified.
   The WebSocket command waits for this typed completion receipt. The serialized
   command handler rejects turn starts before readiness, before persisting their
   user message; background sends cannot write into a fork awaiting setup.
6. The copied logical-boundary manifest records remapped turn and message IDs.
   It lets a fork be forked again directly, without walking ancestor threads or
   pretending copied transcript rows are provider-native turns.
7. For a user-message fork, the web client prepares every authorized image,
   persists the complete unsent destination draft, and flushes storage before
   issuing the server command. Only a confirmed rejected or abandoned operation
   removes that staged draft; an interrupted connection does not.
8. On the first provider turn, the fork's context transfer is resolved: a
   native provider fork when possible (Codex), otherwise a portable handoff
   delivered to one specific provider-native thread. See
   [Provider context delivery](#provider-context-delivery). No outcome is a dead
   end: a send that provably went nowhere is simply retried, and an uncertain
   one is re-delivered on a fresh provider session.
9. Terminal failures such as a disappeared origin attachment or an unavailable
   required worktree checkpoint delete the unusable target thread and record an
   `abandoned` lineage state. Transient failures remain retryable.

The domain-event stream is only a wake-up signal. The lineage table remains the
authority, so a restart or missed live event cannot lose the work.

### Client operation identity and eligibility

`orchestration.getForkOptions` is a read-authorized, capability-gated query
(`threadForkRecovery`). It resolves either a specified user/assistant message
or, when neither is supplied, the latest completed assistant boundary. It
checks retained attachment availability and distinguishes an existing local
workspace from a resolvable Git checkpoint. Both the preview and submission
use this query; the decider and provisioning worker remain the final authority
because dependencies can change after a preview.

`forkAttempt.ts` journals the exact command, environment, destination, display
title, and handoff milestones under `scient:fork-attempt:v1:` in client storage.
The key includes environment, original thread, and fork entry point. A retry
uses the saved command even if a caller supplies different options. No prompts,
file bytes, or authorized asset URLs are duplicated into this journal; drafts
remain in the existing composer store. Journal writes must succeed before
dispatch. Origin-scoped in-memory ownership survives hook remounts, with Web
Locks preventing concurrent operations in other tabs of the same profile.

Fork dispatch errors carry an optional `forkDisposition`. `rejected` means a
known command rejection; `abandoned` means terminal compensation; `failed`
means provisioning is retryable; `pending`/`provisioning` mean work exists;
`ready` proves completion. Missing evidence is `unknown`, never rejection.
Transport errors without this field preserve both the command and draft.
Once ready, retry only performs the client handoff and navigation. Optional
panel continuity cannot turn a ready fork into a failed creation.

After provisioning succeeds, the source dialog finishes its existing exit
animation before the draft handoff and navigation. Base UI
`onOpenChangeComplete(false)` owns this boundary; there is no fixed delay. The
form stays unchanged during its exit. Leaving the source or unmounting cancels
the pending navigation, while a navigation failure reopens the same retry form.

Errors and retries stay inside the existing confirmation form. Title and
workspace inputs are locked while resuming an unresolved operation. Navigating
elsewhere or unmounting the hook does not cancel accepted server work and does
not allow its completion to steal navigation. An unfinished client handoff is
resumed from the same Fork action; deliberate new forks are possible after the
previous handoff has completed.

Automatic names remain server-allocated and custom titles remain authored
command data. Renaming either thread never changes lineage identity. The
marker links by environment and original thread ID, not by title. Provider
selection remains the ordinary model-picker operation on a destination with
no provider session. The provider-switch handoff moves the ordinary draft only
when its prompt and attachment identity still match the captured SHA-256 fingerprint;
changed drafts, queued messages, queue-edit drafts, and queue order remain in
their original conversation. Forking emits no turn-start request.

### History and workspace fidelity

Retained messages are bounded by the selected assistant's position, including
system messages: later system messages cannot leak into an earlier fork. A
legacy message without a turn ID may use its authoritative SQL boundary's
identity; a conflicting non-null turn ID still fails validation. Copied logical
boundaries, rather than ancestor lookups, continue to own re-fork/revert history.

Attachment copies publish by rename only after size verification. Retries can
reuse a complete destination-owned attachment even if the original was removed
after copying. Temporary `.part` files are cleaned on ordinary completion or
failure and use the existing stale-partial sweep after a crash. A missing
attachment is never silently omitted to make a fork appear successful.

A local fork requires its actual workspace directory. If an original worktree
was removed, an explicitly selected new-worktree fork may resolve the historical
checkpoint from the owning project repository. It never falls back to another
workspace for a local request. Provider initialization remains independent of
Git availability for valid non-Git local workspaces.

## Scient-owned implementation

These modules contain the fork behavior and should remain independent of T3
internals:

- `apps/server/src/orchestration/scient-fork/forkDecider.ts`
- `apps/server/src/orchestration/scient-fork/forkRepository.ts`
- `apps/server/src/orchestration/scient-fork/lineageProjection.ts`
- `apps/server/src/orchestration/scient-fork/schema.ts`
- `apps/server/src/orchestration/scient-fork/scientMigrator.ts`
- `apps/server/src/orchestration/scient-fork/migrations/`
- `apps/server/src/orchestration/scient-fork/ForkAttachmentCopier.ts`
- `apps/server/src/orchestration/scient-fork/ForkCheckpointBaseline.ts`
- `apps/server/src/orchestration/scient-fork/ForkContextDelivery.ts`
- `apps/server/src/orchestration/scient-fork/context/` (budget, history, native thread identity)
- `apps/server/src/orchestration/scient-fork/forkActivityCopy.ts`
- `apps/server/src/orchestration/scient-fork/forkLiveTail.ts`
- `apps/server/src/orchestration/scient-fork/inheritedTurns.ts`
- `apps/server/src/orchestration/scient-fork/liveTurnFlush.ts`
- `apps/server/src/provider/turnDispatchPhase.ts`
- `packages/contracts/src/scientForkSettings.ts`
- `apps/web/src/scient/fork/ForkContextSettings.tsx`
- `apps/server/src/orchestration/scient-fork/forkDecisionReadModel.ts`
- `apps/server/src/orchestration/scient-fork/forkBoundaryTypes.ts`
- `apps/server/src/orchestration/scient-fork/ForkBoundaryReadModel.ts`
- `apps/server/src/orchestration/Services/ScientForkReactor.ts`
- `apps/server/src/orchestration/Layers/ScientForkReactor.ts`
- `apps/web/src/components/chat/scient-fork/ScientForkMessageButton.tsx`
- `apps/web/src/components/chat/scient-fork/ScientForkWorkspaceModeDialog.tsx`
- `apps/web/src/components/scient-fork/forkViewContinuity.ts`
- `apps/web/src/components/scient-fork/useScientThreadFork.ts`

Tests live beside these modules. The checkpoint helper uses T3's existing
`VcsProcess` and `CheckpointStore`; it does not extend T3's VCS,
checkpoint-store, or Git-driver interfaces. Provider adapters change only to
opt into native fork (`capabilities.nativeFork`, Codex `thread/fork`).

Scient database state uses `scient_schema_migrations`, a separate migration
ledger. It never consumes or predicts a T3 numbered migration. The
`fidelity_mode`, `provider_mode` and `provider_bootstrap_*` compatibility
columns are retained physically for prototype upgrades but are no longer active
runtime authorities; context delivery lives in `scient_context_transfers` and
`scient_context_handoffs` (migration 14).

## Stack phase A: server-owned boundary resolution

Stack phase A moves fork boundary authority from client-shaped thread snapshots to a
Scient-owned server resolver. The public fork command carries
`originThreadId`, `newThreadId`, `workspaceMode`, and exactly one of
`sourceAssistantMessageId` or `sourceUserMessageId`, plus an optional
user-authored `titleOverride`. The server independently
queries SQL-backed `projection_turns`, `projection_thread_messages`, and
`scient_thread_lineage` to validate message role/order and resolve the exact
completed boundary, its turn ID, conversation count, and checkpoint
eligibility. The client never supplies boundary arrays, turn counts, checkpoint
relationships, or automatic title-allocation authority.

### Boundary ownership

```text
client assistant- or user-message ID
        |
        v
Scient server boundary resolver (ForkBoundaryReadModel)
        |
        +--> authoritative turn/count/checkpoint decision
        +--> retained transcript prefix selection
        +--> durable lineage and provisioning
        +--> narrow baseline marker metadata for client presentation
```

The resolver (`makeForkBoundaryResolver`) queries SQL at resolution time,
independent of any cached snapshot. The pure fork decider (`forkThread`)
consumes the resolved boundaries exclusively and does not read
`origin.conversationForkBoundaries` from the read model. The
`OrchestrationEngine` hydrates only the requested origin detail inside the
serialized command worker, then delegates to the resolver before calling the
decider. Missing origin detail or boundary resolution fails closed; production
code never synthesizes conversation authority from Git checkpoints or cached
snapshot arrays.

User-message boundaries are paired through the authoritative turn projection,
using each turn's pending user-message ID rather than message timestamp or
lexical ID ordering. Legacy rows without that association use a conservative
strictly-earlier turn timestamp fallback; an equal timestamp is excluded. This
may omit an uncertain prior boundary, but it cannot retain the response to the
user message being forked and then send that message again.

### Fork title ownership

Automatic title numbering is shared pure logic in
`packages/shared/src/scientForkTitle.ts`, but the server remains authoritative.
The client uses the same function only to preview the likely title. If the user
leaves that proposal untouched, the command omits `titleOverride` and the server
recomputes against its current project threads when the fork commits. If the
user edits the field, the trimmed non-empty value travels atomically with
`thread.fork`; it does not grant any authority over boundary resolution,
retained history, checkpoints, or provisioning.

`threadForkTitleOverride` is an optional environment capability. Clients
connected to an older server show its automatic proposal read-only and never
send the new field.

### Projection state narrowing

Complete boundary arrays have been removed from global shell snapshots and
ordinary client thread detail. The client receives only a narrow lineage
marker (`originThreadId` and `baselineAssistantMessageId`) from
`scient_thread_lineage`, sufficient for presentation and navigation. Server
detail queries may retain an internal boundary representation for authoritative
resolution, but that representation is not a client-wide contract.

### Snapshot watermark coverage

`REQUIRED_SNAPSHOT_PROJECTORS` includes `threadTurns` (writes
`projection_turns`) and `scientThreadLineage` (writes `scient_thread_lineage`)
so the reported `snapshotSequence` cannot advance ahead of the projectors
whose tables the snapshot queries for fork-boundary, checkpoint, or
latest-turn data. The prior PR 13 baseline omitted both while including the
no-op `checkpoints` projector; stack phase A closes this gap.

### Bootstrap projector ordering

During bootstrap and restart replay, `scientThreadLineage` completes its pass
before `threadMessages` and `threadTurns`, because revert projection reads
`baseline_turn_id` from `scient_thread_lineage` to decide which baseline row
to preserve while trimming later turns. `threadTurns` also bootstraps before
`threadMessages`, `threadActivities`, and `threadProposedPlans` because those
projectors list `projection_turns` during revert replay. If lineage or turns
have not yet projected when revert events replay, baselines can be dropped or
orphaned.

### T3 migration isolation

T3 owns `effect_sql_migrations`; Scient owns `scient_schema_migrations`. Both
ledgers use integer IDs starting from 1, but they are separate tables in the
same SQLite database. The Scient migration runner (`runScientMigrations`)
never inserts into, deletes from, or modifies T3's migration ledger or
numbering. It runs the standard Effect SQL Migrator with its own table name,
giving transactional, ordered, ledger-driven execution. Cross-area
integration tests verify this separation on fresh startup.

The runner reconciles the legacy `applied_at` timestamp column with the
canonical `created_at` column by rebuilding a legacy ledger table in a single
transaction: `created_at` is copied from `applied_at`, and `applied_at`
remains as a nullable historical-residue column. Fresh databases get the
canonical `created_at` table directly from the standard Migrator. No
timestamp value, ledger ID, or migration name is lost or altered. Legacy
migration IDs 1 (`durable-thread-forks`) and 2 (`durable-provider-bootstrap`)
are preserved and never re-run.

### Cross-area integration tests

`apps/server/src/orchestration/scient-fork/crossArea.test.ts` exercises the
full resolver-to-projection-to-lineage flow:

- **VAL-CROSS-005:** A non-final selected assistant remains the exact endpoint
  across the SQL read model, decider prefix, fork event payload, destination
  projection, and Scient lineage row.
- **VAL-CROSS-010:** Revert preserves the immutable baseline, removes later
  projection boundaries, permits a fork at or before the revert point, and
  rejects a reverted-away assistant with no side effects.
- **Fresh startup:** A fresh in-memory SQLite startup creates both migration
  ledgers, the Scient schema, and resolves a valid fork boundary. The T3
  ledger remains unchanged after Scient schema operations.

`apps/server/src/orchestration/scient-fork/crossAreaPR15.test.ts` exercises
cross-layer flows spanning phase A boundary resolution and phase B migration,
lifecycle, recovery, and normalization:

- **VAL-MIGRATE-13:** Prototype rows migrated through the normalization
  migration support full lifecycle operations: recovery selects only
  pending/provisioning/failed with baseline, claims increment attempts,
  ready/abandoned cannot regress, and ready clears errors.
- **VAL-CROSS-001:** Fresh startup creates isolated ledgers, resolves a SQL
  boundary, projects ordered destination events, persists pending lineage via
  the lineage projector, and the reactor claims and marks ready without origin
  mutation.
- **VAL-CROSS-002:** A prototype database with `applied_at` ledger and
  `chat-only`/`replay` fidelity modes is normalized in place: identity is
  preserved, modes become `transcript-bootstrap`, and repository decoders
  (`listRecoverableForks`, `getForkStatus`) read the normalized rows.
- **VAL-CROSS-003:** Restart during pending fork is safe: migration rerun is
  idempotent, pending fields are unchanged, recovery finds the pending row,
  duplicate claims increment attempts, and provisioning completes to ready.
- **VAL-CROSS-004:** Interrupted provisioning retries deterministically:
  recovery reclaims a provisioning row with incremented attempt, terminal
  failure becomes abandoned, and abandoned is excluded from recovery and not
  retried across restarts.
- **VAL-CROSS-006:** Re-fork after normalization uses only canonical values:
  the fork-of-fork payload, lineage row, and repository decode all show
  `transcript-bootstrap` with no prototype mode leaks.
- **VAL-CROSS-008:** Scient and T3 migrations remain disjoint in both orders:
  neither ledger contains the other's migration names, reruns are idempotent,
  and hypothetical T3 ID 39 and Scient ID 3 cannot collide (separate tables).

## Stack phase B: normalized Scient persistence

Stack phase B replaces the monolithic startup schema inspection with a real
Scient-owned versioned migration runner and normalizes the active lineage
model. The migration runner, lifecycle guards, and provider bootstrap
normalization are all Scient-owned and isolated from T3's migration ledger.

### Versioned migration runner

The Scient migration runner (`scientMigrator.ts`) delegates to the standard
Effect SQL Migrator (`Migrator.make`) with its own `scient_schema_migrations`
ledger table. It runs as a side effect of `SqlitePersistenceMemory` layer
construction, before `pipeline.bootstrap` runs T3 migrations. Four migrations
established the fork foundation:

1. `durable-thread-forks` — creates the initial `scient_thread_lineage` table.
2. `durable-provider-bootstrap` — adds provider bootstrap columns.
3. `normalize-active-lineage` — adds lifecycle columns, quarantines malformed
   rows into `scient_thread_lineage_quarantine` (payload snapshot, reason,
   timestamp) instead of failing startup, normalizes prototype modes to
   `transcript-bootstrap`, and creates supporting indexes.
4. `quarantine-invalid-lineage` — preserves migration 3 as immutable history,
   upgrades legacy quarantine evidence without loss, and quarantines every row
   the active repository/recovery model cannot safely decode. It keys evidence
   and deletion by SQLite row ID so null or blank thread IDs are handled
   without collision or undeletable rows.

Later Scient-owned migrations add independent projection and storage state.
Migration 8 retains its pre-commit development ledger name,
`fork-delivery-and-seed`, so already-tested local databases remain readable;
its canonical body now adds the fork-point kind, copied logical-boundary
manifest, and exact provider-delivery reservation fields. Migration 9,
`copied-fork-boundary-manifest`, is an idempotent compatibility convergence for
development databases that recorded the earlier migration-8 body. Fresh
databases receive the column in migration 8 and migration 9 becomes a no-op.

Before the Migrator runs, two Scient-owned preflight passes execute: a
transactional rebuild of legacy `applied_at` ledgers into the canonical
`created_at` shape, and a strict integrity validation requiring the recorded
ledger to be a contiguous prefix of the manifest with exact name matches.
Gaps, renamed entries, and unknown future IDs fail closed with a `BadState`
error before any migration runs — the standard Migrator's high-water mark
alone would silently accept the manifest.

Each unapplied migration runs once, transactionally, in ascending ID order.
Migration failure rolls back the entire transaction: no partial records, no
partial schema changes. Concurrent startup uses PRIMARY KEY constraint
conflicts as a lock: the loser gets an empty result.

### Ledger reconciliation

Existing development databases created by the legacy `ensureScientForkSchema`
have an `applied_at TEXT NOT NULL` timestamp column in the ledger and no
`created_at`. The standard Effect Migrator expects the canonical
`(migration_id, created_at, name)` shape and inserts only `(migration_id,
name)`, relying on `DEFAULT current_timestamp`. The runner detects a legacy
ledger (`applied_at` still `NOT NULL`) and rebuilds it in one transaction: a
canonical replacement table is created, `created_at` is copied from
`applied_at`, `applied_at` is retained as a nullable historical-residue
column, and the old table is dropped and the replacement renamed over it. A
nullable `applied_at` residue marks a completed rebuild, so the pass is
idempotent, and a crash mid-rebuild rolls back cleanly. Fresh databases
receive `created_at` directly. No timestamp value, ledger ID, or migration
name is lost or altered.

### Normalization and lifecycle guards

Migration 3 normalizes prototype mode values (`cold-start`, `chat-only`,
`replay`) to the canonical `transcript-bootstrap` active model. It adds
lifecycle columns (`status`, `checkpoint_status`, `workspace_status`,
`attempt_count`, `last_error`, `updated_at`) with safe defaults. Physical
compatibility columns (`provider_mode`, `fidelity_mode`) remain queryable with
data; only active runtime reads/writes use the canonical model. No columns are
dropped in the first normalization pass.

Migration 4 is deliberately additive because development databases had already
recorded migration 3 before its validation rules were finalized. Rewriting
migration 3 would make the repair invisible to those databases. Migration 4
therefore creates or upgrades the quarantine table, preserves existing evidence,
validates baseline identity, counts, attachment JSON, lifecycle values, and
required IDs, then removes only invalid active rows by `rowid`. Tests cover the
already-recorded migration-3 state, legacy evidence upgrade, null/blank IDs,
malformed recovery data, valid-sibling preservation, and idempotent reruns.
Pre-bootstrap prototype rows without a baseline turn are therefore removed from
active lineage, status, and fork-marker reads; their original payload and the
reason for quarantine remain preserved in the evidence table.

Terminal lifecycle guards are enforced in repository SQL predicates:

- `markForkFailed`: WHERE `status NOT IN ('ready', 'abandoned')` — abandoned
  cannot regress to failed.
- `markForkAbandoned`: WHERE `status NOT IN ('ready', 'abandoned')` —
  already-abandoned rows are unchanged.
- `markForkReady`: WHERE `status IN ('pending', 'provisioning', 'failed')` —
  only non-terminal, non-ready states can transition to ready.
- `claimFork`: WHERE `status NOT IN ('ready', 'abandoned')` — terminal and
  ready states cannot be claimed.
- `beginAttempt`: requires `status = 'ready'` plus
  `provider_bootstrap_status = 'pending'`, and atomically reserves the exact
  outbound user-message ID.
- `markAccepted`: requires `provider_bootstrap_status = 'sending'` and that
  exact reserved message ID. A mismatched or non-ready fork cannot reach a
  completed acceptance marker.
- `markAmbiguous`: transitions only that same in-flight reservation; repeated
  recovery calls are idempotent, while a different message ID fails closed.

### Provider bootstrap normalization

Superseded by Scient migration 14 and
[Provider context delivery](#provider-context-delivery). The old
`provider_bootstrap_*` columns remain for downgrade safety but are no longer
read. Migration 14 carries prior state into handoff rows. Migration 15 adds
native-turn evidence, frozen snapshot identities, and handoff audit artifacts.
Migration 16 preserves completed legacy deliveries against the session identity
saved before resume, explicitly marking that continuity as assumed. It does not
reset a session solely because the old delivery lacked session-specific proof.
See the legacy preservation rules below for replacement and undo handling.
The four latest delivery preambles per fork are retained; older receipts keep
their status and counts without retaining repeated full text. Recovery stays
automatic, without an upgrade dialog or extra user step. The saved Scient
transcript and workspace stay intact; provider-only details can still be lost
when an actual discontinuity requires rebuilding the provider session.

## Provider context delivery

`ForkContextDelivery.ts` (replacing `ForkContextBootstrap.ts`) follows
upstream Orchestration V2's model; names and literals mirror V2 wherever the
meaning is the same.

- **Context transfer** (`scient_context_transfers`, one per fork):
  `pending` -> `resolved_native` | `resolved_portable` -> `consumed`, with a
  `resolution_json` (`native_fork` / `portable_context`), a `fidelity`
  (`native` / `portable` / `portable_mid_turn`) and an `error` that records why
  a native fork was not possible.
- **Handoffs** (`scient_context_handoffs`) are delivered to one
  provider-native thread (`native_thread_key`, derived per provider from the
  live `ProviderSession.nativeSessionId` when supplied, with a resume-cursor
  fallback in `context/nativeThreadKey.ts`). A live identity is not a resume
  credential: an adapter may know it before its transcript is durable. It must
  match the native identity in the eventual cursor. Validated cursors are saved
  on turn completion or abort before publishing that event, including for
  providers whose first send acknowledgement precedes transcript creation. Delivery is `pending` while
  the send is in flight and `inline` once accepted. A provider-native thread
  that has not received the context gets it again: a Codex resume that fell
  back to a new thread, a provider switch, a session after a crash.
- **Failure semantics** (`provider/turnDispatchPhase.ts`): `ProviderService`
  marks every failure raised after it handed the turn to an adapter. Anything
  unmarked provably sent nothing (`notSent`): the pending row is removed and the
  next message simply retries. Anything else is `maybeDelivered`: the row stays
  `pending`, and the next turn settles it from provider evidence or starts a
  fresh provider session (`ProviderService.discardSessionContinuity`) and
  delivers again. A duplicate can only exist in the abandoned session.
- **Evidence, not acceptance.** A handoff counts as received once the provider
  reported the turn it started, or while that turn still runs. New deliveries
  retain the provider send receipt's turn ID and verify that exact turn in the
  durable projection; older deliveries use `projection_turns.pending_message_id`.
  This survives an internal session reset clearing the temporary pending-message
  record, so recovery does not reset and resend history on every later message.
  Acceptance alone is insufficient: an adapter that only enqueued the turn in
  memory (Claude) and then died is re-delivered. Existing incomplete receipts
  may need one fresh delivery before later turns can reuse the confirmed session.
- **Revert** invalidates a handoff whose carrying turn was removed. Every
  preparation rechecks durable turn evidence, including previously confirmed
  rows, so a missed live notification cannot retain stale trust. A changed or
  unknown native identity requires reset and portable delivery. The old row
  stays active until reset succeeds and the replacement handoff is committed.
- Native session identity includes its configured provider instance, so an
  equal provider session ID in a different runtime cannot establish continuity.
- **Silent legacy preservation.** Migration 16 binds completed legacy deliveries
  to the provider session identity already saved at database startup, before any
  resume can replace it. That session continues without resetting, re-sending
  history, or prompting the user. `continuity_basis = legacy_assumed` records
  inherited trust rather than verified delivery; it does not create native-turn
  coverage. Session replacement (including failed first resume) or provider-instance
  change triggers normal fresh-session recovery. Known carrying turns retain the
  normal undo rule: re-deliver only when that turn is removed. Where the old record
  has no carrying turn, a saved revert-event sequence invalidates the assumption
  on any later undo, even when its live notification is missed. Earlier undos do
  not by themselves invalidate the upgrade assumption.
  Missing or malformed saved identities and incomplete/ambiguous old deliveries
  remain on the recovery path. Already-broken legacy sessions can remain broken
  until a tracked discontinuity; preservation deliberately retains that pre-existing
  uncertainty to avoid discarding healthy sessions' provider-only memory.
- A later message never waits for an in-flight handoff: that decision runs on
  the provider command queue shared by every thread. There is no fork-specific
  deadline on the send itself, because adapters such as Droid keep that call
  open through turn completion, including tool work and approvals; provider
  lifecycle handling owns its failure and cancellation. Delivery is proven by
  the provider starting the turn that carries the history
  (`projection_turns.pending_message_id`) on the same provider session. With
  that proof, a later message (for example a steer) is sent without history
  immediately. Without it (the second or two before the provider confirms),
  the later message is refused with a retryable error. It never bypasses the
  history and never blocks other threads.
- **Separate channel.** The handoff travels as `ProviderSendTurnInput.contextPreamble`,
  concatenated immediately before adapter dispatch. The 120,000-character input
  limit keeps measuring only what the user sent; optional skill discovery is
  dropped before any rejection. The preamble is bounded by
  `PROVIDER_CONTEXT_PREAMBLE_MAX_CHARS` and, before that, by the budget below.
- **Budget** (`context/handoffBudget.ts`, V2's `ContextHandoffBudget`
  formula): `min(cap, window − native usage − current input − max(16k, window/4))`,
  using the selected instance/model's adapter metadata and custom-model
  limits, with a 128k fallback when capacity is unknown. Codex reports are
  associated with their turn's model on that adapter instance; resolved
  capacities are retained for that exact model selection across restarts.
  A source's usage for a different destination model is never reused. Tokens are estimated as
  `ceil(bytes / 3)` (V2 uses one byte per token). The cap is the Settings preset
  `scientFork.contextHandoffSize` (Compact 16k, Standard 64k, Large 128k,
  Maximum = window-bounded); `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` overrides.
  The header and reattached content must fit too. ProviderService checks the
  composed preamble, user input, skills and attachments again immediately
  before dispatch, dropping optional discovery before a typed rejection.
  Lookup policy lives in the Scient fork module. The final provider-service
  seam receives only an internal numeric allowance, outside the shared wire
  contract. These are explicit estimates and allowances, not a tokenizer guarantee.
- **Selection** (`context/handoffHistory.ts`, V2's `selectHistory`): whole
  items in V2's priority order (latest user, latest assistant, first user, then
  newest to oldest). Scient extensions: reasoning and tool work are items; the
  latest turn's thinking ranks right after the anchors, older thinking last; a
  running-turn cut ranks first. Anchors that do not fit are kept truncated,
  never silently lost. The coverage header lists omitted and truncated item ids
  and names `t3_thread_read` for reading them.
- Every delivery adds a `scient.fork.context` activity to the fork's timeline
  saying whether it continued natively or received history as a summary.

### Running-turn forks

`sourceRunningTurnId` forks the running turn itself (`/fork` or the fork
button while the agent works). The fork request first flushes the turn's
buffered assistant/reasoning text, proposed plans and materialized generated
images through ingestion's ordered queue (`liveTurnFlush.ts`). A missing
worker, persistence failure or five-second timeout fails the request explicitly;
it never reports successful latest-state capture. Streaming segments stay open.
Materialized images are captured in Scient-owned fork snapshot data and added
only to the fork's hydrated history; capture creates no new origin-chat message
and normal origin completion keeps its existing image placement.
Then the decider copies every completed turn plus the
live tail (`forkLiveTail.ts`): streaming text is copied as it stood and
labelled partial, unfinished tool calls are copied and labelled in flight,
pending approvals/questions are history only. The handoff names the files the
origin touched and whether the fork shares its folder. A new-worktree fork
freezes the current files into its turn-zero ref before dispatch (temporary
index; the user's index is untouched; gitignored files are not copied).
Snapshot OID and capture time are durable, and retries and worktree creation
reuse that frozen reference. Completed-turn forks freeze their selected
checkpoint the same way. Workspace capture and the transcript cut are separate
operations while the source keeps running; the handoff states that limitation.
Older already-accepted provisioning jobs freeze their snapshot on recovery.
Upstream V2
rejects forks from running work; this is the isolated Scient extension.

### Native fork

A fork's first session is started as a native provider fork when it can
reproduce the fork exactly: same provider instance as the source, the forked
turn is completed, every retained source turn has durable evidence for that
same instance and native thread, no running-turn cut, nothing delivered yet.
Imported prefixes and older turns without native-ownership evidence take the
portable path. Native-to-portable recovery updates the recorded fidelity. Adapters opt in with
`capabilities.nativeFork`; `ProviderSessionStartInput.forkFrom` carries the
source cursor and the inclusive turn. Codex implements it with
`thread/fork { threadId, lastTurnId }` and surfaces failure instead of opening
a fresh thread; the reactor then records the reason and falls back to the
portable handoff. Claude and OpenCode stay portable until Scient tracks the
provider message ids their fork APIs need.

### Orchestration V2 mapping

| Scient (this branch)                                 | Upstream V2                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `scient_thread_lineage` + `forkLineage` marker       | `AppThread.lineage` + `forkedFrom`                                          |
| `scient_context_transfers.status`                    | `ContextTransfer.status` (same literals)                                    |
| `resolution_json` `native_fork` / `portable_context` | `ContextTransfer.resolution`                                                |
| `scient_context_handoffs` (`full_thread_summary`)    | `ContextHandoff` + `delivery {nativeThreadId, status}`                      |
| `native_thread_key`                                  | `delivery.nativeThreadId`                                                   |
| fork point turn id / checkpoint count                | `sourcePoint.runId` / `checkpointId`                                        |
| running-turn cut (`mid_turn_cut_json`)               | `sourcePoint.turnItemId` + relaxed forkable-status guard (Scient extension) |
| `handoffBudget` / `selectHistory` / coverage header  | `ContextHandoffBudget` (Scient cap + estimator override)                    |
| `t3_thread_read` (Scient bridge)                     | V2 orchestrator `t3_thread_read`                                            |
| `nativeFork` / `forkFrom`                            | `ProviderAdapter.forkThread`                                                |

On the V2 day, the transfer and handoff rows translate one-to-one; the
Scient-only concepts (running-turn cut, reasoning items, workspace mode,
retain-before for user-message forks) become isolated extensions rather than
fields in V2's persisted event log.

Mirrored snapshot: pingdotgg/t3code PR #2829 at `a3fbbe45315e` (2026-09-27).
Each mirroring module names the upstream file it follows. Only
`attachmentTokenAllowance` is copied verbatim. V2's `historicalMessage`,
`selectHistory` and `handoffCoverage` read V2 turn items and render plain text
measured in bytes, so a verbatim copy would change Scient's behaviour; they
are mirrored in behaviour instead. Known differences to reconcile against that
snapshot:

- Estimator: `ceil(bytes / 3)` instead of one byte per token.
- Cap: Settings preset instead of V2's 16k default, with no 64,000-byte
  `HANDOFF_BYTE_CAP` clamp.
- Window: adapter/custom-model capacity is resolved by instance, with a final
  composed-request check. Source-session window telemetry is not reused.
- Selection: priority classes (cut, anchors, latest turn, conversation,
  detail) and truncated anchors instead of whole-or-omitted.
- Rendering: one JSON preamble with reasoning and tool items instead of V2's
  `[Historical …]` text blocks.

## Narrow T3-owned seams

### Submitted question-answer continuity

`scient-fork/retainedQuestionAnswers.ts` is the shared selection rule for fork admission,
durable history copying, and provider bootstrap. It accepts only decodable
`user-input.answer-submitted` activities associated with retained turn IDs. It does not infer
boundaries from timestamps, copy pending questions, or inspect client drafts. An undecodable
retained record or unscoped submitted answer fails explicitly instead of silently dropping data.

The fork decider remaps activity, request, turn, and attachment identities. It emits historical
`thread.activity-appended` events, never a question request or response command. Message-mode
answers remain ordinary messages and are not duplicated. The existing attachment copier and
projection cleanup own file lifecycle; no new storage schema or provider adapter is introduced.

Bootstrap serializes separate `question-answer` context entries before their retained turn's
terminal assistant message. This is provider-neutral history, not a new user instruction or an
alteration of authored messages. Existing input/attachment budgets apply, with an explicit
omitted-question-answer count. Copied turn identities preserve this behavior through re-fork,
revert, and replay. Existing draft handoff and queue policies are unchanged.

T3 question submission, activity schemas, rendering, and cleanup remain unchanged. Future
upstream schema changes should be qualified against this selector and the fork cross-area tests.

All production seams are additive and marked with `SCIENT-FORK:START` and
`SCIENT-FORK:END` where practical.

| Surface                                                                                                                                                                       | Deliberate change                                                                                                                                            | Retirement condition                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `packages/contracts/src/orchestration.ts`, `packages/contracts/src/environment.ts`                                                                                            | Add fork command, optional user title, capability negotiation, lifecycle events, lineage, and explicit workspace/provider status contracts.                  | Map to a compatible T3 contract or retain a thin translation.             |
| `packages/shared/src/scientForkTitle.ts`                                                                                                                                      | Share automatic numbering between the server authority and client preview.                                                                                   | T3 owns equivalent fork-title allocation.                                 |
| `apps/server/src/orchestration/decider.ts`                                                                                                                                    | Delegate `thread.fork` and record the internal completion event.                                                                                             | T3 owns an equivalent exact-boundary decider.                             |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`                                                                                                                 | Route the new aggregate and rehydrate origin detail for this command only.                                                                                   | T3 command routing natively supports fork.                                |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`, `apps/server/src/orchestration/projector.ts` | Register Scient lineage, expose conversation boundaries, and preserve/advance the immutable baseline through live projection and revert.                     | Generic projection extension and derived-field hooks replace these seams. |
| `apps/server/src/persistence/Layers/Sqlite.ts`                                                                                                                                | Run the independent Scient migration runner.                                                                                                                 | A generic product-schema hook replaces the seam.                          |
| `apps/server/src/orchestration/Layers/OrchestrationReactor.ts`, `apps/server/src/server.ts`                                                                                   | Start/provide the Scient worker and provider-context service.                                                                                                | Generic reactor and provider-context extension points exist.              |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`                                                                                                              | Reserve, prepare, and reconcile the first fork provider turn around the existing provider send.                                                              | T3 exposes a provider request-decoration hook.                            |
| `apps/server/src/ws.ts`                                                                                                                                                       | Wait for durable fork completion before acknowledging the command.                                                                                           | T3 supports typed asynchronous command receipts.                          |
| `packages/client-runtime/src/operations/commands.ts`, `packages/client-runtime/src/state/threadCommands.ts`                                                                   | Dispatch and serialize the fork command.                                                                                                                     | T3 client runtime has an equivalent operation.                            |
| `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/MessagesTimeline.tsx`, `apps/web/src/rightPanelStore.ts`                                                | Send the selected message ID, preview the destination title, mount the single-form fork control, and expose one narrow sanitized panel-state restore action. | T3 exposes row-action and thread-view continuity extension slots.         |

Interface-wide provider and VCS changes from the prototype were deliberately
removed. They forced unrelated adapters and test doubles to understand Scient
forking and would have increased every future upstream merge.

## Omitted-history recovery: `t3_thread_read` bridge

A fork's first provider turn receives a bounded transcript, so older messages
can be omitted. The Scient MCP tool `t3_thread_read` lets the model read them
back from the projections. It is a temporary bridge: it keeps the tool name,
input fields, defaults, and paging semantics of T3 Orchestration V2's
`t3_thread_read` (`OrchestratorMcpThreadReadInput`, upstream
`apps/server/src/mcp/toolkits/orchestrator/tools.ts`), so prompts that name the
tool keep working. **Delete `apps/server/src/mcp/toolkits/threads/`, the
`threads:read` grant, and the `SCIENT-THREAD-READ` seams when V2's orchestrator
toolkit lands.**

- Input: `threadId` (required), `view` (`messages` default, or `activity`),
  `afterPosition` (exclusive), `limit` (1–100, default 50), `itemId`,
  `textOffset`, `maxCharsPerItem` (1–50,000, default 20,000), and `runLimit`.
  `runLimit` is accepted and ignored because this server projects only the
  latest turn, not run history.
- Output: a V2-compatible subset. `thread` includes identity, project, title,
  V2-vocabulary `status`, model, modes, fork parent, `itemCount`, and archive
  state. `items` carry `position`, `itemId`, `type`, `status`, `title`,
  `activityKind`, `messageId`, `turnId`, windowed `text`, `textTruncated`,
  `nextTextOffset`, and timestamps. The page also returns `nextPosition` and
  `hasMore`. There is no `recentRuns` field.
- Timeline: messages of every role, proposed plans, and thread activities
  are paged directly from durable projection tables by `historyRead.ts`.
  Direct item lookup and paging do not inherit the UI's 500-activity limit.
  Internal fork hydration explicitly requests full retained activity history;
  ordinary UI reads remain bounded. Items are ordered by creation time,
  source kind, source sequence, and identifier. `position`
  indexes this full timeline in both views. The `messages` view returns user
  messages, assistant messages, and proposed plans. The `activity` view also
  returns reasoning, system messages, and activities. An activity is rendered
  as its kind and summary followed by its payload. `maxCharsPerItem` bounds
  the returned text window; `textOffset` can reach the full stored payload.
- Paging follows V2: `nextPosition` is the last returned position and is null
  only when the page is empty, and `hasMore` tells whether to continue. The
  `itemId` option ignores `view` and `afterPosition`. `textOffset` applies only
  with `itemId`. Offsets count UTF-16 code units.
- Authority: the `threads:read` session grant is issued to every
  MCP-injected provider session. The calling thread comes from the host-issued
  invocation. It may read itself or a non-deleted thread, including an archived
  one, in the same project. Other projects fail with `thread_outside_project`.
  A projectless thread can read only itself. A fork reads its own copied
  transcript even after the origin is deleted. V2's reads of user-attached
  context threads are not supported because main has no thread context records.
  The tool never mutates state. Unlike V2, it never acknowledges delegated-child
  completion, so it is annotated read-only.

## Safety and bounded compromises

- Only durable sent user messages and terminal completed assistant responses
  are forkable. Invalid, stale, unknown, or streaming message IDs fail closed.
  A newer streaming turn is excluded from the retained prefix rather than
  blocking an older fork point.
- A new worktree fails closed if the historical Git checkpoint is unavailable
  (a running-turn fork snapshots the current files instead).
- Revert never removes a fork's inherited transcript: every inherited turn id is
  recorded and retained, not only the boundary turn.
- An untouched proposed title is recomputed by the server at commit time. Only
  an explicit non-empty user edit bypasses automatic numbering.
- Same-workspace mode is honest about sharing current files; only its
  conversation and checkpoint lineage are independent.
- A fork requires a real owning project. Legacy projectless records fail
  closed rather than inventing a workspace or project during replay.
- Every retained attachment gets a new fork-owned ID and verified file copy, so
  deletion or cleanup of the origin cannot invalidate the fork.
- Portable handoffs keep whole items within a model-window-derived budget and
  never emit invalid JSON; omitted items stay readable through `t3_thread_read`.
- Provider acceptance cannot be made globally exactly-once without provider
  idempotency. Scient therefore re-delivers uncertain context on a fresh
  provider session: the abandoned session may hold a duplicate, the new one
  never does, and the user is never left at a dead end.
- Right-panel continuity copies only safe descriptors. It never reuses a live
  terminal or browser session, never persists authorized URLs, and expires
  pending PDF remaps after seven days.
- A transiently failed durable fork remains recoverable and can be retried in
  place or after restart. A terminally impossible fork is compensated and never shown as a
  usable thread.
- Shared contracts, client runtime, and server behavior are mobile-ready. This
  change intentionally adds no mobile fork UI.

## Upstream update procedure

Before each T3 merge:

1. Fetch the current official T3 head and merge its real history normally.
2. Search the marked T3-owned seams and compare them with this manifest.
3. Resolve conflicts in favor of T3's improved generic behavior, then restore
   only the smallest still-required Scient hook.
4. Check whether T3 added native fork behavior or a generic extension point. If
   so, migrate and delete the corresponding divergence instead of duplicating it.
5. Run fork-focused contract, server, client-runtime, and web tests plus the
   affected package typechecks and a clean merge rehearsal.

The target is not zero changes to T3-owned files at any cost. The target is the
smallest explicit, well-tested change that preserves product quality without
building a parallel generic platform.

## Verification checklist

- Fork-decider first/latest response, internal baseline re-fork, non-Git,
  stale/incomplete response, active newer turn, identity, and attachment cases.
- Durable schema upgrade, lifecycle projection, recovery, idempotency,
  checkpoint, worktree, and failure cases.
- Migration runner: fresh install, prototype upgrade, current schema upgrade,
  legacy ledger immutability, ordering, malformed-row quarantine, restart
  idempotence, concurrent startup, T3 ledger isolation, ledger integrity
  preflight (gaps, name mismatches, unknown future IDs), canonical defaults,
  physical compatibility columns, and `applied_at` / `created_at`
  reconciliation.
- Lifecycle guards: pending durability, bounded claims, failed retry, abandoned
  terminal truthfulness, restart recovery, attachment replay, workspace/
  checkpoint truthfulness, provider bootstrap normal and crash recovery,
  bootstrap readiness gating, re-fork persistence, abandoned non-regression,
  provider reservation identity, ambiguous-send recovery, copied-boundary
  recovery, and non-ready acceptance rejection.
- Cross-area: fresh startup to ready fork, prototype upgrade compatibility,
  restart during pending fork, interrupted provisioning retry, exact boundary
  through projection/persistence, revert-then-fork, re-fork after
  normalization, T3/Scient ledger isolation, and stacked phase A+B validation.
- Provider bootstrap normal, truncation, attachment, restart, send-failure, and
  completion-marker cases.
- Web assistant- and user-message actions, automatic and explicit titles,
  single-form workspace selection, turn-zero user fork, persisted
  unsent text/image draft, failed-command cleanup, streaming exclusion,
  slash-command selection, same-tick duplicate prevention, safe
  right-panel filtering, PDF session remapping, and RPC
  acknowledgement/failure gating.
- Focused server, contracts, client-runtime, and web typechecks/tests; format;
  lint; `git diff --check`; and read-only merge rehearsal against current T3.

No browser automation, screenshot comparison, geometry test, visual-regression
test, or manual UI acceptance is part of this engineering verification.
