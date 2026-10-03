# Scient thread queue: architecture, behavior, and retirement

This is the maintenance contract for the desktop/web queue. The server owns
ordering and delivery. The open conversation is only a view and a composer;
navigation, remounts, and additional windows cannot start a queued turn.
This document describes the implementation in this checkout. Automated checks
and manual product acceptance are separate; no visual acceptance is implied.

## Behavioral contract

- Enter during a running turn, or while messages are already eligible to advance, adds a
  message to the current environment and thread. After Stop, ordinary idle Send starts
  new work while the existing queue waits for its successful completion. Otherwise idle Send uses
  the existing immediate-send path. The server accepts an ordinary Send as either
  an immediate turn or a durable queue entry in the existing event/receipt
  transaction. Busy/completion-boundary races never require a second Send.
  It never silently becomes steering.
- A normal follow-up submitted while work is running appears above the composer
  as **Queuing…**, rather than briefly appearing as a sent conversation message.
  The server receipt determines its final placement. An accepted queued preview
  remains there until the queue snapshot or delivered message arrives; if the
  turn finished and the server sent it immediately, it enters the conversation.
  Draft content is still cleared only after acceptance, and pending previews
  expose no queue editing, steering, deletion, or reordering actions.
- Each waiting message starts individually after the preceding turn's answer
  ingestion **and** checkpoint finalization settles. A failed checkpoint does not
  make a successfully delivered answer unsuccessful. A session's `ready` status
  alone is insufficient. Provider thinking, tool work, and intermediate output
  do not advance the queue.
- Explicit Cmd/Ctrl+Enter and a row's Steer action retain their existing meaning.
  They request immediate provider adoption. Provider support or rejection is
  independent of queue admission. Ordinary queued delivery never steers.
- Edit durably copies text, attachments, settings, and context into the existing
  local recovery journal, then atomically removes the old queue entry using the
  existing edit-token receipt. It becomes an ordinary composer draft. The previous
  ordinary draft is saved through the existing stash menu.
- The edited draft has no reserved slot and never submits itself. Other queued
  messages continue normally. Send starts the draft when idle and eligible, or
  adds it to the queue tail when work is active or earlier entries are eligible.
  Stash and restoration preserve the full draft without resurrecting a queue slot.
- Stop preserves every waiting item, with no automatic delivery.
  A new ordinary message can start work once the session is inactive. Starting that
  work, becoming idle, reconnecting, or restarting the server never releases the queue.
  Only a later successfully finalized answer makes the next waiting item eligible.
  An unsuccessful answer waits for later successful work in the same way.
- When idle after Stop or an unsuccessful answer, the first waiting row offers
  **Send**. This explicitly requests that existing message as a new ordinary
  turn through the server-owned worker. The remaining items wait for its answer
  and checkpoint settlement; reorder first to choose another message. Stop and
  reorder cancel an unadmitted Send request. Older connected servers do not
  advertise `threadQueueExplicitSend`, so their clients do not offer this action.
- Retry applies to a pre-admission delivery error. It cannot bypass an active
  finalization barrier or the requirement for a successful answer after Stop.
  No Retry or additional confirmation is needed after later successful completion.
- Limits remain 20 items, 64 MiB serialized
  queue data per thread, and the existing provider input/attachment limits.
  Normalized image and file attachments count toward the byte cap. The worker
  reuses their owned bytes through an internal-only normalization path; client
  commands cannot claim another message's durable attachment IDs.

## Durable server authority

`apps/server/src/scient/threadQueue/` owns the implementation:

| File            | Responsibility                                                             |
| --------------- | -------------------------------------------------------------------------- |
| `Ledger.ts`     | Typed SQL document, caps, revisions, admission checks, completion barriers |
| `operations.ts` | Enqueue, edit, requeue, stash, delete, reorder, resume, Send, steer        |
| `Worker.ts`     | Scoped background sender and restart reconciliation                        |
| `signals.ts`    | Runtime-local wakeup hints keyed by SQL client identity                    |
| `http.ts`       | Authentication, authorization, transactional mutation, revision reads      |
| `migration.ts`  | Transactional, one-time import of legacy queue payloads                    |
| `Store.ts`      | Read-only v1 JSON compatibility reader                                     |

