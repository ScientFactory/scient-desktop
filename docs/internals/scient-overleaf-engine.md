# Overleaf manuscript engine

This is an unmounted server foundation, not an available product feature. No
routes, UI, automatic synchronization or network publication coordinator uses
it; the coordinator is being built in steps per its
[contract](./scient-overleaf-coordinator-contract.md).
The planned workflow is manual, folder-first synchronization through a private
bare Git repository. The workspace's repository and checkpoint index do not
participate in its merge protocol.

`OverleafRepository` uses system Git 2.39 or newer and `merge-tree` with an
explicit base. Each conflict decision covers the paths connected by renames or
an actual file/folder substitution. A historical file absent from Local, Remote
and Merged does not connect otherwise independent child conflicts. Every tree
is validated before Git or the local applier consumes it. Collision keys use
canonical normalization and pinned Unicode 9.0 full case folding; filenames
retain their original spelling. This is a conservative portability policy,
not a claim about every filesystem's complete filename equivalence relation.
The generated table carries its upstream source hash and Unicode license.

## Local application

`WorkspaceApplier` receives immutable captured, desired, base and remote trees,
conflict groups, rename identities and the paths where Scient deliberately wrote
conflict material. It stores the apply intent and content once in `plan.json`, then durably updates
a small, hash-bound `apply.json` progress record. Recovery validates both before
changing manuscript files; old draft records are upgraded once without replaying
completed steps.
A stale capture at initial preflight yields `replan` without writing any file.
Destinations precede source removal for renames. File/folder substitutions are
one unit, with blocking entries removed only after durable retention and a
reserved in-folder source copy; explicit blocking-removal, destination and final
source-removal dependency layers avoid cyclic ordering. Staging paths are returned
to the coordinator and must be excluded from capture. Directory
removal is restricted to empty directories. Failed units keep their old base
across every path of their file identity, and partly completed units are returned
as forced conflicts for the next review. Untouched skips return no forced
conflict. Recovery consults the per-file journal and staged/displaced identities
before classifying a failed unit: a completed syscall may precede the outer
progress write. Staging alone does not count as an applied change. A durable
fallback installation boundary that cannot be confirmed requires forced review,
including older fallback records where installation may have completed. Recovery never repeats
an uncertain installation over a later save or deletion.

The two retained mutation methods on `WorkspaceFileSystem` use the same
canonical-path locks as saves, creates and renames. Their filesystem critical
section is not interrupted by fiber cancellation. Each record includes staged
file identity (device and inode), expected bytes and retention locations before
the first displacement. Recovery recognizes ownership by identity rather than
content equality. The record directory must be host-owned and on the same
filesystem as the manuscript; it is not an arbitrary client-selected path.

On macOS/Linux an explicitly supplied host-owned helper can exchange the staged
file with the manuscript atomically. Compile the shipped C source with:

```sh
pnpm run build:file-exchange
```

The helper is not discovered from the workspace or PATH at runtime. Its current
consumer supplies an absolute path; packaged resolution and signing remain an
integration gate. The coordinator must supply the helper again on recovery of
an exchange-based record; it cannot silently switch that record to the fallback.
Without a helper the primitive moves the old file aside and
publishes a complete file through an exclusive hard link. Unsupported link
volumes are refused before displacement. This fallback has a missing-path window
and recovery may be needed to restore a path after a crash.

A direct writer's displaced file is compared after exchange. Mismatches are
restored without overwrite-capable rename; a competing newer file is retained
or returned and the apply reports attention. Restoration is bounded to three
exchange rounds; continued interference can leave the latest bytes in retention
with attention required, rather than at the original path. Writes through handles held across
a replacement land in retained copies. Those copies are rechecked at completion
and subsequent invocations and are never automatically removed by this layer.
The coordinator must own the retention period and user-facing compare/restore.
Containment is revalidated under the save lock; a parent-folder replacement
between revalidation and the syscall remains a shared file-service limitation.

