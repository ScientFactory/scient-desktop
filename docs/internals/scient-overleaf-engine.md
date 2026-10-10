# Overleaf manuscript engine

This is an unmounted server foundation, not an available product feature. No
routes, UI, automatic synchronization or network publication coordinator uses it.
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

The macOS artifact pipeline compiles the requested arm64, x64 or universal slices
from source and stages the protocol-1 helper outside ASAR at
`Contents/Resources/file-exchange/scient-file-exchange`. The existing signing hook
signs it with hardened runtime and empty helper entitlements, and verifies its
signature and team against the app. Final bundle validation checks its receipt,
executable permissions, architecture and protocol on a compatible host.

Desktop supplies that absolute server-host path through its private bootstrap.
The helper is never discovered from the workspace or PATH at runtime. Development
uses the explicit `build:file-exchange` output. A separately launched server may
set the absolute host-owned `SCIENT_FILE_EXCHANGE_PATH`; a client path cannot
select the remote server's helper. A packaged macOS installation preserves the
required path even when damaged, so a missing or incompatible helper fails
visibly instead of silently falling back. Recovery resolves the current app's
resource path rather than persisting an obsolete installation path; it preserves
the journaled mechanism and refuses to downgrade an exchange-based record.
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

## Disposable Git protocol qualification

`pnpm overleaf:qualify:git` rehearses the actual Git executor and bare repository
against a local disposable remote, without Cloud traffic. It exercises publication,
fresh independent reads, stale-push rejection, file/folder renames and positive
acceptance evidence after a simulated discarded acknowledgement and later edits.
It never automatically retries publication. Missing history remains unknown;
simulating an acknowledgement loss does not prove behavior under real network loss.

For Cloud qualification, create a fresh disposable project with Git access and
no collaborators, then run this in your own interactive terminal:

```sh
pnpm overleaf:qualify:git --cloud --project https://www.overleaf.com/project/PROJECT_ID --output /absolute/new-report.json
```

Enter the token only at the hidden prompt. The script accepts only credential-free
official Cloud URLs, asks for disposable-project confirmation, uses private
operation-scoped askpass files and removes its local repositories/runtime afterward.
The new report is private, redacts push output and contains no project URL,
token or manuscript content. The project retains the probe files and history for
inspection. Never use a working manuscript or put credentials in command arguments.

The script pauses for browser edits, History labels/revert, displayed-author
inspection, and comments/tracked-change inspection across a content-preserving
rename. Features not exercised are unverified rather than reported as lost. A
browser confirmation alone is not evidence: the probe fetches the required edit
before attempting a stale push and verifies restoration to the pre-ack tree
before testing acceptance after a revert. Missing changes stop the run without
another push. Git startup failures are reported using fixed diagnostic categories;
raw errors and credentials are never included. A completed run is an observation
report, not an automatic qualification verdict.
Review failed, unknown and unverified observations before proceeding to the
coordinator; local rehearsal does not qualify Overleaf's Git bridge.

The disposable Cloud probe confirmed non-fast-forward rejection without remote
mutation, preserved commit/tree identity on fresh reads, and positive acceptance
evidence in bounded history after a browser restore. A content-preserving Git
rename appeared as delete/create in browser History and lost the file's comments
and tracked suggestions. Publication appeared as **You (via Git)**, not a Scient
author label. The coordinator's review must disclose the rename loss and must not
promise that label. A discarded acknowledgement was simulated after an accepted
push; actual network loss remains unverified.

## Remaining integration gates

Before exposing operations, implement connection ownership/binding checks,
prepare/apply/publish recovery, bounded inventory and repository retention,
checkout suspension for checkpoint restores and worktree/VCS operations, and
the editor-flush bridge. The coordinator must implement cancellation between
stages; the local filesystem critical section completes before cancellation can
release its save lock. Qualify unsaved editor buffers, reloads and LaTeX builds
in the development app. Real Overleaf Cloud protocol behavior and packaged,
signed macOS helper behavior are separate gates. A local bare Git remote does
not establish the Cloud bridge's commit/history or publication-acknowledgement
semantics. Server Pro, Windows and Linux remain unverified product environments.