Scient migration **11**, `thread-queue`, belongs to the independent
`scient_schema_migrations` registry. It does not add an upstream numbered
migration. Its tables share the orchestration database and transaction:

- `scient_thread_queue`: one document and monotonically increasing revision per
  thread. The document contains ordered items, migration completion, the delivery
  barrier (`blocked`), active turn ID, `awaitingCompletion`, and a delivery-error
  pause reason. `awaitingCompletion` distinguishes waiting after interruption from
  a retryable delivery failure. It remains true while recovery work runs; only
  successful finalization clears it.
- `scient_queue_receipts`: stable message IDs, owning thread IDs, and the last
  committed edit token. Receipts survive consumption and deletion so a lost
  response cannot recreate an already accepted message.
- `scient_queue_finalization`: independent answer/checkpoint markers by thread
  and durable turn ID. Duplicate markers are harmless; answer failure is sticky
  for that turn, while checkpoint failure only records that its attempt settled.
  Stop writes `successful = 0` in the same transaction as the waiting state,
  revoking that turn's eligibility even if a late success arrives. Existing durable
  turn identities are reused; no second execution-ID system or new SQL table is needed.

Environment ownership comes from the authenticated environment connection and
its database; thread ownership is explicit in every request and command. A
receipt cannot be reused for another thread. Deleting a thread clears its queue
and retains an empty migration tombstone so an old JSON file cannot resurrect it.

## Admission and finalization

1. A mutation runs in a SQL transaction, validates ownership and current state,
   enforces caps, updates the revision, and issues a wakeup hint.
2. The worker rereads SQL, chooses the first waiting item (or an explicitly
   requested steer), and checks the target session. It normalizes attachments
   using the existing attachment pipeline.
3. Its `thread.turn.start` carries internal `queueItemId` and `queueRevision`.
   The command ID is `queue:<itemId>:<revision>`; the message ID is
   the original submission message ID, or `queue:<itemId>` for legacy items. The revision permits a fresh attempt after a rejected stale
   claim while command receipts deduplicate the same attempt.
4. Inside the engine's existing event/receipt transaction, `observeQueueCommand`
   checks the revision, item state, order, session and barrier. It consumes the
   item and closes the barrier atomically with the user message and start events.
   Competing edits, deletes, reorderings, workers, and direct starts cannot both
   win admission. There is no later client-side remove operation.
5. Provider session adoption records the active turn ID. Final answer ingestion
   signals only after final assistant segments, images, and plans are persisted.
   The checkpoint reactor signals after checkpoint capture or its valid skip
   path. Both matching markers are required to release delivery. A stale turn's
   completion cannot release a newer turn.
6. A successful answer with a settled checkpoint wakes the next item. An
   unsuccessful answer leaves the queue waiting for later successful work; a
   pre-admission error remains retryable.

New queue entries capture model/options, runtime mode, and interaction mode.
Admission applies those settings through the existing orchestration events
before the provider starts. Legacy entries without settings use the thread's
current settings. Explicit steering uses the active thread's settings.

The worker starts once per scoped server service. It subscribes before its
initial database scan and processes wakeup hints from a deduplicated mailbox.
Committing a ready session also wakes its queue: a previous attempt may have
skipped an eligible item while the session was still busy. This notification
occurs after the projection transaction commits and does not change queue state
or bypass the answer/checkpoint barrier, Stop recovery, pause, or FIFO rules.
Hints carry no authority; SQL is always reread. There is no background sender
poll and no dependency on a mounted ChatView. Client display refreshes ask once
per second for a revision; unchanged replies do not resend image payloads.

## Failure and restart semantics

A rejected pre-admission attempt keeps the item. Known rejected attachment claims
are cleaned up. If a concurrent mutation changed the revision, the worker
rereads after its wakeup; otherwise a failure pauses the queue visibly.

