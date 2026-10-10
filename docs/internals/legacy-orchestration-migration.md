# Legacy orchestration migration

Orchestration v2 snapshots `state.sqlite` into `statev2.sqlite` before opening writable persistence
on its first launch. Only the copy receives v2 migrations; the original remains available to v1.
Subsequent launches preserve V2 state and reconcile newer V1 history from the sibling original
database. This covers profiles that first created V2 and then continued using V1. It creates V2
thread shell events first and imports the complete transcript lazily when a client reads or
continues the thread, with a background pass for remaining history.

The original is attached read-only during a consistent startup transaction. Only inert historical
inputs are refreshed in the copied legacy tables; source before-images and pending revisions are
retained in Scient's separate migration ledger. Existing projects, native V2 threads, V2 deletion
tombstones, provider sessions, execution queues, and checkpoint authority are preserved. A V1
thread-event ancestry check rejects an unrelated original database when the copied event boundary
is available. A committed source event watermark avoids rescanning unchanged history on every
launch.
Without an event boundary, startup compares the historical rows on each launch: thread counts
and update timestamps alone cannot establish that message or plan content is unchanged. Recovery
logs include the snapshot-refresh duration, and the refresh has its own tracing span.

Reconciliation rechecks current V2 content inside the EventSink transaction. Untouched imported
content receives newer V1 text or historical outcomes. If V2 content has changed, its identity and
content remain intact and a labelled **Recovered V1 version** is added as inert history. Thread
metadata is merged field by field against the copied baseline; conflicting V2 values are retained.
Threads already continued in V2 retain their metadata, execution settings, and workspace binding
even if those fields subsequently changed in V1. A V1 archive or snooze cannot hide continued V2
work.
Rows removed by a V1 rewind are retained as before-images and removed from the import inputs, so
an unfinished import cannot resurrect them. Facts already committed to V2 remain V2 history,
including their positions. Source reconciliation never deletes existing V2 history.

Pending revisions reset only the affected transcript completion markers. Stable event and recovered
version identities make an interrupted import retryable without duplicating committed history or
overwriting edits made before the retry. A revision is acknowledged only after all its history,
attachments, and metadata have been reconciled. Failure to inspect the original rolls back the
staging transaction and leaves restoration visibly incomplete, while the existing V2 state remains
usable. Neither a missing transcript nor a source failure is repaired by replacing the V2 database.
Later source revisions reuse an existing recovered conflict version when its V1 content is unchanged;
another V1 edit retains a separate recovered version without replacing the primary V2 content.

## Imported data

The shell import preserves the project and thread identifiers, title, provider and model selection,
runtime and interaction modes, branch, worktree path, creation and update times, archive and delete
times, settlement override and timestamps, snooze timestamps, pin timestamp and order, and linked
pull request. The metadata repair path fills snooze, pin order, `unsettledAt`, and linked pull request
fields for threads imported before those fields were covered.

Transcript import reads user and assistant rows from `projection_thread_messages`. It preserves
message identifiers, text, supported attachments, timestamps, role, and ordering. A message that was
still streaming becomes an interrupted turn item.

Attachment entries are validated independently so a malformed entry cannot erase valid siblings.
The raw legacy attachment JSON remains available. A malformed JSON value or entry leaves the
thread's import incomplete and prevents continuation with silently missing context; valid entries
are still visible in its imported messages. Retrying does not duplicate history or overwrite V2
edits. Persistent malformed source data requires investigation rather than an automatic database
reset. This does not rewrite imports already acknowledged by an earlier build.

Background restoration reports completion only after the import ledger has no pending threads
and the original-source check has succeeded (or no original is present).
An incomplete pass or failed completion check produces a persistent restoration notice, including
the remaining thread count when it can be verified. Failure details are optional on the existing
lifecycle payload: older clients can still decode it and see restoration as incomplete, while
updated clients show the error notice. Unaffected threads remain usable. Opening an
incomplete thread retries its import, and restarting retries the background pass and refreshes the
overall status. The original V1 database and copied legacy tables are retained for recovery.

Scient's `LegacyScientHistory` also preserves reasoning and system messages, activities and tool
facts, submitted user-input answers, historical approvals, and proposed plans as inert V2 history.
`LegacyV1ThreadImporter` hydrates this history, including repair of already-imported threads.

V1 stored one tool call as many work-log rows (started, one per progress report, completed); V2
keeps one item per call. The import folds a call's rows into one item at the place of its first
row, without losing content: the last row wins and any field it lacks, at the top level or inside
`data`, comes from the newest earlier row (`toolLifecycle.ts` in `@scientfactory/conversation`).
The item shows how the call ended: completed, failed, or interrupted when it never completed.
Context-meter and "Checkpoint captured" rows are dropped; V2 reads neither. On real conversations
this imports 18 to 36 times fewer items. A thread an earlier build already imported row by row
keeps that shape, so a later repair never leaves its items without positions.
Historical approvals and callbacks do not acquire active requests or execution authority; plans
remain inspectable historical facts. The importer does not restore live provider session identity,
native provider runs, or checkpoint/diff execution state.

## First continuation

A migrated thread has no active provider thread. Its first continuation creates a fresh provider
session. `ProviderTurnStartService` delivers eligible imported history through the same native
handoff budget as other portable transfers. Eligible items stay whole: selection prioritizes the
latest user, latest assistant, and original user items, then fills from newest to oldest and delivers
in chronological order. Oversized items are omitted. The default allowance is 16,000 tokens with a
64,000-byte ceiling, reduced for the target window, existing native context, current input,
attachments, and headroom. See [context handoffs](./context-handoffs.md) for delivery and recovery;
the former 32,000-character transcript-suffix rule is superseded.

## Client and server cutover

Clients and servers must agree on `ORCHESTRATION_PROTOCOL_VERSION` (currently 2). The client
runtime appends `orchestrationProtocol=2` to the socket URL, and the `/ws` route rejects a missing
or mismatched version with HTTP 426 (`orchestration_protocol_incompatible`) before any RPC or auth
work runs. The client checks the environment descriptor the same way: a missing version means the
host predates protocol 2, and a different version means both sides need updating. Either direction
blocks the connection as `unsupported` with a message naming the machine to update rather than
running half-upgraded. See `packages/client-runtime/src/connection/compatibility.ts` and
`apps/server/src/ws.ts`.

## Divergent migration ids

`effect_sql_migrations` records `migration_id` and `name`, but the migrator compares ids only:
rows at or below the recorded maximum are skipped without checking names. A database that ran a
local or fork migration under an id this build later assigns to a different migration therefore
never receives this build's migration at that id. `runMigrations` logs each recorded id whose name
differs from the manifest so the skipped schema change is diagnosable. There is no safe id range
for a fork inside this ledger: any id at or below a future upstream id masks it forever, so fork
schema changes belong in a separate migration table or outside the migrator entirely.

## Recovery

Scient's conversation export operates on the current V2 conversation. Offline recovery of the
original V1 data is a separate operation: use an untouched copy of the environment's `userdata`
directory and open that copy with SQLite's read-only mode. The user guide documents the queries
against `projection_threads` and `projection_thread_messages`. Never start a server against the
recovery copy because startup can run migrations and write new state.
