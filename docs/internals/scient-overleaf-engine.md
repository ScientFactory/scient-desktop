# Overleaf manuscript engine

The server mounts it behind authenticated routes (`/api/scient/overleaf/v1/*`)
and agent tools ([Overleaf agent tools](scient-overleaf-agent-tools.md)), both
through `OverleafSync`; no screen calls them yet, and nothing synchronizes
automatically. Its plan, contract, owner decisions
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

`OverleafGitExecutor` runs each Git command with an environment built from
scratch (its own `HOME`, configuration, hooks folder and askpass) in a scratch
folder under its runtime root, removed afterwards. On macOS it runs the real Git
of the selected developer tools (`xcode-select -p`, then Command Line Tools,
then Xcode), resolved once, never the `/usr/bin/git` launcher: that launcher
runs `xcrun`, which records every new `HOME` in a shared database in the user's
temporary folder (`getconf DARWIN_USER_TEMP_DIR`, whatever `TMPDIR` says),
rewriting it on every command (it grew to 84 MB, with 22 GB of leftover partial
copies) and costing about 0.1 s per command. A Git found earlier on `PATH`
(Homebrew, `/usr/local`) is used as before.

A review reads the blobs it needs in one `cat-file --batch` run each (small new
blobs from Overleaf checked for LFS pointers, and the bytes of every file it
would write), not one Git run per file; each blob and their total are held to
the same limits as before.

### Timing

`OverleafSync.bench.ts` syncs 1, 10 and 50 files each way, and 300 files
from Overleaf into one folder, against a local bare repository with the real
applier and prints the time of each stage. It runs in the explicit benchmark
lane (`test:performance`), outside normal CI test discovery. From `apps/server`:

```sh
pnpm exec vp test bench --run --fileParallelism=false --maxWorkers=1 src/scient/overleaf/OverleafSync.bench.ts
```

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

Each file write costs helper runs, so the file layer avoids the ones that
decide nothing (it once took about 300 runs per file, growing with every
record kept in the same folder):

- A lease binds each directory it locks natively when it is taken, walking the
  path from `/` without following links, and is refused if any identity
  differs. The bindings handed to it for a directory on itself (every ancestor
  up to the volume's edge, each held record's folder, a retention folder) are
  therefore observed in process on macOS and Linux: the path is canonical and
  names a directory, not a link, with that device and inode. A path that is
  not canonical, or Windows, still asks the helper.
- The helper's capabilities are asked once per helper binary (path, device,
  inode, size, change time) and root (canonical path and volume); a replaced
  helper or a root on another volume asks again.
- A private retention folder the helper already found private in this
  process is not provisioned again while it stands unchanged: same canonical
  path, device, inode and change time as just before the helper looked. Mode
  bits alone are not enough, because only the helper reads access lists (a
  macOS ACL can open a 0700 folder to everyone), and any change to owner, mode
  or access list moves the change time. A folder seen for the first time, or
  changed since, goes through the helper as before; a folder that gains
  entries changes too, so a record store is asked about on each write.

Journals, their syncs and the order of every step are unchanged.

What a lease holds of the kept records (`bindingsFor` in
`WorkspaceFileMutations.ts`). A write first looks at every record kept for its
folder and for its path, to finish any a crash left unfinished before it
touches the folder. It holds exclusively the folder of each record it may
change, and no other:

- its own record;
- every record not finished: settlement may finish it. This includes an index
  whose journal is not written yet (a write in flight), a journal that cannot
  be read, and a finished record with a discard under way (below).

Settled reads, the workspace epoch and the publication fence (`withRoot`) and
listing one file's versions hold only unfinished records too; a discard holds
the record whose copy it removes, and accepting a record's attention
(`resolveFileMutation`) holds that record. A finished record (a version 2
journal at `done`) is final: its target, mutation id, outcome and published
revision never change, its journal is replaced in one rename so a read sees it
whole, and whoever changes it (a discard, an acceptance) holds it. Adding a
view of a kept copy (`retainedViewPath`: listing, and the attention a refused
write or a read reports) needs no hold: a view is a hard link of a copy still
there, a second making finds the same file there, and a discard removes the
copy before its view, so a view made meanwhile is removed too or never made.
The target's folder and the workspace root are held as before (exclusive
folder, shared ancestors), so two writes in one folder still run one at a
time. Holding every record found, as the file layer once did, made the lease
grow by one folder with every write ever kept in that folder: an incoming sync
of 300 files into one folder stopped at file 236, past the 256 folders a
native lease can bind, and each write took longer than the one before; a file
with that many versions could not list or discard them, and that many
accepted attentions stopped every settled read. `WorkspaceFileMutations.lease.test.ts`
checks that a save's lease and a settled read's lease stay the same size as
records accumulate, that a save succeeds beside 300 finished records, that a
file with 300 versions lists and discards them, and that reads and the epoch
succeed beside 260 accepted attentions; the benchmark's `incoming 300` case
syncs 300 new files into one folder.

