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
  the existing immediate-send path. Server admission rejects an ordinary Send
  that races a busy thread or waiting queue; the draft remains available and
  sending again queues it. It never silently becomes steering.
- Each waiting message starts individually after the preceding turn's answer
  ingestion **and** checkpoint finalization finish. A session's `ready` status
  alone is insufficient. Provider thinking, tool work, and intermediate output
  do not advance the queue.
- Explicit Cmd/Ctrl+Enter and a row's Steer action retain their existing meaning.
  They request immediate provider adoption. Provider support or rejection is
  independent of queue admission. Ordinary queued delivery never steers.
- Edit withdraws the row from the visible and deliverable queue. Its position
  remains reserved internally. The queued text and images occupy the existing
  composer; any ordinary draft is temporarily hidden intact. There is no second
  editor, additional confirmation, or changed queue layout.
- Enter while editing returns that item to its reserved position, then restores
  the ordinary draft. If earlier items started during editing, they cannot be
  overtaken; the edited item remains ahead of the surviving items that followed
  its slot. If no turn is active and the queue is eligible, it can start immediately after requeue.
  Requeue after Stop continues waiting for a successful answer.
- Editing does not block other waiting messages. Dragging rearranges visible
  items across visible slots while hidden edit slots remain fixed. For example,
  `[A, editing B, C, D]`, dragged to visible order `[D, A, C]`, becomes
  `[D, editing B, A, C]`.
- The existing Stash action during an edit saves that complete edit, removes its
  reserved queue slot, and restores the ordinary draft. Restoring that stash is
  ordinary draft restoration; it does not resurrect a queue position.
- Stop preserves every waiting item and edit reservation, with no automatic delivery.
  A new ordinary message can start work once the session is inactive. Starting that
  work, becoming idle, reconnecting, or restarting the server never releases the queue.
  Only a later successfully finalized answer makes the next waiting item eligible.
  An unsuccessful answer waits for later successful work in the same way.
- Retry applies to a pre-admission delivery error. It cannot bypass an active
  finalization barrier or the requirement for a successful answer after Stop.
  No Retry or additional confirmation is needed after later successful completion.
- Limits remain 20 items (including withdrawn edit slots), 64 MiB serialized
  queue data per thread, and the existing provider input/attachment limits.
  Desktop/web queued attachments remain images; generic files are still supported
  in ordinary drafts and immediate sends, but cannot be queued.

## Durable server authority

`apps/server/src/scient/threadQueue/` owns the implementation:

| File            | Responsibility                                                             |
| --------------- | -------------------------------------------------------------------------- |
| `Ledger.ts`     | Typed SQL document, caps, revisions, admission checks, completion barriers |
| `operations.ts` | Enqueue, edit, requeue, stash, delete, reorder, resume, explicit steer     |
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
  and durable turn ID. Duplicate markers are harmless; failure is sticky for that
  turn. Stop writes `successful = 0` in the same transaction as the waiting state,
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
   `queue:<itemId>`. The revision permits a fresh attempt after a rejected stale
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
6. A successful release wakes the next item. Unsuccessful finalization leaves the
   queue waiting for a later successful answer; a pre-admission error remains retryable.

New queue entries capture model/options, runtime mode, and interaction mode.
Admission applies those settings through the existing orchestration events
before the provider starts. Legacy entries without settings use the thread's
current settings. Explicit steering uses the active thread's settings.

The worker starts once per scoped server service. It subscribes before its
initial database scan and processes wakeup hints from a deduplicated mailbox.
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
| Both finalizers succeed for the eligible turn             | false     | false                | Next item becomes eligible           |
| Finalization fails                                        | false     | true                 | Preserved                            |
| Worker admits the next waiting item                       | true      | false                | Exactly that item consumed           |

Stop clears the eligible turn ID and cancels any unadmitted Steer request,
retaining that message in its slot. A new explicit Steer action remains available.
A late running notification while waiting with no admitted start also invalidates that notification's turn ID; it cannot rearm
an interrupted pending start. Running notifications for failed/invalidated or
already completed turn IDs are ignored by the ledger. New work enters through
`thread.turn.start`, whether sent by the composer or another server caller.
Turn IDs retain their existing meaning: a new execution has a new turn
ID; reopening an interrupted execution's session is not a new answer.

