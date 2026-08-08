# Scient conversation fork: design, provenance, and T3 divergence

This document is the maintenance contract for Scient's conversation-fork
feature. It records what the feature promises, which parts Scient owns, and the
small set of T3-owned seams that an upstream merge may touch.

## Product behavior

From a settled user message, a user can create a new conversation at the
completed boundary immediately before that message. The origin conversation is
never modified. The user explicitly chooses one of two workspace behaviors:

- **Create independent worktree** creates a dedicated Git worktree at the
  selected historical checkpoint. It is available only when that checkpoint can
  be resolved safely.
- **Use same workspace** keeps the conversation branch independent while using
  the origin project's current workspace. It does not rewind local files.

The new conversation shows the retained transcript prefix. Its first provider
turn starts a fresh provider session and receives that retained transcript once
as bounded context. This provider-neutral design is intentional: a provider's
native fork API commonly forks the session tip, which is incorrect when the user
chooses an older boundary.

The client navigates to the new conversation only after durable provisioning
has completed. A failed fork is returned as an error instead of exposing a
half-ready conversation as successful.

## Preserved Claude provenance

Claude's implementation remains intact in Git; it was not squashed or rewritten.

- Prototype commit: `8ca683819caa7c956a5013a1e47707d52a04a401`
- Permanent archive branch: `archive/claude-fork-prototype-20260808`
- Scient base used by the prototype: `4138d41362cce474ef08f3fefc6e1ec1e41a847d`
- Official T3 head merged before hardening:
  `4eaf5ef8bb47b870397d5c61cd216b1a6bdd1510`
- Dedicated T3 merge commit: `b4ccca5038cf400533c5de58dc12cac2d80d98be`

The hardened implementation descends from the prototype and the dedicated T3
merge. Future changes must keep the prototype commit and archive branch
reachable even if publication later uses a different presentation strategy.

## Reliability model

Forking is a durable, restart-safe saga:

1. The event-sourced decider validates a settled, completed boundary; allocates
   fresh thread, turn, message, and attachment identities; emits the new thread
   plus retained transcript; and records immutable lineage.
2. The Scient lineage projector inserts a durable `pending` record.
3. The Scient fork reactor claims the record, copies fork-owned attachment
   files, establishes the selected checkpoint baseline, and creates the
   worktree when requested.
4. Deterministic branch, ref, worktree, and internal command identifiers make a
   retry idempotent. Startup recovery resumes `pending`, `provisioning`, and
   `failed` records.
5. The reactor records `ready` only after every required substrate is verified.
   The WebSocket command waits for this typed completion receipt.
6. On the first accepted provider turn, the provider-neutral bootstrap injects
   the retained transcript and recent retained images. The durable bootstrap
   marker is completed only after the provider accepts the send.

The domain-event stream is only a wake-up signal. The lineage table remains the
authority, so a restart or missed live event cannot lose the work.

## Scient-owned implementation

These modules contain the fork behavior and should remain independent of T3
internals:

- `apps/server/src/orchestration/scient-fork/forkDecider.ts`
- `apps/server/src/orchestration/scient-fork/forkRepository.ts`
- `apps/server/src/orchestration/scient-fork/lineageProjection.ts`
- `apps/server/src/orchestration/scient-fork/schema.ts`
- `apps/server/src/orchestration/scient-fork/ForkAttachmentCopier.ts`
- `apps/server/src/orchestration/scient-fork/ForkCheckpointBaseline.ts`
- `apps/server/src/orchestration/scient-fork/ForkContextBootstrap.ts`
- `apps/server/src/orchestration/scient-fork/forkDecisionReadModel.ts`
- `apps/server/src/orchestration/Services/ScientForkReactor.ts`
- `apps/server/src/orchestration/Layers/ScientForkReactor.ts`
- `apps/web/src/components/chat/scient-fork/ScientForkUserMessageButton.tsx`
- `apps/web/src/components/scient-fork/useScientThreadFork.ts`

Tests live beside these modules. The checkpoint helper uses T3's existing
`VcsProcess`; it does not extend T3's VCS, checkpoint-store, or Git-driver
interfaces. Provider adapters are also unchanged.