A discard marks the version in the journal (`discarded`, and `discarding`
until it is done) and syncs that before anything goes, then removes the copy,
then its view, syncs the folder and only then drops `discarding`. A crash at
any point leaves the mark: the record then counts as unfinished, so the next
settled read, epoch or write that finds it holds it and finishes the removals
(each may already have happened). Without the mark a discard killed between
the copy and its view left the view holding the old bytes, hidden from the
listing yet counted against the retention budget
A legacy record (journal version 1) is never finished, so every lease that
finds it holds it; its discard writes a durable tombstone (`discard-<copy>.json`)
before the same removals, and settlement finishes any whose copy or view is
still there (`RetainedDiscard.crash.test.ts` kills a child before the copy goes,
between the two, and after both, for both kinds of record). A kept copy may be
a folder (one that stood where a file was). Nothing below a kept copy's name
is ever visited: a file or link is removed with `unlink` (a link as a name),
a folder with a single `rmdir`, which removes only an empty real folder and
fails harmlessly on one with anything in it, a link or a mount point. A
discard of a kept folder with anything in it is refused before anything is
marked (`WorkspaceFileMutationUnavailableError`, reason `kept-folder-not-empty`);
the version stays listed and as it was. A mark that already stands on such a
folder (an older discard, or one that met a folder filled meanwhile) leaves it
as it is: settlement tries the `rmdir` each time it finds the record, keeps
the version listed, and never fails the read, epoch, listing or write that
found it; once the folder is empty the next settlement finishes the discard.

Finding the records still reads every record its store keeps, on each
discovery (several per write). A finished record already read is taken from
memory while its folders and journal stand as they did just before it was read
(each folder still private, with the same inode, mode and times; the journal
with the same inode, size and times): a finished journal changes only by being
replaced through a rename. Anything else is read and decoded as before. A
discovery made under a lease is reused after settlement when settlement had
nothing to finish, since the lease keeps the others' records as they are. A
retained write qualifies its target once, at publication, and once more first
only when a folder stands in the file's place and is removed.

What stays bounded only by the folder tree: a lease binds every folder from a
written folder up to the volume's edge, and those of the retention stores. A
file nested so deep that one write would need more than 256 folders cannot be
written, nor a file whose place is taken by a folder holding folders that
deep (each is removed by a write of its own). Before an apply is recorded,
confirm, undo and restore ask the applier (`WorkspaceApplier.fits`, counting
with `retainedWriteFolders`) whether every changed path fits, counting each
folder up to `/`, every folder below a folder that stands in a written file's
place, the record stores and every unfinished record a lease would hold; if
not they refuse with `OverleafRetainedLimitError` `folder-depth` and nothing is
written or recorded (`OverleafCoordinator.leaseRoom.test.ts`).

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
ordinary Markdown underline headings are not publication failures. The result
also says whether every unit was done (`unitsDone`).

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

