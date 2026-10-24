# Overleaf manuscript engine

The server mounts it behind authenticated routes (`/api/scient/overleaf/v1/*`)
through `OverleafSync`; no screen or agent tool calls them yet, and nothing
synchronizes automatically. Its plan, contract, owner decisions
and status live on the working-documents PR
[#535](https://github.com/ScientFactory/scient-desktop/pull/535), which is
closed rather than merged; this file records what is implemented.
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
apply target, and the parent and candidate commits of every attempt still
recorded that is unresolved or accepted) that cleanup must keep. An accepted
attempt keeps its pins until it is pruned, so Undo stays possible after its
bases rotate out or Overleaf's history is rewritten. A pending undo
(`sync-undo` apply link) names its attempt, and a document is valid only while
that attempt is recorded as accepted, so it cannot be pruned meanwhile. The
coordinator writes required refs by what the repository holds, not by the
previous document's list: a required ref found missing is written again, and a
failure to write it fails the replacement. Only an accepted attempt's ref (kept
for Undo alone) whose object Git confirms is gone is left out, so it never
blocks.

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
`stateDir/overleaf/retained/<connection>` when Scient's state shares the
checkout's volume and lies outside it. Otherwise it is a hidden
`.scient-overleaf/<environment>/<connection>` folder beside the checkout on the
project's own disk, so projects on external disks are supported. Either way it
is private, owned by the server user, not a symlink and outside the checkout,
so checkout cleanup cannot erase it. Its location is recorded as the disk's
volume UUID (from `diskutil`) plus the folder's file ID, never the device
number, so a disk mounted again under another path is recognized. Once
recorded, nothing is created: a missing folder (unplugged disk, deleted
folder) or a different folder in its place is reported, never replaced.
Before use, a probe exchanges two files through the host's exchange helper;
a disk that cannot (exFAT and FAT among them) is refused. Without a helper,
the declared development fallback requires hard links instead. Each refusal
has its own reason: disk not connected, no volume UUID, unsupported file
system, read-only or shared parent, checkout at the root of its disk, unsafe
folder, missing or replaced folder.

## Checkout barrier

`scient/workspace/CheckoutBarrier.ts` keeps an Overleaf apply and a bulk change
of the same checkout from overlapping. A checkout is a Git working tree's top
folder, found by physical identity, so every path into it (a subfolder, a
symlink) is the same checkout. A checkout inside another (a submodule, a nested
repository) belongs to both, because a recursive checkout or pull of the outer
one rewrites the inner one too.

- A bulk change (checkpoint restore, pull, switching branch, creating a branch
  and switching to it, moving a pull request's worktree to its head, checking
  out a pull request locally, removing a worktree) closes new apply admission
  at once, waits for running applies to finish, then runs.
