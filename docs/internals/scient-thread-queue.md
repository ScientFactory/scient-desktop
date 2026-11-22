# Scient thread queue: architecture, behavior, and recovery

This is the maintenance contract for the desktop/web queue. The server owns
ordering and delivery. The open conversation is only a view and a composer;
navigation, remounts, and additional windows cannot start a queued turn.
This document describes the implementation in this checkout. Automated checks
and manual product acceptance are separate; no visual acceptance is implied.

## Native V2 cutover

For V2 threads, native queued runs and their user messages are the sole live
queue authority. Upstream's `QueuedRunsControl` presents that projection in the
composer's drawer column (`queuedRunsControl` → `attachedAbove`), so it shares the
Tasks bar's width. Scient's parts are mounted from
`scient/threadQueue/useScientQueueParts.tsx`: the
failed-start notice with Retry, readable command failures, and "Queuing…" only
when admission is slow.
The web app does not read the pre-native queue endpoint except once per thread,
through `useLegacyQueueRecoveryError`, to show retained work that needs recovery.
`Orchestrator` owns admission, held state, ordering and delivery.
Legacy payloads enter native held runs through `LegacyQueueCutover` before
native delivery. Reading recovery data never executes it. The V1 Scient
ledger and worker are superseded; do not build new queue behavior on them.