After durable admission the item is represented by the orchestration message,
not a second waiting copy. A provider-side failure leaves remaining items waiting; it
cannot safely be interpreted as proof that the provider never received the
message. Scient does **not** promise exactly-once execution inside an external
provider or blindly replay an ambiguous accepted start.

At server restart, each persisted incomplete barrier is transactionally converted
into `awaitingCompletion`, retaining all items and invalidating the previous turn.
It does not replay a start or consume a waiting item. A later admitted start can
run normally; its successful answer and checkpoint completion release one item.
Queues already eligible before shutdown can still advance in the background.

The lifecycle transitions are:

| Event                                                     | `blocked` | `awaitingCompletion` | Queue items                          |
| --------------------------------------------------------- | --------- | -------------------- | ------------------------------------ |
| Stop, failed active session, or incomplete server restart | false     | true                 | Preserved                            |
| New ordinary/automation start admitted                    | true      | Preserved            | Preserved                            |
| Provider adopts that start                                | true      | Preserved            | Preserved; eligible turn ID recorded |
| Session becomes ready, or only one finalizer finishes     | Unchanged | Unchanged            | Preserved                            |
| Answer succeeds and checkpoint settles                    | false     | false                | Next item becomes eligible           |
| Answer fails after checkpoint settles                     | false     | true                 | Preserved                            |
| Aborted turn for the eligible turn                        | false     | true                 | Preserved                            |
| Worker admits the next eligible item                      | true      | Preserved            | Exactly that item consumed           |

An aborted turn records an unsuccessful answer and settled checkpoint, so it
ends the barrier without advancing delivery or remaining blocked indefinitely.
The eligible-turn check still applies: an abort naming any
other turn cannot release the current one.

Stop clears the eligible turn ID and cancels any unadmitted Send or Steer request,
retaining that message in its slot. Finalization also cancels an unadmitted
Steer aimed at the completed turn. New explicit actions remain available.
A late running notification while waiting with no admitted start also invalidates that notification's turn ID; it cannot rearm
an interrupted pending start. Running notifications for failed/invalidated or
already completed turn IDs are ignored by the ledger. New work enters through
`thread.turn.start`, whether sent by the composer or another server caller.
Turn IDs retain their existing meaning: a new execution has a new turn
ID; reopening an interrupted execution's session is not a new answer.

Ordinary Send admission checks both the actual session and the durable barrier.
Only an inactive task waiting for completion can start an ordinary message ahead
of its retained queue. Of competing recovery sends, one starts and the other is
accepted into the queue. Edited composer drafts use this same rule.

Earlier candidate documents without `awaitingCompletion` retain compatibility:
legacy Stop/failure/restart pauses convert transactionally on read to waiting
state. Delivery-error pauses remain retryable. No payload or edit journal is
rewritten by this conversion. No live application data is needed for tests.

## Composer draft ownership and recovery

The capability foundation adds optional `selectedScientSkillNames`
and `composerSnapshot` to queue items. The latter is bounded versioned JSON
(4 MiB per item, also within the existing thread-byte cap), retained opaquely by
the server and decoded by the client with the existing draft-context codecs.
It contains raw composer text and terminal/preview/review selections;
images and delivery settings remain in their existing fields. It is edit data,
not provider input or authority. Delivery uses `text`, the same typed message
`context` as immediate turns, attachments, and independently captured Skill
selections. The worker never interprets the edit snapshot. There is no second
queue or database migration.

`threadQueueMessageContext` advertises typed queue support separately from
`inlineMessageContext`: older hosts can understand immediate context without
preserving queued records. Clients use the existing legacy-context serializer
when queue support is absent. Image IDs and capture metadata survive queueing
and editing; the normal attachment pipeline rebinds client IDs at admission.

New edit snapshots use version 2. Version 1 snapshots and older edit journals
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
An update replaces/removes optional context and selection fields rather than
retaining stale data or selection intent from the previous version.