- Bulk changes of one checkout run one at a time. One the owning fiber makes
  inside its own section (a provider's checkout calling the Git driver) runs
  within it; any other fiber, a forked child included, waits its turn.
- An apply asking to start during a bulk change is refused
  (`CheckoutSuspendedError`), not queued.
- Each bulk change advances the checkout's epoch as it starts and as it ends,
  even if it fails. A plan made against an older epoch is stale; an inner
  checkout's epoch includes its enclosing checkouts'.
- Before a bulk change runs, registered settlers may finish unfinished local
  work inside its section, or refuse the change (`CheckoutRecoveryRequiredError`,
  which Git callers see as a `GitCommandError`). A folder that can't be examined
  is a `CheckoutLookupError`, mapped the same way.

The hooks sit in the Git driver's method table (one wrapper per bulk method, so
callers that bypass `GitWorkflowService` are covered too), in
`CheckpointServiceV2.restore`, in `GitManager`'s local pull-request checkout
(provider command-line tools that never reach the driver), and in storage
cleanup's worktree removal. Each is marked `SCIENT-FORK:START
overleaf-checkout-barrier`. The barrier is a `Context.Reference` whose default
is one instance per server process, shared however each layer was built.
Arbitrary shell writers, external Git commands and other server profiles are
outside it.

## Coordinator

`OverleafCoordinator` prepares reviews, applies a
confirmed one and sends its result to Overleaf, recovers an interrupted apply,
settles earlier sends, lists and restores kept copies, and undoes an accepted send.

- **Lock order.** The connection's operation reservation comes first: in
  memory, refused (`OverleafOperationActiveError`) rather than queued. Then the
  checkout barrier's application section, then the store's compare-and-set,
  then the file layer's locks. Overleaf is fetched before the section.
- **New files** (pr-c-design section 5). A review prepared without a list of
  additions selects every new file no rule skips; an explicit list, even an
  empty one, is used exactly as given. The rule is judged again at every
  capture and never remembered: build leftovers, hidden files (any path
  segment starting with `.`, the file's own name included), Scient's own
  `AGENTS.md` and `PROJECT.md` (under any letter case or Unicode spelling,
  compared by collision key) when the linked folder is the checkout's top,
  and files over 50,000,000 bytes. A file too large is never read, not even a
  prefix: the opened file's type and size are checked again before its first
  bytes are read, so one that grew after the listing is marked too large.
  Selecting one is refused (`file-too-large`); an LFS pointer is
  left out of the default selection rather than refused. Each review lists
  every addition with whether it is selected and why it is skipped. On
  confirm, only an addition sent by default that the selection left out joins
  `localOnlyPaths` (at most 2,000, `local-only-limit`). `sendLocalOnly` sends
  paths from that list: they are read like selected additions, leave the list
  when the review is applied and become managed. A path not on the list is
  `not-local-only`, one not in the folder `not-selectable`. A file Overleaf
  already has is managed and synced whatever its name.
- **Per-file requests.** `keepOnlyHere` and `send` are judged on the review's
  own capture, with the defaults applying to every other file. `keepOnlyHere`
  keeps a new file only on this computer and remembers it, whatever the rule
  says of it; it wins over every request to send, ignores a path that is not a
  new file, and leaves a local-only one local-only. `send` selects a skipped
  new file (refusing one too large), sends a local-only one, and is already
  satisfied for a managed one, so a retry after the apply succeeds. Both are
  recorded in the binding and applied again by every replacement review, so a
  kept file that disappears and returns, or shrinks, stays kept. The binding's
  `keepOnlyHere` also holds every deliberate deselection, including one an
  explicit `selectedAdditions` list implied, so it survives replacements the
  same way; its `send` also holds every `sendLocalOnly` request, so a file
  first decided as a collision is still sent if that collision is gone when a
  replacement review is built. A local-only file being sent stays a collision candidate: where
  Overleaf has content at its place it is read in full and reviewed as a
  collision (keep mine or use Overleaf's), never merged into Overleaf's file.
- **Confirm.** Inside the section, it checks the folder and retention
  identities, captures the folder again and rebuilds the review with the same
  choices, the same selected and sent files, the same deliberate deselections,
  and the default rule for anything else. A deliberate deselection is kept
  whatever the rule now says of the file (one that grew too large stays kept
  only here). A file that appeared meanwhile is
  therefore selected by default, never taken for a "keep only here", and a
  selected file that is gone is left out instead of refused, so the rebuilt
  review differs and replaces the stale one. Capture reads the base's paths, the managed paths and
  every path in a forced conflict. A different digest is a stale review: the
  fresh one is offered and nothing is applied. Before anything is written it
  checks room:
  for every kept copy the apply could add, and for every group an interruption
  could leave as a forced conflict (at most 2,000 paths each). Then, before the
  applier runs, it records the receipt, a local snapshot, the intent pin and
  `activeApply`, in that order.
- **Adoption** is one document replacement:
  - the base: a tree written from the applier's per-path base on the fetched
    remote commit, with the previous base moved into `priorBases`;
  - managed and local-only paths;
  - `forcedConflicts` (interrupted groups) and `markerPaths`;
  - kept copies, each with its place in the retention folder and a stamp (size
    and change time) taken around a fresh read of its bytes, from the file its
    path still names. A copy that no longer holds what the applier kept is
    recorded `changed`, never released;
  - `completedSyncCount`, which advances only on `complete`;
  - unknown publication attempts, which become `superseded-unresolved`;
  - the link, cleared.

  Recovery resumes the applier by the linked ID and adopts once. A link whose
  apply never recorded its plan is cleared as a replan.

- **Bulk changes.** The coordinator registers the barrier's settler: a bulk
  change of a checkout with a pending apply recovers it inline when the
  reservation is free, and is refused otherwise. Structural copies in the
  folder always refuse it, including any the inline recovery finds.
- **Listing kept copies** compares each copy by its stamp and reads again only
  a changed or extra version. One listing reads at most one inventory's total;
  a file past that budget, or larger than a restore reads (a kept copy or the
  folder's file), is listed `unread`, which is not the same as gone.
- **Restore.** It puts a kept copy back as a one-file `retained-restore` apply,
  only if both the copy and the folder's file still have the revisions the
  request saw. It reads the copy and the folder's file once each, never past
  50 MiB; a folder file too large to read is never taken for an absent one.
  Before writing, it checks room for the copy it keeps, a file it brings back
  into the sync, the group it may leave and conflict material it tracks again.
  The file it replaces is kept (state `kept`), the base never moves, and the
  restored bytes are a local change for the next review. A restore the applier
  cannot finish leaves its file as a forced conflict, beside those already
  recorded.
- **Undo** puts back what Overleaf had before one accepted send, named by its
  attempt number (design section 4.3). Any other attempt, or one no longer
  recorded (the last 64 are), is `not-eligible` with the reason. Under the same
  reservation, receipt (`undo`) and application section as a restore, it
  compares the attempt's parent tree with the tree it sent: every changed path,
  both sides of a rename included, goes back to the parent's entry (its bytes,
  or absence). The folder is captured as a review captures it, plus any file at
  a changed path that the sync no longer reads, and a path is put back only
  while it holds exactly what the send left there; otherwise it
  is skipped and reported (`changed`, or `already-undone` when it already holds
  the earlier version). A file it would recreate is skipped (`name-clash`) when
  another spelling of it or of a folder above it is on disk, a file stands
  where a folder above it must go, or the result would not be a valid tree;
  one larger than a restore reads is `too-large`. An attempt whose commits the
  private repository no longer holds is `not-eligible` (`history-unavailable`).
  Before anything is written it checks room for one kept copy per path it
  touches (recreated files included: interference can leave a version there),
  for the managed set afterwards (files it writes join it; files it removes
  leave it where every capture reads them anyway, the base or a forced
  conflict, so a rename at the 2,000-file limit fits) and for interruptible
  groups. It then runs as a `sync-undo` apply, adopted like a restore:
  displaced files are kept (`kept`), the base never moves, nothing is sent,
  and each file the applier wrote (its recorded base, keyed by blob ID, holds
  the written blob, in recovery too) joins the managed set and leaves the
  local-only list; a write it skipped keeps the path's earlier part in the sync. A
  removed path (the link records them, `retired`) leaves the managed set once
  the applier has removed it, or where the base or a forced conflict covers
  it; a removal skipped elsewhere stays managed, so its file stays in the sync.
  Recovery resumes the same intent, and a repeated request returns the
  receipt. Saving open editors first is the caller's job.

### Publication

After a complete adoption, confirm sends the result. Steps 1 to 4 run inside its
application section, which is released before the network is used (contract
section 9):

1. **Gate.** Nothing is sent after a partial apply, while conflict material or
   structural copies remain, or when a copy this apply kept is `changed` or
   `ambiguous`. The result is `blocked` with the reason.
2. **Nothing to send** when the candidate equals Overleaf's fetched tree
   (`none`).
3. **Verify.** The folder is captured again, the way a review captures it and
   over every path the plan read or wrote (so an explicit deletion must still be
   absent), and its tree must equal the candidate. A difference is
   `not-verified`, and the edit is the next review's to send. Each copy this
   apply kept is checked again by its stamp: one a late writer changed is
   recorded `changed` and the send is `blocked`. From here on, the content comes
   from the private repository's objects, never from the folder.
4. **Record.** The candidate is committed on the plan's fetched head. The
   attempt is recorded `unknown` with its pins, before anything is sent.
   Resolved history makes room; a confirm that would need a seventeenth
   unresolved attempt is refused before the apply.
5. **Send admission**, a short application section of its own, decides from
   what it finds there: the same checkout (every key of its chain, so a
   replaced or removed checkout fails) at the same epoch as at verification,
   the same physical folders, and the credential the review used. Anything else
   (a pull, switch or restore that ran or is running, a replaced checkout or
   folder, a renewed credential) records `not-sent` (`send-refused`). Changes
   after admission are later local changes and never alter what is sent.
6. **Send** once, never forced, holding no section, so a pull or branch switch
   of the checkout does not wait for the network. `accepted` makes the
   candidate the base in the same replacement. `out-of-date` keeps the adopted
   base. Anything else stays `unknown`, as does an attempt whose finalizing
   write fails.

**Settling earlier sends.** Prepare (on the head it fetches) and recover (one
fetch) check every unresolved attempt against Overleaf by positive evidence
only:

- the head's tree equals the candidate's;
- the candidate's tree is in a first-parent commit (of the last 64) that
  descends from the attempt's parent, so a rewritten history proves nothing;
- the candidate commit is reachable from the head.

An unknown attempt on the current base becomes the base when accepted. A
superseded one is only marked accepted, and the later base stays. Absent
evidence changes nothing, including when Overleaf still holds the parent. The
review warns about each unresolved attempt (`unresolved-publication`), and the
confirmation must acknowledge it. Nothing is ever resent.

A crash after the send leaves the confirm receipt `running` and the attempt
`unknown`. A repeated request returns that receipt, and recovery settles the
attempt.

## Saving open editors

Text a person typed is on disk only once the window holding it has saved it.
`scient/editorFlush/EditorFlush.ts` lets a server operation ask every window
of this environment to save its editors for one folder, and wait:
`flushFolder({ checkoutRoot, folder, timeout, overallTimeout })`. Nothing
calls it yet; the Overleaf agent tools will, before prepare and again before
confirm.

- Each window subscribes once (`editors.flushConnect`), asks where its
  editors' files are (`editors.flushResolve`), answers (`editors.flushRespond`)
  with the files it saved and every file it could not save, named relative to
  the checkout, with the reason: `unconverted-input` (visual input not yet
  source), `composing` (an input method is composing), `save-failed`, or
  `conflict` (the file changed outside an editor holding unsaved text), and
  says goodbye when it closes (`editors.flushLeave`, sent on `pagehide`, which
  a closing desktop window also fires). All four need the filesystem write
  scope.
- A window is known by the authenticated session of its connection and the
  id it chose. Another session can neither replace it nor answer, resolve or
  say goodbye for it. A window that reconnects replaces its own earlier
  connection, and every call names its connection: an answer or resolve
  counts only from the connection the request last reached, and a goodbye
  only from the window's latest connection, so a late call from a replaced
  connection can neither satisfy a request nor remove the window. The window
  itself drops a flush that finishes after its connection was replaced.
- A page kept in the back-forward cache keeps its drafts, so its `pagehide`
  sends no goodbye; restored (`pageshow`), it registers again at once. A
  window says goodbye at most once per connection, so after registering again
  a later close says goodbye again.
- Membership is not the set of open streams. A window that says goodbye is
  forgotten at once, and a request still awaiting it stops waiting. A window
  whose connection drops without a goodbye stays known for five minutes: every
  flush asks it, sends the request again when it is back, and otherwise counts
  it `Unanswered` (`disconnected`), so the sync stops and names it. After five
  minutes it is retired. A window that registers while a request is open is
  asked too.
- The boundary: a window lost for longer than five minutes, or one that
  connects only after a new server's ten-second wait for its first window
  (that wait cannot prove no window exists), is not asked. Its unsaved drafts
  stay protected by the outside-change and revision conflict (contract
  section 10): a later save from it cannot silently overwrite what the sync
  wrote. The remaining risk is only that the sync ran without that window's
  latest typing.
- A window's answer time (`timeout`) starts when the request reaches it, so
  one that reconnects late still gets the whole time. The request as a whole
  ends at `overallTimeout`, however many windows join meanwhile.
- The result is `NoWindowOpen` (no window known: nothing is unsaved),
  `FolderUnavailable` (the folder could not be examined), or `Answered` with
  one outcome per window and `allSaved`. An unanswered window is never a
  success.
- Files are placed by physical identity (`folderIdentity.ts`): the folder is
  known by device and inode, and a file is inside when a folder physically
  holding it is that folder, so a symlinked spelling or another letter case
  finds it. A file not yet on disk is placed by its nearest existing folder. A
  file the server cannot place (`unknown`) fails when its editor holds unsaved
  text.
- The window side (`apps/web/src/scient/editorFlush/`) uses the existing save
  pipelines only. LaTeX Visual input of editors whose own file is inside is
  committed in the background, as the editor's idle save does: focus,
  selection and open fields stay as they are, and input that cannot become
  source this way (an open title field, a raw block) is reported
  `unconverted-input`. An editor of a file outside the folder whose document's
  root is inside is only inspected. Then open documents are flushed through
  the document registry, and ordinary file editors through
  `WorkspaceFileSessionRegistry.flushWhere`. Source editors and the Markdown
  Visual editor register their composition state (`editorComposition.ts`).
- Right before answering, every editor in the folder, every one the server
  could not place, and every one not yet placed (opened while the server was
  being asked) is checked again at once. If any has unsaved text the whole
  save runs once more; a file still unsaved then fails, as edited again or as
  not placed.

## Service and routes

`OverleafSync` (`OverleafSync.ts`) is what the routes, and later the agent
tools, call. It owns one coordinator and `OverleafConnections`, which share the
coordinator's per-connection reservations.

- **Listing.** A connection is listed only for the host project that owns its
  recorded binding (by binding ID), whatever its folder's path resolves to now.
- **Authority.** A request names the caller's workspace or thread; the server
  resolves it. A connection is used only while its checkout still resolves to
  the binding and authority generation it recorded (otherwise `relink-needed`),
  and only by callers of the same host project. A caller in another worktree acts
  on the linked copy, and results say so (`linkedElsewhere`). Both authorities,
  as resolved when the request began, are checked again with the folders before
  every change to them and inside send admission (`OverleafAuthorityGuard`); a
  change there is `authority-changed`, or `not-sent` at the send. Relink is
  allowed only to the host project that owns the binding the connection
  recorded, found by its ID even when the old checkout is gone; unknown
  ownership refuses.
- **The token.** One Overleaf Git token, in the server secret store
  (`overleaf-git-token-<site>`). Saving or removing it advances the credential
  epoch, so reviews built before it are stale, and waits for fetches and pushes
  in progress. A push runs only with the token its review was built with; a
  missing or renewed token fails it before Git runs. The token is never
  returned, logged or put in an error. Git failures leave the service as fixed
  reasons (`access-denied`, `project-not-found`, `unreachable`,
  `git-unavailable`, `git-failed`).
- **Connect** (`OverleafConnections.connect`). It refuses folders that are not
  real folders inside the checkout, a folder equal to, inside or around another
  active connection's (compared by the device and inode of each folder up the
  path, so letter case and Unicode spelling cannot hide a nesting), and a second link of one project in one checkout. It
  then prepares the retention folder, discovers the single `main`/`master`
  branch, fetches once and records an empty base. It writes no manuscript file
  and sends nothing. "Bring in as a new folder" creates the folder, which must be
  absent or empty, and removes it again if connect fails. Connect checks again,
  inside registration and before it records anything, that the caller's
  authority still holds. A connect has a receipt bound to its caller's binding
  and request: a repeated request returns its connection or recorded refusal,
  and the same request ID with other input is refused. Disconnect and relink
  have receipts the same way. A request whose receipt was begun but never
  finished (the process stopped) is never run again: it answers
  `request-incomplete`. Connect and relink refuse (`records-unreadable`) while
  any connection record cannot be read, since it may own the folder. Connecting a folder whose archived
  connection has the same project reactivates that archive, so its base, kept
  copies and unresolved sends survive, but only when the folder is the very
  directory the archive recorded (same volume and file ID) and the archive's
  recorded binding belongs to the caller's host project; otherwise a new
  connection starts with an empty base and the archive is left as it is. A new
  directory made at an archived folder's path would otherwise inherit the old
  base, and its first sync would delete Overleaf's files. Git failures leave as fixed categories
  (`access-denied`, `project-not-found`, `unreachable`, `no-branch`,
  `git-unavailable`).
- **Disconnect** archives the connection; it refuses while an apply or its
  staged files are unsettled, and rechecks authority before the change. **Relink** records a moved folder or a renewed
  workspace binding, finds the retention folder by its recorded identity, and
  keeps the base. It refuses a second link of one project in the target
  checkout.
- **Status** reads disk only, and is reused for two seconds while the
  connection's record is unchanged: availability (`ready`, `recovery-required`,
  `attention`, `unavailable`, `disconnected`) with every reason, and the
  folder's changes against the base by Git object ID (changed, deleted, and new
  files the next sync would send).
- **Sync** is the product rule: only a conflict stops it. It prepares a review
  with the default selections; a review whose every conflict has a choice is
  confirmed at once with its acknowledgements. A review rebuilt because the
  folder changed is confirmed the same way, up to three times. An out-of-date
  push starts one new sync. Every outcome except `duplicate` says what the sync
  did before it: `retried` (the first attempt applied a review and its send was
  out of date, so that attempt wrote the folder and sent nothing) and `settled`
  (an interrupted earlier sync it finished first, with how that apply ended). A
  preview's review carries `settled` too; the coordinator's prepare reports a
  completely recovered apply as `settled` on its review. Conflict choices answer one Overleaf tree
  (`reviewedRemote`); when Overleaf has moved, a review that still has conflicts
  is shown again without them, and one that has none is confirmed as usual.
  Per-file decisions (`files.keepOnlyHere`, `files.send`) go to the engine's
  selections, applied to the review's own capture and carried through rebuilt
  reviews; reviews list every new file with its selection and skip reason.
  A caller that saved a folder's editors first passes `savedFolder`; sync,
  preview, recovery and kept-copy restore then hold the connection and refuse
  (`folder-changed`) if the link no longer names that folder. The coordinator's confirmations inside a sync use
  server-made 64-character request IDs, which no client request ID can equal.
  **Cancel** asks the running sync to stop at its next stage boundary (before
  it prepares again, or before it applies); an apply or send already started
  finishes, and its outcome stands. A sync has its own receipt, so a repeated request
  returns it instead of syncing again. The result names other agents working
  in the same checkout (a running turn or background work), read before and
  after the sync, never the caller or its subagents, and `null` when activity
  could not be read.

## Remaining integration gates

The coordinator contract on [#535](https://github.com/ScientFactory/scient-desktop/pull/535)
defines the remaining work and tracks each step's status.
Before exposing operations, implement connection ownership/binding checks and
bounded repository retention, call the editor flush before prepare and confirm,
and derive status (a
`running` receipt whose operation is no longer live was interrupted). The coordinator must implement cancellation between

defines the remaining work and tracks each step's status. The editor-save
request, the agent tools and the screens come next. Derive interrupted
operations in status (a `running` receipt whose operation is no longer live was
interrupted). The coordinator must implement cancellation between
stages; the local filesystem critical section completes before cancellation can
release its save lock. Qualify unsaved editor buffers, reloads and LaTeX builds
in the development app. The exercised Cloud protocol behavior is recorded on #535;
packaged, signed macOS helper behavior is a separate gate. A local bare Git
remote does not establish the Cloud bridge's commit/history or
publication-acknowledgement semantics. Server Pro, Windows and Linux remain
unverified product environments.