Ordinary Send admission checks both the actual session and the durable barrier.
Only an inactive task waiting for completion can accept an ordinary message ahead
of its retained queue. Two competing recovery sends cannot both win. Editing
continues to requeue in its reserved slot, even when the task is stopped.

Earlier candidate documents without `awaitingCompletion` retain compatibility:
legacy Stop/failure/restart pauses convert transactionally on read to waiting
state. Delivery-error pauses remain retryable. No payload or edit journal is
rewritten by this conversion. No live application data is needed for tests.

## Composer draft ownership and recovery

`editSession.ts` maintains a local IndexedDB journal containing both full drafts,
including File/Blob bytes, image metadata, settings and structured composer
context. The ordinary draft keeps its original scoped identity. The edit has an
internal draft identity but renders through the same keyed ChatComposer. During
in-app switching, editor state/history/cursor are cached by draft identity and
never shared between those two drafts. Reload restores draft contents, not the
previous process's undo history.

Before withdrawal, both drafts are durably saved. The server's editing token
owns the reserved slot; other tokens cannot overwrite or delete it. Browser
Web Locks prevent two windows in the same origin from simultaneously recovering
and editing the same journal. Closing the owning window releases its lease.
Other devices are still governed by the server token and cannot adopt that
window's local unsaved draft.

Attachment bytes live in a separate IndexedDB store and are written only when
the File object changes; keystrokes write lightweight draft metadata. Completing
an edit removes its journal-owned blobs. Autosave operations serialize by journal key. Requeue flushes the journal,
reasserts the same edit token, submits the replacement, and deletes the journal
only after durable acceptance. The receipt token makes retries harmless even
if the worker already consumed the replacement. Storage/network failures retain
both drafts and report an error. A lost withdrawal response retains its durable
intent and token for retry. A definitive conflict leaves the ordinary composer
untouched. A committed edit receipt also stores a payload fingerprint: changed
text after a lost response cannot be mistaken for an identical retry.

Async attachment and transcript callbacks retain their original draft target.
The composer is remounted on draft identity changes; unmounted voice callbacks
write to their captured draft, never the newly visible composer. Sending waits
for pending image compression/voice work, and the editing composer is disabled
while its submission is in progress. Ordinary enqueue clears only the unchanged
submitted draft, so newly typed text or a different task cannot be erased by a
late response. If content still arrives during an accepted requeue, a recovery
copy is retained through the existing prompt stash and reported visibly. Incoming
approvals/questions cannot consume the editing draft as an answer; their normal
composer controls return after requeue or stash.

Stashed queue edits retain their full journal rather than fitting file bytes
into localStorage's smaller prompt-stash image allowance. Their existing stash
menu entry points to that journal. Browser storage is local to that installation;
clearing it removes local edit/stash recovery data. It is not cloud draft sync.

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
`editSession.test.ts`, orchestration engine/ingestion/checkpoint tests, migration
schema tests, and the existing disposition/image-restore tests. The worker test
uses real SQL, normalization, engine receipts and projections, with no mounted
client or provider call. Repository format, lint, type, test, build, and desktop
smoke gates are required before manual review.

Manual acceptance should exercise these cases in an isolated candidate:

1. Queue several messages in A, visit B, and stay there while A finishes. Every
   message belongs to A; each starts after its own preceding answer finishes.
2. Edit a middle item over an ordinary draft containing text and attachments.
   Requeue it, verify its position and the restored ordinary draft, then exercise
   cursor/undo and repeated navigation.
3. Edit the head while the current answer finishes. Later waiting items may
   start; the withdrawn message must not. Requeue before and after that advance.
4. Drag visible items while another slot is being edited. Delete and explicitly
   steer rows using the existing controls.
5. Stop with multiple messages queued. Visit another task, return, and restart
   the candidate: nothing should send. Send a new ordinary message; the queue
   waits through that answer, then advances one message per completed answer.
   Stop again and repeat. Check failed delivery/Retry separately. Exercise reload
   during editing, another window, and lost responses; inspect for missing or
   duplicated user messages and retained drafts.
6. Stash an edit, restore the ordinary draft, then recover that edit through the
   existing stash menu. Check text, image bytes, settings and context fidelity.

Visual/layout and real-provider adoption remain manual acceptance work. Unit and
integration tests do not establish those properties.