Scient database state uses `scient_schema_migrations`, a separate migration
ledger. It never consumes or predicts a T3 numbered migration. The
`fidelity_mode` column is retained solely to upgrade Claude prototype databases;
`provider_mode`, `checkpoint_status`, and `workspace_status` are the current
explicit authorities.

## Narrow T3-owned seams

All production seams are additive and marked with `SCIENT-FORK:START` and
`SCIENT-FORK:END` where practical.

| Surface                                                                                                     | Deliberate change                                                                              | Retirement condition                                          |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/contracts/src/orchestration.ts`                                                                   | Add fork command, lifecycle events, lineage, and explicit workspace/provider status contracts. | Map to a compatible T3 contract or retain a thin translation. |
| `apps/server/src/orchestration/decider.ts`                                                                  | Delegate `thread.fork` and record the internal completion event.                               | T3 owns an equivalent exact-boundary decider.                 |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`                                               | Route the new aggregate and rehydrate origin detail for this command only.                     | T3 command routing natively supports fork.                    |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`                                                | Register the Scient lineage projector.                                                         | A generic extension registration point replaces the seam.     |
| `apps/server/src/persistence/Layers/Sqlite.ts`                                                              | Run the independent Scient schema bootstrap.                                                   | A generic product-schema hook replaces the seam.              |
| `apps/server/src/orchestration/Layers/OrchestrationReactor.ts`, `apps/server/src/server.ts`                 | Start/provide the Scient worker and provider-context service.                                  | Generic reactor and provider-context extension points exist.  |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`                                            | Prepare the first fork turn and mark its bootstrap accepted after provider send.               | T3 exposes a provider request-decoration hook.                |
| `apps/server/src/ws.ts`                                                                                     | Wait for durable fork completion before acknowledging the command.                             | T3 supports typed asynchronous command receipts.              |
| `packages/client-runtime/src/operations/commands.ts`, `packages/client-runtime/src/state/threadCommands.ts` | Dispatch and serialize the fork command.                                                       | T3 client runtime has an equivalent operation.                |
| `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/MessagesTimeline.tsx`                 | Resolve the existing completed-turn boundary and mount Scient-owned hook/control components.   | T3 exposes a row action/extension slot or ships native UI.    |

Interface-wide provider and VCS changes from the prototype were deliberately
removed. They forced unrelated adapters and test doubles to understand Scient
forking and would have increased every future upstream merge.

## Safety and bounded compromises

- Forking is disabled while the origin is streaming, running a turn, or
  starting/running a provider session. This prevents torn history.
- A new worktree fails closed if the historical Git checkpoint is unavailable.
- Same-workspace mode is honest about sharing current files; only its
  conversation and checkpoint lineage are independent.
- Every retained attachment gets a new fork-owned ID and verified file copy, so
  deletion or cleanup of the origin cannot invalidate the fork.
- Provider bootstrap preserves exact message text until the total contract
  budget requires truncating the oldest context. It never emits invalid JSON.
  The current bounds are 120,000 characters and eight recent images.
- Marking provider bootstrap complete retries locally. If persistence fails
  after a provider accepted the send, restart recovery may inject the context
  again. At-least-once context is safer than silently losing it; true
  exactly-once delivery requires provider-side idempotency.
- A failed durable fork remains recoverable and is retried after restart. A
  richer visible failed-state/retry UI can be added later without changing the
  lineage model.
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

- Fork-decider normal, turn-zero, invalid-boundary, busy-session, identity, and
  attachment cases.
- Durable schema upgrade, lifecycle projection, recovery, idempotency,
  checkpoint, worktree, and failure cases.
- Provider bootstrap normal, truncation, attachment, restart, send-failure, and
  completion-marker cases.
- Web control boundary, disabled state, same-tick duplicate prevention, and RPC
  acknowledgement/failure gating.
- Focused server, contracts, client-runtime, and web typechecks/tests; format;
  lint; `git diff --check`; and read-only merge rehearsal against current T3.

No browser automation, screenshot comparison, geometry test, visual-regression
test, or manual UI acceptance is part of this engineering verification.