Web, desktop and mobile edit a queued message in place, as upstream does. The web composer
uses upstream's [`useQueuedRunEdit`](../../apps/web/src/components/chat/useQueuedRunEdit.ts);
mobile uses [`queued-run-edit.ts`](../../apps/mobile/src/state/queued-run-edit.ts). Edit opens
the message in a dedicated edit draft (`queuedRunEditDraftId`) without cancelling the queued run,
so it keeps its place. Saving sends `queued-run.edit` with retained server attachments and newly
prepared uploads; context bindings follow the replacement list. Cancel leaves the queued message
unchanged, and a rejected save keeps the edit in the composer. The edit lives in memory: it
survives navigating between threads, while a reload or crash before saving leaves the queued
message exactly as it was and drops only the unsaved changes. If the run starts or is removed
elsewhere during an edit, changed content moves into the thread's draft when that draft is empty.
See [composer Help](../user/composer.md#queued-messages).

An unheld native queue advances automatically, one message at a time, after
the current turn finishes successfully and its finalization settles. Ordinary
completion never requires Resume. Native Stop, interruption and failed starts
hold delivery. Becoming idle does not resume a held queue.

Three things release a held queue, and each releases every queued run:

- **Send on a row.** While the queue is held and the thread is idle, every user
  row offers **Send now** (on mobile too). It dispatches upstream's `queued-run.start`:
  the server starts the chosen message first, even ahead of a waiting automatic
  completion, and releases the rest in their current order. It refuses a run that
  is not a queued user message or a thread that is still running ("A queued user
  message can only be sent now while the thread is stopped."). Scient builds before
  0.6.26 send this as `queue.resume` with a `runId`; client intake reads that as
  `queued-run.start` (`scient-fork/QueuedRunSend.ts`). There is no held header or
  Resume queue.
- **A direct send.** A user message sent with `start_immediately` and no
  delivery intent (or `auto`) that starts its own run releases every queued run
  in the same command (`scient-fork/QueuedRunSend.ts`). A Queue submission or a
  Steer that starts at once on an idle thread, Restart, a manual or scheduled
  continuation, automatic deliveries, notifications and scheduled tasks leave a
  held queue held. A plain send that Stop turns into a queued message joins the
  held queue too.
- **Resume.** `queue.resume` without a run, from the composer's empty-draft
  Resume, still releases the whole queue.

A usage limit refuses Send and Resume ("Continue the limited thread before resuming its
queue."). The composer's **Resume thread** continues the limited thread first and then
resumes the queue. Clients offer Send and leave that refusal to the server. Idle reorder remains
available, including before a provider session exists. Provider-start failure
retains the queued message for Retry, which is Send on that message.
Holds follow the exact attempt's original failure or interruption boundary.
The terminal hold reaction treats a release written by `queue.resume`, `queued-run.start` or by a
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
`queued-message.promote-to-steer`, `queued-run.start` and `queue.resume`. Their predicates and receipts belong to
V2. The effect worker starts an admitted run through `ProviderTurnStartService`; provider events
flow through `ProviderEventIngestor` and `RunExecutionService`. Finalization settles checkpoint
work separately from provider success. A capture failure does not turn an answer into a failure.
Only an eligible unheld head can advance after finalization; session-idle state alone cannot
release a held queue.

Stop and process-loss recovery preserve waiting messages. Stale outbox starts are guarded by
attempt identity; a provider-start failure restores held retryable queue work. Native admission
and recovery never promise exactly-once execution inside an external provider. Do not replay an
ambiguous accepted provider start simply because a client lost its response.

Stop also stops the thread's app-owned delegated subtree, including work beneath completed
tasks. Public commands cannot opt out of that cleanup. V2 records the delegated Stop in its
outbox; a server caller that walks the subtree synchronously marks only its current thread's
dispatch internally, so it does not enqueue a duplicate walk. MCP task cancellation keeps that
walk under the caller's dispatch-mode limit.

## Legacy recovery boundary

Startup imports retained queue JSON and `scient_thread_queue` data through V2
`legacy/LegacyQueueCutover`, `HeldQueueAdmission`, and `LegacyQueueCompatibility`.
Imported messages become native held runs with deterministic identities before runtime recovery
and worker startup. Explicit Send/Resume releases them; reading or cloning a recovery payload does
not execute it. The legacy queue HTTP compatibility surface (`list` and `control` only)
translates into V2 and is not a second live ledger or sender.

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

Imported legacy messages may still carry a `composerSnapshot`; the server keeps it, but the client
no longer reads it. Editing opens the message text without the synthetic attachment-only prompt,
the thread, machine and reply records the text still references, and its existing attachments.
Saving sends the edited text, the replacement attachment list and context, and the selected Scient
skills recomputed from the edited `$skill` mentions, as a new send computes them. Native
`queued-run.edit` retains context and selected skills when their fields are omitted. Explicit
`context: null` clears context; an explicit empty skill-selection list clears selections. Every
accepted native edit discards the previous composer snapshot.

An ordinary send carries a durable submission identity from
[`submission.ts`](../../apps/web/src/scient/threadQueue/submission.ts), so an unknown
acknowledgment retries the same command and message IDs instead of submitting twice. The server
reconciles accepted command receipts before repeating upload claims or bootstrap side effects. A
queued acknowledgment removes the optimistic message and releases local dispatch immediately. An
ordinary send clears its draft when its optimistic message appears, as upstream does. A failure
removes that message and returns the draft to an empty composer; otherwise a persistent toast
restores the whole snapshot once the composer is empty.

Queue attachment ownership participates in existing revert pruning and removal
cleanup. Bytes still referenced by a queued item or projected message are retained.

## Implementation owners

| Owner                                                            | Responsibility                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/server/src/orchestration-v2/Orchestrator.ts`               | Admission, command predicates, held state, and advancement                   |
| `apps/server/src/scient/orchestration/TerminalQueueHold.ts`      | Exact terminal boundary and held-queue eligibility                           |
| `apps/server/src/orchestration-v2/QueuedRunOrder.ts`             | Native delivery order and automatic-completion separation                    |
| `apps/server/src/orchestration-v2/QueuedMessageBudget.ts`        | Serialized-message and owned-byte limits                                     |
| `apps/server/src/orchestration-v2/EffectWorker.ts`               | Durable execution after admission                                            |
| `apps/server/src/orchestration-v2/legacy/`                       | Legacy queue cutover and recovery readers                                    |
| `apps/web/src/components/chat/QueuedRunsControl.tsx`             | Upstream's queue presentation and native commands, with marked Scient mounts |
| `apps/web/src/scient/threadQueue/useScientQueueParts.tsx`        | Retry, command errors, admission status                                      |
| `apps/web/src/scient/threadQueue/useLegacyQueueRecoveryError.ts` | One-time notice for retained pre-native queue work                           |
| `apps/web/src/components/chat/useQueuedRunEdit.ts`               | Upstream's in-place queued edit, with a marked Scient skill-selection mount  |
| `apps/web/src/scient/threadQueue/submission.ts`                  | Ordinary send submission identity and accepted-draft matching                |

## Verification and manual acceptance

Native qualification includes `NativeQueueHoldPolicy.integration.test.ts`,
`QueuedStartRecovery.integration.test.ts`, `QueuedMessageBudget.integration.test.ts`,
`LegacyV1RecoveryAcceptance.integration.test.ts`, complete runtime/worker tests,
and the mounted queue, shortcut, queued-run edit and timeline-consumer tests.
V1 ledger/worker tests are not evidence for native queue execution. Retained-reader tests qualify
only their import/recovery boundary.
Repository format, lint, type, test, build and desktop smoke gates are required
before manual review.

Manual acceptance should exercise these cases in an isolated candidate:

1. Queue several messages in A, visit B, and stay there while A finishes. Every
   message belongs to A; each starts after its own preceding answer finishes.
2. Edit a middle item over an ordinary draft containing text and attachments.
   Verify the row stays in place and is highlighted, the ordinary draft returns
   after saving or cancelling, and the saved message keeps its position. Save
   with Enter, and with `Cmd+Enter` while a turn runs to save and steer it.
3. Edit the head while the current answer finishes. When it starts, the edit
   ends and changed content moves into an empty thread draft.
4. Drag visible items while another message is being edited. Delete and explicitly
   steer rows using the existing controls.
5. Stop with multiple messages queued. Visit another task, return, and restart
   the candidate: nothing should send. Send a new ordinary message; the existing
   queue is released and follows that message automatically. Stop again with
   several queued messages, reorder while idle, then Send a later held row;
   that row starts first and the remaining queue is released in its retained
   order. Verify delivery after each successful
   finalized answer and check failed delivery/Retry separately. Exercise reload
   during editing, another window, and lost responses; inspect for missing or
   duplicated user messages and retained drafts.
6. Navigate away from an open edit and back; the edit is still open. Reload
   during an edit; the queued message is unchanged and still queued.

Visual/layout and real-provider adoption remain manual acceptance work. Unit and
integration tests do not establish those properties.