`editSession.ts` keeps both complete drafts in the existing IndexedDB journal,
including attachment bytes. Before extraction, the client saves the queue item's
snapshot and bytes. The server checks its update timestamp or existing edit token,
removes the item transactionally, and records the token in the existing receipt.
A matching extraction retry succeeds without removing another entry. A legacy
accepted-requeue fingerprint cannot be mistaken for an extraction receipt.

Extraction installs the edited content into the ordinary draft identity. Async
callbacks retain their captured draft targets. Journal persistence resamples the
previous draft before replacement, so typing during extraction is retained in
its stash. Browser Web Locks prevent two windows from recovering the same edit
journal concurrently. Storage or network failure preserves the draft and recovery
intent; a lost response reconciles with the same token.

Send uses the ordinary submission path. Its stable identity is retained through
an uncertain response, and the server reconciles accepted command receipts before
repeating upload claims or bootstrap side effects. A queued acknowledgment removes
the optimistic message and releases local dispatch immediately. Acceptance clears
only the submitted draft; typing during the request remains in the composer.

Stashes reference full journals instead of placing file bytes in localStorage.
Restoration saves a discoverable recovery journal for the target draft before
releasing the source copy. Browser storage is local to that installation; clearing
it removes local draft recovery data. It is not cloud draft sync.

Queue attachment ownership participates in existing revert pruning and removal
cleanup. Bytes still referenced by a queued item or projected message are retained.

## API and compatibility

The authenticated API is `/api/scient/thread-queue/v2/` with `list`, `enqueue`,
`update`, `remove`, `reorder`, and `control`. List accepts `knownRevision`.
Mutations return the authoritative snapshot. Expected queue conflicts/capacity
errors use a typed 409 response; unexpected storage errors use the existing
internal-error channel. Read and operate scopes remain distinct.

Old unversioned queue endpoints are removed. Client turn starts must advertise
`queueProtocolVersion: 2`; the shared updated client runtime supplies it. This
prevents an old client-owned queue pump from dispatching copied queue contents.
Older connected clients must update before sending. Internal queue admission
fields are absent from the client command schema.

At startup, the server discovers valid v1 files, including unopened threads,
and imports each existing thread transactionally. First HTTP access also imports
if necessary. Hashed filenames and older safe thread filenames are accepted;
ownership, schema, duplicate IDs, and size are checked. Source bytes are retained
unchanged. Invalid files are not erased or converted to an empty successful
import; opening their thread surfaces the failure. Deleted/nonexistent threads
are not imported.

## Integration seams and retirement

Protected upstream seams are the command schema/protocol gate, engine admission
transaction, decider settings events, provider ingestion, checkpoint reactor,
reactor/server layer wiring, shared HTTP client errors, and composer wiring.
There are no new orchestration event types. Review these semantic seams during
an upstream merge even if Git merges them cleanly.

A native replacement must first preserve the behavioral contract above. Retire
this implementation only with a migration for waiting items, withdrawn slots,
receipts, incomplete barriers, and local edit journals. Remove the old sender
before enabling another sender. Keep deployed Scient migration history intact;
do not delete or renumber migration 11. Retained v1 files are recovery sources,
not active authority. Remove this document only after the replacement owns the
contract and recovery path.

## Verification and manual acceptance

Automated coverage belongs to `Ledger.test.ts`, `Worker.test.ts`, `Store.test.ts`,
`editSession.test.ts`, `submission.test.ts`, orchestration engine/ingestion/checkpoint tests, migration
schema tests, and the existing disposition/image-restore tests. The worker test
uses real SQL, normalization, engine receipts and projections, with no mounted
client or provider call. Repository format, lint, type, test, build, and desktop
smoke gates are required before manual review.

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
   the candidate: nothing should send. Send a new ordinary message; the queue
   waits through that answer, then advances one message per completed answer.
   Stop again and repeat. Check failed delivery/Retry separately. Exercise reload
   during editing, another window, and lost responses; inspect for missing or
   duplicated user messages and retained drafts.
6. Stash and restore an edit through the usual menu. Reload immediately after
   restoration; check text, file/image bytes, settings, and context fidelity.

Visual/layout and real-provider adoption remain manual acceptance work. Unit and
integration tests do not establish those properties.
