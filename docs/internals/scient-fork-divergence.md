# Scient conversation fork: design, provenance, and T3 divergence

This document is the maintenance contract for Scient's conversation-fork
feature. It records what the feature promises, which parts Scient owns, and the
small set of T3-owned seams that an upstream merge may touch.

## Product behavior

From the Fork action beside either a sent user message or a completed assistant
response, a user can create a new conversation at that exact point. The origin
conversation is never modified. `/fork` continues to select the latest
completed assistant response.

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
a dedicated Git worktree at the selected historical checkpoint, and is
available only when that checkpoint can be resolved safely. Leaving it off
keeps the conversation branch independent while using the origin project's
current workspace; it does not rewind local files.

The new conversation shows the retained transcript prefix. Its first provider
turn starts a fresh provider session and receives that retained transcript once
as bounded context. This provider-neutral design is intentional: a provider's
native fork API commonly forks the session tip, which is incorrect when the user
chooses an older boundary.

The client navigates to the new conversation only after durable provisioning
has completed. A failed fork is returned as an error instead of exposing a
half-ready conversation as successful.

The destination also inherits safe, durable right-panel intent: files, diffs,
pull requests, Agents, Sources, source PDFs, and portable Scient artifacts.
Live terminal sessions are intentionally dropped. Live browser tab identities
are replaced by one fresh browser surface rather than reusing another thread's
session. Workspace-backed or attachment-backed transient artifact surfaces are
dropped. A file PDF keeps its reader position automatically in a shared
workspace; for a separate worktree, Scient remaps the saved reader session to
the destination path after that workspace becomes available. This continuity
is best-effort and can never make an otherwise successful fork fail.

The fork lifecycle has three separate readiness milestones:

1. **Server provisioning complete:** the durable fork workflow has created and
   verified the destination thread, retained transcript, attachments, and
   requested workspace substrate.
2. **Thread visible in client state:** the destination thread's server detail has
   reached the client store and is recognized as started.
3. **Navigation complete:** the client has routed to the destination thread.

These milestones must not be collapsed into a fixed delay or treated as
interchangeable. Navigation is successful only after the first two milestones
are true; the third is the final UI action.

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
5. The reactor records `ready` only after every required substrate is verified.
   The WebSocket command waits for this typed completion receipt.
6. The copied logical-boundary manifest records remapped turn and message IDs.
   It lets a fork be forked again directly, without walking ancestor threads or
   pretending copied transcript rows are provider-native turns.
7. For a user-message fork, the web client prepares every authorized image,
   persists the complete unsent destination draft, and flushes storage before
   issuing the server command. A rejected command removes that staged draft.
8. On the first provider turn, the provider-neutral bootstrap injects only the
   immutable retained baseline and recent retained images. It reserves the
   exact outgoing message before the external send and records
   `pending` -> `sending` -> `completed`. A failed or interrupted send becomes
   `ambiguous`; Scient never silently re-injects context whose acceptance is
   uncertain. A later completed assistant response can reconcile that state as
   accepted.
9. Terminal failures such as a disappeared origin attachment or an unavailable
   required worktree checkpoint delete the unusable target thread and record an
   `abandoned` lineage state. Transient failures remain retryable.

The domain-event stream is only a wake-up signal. The lineage table remains the
authority, so a restart or missed live event cannot lose the work.

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
- `apps/server/src/orchestration/scient-fork/ForkContextBootstrap.ts`
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
`VcsProcess`; it does not extend T3's VCS, checkpoint-store, or Git-driver
interfaces. Provider adapters are also unchanged.

Scient database state uses `scient_schema_migrations`, a separate migration
ledger. It never consumes or predicts a T3 numbered migration. The
`fidelity_mode` and `provider_mode` compatibility columns are retained
physically for prototype upgrades but are no longer active runtime authorities;
`transcript-bootstrap` is the only active provider bootstrap mode, enforced by
migration normalization and active repository/bootstrap code paths.

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

`transcript-bootstrap` is the only active provider bootstrap mode.
`prepareTurn` no longer reads the `provider_mode` compatibility column. It
reads the immutable `baseline_assistant_message_id` and will never infer the
baseline from later destination messages. Before the external provider send,
`beginAttempt` atomically reserves the exact user message. `markAccepted`
completes only that reservation. A send failure
marks delivery ambiguous; a restart blocks re-injection unless a completed
assistant response proves the original attempt was accepted. Bounded omission
counts remain explicit inside the injected context payload.

## Narrow T3-owned seams

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

## Safety and bounded compromises

- Only durable sent user messages and terminal completed assistant responses
  are forkable. Invalid, stale, unknown, or streaming message IDs fail closed.
  A newer streaming turn is excluded from the retained prefix rather than
  blocking an older fork point.
- A new worktree fails closed if the historical Git checkpoint is unavailable.
- An untouched proposed title is recomputed by the server at commit time. Only
  an explicit non-empty user edit bypasses automatic numbering.
- Same-workspace mode is honest about sharing current files; only its
  conversation and checkpoint lineage are independent.
- A Quick Chat may be forked in the same environment without inventing a
  project. Its projectless workspace root is preserved on the new thread;
  separate-worktree mode remains unavailable without a project checkpoint.
- Every retained attachment gets a new fork-owned ID and verified file copy, so
  deletion or cleanup of the origin cannot invalidate the fork.
- Provider bootstrap preserves exact message text until the total contract
  budget requires truncating the oldest context. It never emits invalid JSON.
  The current bounds are 120,000 characters and eight recent images.
- Provider acceptance cannot be made globally exactly-once without provider
  idempotency. Scient therefore chooses the safe failure mode: an uncertain
  send is durable and blocks automatic re-injection. A proved provider response
  reconciles it; otherwise the user creates a fresh fork instead of risking a
  duplicated request.
- Right-panel continuity copies only safe descriptors. It never reuses a live
  terminal or browser session, never persists authorized URLs, and expires
  pending PDF remaps after seven days.
- A transiently failed durable fork remains recoverable and is retried after
  restart. A terminally impossible fork is compensated and never shown as a
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
