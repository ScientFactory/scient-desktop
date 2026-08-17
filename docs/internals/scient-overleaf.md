# Scient Overleaf manual-sync adapter

## Invariants

The adapter implements Model B: each connection owns a private Git mirror under
`<stateDir>/scient/overleaf/v1/connections/<connectionId>/mirror`. Workspace files are projected
artifacts, not a nested Git clone. This keeps the workspace/checkpoint repository and its index out
of the synchronization protocol.

The v1 invariants are:

- network activity begins only from an explicit Connect, Sync, Retry, Repair, or Sync-and-disconnect
  request;
- one connection operation is admitted at a time and concurrent requests fail instead of queueing;
- an operation creates at most one unpublished outbound workspace snapshot commit;
- only `HEAD:master` is pushed, without force and without tags or private refs;
- the candidate is pushed before workspace projection;
- workspace projection uses click-time hashes, a durable journal, same-filesystem temporary files,
  and per-file backups;
- conflicts and conflict markers remain in the private mirror;
- tokens never appear in contracts, registry/connection JSON, logs, errors, arguments, or URLs; and
- commit author/committer metadata comes only from the selected human account identity.

## Owned boundary

Server code lives in `apps/server/src/scient/overleaf`, web code in
`apps/web/src/scient/overleaf`, with one contract file and one client-runtime file. The feature does
not use `ProcessRunner`, `GitVcsDriver`, workspace VCS registries, checkpointing, editor internals,
Desktop IPC, or mobile code.

`scient-overleaf-seams.json` declares every inherited mount/dependency and enforces a budget of eight
mounts. Run:

```sh
pnpm overleaf:seams:check
```

The owned Git executor uses Effect's `ChildProcessSpawner` with `extendEnv: false`. It resolves Git
to an absolute executable, builds a closed child environment, bounds both output streams, applies a
timeout, and nests process-tree termination inside operation-runtime cleanup. Credentialed commands
receive an operation-scoped askpass token file. On Windows the helper is a `.cmd` launcher plus
Windows PowerShell using `File.ReadAllText` and `Console.Out.Write`, so no CR/LF is appended.

## Durable state and recovery

Registry, connection, baseline, and operation records are schema-decoded and written by temp-file,
file fsync, rename, and directory fsync where the platform supports it. Startup removes abandoned
credential runtime directories. Human review/conflict states survive restart. An interrupted push
becomes outcome-unknown, and an interrupted confirmed-push projection remains offline-retryable;
other in-flight Git phases become interrupted and require explicit repair.

Projection journals record the expected candidate hash and backup for each managed path before a
mutation. Recovery rolls back only when the current file still matches journaled partial output; a
later user edit wins. Replace-local backups are retained until disconnect. Ordinary projection
backups are removed after convergence.

After a confirmed push, projection failure records `remote_synced_local_pending`. A retry is local
only. A click-time compare-and-swap mismatch records the accepted remote candidate and requires
offline three-way reconciliation using a retained private ref for the exact click tree as Base, the
accepted candidate as Overleaf, and the current workspace as Local. Only the later-local delta is
rebased onto the accepted candidate, so unrelated collaborator changes are not turned into reverts.

A lost push response records `push_outcome_unknown` and leaves the workspace untouched. Retry uses
candidate tree equality first, then candidate-tree presence in first-parent history, then commit
reachability. Tests must cover bridges that preserve commit objects and bridges that recreate them.

## Review policy

Candidate status comes from `git diff --find-renames=50% --name-status -z`. Unmatched deletions,
per-file historical reverts, and whole-tree historical reverts always block. The first rename per
connection blocks with a metadata-displacement warning; its future warning can be suppressed without
suppressing destructive review. All confirmations bind to the operation generation and candidate
commit and are invalidated by a refetch/rebase.

File/count guidance is advisory. Hard failures are reserved for trees that cannot be represented
safely: unsafe/platform-invalid paths, case-fold collisions, symlinks/reparse traversal, submodules,
LFS configuration, unsupported Git modes, disk failure, or loss of crash-safe projection.

## External release gates

The unit boundary cannot establish Overleaf Git Bridge object semantics or packaged-platform HTTPS
behavior. Before release, run the disposable Cloud/Server Pro acceptance matrix from the implementation
plan. In particular, push and refetch a unique tree, compare commit IDs, make a later web edit, and
verify that the pushed tree remains discoverable in first-parent ancestry. Exercise cancellation of
a live `git-remote-https` descendant and verify that no process or runtime credential directory
survives. Browser UI evidence requires the repository's explicit browser/computer-use approval.
