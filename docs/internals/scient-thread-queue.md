# Scient thread queue: architecture, behavior, and recovery

This is the maintenance contract for the desktop/web queue. The server owns
ordering and delivery. The open conversation is only a view and a composer;
navigation, remounts, and additional windows cannot start a queued turn.
This document describes the implementation in this checkout. Automated checks
and manual product acceptance are separate; no visual acceptance is implied.

## Native V2 cutover

For V2 threads, native queued runs and their user messages are the sole live
queue authority. `QueuedRunsControl` adapts that projection and native commands
into the single Scient `ThreadQueueStrip`; it does not render another queue.
`Orchestrator` owns admission, held state, ordering and delivery.
Legacy payloads enter native held runs through `LegacyQueueCutover` before
native delivery. Reading recovery data never executes it. The V1 Scient
ledger and worker are superseded; do not build new queue behavior on them.

Native Edit first journals the captured message, context, settings and owned
attachment bytes, then sends `queued-run.cancel` with its exact message
`expectedUpdatedAt` and a stable journal command ID. Only accepted cancellation
installs an ordinary draft; ambiguous outcomes retain the journal and original
draft for reconciliation. The existing IndexedDB journal, Web Lock and prompt
stash protect reloads, multiple windows and previous ordinary drafts.
An exact durable rejection clears the extraction intent and releases its lock;
it leaves the ordinary draft and server queue unchanged. An arbitrary transport
or storage error does not prove rejection.