The result separates unit completion, retained changes, unresolved marker paths
and whether the current folder matches the desired content. `complete` alone is
not permission to publish: the coordinator must also verify its immutable review
and current tree. A later edit makes the result report attention. The next
coordinator must capture and verify the exact publication tree independently.
Local executable permissions do not participate in content revisions and do not
block application; unchanged files retain their permissions. Target executable
flags are ignored. Alias-only renames remain refused until captures and the
planner represent alias moves consistently.
Marker detection is conservative and runs only on the recorded conflict paths;
ordinary Markdown underline headings are not publication failures.

## Connection state

`OverleafStateStore` keeps each manual connection's durable state under
`stateDir/overleaf`, outside every workspace. A connection document changes
only by compare-and-set on its revision, through a synced temporary file, a
rename and a directory sync, so a crash or a full disk leaves the previous or
the next complete document, never a partial one. Orphaned temporaries are
removed when a process takes the lease. An unreadable or newer-schema document
is reported as such, never treated as missing or reset; it can only be moved
to `quarantine/` with its bytes intact.

`OverleafConnectionState` defines what a document and a replacement must
keep, and the store refuses violations, validating every document before it is
written. The base never moves backwards or changes without a new generation.
Each publication attempt records its operation, request, plan digest,
workspace authority, parent, candidate and base generation; those never
change, and only its classification may move forward: `unknown` to
`accepted`, `out-of-date`, `not-sent` or `superseded-unresolved`, and
`superseded-unresolved` to `accepted`. Each outcome needs its kind of evidence.
A new attempt takes a fresh number and is recorded `unknown` on the current
base, before any send. Acceptance adopts exactly the candidate on the base it
was built for; a rejection or `not-sent` leaves the base alone. A base change
must supersede every attempt still unknown in the same replacement, and late
acceptance of a superseded attempt is recorded without moving the later base.
At most sixteen attempts may be unresolved. A pending apply link is immutable
until cleared. A retained copy keeps its revision, time and sync count; a
changed copy never becomes releasable again, and a copy is dropped only after
seven days and a later completed sync (`completedSyncCount`).
`overleafRequiredPins` names the private refs (bases, local snapshots, pending
apply target, unresolved attempts) that cleanup must keep.

Request receipts are created once per request ID. A repeat with the same
payload returns the original receipt instead of running again; reuse with a
different payload, or a second different terminal status, is refused.

Writes require a process lease: an exclusive lock on `lease.sqlite`, held by
a dedicated SQLite connection for the store's lifetime and released by the
kernel if the process dies. Another server sharing the directory gets
`OverleafStateLockedError` instead of waiting or stealing. The lease is taken
at the first write rather than at startup, so a server that started while an
older one was still exiting gains write access once the older one is gone.
Reads need no lease.

The applier's application directory (displaced copies and journals) is
`stateDir/overleaf/retained/<connection>`: private, owned by the server user,
not a symlink, outside the checkout so checkout cleanup cannot erase it, and on
the checkout's volume. A checkout on another volume is refused rather than
given storage beside it.

## Remaining integration gates

The [coordinator contract](./scient-overleaf-coordinator-contract.md) defines
the remaining work and tracks each step's status; the
[sync plan](./scient-overleaf-sync-plan.md) is the feature's planning owner.
Before exposing operations, implement connection ownership/binding checks,
prepare/apply/publish recovery, bounded inventory and repository retention,
checkout suspension for checkpoint restores and worktree/VCS operations, and
the editor-flush bridge. The coordinator must implement cancellation between
stages; the local filesystem critical section completes before cancellation can
release its save lock. Qualify unsaved editor buffers, reloads and LaTeX builds
in the development app. The exercised Cloud protocol behavior is recorded in
[the Cloud qualification](../reports/overleaf-cloud-qualification-20261009.md);
packaged, signed macOS helper behavior is a separate gate. A local bare Git
remote does not establish the Cloud bridge's commit/history or
publication-acknowledgement semantics. Server Pro, Windows and Linux remain
unverified product environments.