Conflict material is recorded per file (`markers`): where the file is in the
folder, where its marks are looked for, other folder paths an unfinished apply
may have left it at, and its paths on Overleaf. A kept copy of conflict material
remembers its file's other paths (`markerLinks`), which never change. The
document is at schema version 2. A version 1 document, which recorded folder
paths only (`markerPaths`, and a pending apply's `priorMarkers`), is read and
upgraded in memory (a pending undo keeps its attempt and retired paths), each
path becoming a file whose one path it is; a kept copy
of conflict material (and a pending apply's held file) gets `markerLinks: null`,
other paths unknown, and a restore holds it at every path Overleaf has. The next
replacement writes version 2. A later
version is reported unsupported; an older one that does not upgrade cleanly is
reported corrupt.

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
number, so a disk mounted again under another path is recognized. New identities
carry platform and version tags; existing untagged macOS identities decode unchanged
and compare as the same objects. Linux and Windows identity shapes are defined,
but those hosts remain refused until their resolvers and file mechanisms qualify. Once
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
- **Confirm.** First it reads Overleaf's head with one ref advertisement
  (`ls-remote`, nothing downloaded): while it is still the review's head, the
  objects fetched for the review stand for Overleaf; otherwise it fetches.
  Inside the section, it checks the folder and retention
  identities, captures the folder again and rebuilds the review with the same
  choices, the same selected and sent files, the same deliberate deselections,
  and the default rule for anything else. A deliberate deselection is kept
  whatever the rule now says of the file (one that grew too large stays kept
  only here). A file that appeared meanwhile is
  therefore selected by default, never taken for a "keep only here", and a
  selected file that is gone is left out instead of refused, so the rebuilt
  review differs and replaces the stale one. Capture reads the base's paths, the managed paths and
  every path in a forced conflict. A different digest is a stale review: the
  fresh one is offered and nothing is applied. The review is a function of the
  connection record, the checkout and credential epochs, Overleaf's head and
  the capture, so when the record's revision, both epochs and the head are the
  review's and the folder, captured exactly as the review captured it, gives
  the same inventory digest (every field, each read file by its SHA-256), the
  review stands as it is and is not built again (no Git work); any difference
  builds it again as above. The record's revision and both epochs are read
  again after that capture, as a build reads them after its own, so a
  credential renewed while the folder is read makes the review stale
  (`credential-epoch`) rather than applied. Before anything is written it
  checks room:
  for every kept copy the apply could add, and for every group an interruption
  could leave as a forced conflict (at most 2,000 paths each), and that every
  write fits one native lease (`folder-depth`). Then, before the
  applier runs, it records the receipt, a local snapshot, the intent pin and
  `activeApply`, in that order.
- **Adoption** is one document replacement:
  - the base: a tree written from the applier's per-path base on the fetched
    remote commit, with the previous base moved into `priorBases`;
  - managed and local-only paths;
  - `forcedConflicts` (interrupted groups) and `markers`: the held files the
    review carried, where the apply put them, plus each file given new marks
    that still has them. An apply that did not finish every unit may have left a
    file where it was, so its record keeps that folder path too. A record that
    names no path of the result (a version 1 pending apply named files where they
    were before it) is placed by the result's renames from the base;
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
  recorded. `restored` always says how its apply ended (`adopted.outcome`), and
  HTTP carries it (`{ _tag: "restored", outcome }`, `http.ts` `restoreView`,
  which the agent tool reads too): only `complete` put the copy back, and a
  `replan` (the folder changed first) wrote nothing.
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

  Undo and held files: a send never changes a held path (the publication tree
  keeps Overleaf's version there), so an attempt's changes never name a file
  held at that send, and Undo puts back only a path that holds exactly what the
  send left, which has no conflict marks. A file given marks since the send is
  skipped (`changed`), never replaced. Undo records no conflict material of its
  own: the records stand as they were, and the next sync holds every marked
  file as usual, so Undo neither sends marks nor deletes or replaces Overleaf's
  file of a conflict not settled.

### Holding back a file with conflict marks

While a file has conflict marks, only that file waits; everything else is sent
(design section 4.2). The review holds two trees: the local target (the
candidate: what the folder will hold, marks included) and the publication tree
(the candidate with every held path set to Overleaf's fetched entry, or absent
where Overleaf has none). Both, and the held paths, are in the digest. Outgoing
changes are Overleaf's tree against the publication tree, so no held path is
among them.

- **What is held is a file**, every path it has in the base, the folder and on
  Overleaf, linked by renames on either side (`heldFiles` in `syncRules.ts`).
  A marked `a.tex` renamed to `b.tex` in the folder is held at both: Overleaf
  keeps `a.tex` and gets no `b.tex`.
- **Which files**: each one given new marks in this apply (a group merged in the
  editor is one path no rename touches), each recorded one whose file still has
  marks, and any other file with a conflict, recorded or not: Scient's own
  labelled marks (`<<<<<<< Scient`, `>>>>>>> Overleaf`), or a whole conflict
  block whatever its labels (an opening, a separator and a closing line, in
  that order, each a line of its own; `hasConflictBlock`). A Markdown underline
  never matches. Every captured file is checked from the bytes the inventory
  already read; most are ruled out by the absence of `<<<<<<<` and `>>>>>>>`.
- **Finding a recorded file**: at its folder path, its other recorded paths and
  where a rename in the folder took it; it is held where one of them has marks.
  Finding it proves less than it seems: Git sees a rename only from the base,
  which may no longer have the file, and a clean file at a recorded path may be
  a newcomer put there after the marked file moved, even over another marked
  file. So a record found clean or found nowhere is settled only when no file
  is held at all; while any is, recorded, unrecorded or given new marks, each
  held file keeps the record's paths. A marked `a.tex` moved over the marked
  `b.tex`, with a new `a.tex` written: Overleaf keeps both. Once settled, the
  file's edit, rename or deletion goes out. The cost is waiting: with two
  conflicts, the one settled first goes out with the second.
- **Records** move with the file: after an apply, at the path the result holds
  it (Overleaf's rename moves it), with the file's paths Overleaf has, and the
  paths of the records it took over. A record stays until the marks are gone,
  across acceptance, restart and recovery. A restored kept copy of conflict
  material is held at the paths its file had; one kept before those were
  recorded (version 1) is held at every path of the base, since any of them may
  have been its file's.
- **Sending one as it is** (`releaseMarked` in the selections): a file whose
  marks are its content (a guide quoting them) is sent, marks included, when
  the request lists it. It is a choice, not a permission: the review lists the
  files that may be released (`unresolvedMarkers`: the held files with marks
  already in the folder) and those it sends as they are (`released`, bound in
  the digest). Marks the review itself writes are never released, and a
  released file's record is dropped. A release is checked against the whole
  result: a file whose path another held file keeps (its former name, say) is
  not sent, so the request is refused (`release-held`) rather than reported as
  sent.
- **The publication tree is validated** like any other: a held path that the
  result turns into a folder, or the other way round, is refused
  (`held-file-clash`); the file and size limits apply to it too.

### Publication

After an adoption, confirm sends the result. Steps 1 to 4 run inside its
application section, which is released before the network is used (contract
section 9):

1. **Gate.** Nothing is sent after a partial apply, while interrupted groups or
   structural copies remain, while a recorded file with conflict material is not
   one the review holds, or when a copy this apply kept is `changed` or
   `ambiguous`. The result is `blocked` with the reason. An apply needing
   attention only because of marks in held files is sent: every unit done, the
   folder matching the local target, no kept copy changed.
2. **Nothing to send** when the publication tree equals Overleaf's fetched tree
   (`none`).
3. **Verify.** The folder is captured again, the way a review captures it and
   over every path the plan read or wrote (so an explicit deletion must still be
   absent). Outside the held files it must equal the publication tree; held
   files are work in progress and are not compared. A difference is
   `not-verified`, and the edit is the next review's to send. Each copy this
   apply kept is checked again by its stamp: one a late writer changed is
   recorded `changed` and the send is `blocked`. From here on, the content comes
   from the private repository's objects, never from the folder.
4. **Record.** The publication tree is committed on the plan's fetched head. The
   attempt is recorded `unknown` with its pins, before anything is sent.
   Acceptance makes it the base, where a held file has Overleaf's version at
   Overleaf's paths, as the apply already set it; the user's merge, and any
   rename, go out at the first sync after the marks are gone.
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
   publication tree the base in the same replacement. `out-of-date` keeps the adopted
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

## Service and routes

`OverleafSync` (`OverleafSync.ts`) is what the routes and the
[agent tools](scient-overleaf-agent-tools.md) call. It owns one coordinator and `OverleafConnections`, which share the
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
  push starts one new sync. **Progress is reported on every outcome and on
  refusals:** every sync outcome except `duplicate`, and a preview's review or
  refusal, says what it did before: `retried` (the first attempt applied a
  review and its send was out of date, so that attempt wrote the folder and
  sent nothing) and `settled` (an interrupted earlier sync it finished first,
  with how that apply ended). Once either happened, an actionable refusal
  (a Git failure on the fetch that follows, authority that changed, a busy
  connection) comes back as a `refused` result carrying them, not as an error,
  so nothing hides that the folder was written; before any progress, refusals
  stay errors. Other failures (state store or file-system defects) stay internal
  errors. Settlement is its own prepare step: the coordinator's
  prepare that finds an interrupted apply settles it and returns `recovered`
  with how it ended, never fetching or building in the same call; sync and
  preview record it and prepare again. Conflict choices answer one Overleaf tree
  (`reviewedRemote`); when Overleaf has moved, a review that still has conflicts
  is shown again without them, and one that has none is confirmed as usual.
  Per-file decisions (`files.keepOnlyHere`, `files.send`, `files.release`) go
  to the engine's selections (`release` is `releaseMarked`), applied to the
  review's own capture and carried through rebuilt reviews, and are part of the
  sync receipt's digest; reviews list every new file with its selection and skip
  reason, the files held for their marks (`unresolvedMarkers`) and those sent as
  they are (`released`).
  **Undo** (`OverleafSync.undo`, attempt number and request ID) saves the
  folder's editors, runs the coordinator's undo, and when it put nothing back or
  its apply completed, syncs under the same hold, with a receipt derived from the
  request's (64 characters, so no client request ID equals it): the restored
  files go out as ordinary local changes, the request's per-file decisions are
  recorded as any sync records them, and only a conflict stops. An apply that
  stopped partway (`attention`) or replanned is never published: its `sync` is
  `{ _tag: "not-synced", reason: "undo-incomplete" }`, and nothing goes out until
  the files are checked and a sync is asked for. A repeated request is
  the undo's `duplicate` and syncs nothing. A refusal the sync meets after the
  undo wrote the folder is its `sync` result (`refused`), never an error that
  hides the undo. It claims the connection's running sync like a sync, so
  cancel reaches it: a cancel asked while the editors save returns `cancelled`
  before anything is put back; once the undo's apply has started it finishes,
  and the sync after it stops at its first boundary. The request's per-file
  decisions (`files`) go to that sync like any sync's, and are part of its
  receipt's digest. Undo never writes a path kept only on this computer, whether
  recorded (`localOnlyPaths`) or asked for with the request (`keepOnlyHere`,
  passed to the coordinator and part of the undo receipt's digest): it is skipped
  as `kept-only-here`, so it is never made part of the sync and never reaches
  Overleaf. `undoableSends` lists the newest ten accepted sends whose
  commits are still held, each with its changes (the parent tree against the
  sent tree), reading the private repository only; older ones are undone by
  number. HTTP: `undo/sends` (read scope) and `undo` (operate scope).
  **Editors first.** Every service operation that may write the folder (sync,
  preview, recovery, kept-copy restore, undo) takes the connection, reads the
  folder the link names inside that hold, asks every window to save that
  folder's open editors (`OverleafEditorSave`), and only then runs; the hold
  lasts to the end, so a relink can't move the folder between the save and the
  operation's reads. A failed save refuses with `OverleafEditorUnsavedError`
  (reason `editor-unsaved`, the files that could not be saved and the windows
  that did not answer) before anything is read or written; HTTP carries the
  files as the operation error's `paths`. Callers never save editors
  themselves. The coordinator's confirmations inside a sync use
  server-made 64-character request IDs, which no client request ID can equal.
  **Cancel** asks the running sync to stop at its next stage boundary (before
  any prepare, including the one after settling an interrupted sync, or before
  it applies); an apply or send already started
  finishes, and its outcome stands. A sync has its own receipt, so a repeated request
  returns it instead of syncing again. The result names other agents working
  in the same checkout (a running turn or background work), read before and
  after the sync, never the caller or its subagents, and `null` when activity
  could not be read.

## Saving open editors

Text a person typed is on disk only once the window holding it has saved it.
`scient/editorFlush/EditorFlush.ts` lets a server operation ask every window
of this environment to save its editors for one folder, and wait:
`flushFolder({ checkoutRoot, folder, timeout, overallTimeout })`. The
Overleaf service calls it through `OverleafEditorSave.layerFromEditorFlush`
before any operation that may write the folder, for the agent tools and the
screens alike (the screens' own window answers like any other).

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

## Remaining integration gates

The coordinator contract on [#535](https://github.com/ScientFactory/scient-desktop/pull/535)
defines the remaining work and tracks each step's status. Derive
interrupted operations in status (a `running` receipt whose operation is no
longer live was interrupted). The coordinator must implement cancellation between
stages; the local filesystem critical section completes before cancellation can
release its save lock. Qualify unsaved editor buffers, reloads and LaTeX builds
in the development app. The exercised Cloud protocol behavior is recorded on #535;
packaged, signed macOS helper behavior is a separate gate. A local bare Git
remote does not establish the Cloud bridge's commit/history or
publication-acknowledgement semantics. Server Pro, Windows and Linux remain
unverified product environments.

## Known limits

- **Retention removals follow path names.** Discarding a kept copy, and the
  other places the file layer removes retained objects, name the target by
  its full path. After a record's lease is taken, another process running as
  the same user could rename the record folder (or a folder above it) and put
  a link to a workspace folder in its place; the removal would then follow the
  link and delete a same-named workspace file or empty folder. The lease holds
  the record's folder, not its name. This predates the Overleaf work (main's
  discard removes by path the same way) and needs a deliberate same-user
  process racing Scient's private retention folders. The fix is to perform
  these removals in the native helper, relative to the held folder
  (`unlinkat`-style, single-component names, with the folder sync anchored
  there too), for discard, settlement and the file layer's other path-named
  removals; it is a follow-up of its own.
- **A refused discard's reason travels in the message only.** A discard of a
  kept folder that still has contents is refused with
  `reason: "kept-folder-not-empty"` on the server error; over the WebSocket it
  reports as `mutation_unavailable` with the reason in the message.