Mobile uses a separate native in-place edit contract: its queue sheet opens a dedicated edit draft
without cancelling the queued run. Saving uses `queued-run.edit` with retained server attachments
and newly prepared uploads; context bindings follow the replacement list. Cancel leaves the queued
message unchanged, and a rejected save keeps the edit in the composer. See
[mobile composer Help](../user/composer.md#send-while-the-agent-is-working) and
[`queued-run-edit.ts`](../../apps/mobile/src/state/queued-run-edit.ts).
The desktop/web cancellation, extracted-packet journal and Web Lock recovery described here are
not a mobile recovery guarantee.

An unheld native queue advances automatically, one message at a time, after
the current turn finishes successfully and its finalization settles. Ordinary
completion never requires Resume. Native Stop, interruption and failed starts
hold delivery. Becoming idle does not resume a held queue.

Three things release a held queue, and each releases every queued run:

- **Send on a row.** While the queue is held and the thread is idle, every user
  row offers Send (on mobile too). It dispatches `queue.resume(runId)`: the
  server moves automatic delegated completions first, then the chosen message,
  then the other messages in their current order, and releases them all. The
  shared rule is `canSendQueuedRun` (`@t3tools/shared/scientQueuedRunSend`);
  the server refuses a run that is not queued, an automatic delivery, a busy
  thread, or a usage-limited thread. There is no held header or Resume queue.
- **A direct send.** A user message sent with `start_immediately` and no
  delivery intent (or `auto`) that starts its own run releases every queued run
  in the same command (`scient-fork/QueuedRunSend.ts`). A Queue submission or a
  Steer that starts at once on an idle thread, Restart, a manual or scheduled
  continuation, automatic deliveries, notifications and scheduled tasks leave a
  held queue held.
- **Resume.** `queue.resume` without a run, from the composer's empty-draft
  Resume, still releases the whole queue.

A usage limit refuses Send and Resume. The composer's **Resume thread** continues
the limited thread first and then resumes the queue. Clients hide Send for the
limit only when the server-built thread shell confirms it, so a windowed
snapshot never hides a Send the server would accept. Idle reorder remains
available, including before a provider session exists. Provider-start failure
retains the queued message for Retry, which is Send on that message.
Holds follow the exact attempt's original failure or interruption boundary.
The terminal hold reaction treats a release written by `queue.resume` or by a
direct send's `message.dispatch` as newer than an earlier terminal, so a late
reaction or a delayed checkpoint echo cannot hold the queue again; a failure or
Stop after the release still holds it.
Queue limits remain 20 items and 64 MiB, including actual owned attachment bytes.

Pending admission previews belong only above the composer. A durable queued
receipt keeps the preview there until its native queued run arrives; an immediate
start receipt promotes it into the conversation. Authoritative messages and
queue snapshots suppress duplicate previews. Automatic delegated-task deliveries
remain outside the user queue.

## Native admission and execution

`message.dispatch` enters V2 through `ThreadMessageIntake` and `Orchestrator`. The command is
serialized for its thread and chooses immediate execution, a queued run, or explicit steering
according to current state and `CommandPolicy`. Queue admission is not provider acceptance.
`EventSink` commits the user message, run/attempt/node state, command receipt, and outbox work
transactionally; no client-side remove or mounted queue pump owns delivery.

Each queued run names its durable user message and captured model selection, runtime mode,
interaction mode, selected Scient skills, and typed context. Ordinary native submissions do not
accept a composer edit snapshot; imported messages may retain an opaque legacy one.
`QueuedRunOrder` defines delivery order; automatic delegated completions are not ordinary user
rows. `QueuedMessageBudget` enforces the 20-item/64-MiB cap under thread serialization. It counts
serialized messages and the actual file size of each owned attachment reference, including a
promoted run whose native acceptance is still pending. Missing or foreign-thread bytes fail closed.

The native commands are `queued-run.reorder`, `queued-run.cancel`, `queued-run.edit`,
`queued-message.promote-to-steer`, and `queue.resume`. Their predicates and receipts belong to
V2. The effect worker starts an admitted run through `ProviderTurnStartService`; provider events
flow through `ProviderEventIngestor` and `RunExecutionService`. Finalization settles checkpoint
work separately from provider success. A capture failure does not turn an answer into a failure.
Only an eligible unheld head can advance after finalization; session-idle state alone cannot
release a held queue.

Stop and process-loss recovery preserve waiting messages. Stale outbox starts are guarded by
attempt identity; a provider-start failure restores held retryable queue work. Native admission
and recovery never promise exactly-once execution inside an external provider. Do not replay an
ambiguous accepted provider start simply because a client lost its response.

## Legacy recovery boundary

Startup imports retained queue JSON and `scient_thread_queue` data through V2
`legacy/LegacyQueueCutover`, `HeldQueueAdmission`, and `LegacyQueueCompatibility`.
Imported messages become native held runs with deterministic identities before runtime recovery
and worker startup. Explicit Send/Resume releases them; reading or cloning a recovery payload does
not execute it. The legacy queue HTTP compatibility surface translates into V2 and is not a
second live ledger or sender.

Preserve Scient migration 11 (`thread-queue`) and the independent
`scient_schema_migrations` history. Old queue documents, receipts, incomplete barriers, files,
and edit journals are recovery inputs. Source bytes and idempotent import evidence must survive;
invalid payloads must surface an error rather than be erased or converted into an empty success.
Never reinterpret the older V1 successful-answer release rule as permission to unhold V2 work.

## Composer draft compatibility and recovery

New native `message.dispatch` submissions preserve canonical `text`, typed `context`, attachments,
and selected Scient skills. Neither the dispatch schema nor the native client operation accepts
`composerSnapshot`. Imported messages may retain that opaque legacy edit data, which the client
can decode with the existing draft-context codecs; it is never provider input or authority.
The native persisted-message schema permits an optional unbounded snapshot string. Its queue
admission budget counts serialized messages and actual attachment bytes together, enforcing
20 items/64 MiB in aggregate. There is no separate native 4 MiB snapshot limit. The retained legacy
`ScientThreadQueueItem` schema instead limits snapshot string length to `4 * 1024 * 1024`;
that is not a byte limit or the native submission contract.

Current web send paths check `inlineMessageContext` and use the existing
legacy-context serializer when that capability is absent. The environment also
advertises `threadQueueMessageContext`, but the current client does not consult
it to select a separate queued-message fallback. Image IDs and capture metadata
survive queueing and editing; the normal attachment pipeline rebinds client IDs
at admission.

The retained snapshot codec uses version 2. Version 1 snapshots and older edit journals
migrate saved element picks into preview annotations and terminal placeholders
into references. Migration reuses the ordinary composer's conversion helpers;
malformed selections are reported rather than discarded, and reading a journal
does not rewrite its original bytes.

Editing restores those typed context fields and raw text, then recomputes
explicit selections and materializes context once on resend. The existing
journal carries `composerSeparated` through reload and stash recovery. Malformed
snapshots leave the item untouched. Legacy items/journals without separated
context cannot safely infer `$name` selections: an affected edit is retained
with an explanation to compose a new selected-Skill message. Plain legacy text
remains editable, and already queued delivery does not require an edit snapshot.
Native `queued-run.edit` retains context and selected skills when their fields are omitted.
Explicit `context: null` clears context; an explicit empty skill-selection list clears selections.
Every accepted native edit discards the previous composer snapshot. This command differs from
the strip's cancellation/extraction followed by a new ordinary submission.

`editSession.ts` keeps both complete drafts in the existing IndexedDB journal,
including attachment bytes. Before extraction, the client saves the queued message's
snapshot and bytes. Native cancellation checks `expectedUpdatedAt`; its durable
command receipt reconciles retries before installing the ordinary draft. Legacy edit
journals retain their original recovery identities and are handled by compatibility
code, not by restoring a V1 sender.

Extraction installs the edited content into the ordinary draft identity. Async
callbacks retain their captured draft targets. Journal persistence resamples the
previous draft before replacement, so typing during extraction is retained in
its stash. Browser Web Locks prevent two windows from recovering the same edit
journal concurrently. Storage or network failure preserves the draft and recovery
intent; a lost response reconciles with the same token.

Send uses the ordinary submission path. An extracted draft freezes its prepared
submission packet, intent and identities before offering intake through
[`extractedIntentSend.ts`](../../apps/web/src/scient/threadQueue/extractedIntentSend.ts) and
[`submission.ts`](../../apps/web/src/scient/threadQueue/submission.ts). An unknown acknowledgment
retries that same packet; it never substitutes current settings, uploads or a newer draft.
The server reconciles accepted command receipts before
repeating upload claims or bootstrap side effects. A queued acknowledgment removes
the optimistic message and releases local dispatch immediately. Acceptance clears
only the submitted draft; typing during the request remains in the composer.

Stashes reference full journals instead of placing file bytes in localStorage.
Restoration saves a discoverable recovery journal for the target draft before
releasing the source copy. Browser storage is local to that installation; clearing
it removes local draft recovery data. It is not cloud draft sync.

Queue attachment ownership participates in existing revert pruning and removal
cleanup. Bytes still referenced by a queued item or projected message are retained.

## Implementation owners

| Owner                                                                                   | Responsibility                                                             |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/server/src/orchestration-v2/Orchestrator.ts`                                      | Admission, command predicates, held state, and advancement                 |
| `apps/server/src/scient/orchestration/TerminalQueueHold.ts`                             | Exact terminal boundary and held-queue eligibility                         |
| `apps/server/src/orchestration-v2/QueuedRunOrder.ts`                                    | Native delivery order and automatic-completion separation                  |
| `apps/server/src/orchestration-v2/QueuedMessageBudget.ts`                               | Serialized-message and owned-byte limits                                   |
| `apps/server/src/orchestration-v2/EffectWorker.ts`                                      | Durable execution after admission                                          |
| `apps/server/src/orchestration-v2/legacy/`                                              | Legacy queue cutover and recovery readers                                  |
| `apps/web/src/components/chat/QueuedRunsControl.tsx`                                    | Native projection and command adapter for the strip                        |
| `apps/web/src/scient/threadQueue/ThreadQueueStrip.tsx`                                  | Queue presentation                                                         |
| `apps/web/src/scient/threadQueue/editSession.ts`                                        | Local draft journal and edit recovery                                      |
| `apps/web/src/scient/threadQueue/extractedIntentSend.ts`, `submission.ts`               | Frozen offered packet, uncertain-intake retry and later-draft preservation |
| `apps/web/src/scient/threadQueue/extractedDraftIntent.ts`, `extractedImageSelection.ts` | Extracted intent and image-selection ownership                             |

## Verification and manual acceptance

Native qualification includes `NativeQueueHoldPolicy.integration.test.ts`,
`QueuedStartRecovery.integration.test.ts`, `QueuedMessageBudget.integration.test.ts`,
`LegacyV1RecoveryAcceptance.integration.test.ts`, complete runtime/worker tests,
and the mounted queue, shortcut, edit-journal and timeline-consumer tests.
V1 ledger/worker tests are not evidence for native queue execution. Retained-reader tests qualify
only their import/recovery boundary.
Repository format, lint, type, test, build and desktop smoke gates are required
before manual review.

Manual acceptance should exercise these cases in an isolated candidate:

1. Queue several messages in A, visit B, and stay there while A finishes. Every
   message belongs to A; each starts after its own preceding answer finishes.
2. Edit a middle item over an ordinary draft containing text and attachments.
   Verify the old row disappears and the previous draft is available in Stash.
   Send the edit while idle and busy, then exercise cursor/undo and navigation.
3. Edit the head while the current answer finishes. Later waiting items may
   start; the withdrawn message must stay in the composer. Send before and
   after that advance and verify ordinary immediate/tail-queue behavior.
4. Drag visible items while another message is being edited. Delete and explicitly
   steer rows using the existing controls.
5. Stop with multiple messages queued. Visit another task, return, and restart
   the candidate: nothing should send. Send a new ordinary message; the existing
   queue is released and follows that message automatically. Stop again with
   several queued messages, reorder while idle, then Send a later held row;
   that row starts first and the remaining queue is released in its retained
   order (automatic completions first). Verify delivery after each successful
   finalized answer and check failed delivery/Retry separately. Exercise reload
   during editing, another window, and lost responses; inspect for missing or
   duplicated user messages and retained drafts.
6. Stash and restore an edit through the usual menu. Reload immediately after
   restoration; check text, file/image bytes, settings, and context fidelity.

Visual/layout and real-provider adoption remain manual acceptance work. Unit and
integration tests do not establish those properties.
