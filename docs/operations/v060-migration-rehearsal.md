# v0.6.0 migration rehearsal

This runbook defines the supported, non-destructive cutover test for the first
T3-derived Scient release. It is a release-acceptance procedure, not a
database-import implementation and not authorization to publish.

## Supported v0.6.0 contract

- The new application installs as `Scient` and uses its separate
  `scient-next` application-data directory.
- Existing project folders are preserved. A user can open the same project
  folder in the new app; project files, including `PROJECT.md`, `AGENTS.md`,
  and `.scient/project.json`, remain the project's source of truth.
- The old application's data directory is not probed, adopted, copied, or
  modified by the new app.
- v0.6.0 does **not** import the old app's chat history, provider credentials,
  or SQLite database. The two applications have divergent migration
  lineages, so copying `state.sqlite` would be unsafe and is not a supported
  migration.
- The old application remains a rollback option while the new release is
  evaluated. A failed cutover must not destroy or rewrite the old app's data.

This is intentionally a safe application cutover with project portability,
not a promise of historical chat-state continuity. A future database import,
if desired, must be a separately designed, versioned, tested migration.

## Rehearsal rules

Run the rehearsal with temporary directories only. Never point either app at
`~/.scient`, `~/.scient-next`, a real project containing private data, or a
production credentials directory. Record the exact artifact version and
source SHA used.

### 1. Prepare isolated homes

Create a temporary root with separate old and new homes, for example:

```sh
REHEARSAL_ROOT="$(mktemp -d)"
OLD_HOME="$REHEARSAL_ROOT/old-scient"
NEW_HOME="$REHEARSAL_ROOT/new-scient"
PROJECT="$REHEARSAL_ROOT/project"
mkdir -p "$OLD_HOME" "$NEW_HOME" "$PROJECT"
```

Use the old app's `SCIENT_HOME` override for the old artifact and the
candidate's `SCIENT_NEXT_HOME` override for the new artifact. Do not share
either directory between processes.

### 2. Establish old-app continuity

1. Launch the old artifact with `SCIENT_HOME="$OLD_HOME"`.
2. Create one disposable project at `"$PROJECT"`, add a harmless marker file,
   and create representative local state (for example, one thread and one
   provider entry using test credentials only).
3. Close the old app cleanly.
4. Record a recursive checksum or file listing of `"$OLD_HOME"` and
   `"$PROJECT"`.

### 3. Open the same project in the new app

1. Launch the v0.6.0 artifact with `SCIENT_NEXT_HOME="$NEW_HOME"`.
2. Open `"$PROJECT"` from the project picker.
3. Confirm the project opens without waiting for a database conversion.
4. Confirm the existing marker file and existing project guidance are
   unchanged.
5. Initialize only if the project is missing Scient guidance; initialization
   must preserve any existing files.
6. Confirm the new app creates only its own state below `"$NEW_HOME"` and does
   not create, rename, or modify anything below `"$OLD_HOME"`.
7. Confirm provider setup is presented as a fresh connection in the new app;
   old credentials are not silently reused.

### 4. Verify rollback

1. Close the new app.
2. Relaunch the old artifact with `SCIENT_HOME="$OLD_HOME"`.
3. Confirm the old app can reopen the disposable project and its prior local
   state.
4. Compare the post-rehearsal old-home and project checksums/listings with the
   records from step 2.
5. Remove the temporary root only after the evidence has been recorded.

## Acceptance result

The cutover passes only when all of the following are true:

- the new artifact starts with an isolated `scient-next` home;
- the existing project folder remains intact and usable;
- no old SQLite database or credential store is copied or mutated;
- the old application still starts and retains its original disposable state;
- any limitation on historical chats or provider sign-in is clear in the
  release communication.

A build-only release run, a green CI badge, or a successful manual launch does
not by itself satisfy this rehearsal.
