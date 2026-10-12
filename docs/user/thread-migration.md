# Upgrading a Scient thread database to V2

On your first V2 launch, Scient copies the V1 database, `state.sqlite`, into `statev2.sqlite`
in the same selected profile directory and migrates the copy. Your threads appear automatically,
with full transcripts imported as needed. You do not need to run an import command. This upgrades
the selected Scient profile; it does not adopt a different application's or retired profile's data.

V1 continues using its original database while V2 uses the copy. The database import can run while
V1 is open. Opening V2 again resumes your V2 history and checks the original database for V1
conversations or history newer than its first copy. This automatically restores conversations
created in V1 after an earlier V2 launch. Settings, attachments, and workspace files remain shared.
V2 changes are not written back into V1.

If the same content changed in both versions, your V2 edit is preserved and the recovered V1
content appears with a **Recovered V1 version** notice. Existing V2 deletions are respected. A
rewind in V1 removes rows from an unfinished import; history already committed to V2 is retained.
If restoration cannot finish, Scient keeps a restoration notice visible. Restarting retries it;
keep both databases and request support if the notice persists.

The V2 desktop app uses a separate browser profile, so browser cookies and caches do not carry
over from V1. You may need to sign in again to websites opened inside the app. On its first launch,
the V2 desktop app copies stashed prompts, unsent drafts, layout, and theme from V1. Anything you
change in V2 afterwards stays in V2.

The migrated thread keeps its title, project, provider and model selection, permission and
interaction modes, branch or worktree, archive state, settlement state, snooze and pin state, and
linked pull requests and local fork ancestry. Scient also brings over user and assistant messages,
their timestamps, structured context, and supported attachments. Large histories may appear in
stages while the server imports transcripts.

Historical tool/activity records, system messages, approval outcomes, and proposed plan text are
retained as timeline items. An unresolved old approval is interrupted historical evidence, not a
live request: it cannot authorize a tool or restore the old provider session. Historical plans do
not create live execution nodes. Message-only imports made by an earlier V2 build receive the
missing historical items when first opened, without overwriting edits already made in V2.

The migration does not recreate old runs, live provider sessions, native fork authority,
checkpoints, or diffs. Legacy queued messages become held V2 queued runs, retaining their order,
selected skills, context, composer snapshot, attachments, and execution options. They wait for
an explicit Send or Resume; stale send, steer, and edit authority is cleared. The old queue entry
is retired only after V2 durably accepts it. If acceptance fails, its payload remains available
for recovery. Send releases the idle queue head; Resume releases the queue. A project clone must
finish before either can deliver work.

If saved queued work cannot be admitted, Scient shows a recovery notice above the composer.
Keep your recovery copy and restart Scient to retry. If the notice persists, request recovery
support before sending those messages again; their saved payloads remain retained.

## Continuing a migrated thread

The first new message starts a fresh provider session. Scient selects intact user and assistant
messages using the same [handoff budget](./portable-handoffs.md) as a provider switch. Omitted text
remains in the thread and can be retrieved by the agent. The migration retains its separate
32,000-character recovery excerpt; neither that excerpt nor the handoff replaces the full imported
transcript.

Before continuing a long or important thread, read the recent transcript and include any older
requirements the agent still needs in your next message. Starting a new thread and pasting a short
handoff is also a good choice when the old conversation contains conflicting instructions.

## Keeping a recovery copy

Before a major server update, stop the server and copy its entire configured `userdata` directory
(or its development-state directory) to a safe location. Include both `state.sqlite` and
`statev2.sqlite`, any SQLite `-wal`/`-shm` files, attachments, settings, and `scient/thread-queue`.
A server started with `--home-dir <path>` normally uses `<path>/userdata`; use the actual state
directory for development or desktop-managed profiles. Do not copy just one database while a
server is writing to it. For an online database-only snapshot, use SQLite's backup API separately
for each database; this does not back up attachments or other profile files.

If a migrated transcript is missing from the app, keep that copy unchanged. You can inspect the
old transcript without starting a server against it:

```sh
sqlite3 -readonly /path/to/recovery-copy/state.sqlite
```

At the SQLite prompt, list recent legacy threads:

```sql
.headers on
.mode tabs
SELECT thread_id, title, updated_at
FROM projection_threads
ORDER BY updated_at DESC;
```

Then print one transcript, replacing `<thread-id>` with the value from the first query:

```sql
SELECT role, text, created_at
FROM projection_thread_messages
WHERE thread_id = '<thread-id>'
  AND role IN ('user', 'assistant')
ORDER BY created_at, message_id;
```

Open only the copied database. Do not edit it or point a newer or older server at your recovery
copy. If the affected environment is remote, make and inspect the copy on the machine that runs
that environment.
