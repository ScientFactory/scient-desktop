# Scient Sources foundation

Status: implemented local-first foundation; user visual acceptance remains a
separate gate.

## Ownership and dependency shape

`packages/scient-sources` owns the source schema, normalization, metadata
diagnostics, duplicate assessment, operations, receipts, and project-local
store. It has no React, Electron, or T3 application dependency. Zotero and
direct PDF intake are adapters into that model; neither defines Scient's
scientific truth.

`packages/scient-citations` is a separate derived-output layer. It maps the
canonical Scient source record to CSL JSON and formats references with pinned
Citation.js/CSL dependencies. It does not import Zotero adapter data, mutate
source records, or persist rendered strings. The web surface lazy-loads the
processor only after source details are opened, keeping the normal app bundle
and Sources overview path free of the citation engine.

The server owns environment-scoped transport, local Zotero access, bounded PDF
metadata extraction, and identifier resolution. The web feature owns
presentation and orchestration. The inherited host is changed only at narrow
seams:

- additive typed environment HTTP endpoints;
- one Scient-owned right-panel surface registry for the library and its peer
  PDF tabs; the inherited store accepts validated descriptors without owning
  their subtype shapes, persistence normalization, labels, or icons;
- lazy Sources and source-PDF render branches; and
- one Sources entry in the existing right-panel menu.

The feature does not replace project registration, panel layout, environment
auth, asset signing, or the PDF reader. A Sources-owned authenticated endpoint
resolves an attachment ID through the project store and asks the existing asset
signer for an exact PDF URL. `SourcePdfPreview.tsx` translates that URL into the
existing `ScientPdfReader` contract. Preview authorization therefore does not
depend on a chat thread already having been persisted.

Every Library change the client sends (Sources, annotation writes and reference
check fixes) is a guarded HTTP command (`createEnvironmentHttpCommand` in
`packages/client-runtime/src/state/scientSourcesCommands.ts`), registered with
the scope its server route requires in `CLIENT_GUARDED_HTTP_SCOPES`. These tags
stay out of `CLIENT_GUARDED_RPC_SCOPES` because the server's RPC scope table
must list exactly its WebSocket methods. The command checks the destination's
grant when it runs, and the web's `useCanChangeLibrary` reads its
`permissionAtom`, so a connection that can only read sees the Library with its
change controls disabled; the server still authorizes each route.

The Sources library, source details, and metadata editor are local states within the
same Scient-owned panel. A source row opens details even when no attachment is
present; an explicit PDF action opens a peer source-PDF surface. This keeps
source identity and bibliographic information separate from document display
without adding another host navigation concept or environment endpoint.
`useScientSources` delegates the panel's transient import, overview, and Zotero
browsing state to one reducer. The durable server import operation remains the
only authority for import phase, per-item status, cancellation, retry, and
resumption. Synchronous request tokens are partitioned by workflow lane and are
reset to the exact same values in the hook and reducer when the selected project
changes. This lets routine overview refreshes and Zotero searches progress
without invalidating a running import, while late responses from an older
request or project are discarded.
Concrete material selection is centralized in
`@scientfactory/scient-sources/material-selection`: one eligible PDF may be
selected automatically, while several eligible PDFs require an explicit
stable attachment ID. The details surface presents that choice instead of
treating `attachments[0]` as architectural meaning. List and context-menu PDF
actions use the same contract: one eligible PDF opens directly, while several
PDFs route the researcher to the details choice. PDF-based metadata refresh
also refuses to choose among several materials implicitly; identifier-based
refresh may still proceed independently. The same provider-neutral contract
distinguishes absent, unsupported, missing, duplicate-ID, hash, and byte-length
states for adapters without silently selecting another material.
Normal local-PDF and Zotero intake use one user action after selection:
preflight runs as part of the import pipeline, new items are imported
immediately, and a single completed source opens in the existing details state.
The preflight surface is retained only for the weak possible-metadata-match
decision that cannot be made safely on the researcher's behalf.

Journal artwork is optional presentation, not source truth. A Sources-owned
read endpoint may resolve a journal article's explicit publisher origin, fetch
the conventional favicon and up to two larger first-party icons declared by the
publisher's bounded public-HTTPS home page, validate raster bytes, preserve a
smaller official icon when no better one succeeds, and cache the result under
the environment state directory. The renderer uses
the existing signed asset route and paints the generic book before lookup, on
offline resolution, and on image failure. Resolution starts only for rows near
the visible scroll region, so a large ledger does not create one network job per
stored source. Icons never enter project records, block the list, or permit the
renderer to contact arbitrary publisher URLs.

## Durable project store

`.scient/project.json` remains the sole project identity authority established
by Scient project initialization. Sources use this project ID and create only
their own subtree:

```text
.scient/sources/
├── records/                 one versioned JSON record per source
├── files/sha256/<prefix>/   content-addressed PDF copies
├── history/<source-id>/     kept prior revisions (first one plus the latest 49)
├── trash/<source-id>.json   removed sources, whole, until restored or deleted
├── text/sha256/<prefix>/    extracted PDF text, one JSON file per PDF hash
├── collections.json         collections and saved searches
├── categories.json          study design and topics per source, from registries
├── reviews/<review-id>.json systematic reviews
├── bulk-edits/<batch-id>.json what a bulk edit changed, for Undo
├── operations/              resumable import state
├── receipts/                terminal import evidence
└── staging/                 bounded temporary copies
```

There is deliberately no canonical mutable manifest. An overview is derived
from validated records and operations. The overview contract returns bounded
summaries only (tags included, so the list can filter by them); complete
abstracts, provenance, and revision evidence are
loaded through a direct source-ID detail endpoint when a researcher opens an
item. Journal artwork uses the same direct record lookup, so rendering one row
does not repeatedly decode the rest of a large ledger. Source-PDF preview keeps
the existing host seam and resolves its content-addressed attachment only when
the researcher opens it; avoiding another `ChatView`/right-panel state branch is
the deliberate upstream-maintenance tradeoff. JSON writes use a temporary file,
`fsync`, and atomic promotion. New source records use exclusive creation. PDF
copies are size-bounded, require a regular non-symlinked `%PDF-` file, are
hashed while copying, and are promoted before a source record can refer to
them. A crash can leave harmless unreferenced content, but never a committed
record pointing to a partial PDF.

Direct uploads use the selected environment's authenticated HTTP channel and a
bounded multipart body rather than an Electron-only filesystem path or a
base64/JSON copy. The environment server stages and hashes one file per request,
which bounds memory and concurrency while the UI may still select a batch.
Staged descriptors carry the normalized candidate and content identity so the
item inspected during preflight is the item later imported. Completion,
failure, cancellation, and explicit duplicate-review dismissal remove its
staging material.

Stored attachment paths use portable POSIX-relative syntax and are resolved
only within `.scient/sources`. Records whose project identity does not match
the current folder are rejected. All durable record reads enter through one
explicit format-version decoder; future migrations extend that boundary rather
than scattering version checks through adapters and UI code.

## Personal library store (built, not active)

The personal library is the same store over a library root instead of a
project root. It is code only until the switch (build step 5e): no request,
agent tool or UI routes to it, and the project store above stays the only
active backend. The agent tools can already run on it behind a code constant
(below); the move of existing projects and the HTTP routes come in later steps.

The library lives under the server's resolved state directory for the launch
mode, `scientLibraryRootFor(stateDir)` = `<stateDir>/scient/library/`, so dev
apps never touch the installed app's library.

```text
<stateDir>/scient/library/
├── library.json             formatVersion 2, libraryId, owner {kind: "user"}
├── library.lock             cross-process write lock (below)
├── records/                 one formatVersion 2 record per source, no projectId
├── history/<source-id>/     kept revisions, same cap as projects
├── trash/<source-id>.json   formatVersion 2 entries
├── files/sha256/<prefix>/   PDFs
├── text/sha256/<prefix>/    extracted text
├── collections/<id>.json    one file per collection, nesting kept
├── saved-searches.json
├── categories.json
├── instances.json           this computer's project checkouts
├── projects/<instance-id>.json  per checkout: project source ID → library ID
├── aliases.json             merged source ID → survivor, with Undo tombstones
├── distinct-pairs.json      pairs never merged automatically
├── merges/<merge-id>.json   one per merge: report and what Undo reverts
├── merges/pending/          merges a crash interrupted, finished by the next write
├── zotero/<source-id>.json  Zotero merge bases
└── bulk-edits/ operations/ receipts/ staging/
```

Store functions take a `ScientSourceStoreLocation`: a project root (a string)
or `scientLibraryLocation(root)`. `ensureScientLibrary` creates the folder and
publishes `library.json` with an exclusive create, so two processes agree on
one library ID. In a library:

- Records, trash entries, import operations and receipts are format version 2.
  Records name no project; operations and receipts name the `libraryId`. New
  source IDs are derived from the library ID. The single record decoder
  accepts version 1 only with a `projectId` and refuses a version 2 record
  that names one, so no project link is silently dropped.
- Each collection is its own file (`formatVersion` plus the collection), so
  two computers editing two collections never touch the same file. Writes
  replace only the files that changed and remove the files of collections no
  longer kept. Saved searches stay in one file.
- Attachment paths are relative to the library root. The library folder is
  Scient's own, so project link checks are skipped there; PDF reads still
  refuse any path that resolves through a symlink.
- `registerScientLibraryInstance` gives each (project ID, canonical real path)
  pair a random `instanceId` in `instances.json`. A copied or moved folder is a
  new instance. Nothing removes entries yet: an unattached drive looks like a
  deleted folder, so the move decides.

### Library lock

`withScientLibraryLock(root, run, { timeoutMs, signal })` holds `library.lock`
across processes while `run` runs. Every library write takes it: the store,
collections, categories and full text through `withStoreLock`, and the move,
background passes and sync worker are to call it directly. The library lock
is taken before the store's process-local operation key, so a holder's nested
writes never wait on a key a waiter holds. Calls nested inside `run` re-enter;
other writers in the same process queue behind it.

The lock is an exclusive transaction on an empty SQLite file
(`node:sqlite`, `busy_timeout = 0`, in-memory journal), the technique the
server's `server-owner.sqlite` ownership lock already uses. The operating
system releases it when the holder's process exits, even on `SIGKILL` or a
crash, on macOS, Linux and Windows, so a dead owner never leaves a stale lock
and there is no PID file to clean up. A waiter retries with backoff and fails
with `ScientLibraryBusyError` after 30 seconds by default; `timeoutMs: 0`
tries once, for passes that can come back later. The held handle is kept in a
module map, because a collected handle would close its file and drop the lock.
Nothing else may open `library.lock`: closing any other descriptor of it in the
holding process drops the POSIX lock. A replaced lock file is detected by
comparing its identity before and after locking.

The server's ownership lock already stops two servers from sharing one state
folder. `library.lock` covers the writers that are not that server.

### Merge engine and aliases

`@scientfactory/scient-sources/library-merge` merges duplicates library-wide.
Every function takes a `ScientLibraryLocation` and writes under the library
lock. Nothing calls it yet; the move (5d) runs the bulk pass and 5f lists the
possible duplicates.

The assessment follows the design's order. These merge automatically:

1. The same external item (`system`, `libraryId`, `itemKey`), such as one
   Zotero item imported twice.
2. A shared work-level identifier from `WORK_LEVEL_IDENTIFIER_SCHEMES` in
   `duplicates.ts` (DOI, PMID, PMCID, arXiv, OpenAlex, Semantic Scholar).
3. The same PDF hash, titles equal once case, punctuation and spacing are
   ignored, and no conflicting identifiers. Identifiers conflict when both
   records name a scheme (ISBN included) and share none of its values.

Two kinds of match are only listed as `possibleDuplicates`, never merged:
title, lead author and year (`possible-metadata-match`), and a shared ISBN or
ISSN plus the same title between records with no work-level identifier
(`possible-container-match`). Chapters of one book share an ISBN and articles
of one journal an ISSN, so a shared container identifier alone lists nothing.
Pairs in `distinct-pairs.json` (`marked-distinct` from a person or agent,
`divergent-copies` from the move) are never grouped, not even through a third
record, and are not listed. Pair members resolve through aliases.

`mergeScientLibrarySources` merges one pair on request; the bulk pass
`mergeScientLibraryDuplicates` merges every group and returns `mergedCount`,
`keptDifferentCount` (merges with a non-empty report), the merges, failed
pairs and what is left as possible duplicates. One merge:

- The survivor has the latest `verification.checkedAt`, otherwise the oldest
  `importedAt`, then the lower source ID, so every computer picks the same one.
  A request may name the survivor.
- Bibliographic fields: an empty value takes the loser's, a different one
  keeps the survivor's and goes into the report. The citation key,
  verification and editorial status fill when empty and are never reported.
  Abstract sections come along only with the abstract they belong to.
- Tags (case-insensitive), identifiers, attachments (by hash) and external
  references are united. A second value of a work-level scheme, such as
  another DOI, is reported instead of added. Personal notes are joined, each
  under `From <label>:`, where the label is the caller's (the project name at
  the move), else the citation key.
- Library collection membership moves to the survivor. When the survivor
  gains a Zotero link it lacked, the loser's Zotero base is copied to it.
- The loser goes to the trash with `mergedInto` (survivor and merge ID). A
  plain restore refuses it; only the merge's Undo brings it back.
- `aliases.json` maps the loser to the survivor. `resolveScientLibraryAlias`
  (`/library-aliases`) follows aliases to the last survivor and skips
  tombstones; the instance map (5c) resolves through it.

A merge first writes `merges/pending/<id>.json`, then the survivor revision,
then the trash entry, then membership, aliases and the final merge file. The
next merge, bulk pass or Undo finishes a pending merge whose loser is in the
trash or whose survivor revision landed, and drops one that stopped earlier;
the pair is then found again.

`undoScientLibraryMerge` restores the loser as a new revision, reverts each
field the merge set only where the survivor still holds the merged value,
removes united items that are still there, and names the fields a later edit
changed (`unrevertedFields`), which keep the later value. It puts collection
membership back and marks the alias `undoneAt`; the tombstone stays so sync
never brings the alias back. Undo refuses while the survivor itself was merged
on or removed, and when the trash was emptied.

Measured once at 20,000 records with 1,000 seeded DOI duplicates (generated
records in a temporary folder; Apple M5 Pro, Node 24.19, load average about 8):
the bulk pass took 34 s and merged all 1,000, each with a kept title in its
report; peak process memory grew 65 MiB. A second pass, finding nothing, took
1.6 s. Each merge is about six synced file writes of about 5.5 ms each, so the
time is the disk's.

### Derived record index

Records stay the truth. Listing a library's records goes through an in-memory
index per library root. The index keeps each record file's result under its
stamp (inode, size, mtime, ctime) and the records folder's identity. While the
folder is unchanged, a listing answers from the index without touching a
file. When the folder changed, each file is checked by its stamp and only new
or changed files are read again. Every Scient write replaces, creates or
removes a record file by rename, which changes the folder. Timestamps within
two seconds of the scan are not trusted, for volumes with coarse clocks. A
record file edited in place by hand is seen once the folder changes or the
server restarts. A scan stats, and reads where needed, 32 files at a time and
keeps them in file-name order; one at a time, 20,000 serial stats alone took
0.6 s (scale gate, below).

Measured once at 20,000 records (42.5 MiB of generated record files with
abstracts, in a temporary folder; Apple M5 Pro, Node 24.19, under shared agent
load):

| Measure                                                           | Result  |
| ----------------------------------------------------------------- | ------- |
| Cold build (first listing)                                        | 1.53 s  |
| Heap retained by the index                                        | 76 MiB  |
| Process memory growth                                             | 166 MiB |
| Repeat listing, timestamps settled                                | 0.3 ms  |
| Listing after one write (stat every file, read one)               | 219 ms  |
| Repeat listing within two seconds of the writes (reads all again) | 1.77 s  |

The in-memory index is enough for 5a. If a library grows far past this, the
same index can move into a SQLite file in the library, rebuilt from records.

### Reading status

Library records (format version 2) carry `readingStatus` (`unread` or `read`)
and `starred`. New library records start unread and not starred, and a version
2 record written before these fields decodes the same way. Project records
(format version 1) never carry them: the version 1 decoder drops them. The
shared `ScientSourceRecord` schema does not list them either; library-mode
results add them where a reader needs them (see "Highlights, the two notes and
reading status" below). The trash keeps them because a trash entry's record
goes through the central record decoder.

`setScientLibraryReadingState` (package `store.ts`) sets either or both on one
source or many under the library lock. It writes the record file in place with
no new revision and no history entry: reading state is about the person, so an
editor open on the record is never made stale. For the same reason revisions
never list it as a change, and a revert keeps the current values. A merge keeps
the survivor read if either record was read and starred if either was, as
ordinary merge changes, so Undo puts each record's own values back. A source
that arrives through the move starts unread and not starred.

### Pins and project keys

`@scientfactory/scient-sources/project-pins` keeps a project's list of library
sources in `<project>/.scient/library/pins.json`:

```json
{
  "formatVersion": 1,
  "pins": [
    {
      "citationKey": "smith2020deep",
      "sourceId": "source_3f…",
      "pinnedAt": "2026-11-12T09:00:00.000Z",
      "pinnedBy": "agent",
      "note": "Why I cite this here.",
      "work": {
        "type": "article",
        "title": "…",
        "creators": [],
        "issuedYear": 2020,
        "identifiers": [{ "scheme": "doi", "value": "10.…" }],
        "containerTitle": "…"
      }
    }
  ]
}
```

- The file is sorted by key (case-insensitively, then exactly), pretty-printed
  with fields in a fixed order, and written only when its bytes would change,
  so the same pins are the same bytes on every computer. Fields a newer
  Scient wrote at the file, pin or `work` level are kept on every rewrite,
  after the known fields in sorted order. Unknown fields inside creators and
  identifiers are not kept. The file may be 64 MiB: 20,000 pins with long
  author lists are about 26 MiB. Writes go through the store's atomic write under a
  process-local `<project>:pins-write` lock, the same kind of lock as the
  project store's.
- `pinScientLibrarySource` copies the record's preferred `citationKey` (or a
  generated one) as the project key, with the usual suffix when the project
  already has it, compared case-insensitively. The key is frozen: changing the
  record's preferred key later never changes the pin. A source already pinned
  under any ID that resolves to it returns the existing pin.
- `note` is the project note, set and cleared with `setScientProjectPinNote`
  on the pin only; an empty note removes the field. The library record's
  personal note is never touched.
- `work` is a small snapshot (type, title, creators, issued year, identifiers,
  container title; no abstract, note or PDF). `refreshScientProjectPinSnapshots`
  updates it from the resolved library records and reports `changed`; it
  writes nothing when no snapshot changed. A `type` this version does not know
  is read as `other`.
- `listScientProjectPinnedWorks` returns the pins under the project's keys for
  the managed bibliography: the library record when this library resolves the
  pin, otherwise a record built from `work`. It accepts no library at all (a
  collaborator's checkout or CI). Personal notes are left out of the record;
  the project note comes beside it. `ManagedBibliography.ts` does not use it
  yet.

### Instance map and resolving project source IDs

`@scientfactory/scient-sources/library-instance-map` resolves every project
source ID through one function, `resolveScientProjectSources`, which takes each
ID with its snapshot (a pin's `work`, later a review's record snapshot):

1. `projects/<instance-id>.json`, the checkout's map (`registerScientLibraryInstance`
   gives the instance). The mapped ID is followed through `aliases.json`, so a
   merge's Undo puts the old target back.
2. The same ID in this library, through `resolveScientLibraryAlias`.
3. The snapshot: a shared work-level identifier, then title, lead author and
   year (`assessSourceMetadataDuplicate`). Records whose work-level identifiers
   conflict with the snapshot's are skipped. More than one match is
   `ambiguous` and stays unresolved.
4. Otherwise unresolved: `no-match`, or `removed` when the map named a record
   that is gone and nothing else matched.

`read` mode writes nothing at all: no instance registration, no map, no lock
file. `write` mode holds the library lock, registers the instance and records
each new resolution in the map, written only when it changed. Map entries keep
the ID resolved to then, never the alias survivor.

`resolveScientProjectPins` resolves a project's pins. In `write` mode each
`no-match` pin is hydrated: a library record built from its `work` (intake
`file`, field provenance `project-file:<field>`, no abstract, no PDF, the
pin's key as preferred key), recorded as `hydrated` in the map. Its source ID
is derived from the library ID and the project source ID, so a repeat after a
lost map finds the same record. `ambiguous` and `removed` pins are never
hydrated, so hydration never adds a duplicate or brings back a removed record.

### Review record snapshots

`@scientfactory/scient-sources/library-reviews` is the library-mode review
store. Reviews stay in the project, in `<project>/.scient/library/reviews/`,
with the same schema and rules as the project store: both run one shared
change function (`changeReviewIn` in `systematicReviewStore.ts`) and differ
only in the folder, the set of known source IDs and a hook that runs before
the review is written. `changeScientSystematicReview` passes no
hook, so the active path writes no snapshot.

Each review has a record snapshot, `<review-id>.works.json`, so a collaborator
without the author's library can still list, screen and count:

```json
{
  "formatVersion": 1,
  "reviewId": "review_…",
  "records": {
    "source_3f…": {
      "type": "article",
      "title": "…",
      "creators": [],
      "issuedYear": 2020,
      "identifiers": [],
      "containerTitle": "…",
      "abstract": "…",
      "abstractSections": [],
      "capturedAt": "2026-11-12T09:00:00.000Z",
      "capturedRevision": 4
    }
  }
}
```

- Keys are the project source IDs the review stores, never the resolved library
  ID. Entries hold no notes, tags, PDFs or full text. Keys are in code-unit
  order, fields in a fixed order, unknown fields kept after them, and the file
  is written only when its bytes would change.
- `changeScientLibraryReview`, under the reviews lock: resolves the IDs the
  review names and the IDs the change brings in (`write` mode), builds entries
  for named IDs that have none from the library records, publishes the
  snapshot (atomic write, then read back), checks that it holds every record
  the change adds, and only then writes the review. `create-review` publishes
  an empty snapshot first. New IDs must resolve in this library; others are
  skipped, as the project store skips IDs it does not hold.
- Every ID the review names counts in screening and PRISMA: from the library,
  from the snapshot, or with its details missing. Only an ID this computer's
  library reports `removed` (in the trash) is left out, as the project store
  counts a trashed record as removed before screening. Review records are
  never hydrated into the library.
- `listScientLibraryReviewRecords` and `readScientLibraryReviewRecord` return
  `from: "library"` with the library record, `from: "snapshot"` with a record
  built from the entry (the project source ID as `sourceId`,
  `capturedRevision` as `revision`), or `from: "missing"`. When the library
  record has no abstract the snapshot's is used (`abstractFrom: "snapshot"`).
  `readScientLibraryReview` returns the usual detail; possible duplicates also
  pair review IDs that now resolve to one library record.
- `read` mode writes nothing at all. `write` mode also records resolutions and
  fills missing entries.
- `refreshScientLibraryReviewSnapshot` updates entries from the library. A
  field the library lacks keeps the snapshot's value (an imported abstract
  survives), `capturedAt` and `capturedRevision` change only with the content,
  entries the review no longer names anywhere (searches, records, duplicates,
  distinct pairs, screening, retrieval) are dropped, and nothing is written
  when nothing changed.
- Recovery: entries the review does not name (a crash after the snapshot, before
  the review) are ignored by readers and reused by a retry. A file that does not
  decode is read as empty; a `write` call renames it to
  `<name>.broken-<time>` and rebuilds what this library resolves. A
  `write` listing removes snapshots whose review file does not exist.
- Size: a 10,000-record snapshot with realistic abstracts is about 58 MiB
  (records keep the abstract text and its sections). Once one file would pass
  32 MiB the snapshot moves to sixteen shard files, `<review-id>.works/<h>.json`,
  where `<h>` is the first hex digit of the ID's SHA-256, and stays sharded.
  Only shards whose bytes change are written. After a crash while sharding,
  readers merge both layouts (shard entries win) and the next write removes
  the single file.

### Agent tools on the library (built, switched off)

`apps/server/src/scient/sources/SourcesBackend.ts` holds the backend constant,
`"project"` until the switch. It is not a setting or an environment variable;
tests select `"library"` through the `ScientSourcesBackend` reference, whose
default is the constant. `resolveScientSourcesStoreFor` gives every Sources
call its store: the project root, or the project root plus
`scientLibraryLocation(scientLibraryRootFor(stateDir))`. The project still
comes only from the thread's workspace binding (`resolveScientSourcesProject`),
so tools take no project argument. The same reference picks the advertised
tool list (`ScientSourcesToolkit` or `ScientSourcesLibraryToolkit`); both
share operations and handlers.

- Write authority is the invocation's `sources:write`. With it a call creates
  the library once, resolves pins and review records in `write` mode
  (recording the instance map, hydrating unresolved pins) and may write.
  Without it nothing is written anywhere: unresolved pins come from their
  `work` snapshot, review records from the review's snapshot.
- Any tool that takes a source ID accepts a library ID or a project source ID
  of this project; both resolve through aliases and the instance map.
- `scient_sources_list` lists this project's pins under their project keys
  (`fromSnapshot` marks a pin this library lacks); `scope: "library"` lists the
  whole library with `pinned` per record. `scient_sources_search` searches the
  whole library and marks pinned hits with their project key.
- Intake (`scient_sources_add`, identifier lists, `scient_sources_save_page`,
  reference files, `importEdited`, Zotero, `scient_paper_get` and the papers
  queue) adds to the library and pins the source here, or the record an exact
  duplicate is; a possible metadata match is not pinned. Review searches log
  existing library IDs and pin nothing.
- The durable imports (`ScientSourcesCoordinator.ts`: Zotero, local PDFs,
  reference files) take a `ScientSourceStoreLocation`, so their operation,
  receipt and staging files live in the library's `operations/`, `receipts/`
  and `staging/`, and Zotero merge bases in `zotero/<sourceId>.json`. An import
  started from a project names it with `pinInto`; the operation stores that
  checkout's `pinInstanceId`, so an import resumed, retried or advanced later,
  by any caller, still pins the rest into it. Each item is pinned before the
  item is recorded, so a crash in between pins it when the item runs again.
  When the import settles (completed or cancelled) the project's managed files
  are built from the pins once. A cancel keeps what was pinned. Reference-file
  entries already in the library never become items; they are pinned when the
  import begins. A pin target whose folder is gone or holds another project is
  skipped.
- `scient_sources_import_file` and `scient_sources_zotero_import` take an
  optional `pin` in library mode only: `false` brings the records into the
  library without pinning them and leaves the project untouched.
  `importEdited` always pins, because the entries were added to this project's
  file.
- `scient_sources_zotero_refresh` and `scient_sources_zotero_send` act on the
  library records the call names, by library ID or by this project's source
  ID; refresh with no IDs refreshes this project's pinned records. A refresh
  refreshes the pin and review snapshots like an edit.
- The papers queue keeps its own state in the project. In library mode a paper
  filed on a source goes onto the library record (its PDF copied into the
  library's `files/`), and a paper added to the Library is pinned here. The
  N1 rule is unchanged: filing or adding needs `sources:write` when it is
  asked for.
- `scient_sources_cite` pins each source first and cites it by its project
  key, never the record's preferred key; the managed files are written from
  the pins first, so pins this library lacks are hydrated before the check.
- `scient_sources_note_update` edits the personal note on the library record;
  the project note is set with the `organize` action `pin`. `organize` also
  has `unpin` (by project key), `merge` (through `mergeScientLibrarySources`;
  the result lists each `mergeId`) and `undo-merge`. Collections and saved
  searches are the library's.
- A new `citationKey` on a source pinned here renames this project's pin
  (`renameScientProjectPinKey`) and this project's documents; the record's
  preferred key is left as is. For a source not pinned here it changes the
  preferred key only.
- Edits, removals and merges report `alsoPinnedIn`: the other registered
  checkouts on this computer whose pins resolve to the record. Their pins are
  read only; a checkout whose folder is gone is skipped.
- After a metadata edit, revert, merge or undo, the same call refreshes this
  project's pin snapshots, the snapshots of its reviews that name the record,
  and its managed files; each writes only when bytes change. Other projects
  refresh the next time a call with write authority opens them. Once this
  project has had a full refresh that succeeded in this server process, only
  the pins of the changed records are refreshed, reading just those records,
  and each live review's snapshot is loaded once and written only when the
  review names a changed record. The first refresh after start, and the next
  one after a refresh failed, refresh every snapshot, so a refresh that failed
  is caught up by the next change (`refreshProjectAfterLibraryChange`). The bulk route refreshes after a type change and after the
  Undo of a bulk edit that changed a type (`scientBulkEditChangedType`), never
  after tag-only edits or their Undo: tags are in no snapshot and not in the
  bibliography. With one 10,000-record review the refresh costs about 1.4 s
  per part of 100 right after the write (scale gate, below).
- In library mode the managed `references.bib` and `references.json` come from
  `listScientProjectPinnedWorks`, with the same state machine and kept copies;
  the last-written copies live in `.scient/library/bibliography/`.
- Systematic review tools call the library review functions with the same
  mode; review records keep the project source ID the review stores, are
  labelled "From this review's snapshot" or "Details missing" when this
  library lacks them, and never carry the personal note.
- On a computer with no library, read calls pass `library: null` to the review
  readers (`readScientLibraryReview`, `listScientLibraryReviews` and the record
  readers accept it in `read` mode only): every record comes from the review's
  snapshot and nothing is created. A `write` call needs a library and creates
  it.

### Library routes and the scope filter (built, switched off)

The HTTP routes in `apps/server/src/scient/sources/http.ts` resolve their store
the way agent tools do, through `resolveScientLibraryStoreAt(root, access)`:
`read` for read endpoints, `write` only for change endpoints (those that need
`orchestration:operate`). Under `"project"` that returns null without reading
anything, and each route makes its earlier call with the same arguments. Under
`"library"` the route calls the library version in `LibrarySourcesRoutes.ts`.
A folder that is not a Scient project still gets the v1 overview, which reports
its state.

- **Overview.** `scope` (`project` by default, or `library`) picks this
  project's pinned works or the whole library. The payload adds `scopes`
  (`listed`, plus a count for `project` and for `library`); its presence is how
  the web learns the server keeps a library. Each record adds `pinned`,
  `projectNote` when pinned, and `fromSnapshot` for a pin this library lacks
  (its `sourceId` is then the project source ID). A pinned record's
  `citationKey` is this project's key. `activeOperation` is the library's,
  whichever project started it. Indexing and categorizing are started only for
  a caller that also holds operate, because they write library caches.
- **Source IDs.** Every route that names a source accepts a library ID or a
  project source ID of this project. Detail for a pin this library lacks
  returns the pin's snapshot with `fromSnapshot`.
- **Notes.** Routes serve any connected client, so a library record's personal
  note never appears in a route payload. A route record's `note` is this
  project's note on its pin instead, and `updateNote` sets that note
  (`setScientProjectPinNote`); a source not pinned here has no project note,
  and the panel hides the note editor for it. Exports carry the project note
  the same way.
- **Edits.** `updateMetadata`, `refreshMetadata`, `remove` and `revert` act on
  the library record and add `alsoPinnedIn`; a new key on a pinned source
  renames this project's pin, as the agent tool does. Edits refresh this
  project's pin and review snapshots and its managed files.
- **Organize.** The request also takes `pin`, `unpin`, `merge` and
  `undo-merge`; a merge result lists each `mergeId` for Undo. A project server
  refuses them.
- **Imports pin by view.** Begin calls (`beginImport`, `beginScopedImport`,
  `localBeginImport`, `fileImport`, and the `addByIdentifier` and `savePage`
  intakes) take `pin`. From "This project" the web sends nothing and the route
  passes `pinInto: <project root>`; from the Library view it sends
  `pin: false` (the string `"false"` in the multipart file import) and nothing
  is pinned. The file import also passes `projectRoot` for linked PDFs. Advance,
  cancel, retry, upload, discard and preflight take only the library location.
  One import runs per library: a second is refused with "Another source import
  is already running in the Library."
- **Reviews.** `systematicReview` adds `records`: each record the review names,
  under the ID it stores, with `label` ("From this review's snapshot" or
  "Details missing"); records removed from this library are left out. Detail
  with `reviewId` returns the review's own record, from its snapshot when this
  library lacks it. On a computer with no library both read with
  `library: null` and create nothing.
- **Get PDF** goes through the papers queue, which resolves the library record
  from a library ID or a project source ID (see above).

The web (`useScientSources.ts`) sends `scope` only after the person picks the
Library view, which `SourcesFilterMenu` offers only when the overview has
`scopes`: "This project" and "All" replace "All sources" at the top of the
Collection submenu. In the "All" view rows pinned here say "In this project",
and a pin this library lacks says "Not in this Library" in either view. The
review screen uses the review's `records` when present.

### Moving a project into the library (built, switched off)

The one-time move of design section 5 lives in
`packages/scient-sources/src/libraryMove.ts`; the server reaches it only
through the library backend. With the constant on `"project"`, nothing calls
it, no journal is written and every route reads the v1 store as before.

**When it runs.** `resolveScientSourcesStoreFor` (`SourcesBackend.ts`) on the
library backend:

- A call with write authority (a route that needs `orchestration:operate`, an
  agent call with `sources:write`) first runs `moveProjectIntoLibrary`
  (`LibraryMove.ts`). A project with nothing to move costs a journal read and a
  folder listing; git runs only when a move runs.
- A read-only call never starts a move. It reads the v1 store while the
  project is not moved (`readScientLibraryMoveState`), and writes nothing.
- A project that was moved back, or whose v1 store has an import another
  process touched in the last ten minutes, stays on its v1 store. So does a
  project whose move failed; the failure is logged and the next write retries.
- `LibraryMovePass.ts` runs the same move for every project the environment
  lists, two minutes after start and every six hours, one project at a time.
  A folder that is not there (an unattached drive) waits for a later pass.

**Journal.** `<library>/migrations/<instanceId>/journal.json`, written with an
atomic replace. States: `copying`, `prepared`, `committed`, `cleanup`, `done`,
`restoring` while "Move back into this project" runs, and `moved-back` after
it. It records the run
number, each v1 source's library ID and identity outcome (`copied`, `same`,
`older`, `newer`, `diverged`, `removed`), the PDFs and annotation files moved,
every project artifact (destination, plan `create` / `keep` / `replace` /
`conflict-copy`, destination hash at staging, staged hash), the cleanup and
retry lists, the merge counts, review conflicts and whether git tracks
`.scient/sources`. Only this checkout's journal in `committed` or `cleanup`
deletes v1 files; a `pins.json` on its own never does.

**Steps.**

1. Locks: this project's move, reviews and pins locks, then this checkout's
   move lock (`migrations/<instanceId>/move.lock`, the library lock's SQLite
   file lock on another file), held for the whole run so no other process
   moves the same checkout. The library lock itself is taken only in bounded
   holds (see "Lock holds" below). Abandoned staging is dropped. A project with
   no journal and no v1 store returns before any lock and writes nothing.
2. Copy: records rewritten to format 2 (no `projectId`; the note goes to the
   pin), their history, trash entries, Zotero merge bases, PDFs and full text
   by hash, and annotation files for library PDFs, joined by annotation ID
   (the higher revision wins). Full text is named by its PDF's hash, so other
   text already at that name stays in force. A copy cut short is replaced in
   one rename, so the path is never empty: for a PDF, the start of the right
   bytes under the wrong hash; for full text, the start of the source that is
   not whole JSON. Every other
   write is an exclusive create; a record ID
   the library already has goes through the identity check below. Each
   project source ID is written to the instance map (`resolvedBy: "moved"`).
3. Verify and back up: every copied PDF is hashed and every mapped record read
   back. Every v1 file except PDFs, and full text the library holds byte for
   byte, is copied to `migrations/<instanceId>/v1/<run>/` (a PDF whose bytes
   do not match its name goes there too). A backup file is never overwritten; another version
   sits beside it as `<name>.~<sha12>`.
4. `mergeScientLibraryDuplicates`, then collections and saved searches move in.
   A collection already in the library under the same ID gains the members; a
   name another collection uses gets the project folder's name, "Methods
   (Thesis)".
5. Stage under `.scient/library/.staging/<runId>/`: each review (its v1 bytes),
   its record snapshot (built from the library records, captured at each
   record's last change so a rerun stages the same bytes), the bibliography
   copies and the pins. Each staged file is read back and decoded, then planned
   against the destination's bytes (the join rules below).
6. Switch: each artifact is published from its staged bytes, `pins.json` last,
   and read back against its staged hash. A destination that changed since
   staging restages the plan (up to four times). A destination that is the
   start of the staged bytes is a copy cut short; it is set aside as
   `<name>.broken-<time>` and published again.
7. Cleanup: each v1 file is deleted once its counterpart verifies (library
   record, PDF by hash, text by its own bytes in the library, annotation file
   by IDs, review or bibliography copy by journal hash, everything else, and
   text the library holds differently, by its backup copy). A file that
   cannot be deleted (a PDF open on Windows) stays in `retry` and the journal
   stays in `cleanup` until a later open deletes it.

**Recovery** follows the design's table: no journal or `copying` reruns from
step 1 (a rerun finds its earlier copies identical); `prepared` reruns the
switch, which treats an artifact already at its staged hash as done; a
`pins.json` that does not decode is set aside, one that decodes but differs is
joined on restage; `committed` and `cleanup` finish the cleanup; `done` with
files under `.scient/sources` again starts run `n + 1`. A staging folder that
came with a copied project is dropped by the next move.

**Joins.** A review with other bytes at the destination stays in force; the
incoming version and its snapshot go to
`.scient/library/conflicts/reviews/<reviewId>/<sha12>.json` and `.works.json`.
Equal reviews unite their snapshots, keeping the existing entry where the two
differ (the incoming entry goes to `snapshot-<sha12>.works.json`). A
bibliography copy is replaced only when the root file equals the v1 copy. A
`pins.json` that exists gains the v1 pins it lacks, under its own keys where
the source is already pinned (`joinScientProjectPinsText` keeps every existing
pin's bytes and fields a newer Scient wrote).

**Copies of one project** (`lineage` in `libraryMove.ts`): same content at the
same revision, or the library's history holding the incoming revision, maps
the ID to the library record; incoming history holding the library's current
revision applies the incoming revisions; otherwise the copy is imported under
a new ID (`moved-copy:<instanceId>:<id>`), the instance map sends this
checkout's ID to it, and the pair is marked `divergent-copies` so the
duplicate pass never merges it. A record merged away since an earlier run
maps to its survivor; one in the library trash with the same lineage stays
removed.

**Review conflicts** (`libraryReviewConflicts.ts`): `listScientReviewConflicts`
and `resolveScientReviewConflict` with `keep`, `use-other` or `combine`. The
version not kept goes to `migrations/<instanceId>/reviews/<reviewId>/` first.
Combine unites searches (a search in both keeps its details and the union of
its IDs; differing details are reported), other IDs, duplicates, distinct
pairs, screening and retrieval. A pair marked duplicate in one version and
distinct in the other is dropped from both lists and reported as undecided. A
source whose latest decision differs between the two gets a `cleared` entry
with the note "Decided differently in two copies". The snapshot covering the
whole membership is published and read back before the review. A combine that
leaves something to decide stores its report as `combined.json` in the
review's conflict folder (the conflict listing never offers it) until someone
dismisses it (`dismissScientReviewCombineReport`). `readScientReviewVersions`
summarizes the version in force and each other version for the picker: title,
who changed it last and when, searches, records, decisions in force and the
latest decision's date.

**Git.** `libraryMoveGitTracked` runs `git ls-files -z -- .scient/sources`
through `GitVcsDriver` before the first cleanup. Tracked files are deleted from
the working tree like any other and left for the person to commit;
`scientLibraryMoveStatusLines` gives "The Library moved out of this project.
Commit the change to stop storing PDFs in git." and the merge line "Merged N
duplicates. K kept different values: Review." for 5e to show.

**Move back into this project** (`moveScientProjectBackIntoProject`; the
organize route and `scient_sources_organize` take `move-back`): finishes a
pending cleanup, then builds the v1 store in a staging folder,
`.scient/library/.restoring/sources`: every run's backup, each pinned record's
later library state as a new v1 revision under the pin's key and project note,
its PDFs, and the current reviews and bibliography copies over the backup's.
One rename publishes the folder as `.scient/sources`. After that it restores
highlight files that are not there, backs up and removes `pins.json`, and sets
the journal to `moved-back`. Library records stay. It refuses while
`.scient/sources` holds files again.

The staging folder is created first and the journal set to `restoring` second,
so an interrupted move back resumes on the next move back, write or background
pass. With the staging folder present, the build reruns from the start (only
the move back writes there); if `.scient/sources` holds files by then, an older
Scient wrote them, so the staging folder is dropped, the journal returns to
`done` and the ordinary move joins those files. With the staging folder gone,
the store is published, and nothing under `.scient/sources` is written again:
changes made there since are kept. Until the move back finishes, the project
counts as moved.

#### Lock holds, progress and one move per project (5e-1)

**Lock holds.** No single hold of the library lock grows with the number of
PDFs, so other library writers interleave with a long move:

| Hold                                                           | What runs in it                                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Each batch of 200 records                                      | `settleRecord` (records, history, the identity check, diverged imports); aliases are read again per batch       |
| Each batch of 200 trash entries, merge bases, annotation files | exclusive creates; annotation joins                                                                             |
| One                                                            | the instance map write                                                                                          |
| One                                                            | `mergeScientLibraryDuplicates`, collections and saved searches                                                  |
| One                                                            | stage, `prepared`, switch, `committed`                                                                          |
| Move back: one, then one                                       | the records, reviews and bibliography of the rebuilt store; then publish, highlights, `pins.json`, `moved-back` |

Between holds, with only the move lock: PDF and full-text copies (both
directions), verification and backups, and the whole cleanup. A crash between
holds leaves `copying`, which reruns from step 1; the crash point
`after-first-batch` and the test for an edit made in that gap cover it.

**Progress.** `runScientLibraryMove` and the move back take `onProgress`
(`{ phase, done, total }`, phases `sources`, `files`, `verifying`, `merging`,
`switching`, `cleaning-up`, `restoring`; each counts its own items).
`verifying` counts the PDF hashes, the moved records it checks, and the v1
files and highlights it backs up, each once its check or backup has finished,
so the line keeps moving through the backups and never shows done early. Nothing about progress is written to the journal.

**Measured** with `packages/scient-sources/scripts/measureLibraryMove.ts`
(`pnpm run measure:library-move` in that package, Node 26; 5,000 records,
1,250 PDFs with text, one review, five collections; the longest time another
writer waited for the lock): before, 67.5 s total and 67.5 s held; after,
63.4 s total and 1.6 s longest wait (Apple M5 Pro, 18 cores, macOS 26, shared
with other work).

**One move per project in the server** (`LibraryMove.ts`). A process-wide map,
keyed by the project folder's real path, holds the running move or move back
and its latest progress, plus the last failure's reason. A write's lazy move,
the background pass and the move back all join a run that is going instead of
starting another. A write waits up to `ScientLibraryMoveWait` (20 s); past it
the call fails with `ScientLibraryMoveBusyError`, "This project's sources are
still moving into your Library (1,240 of 5,000). Try again shortly.", and the
move goes on. Agent tools return that message; routes fail with the reason
`scient_sources_library_moving`. The background pass and the papers queue
worker wait until the move ends. The move back runs in its own request, as
before, but is registered in the same map.

**Status** (`readLibraryMoveStatus`, route `moveStatus`,
`POST /api/scient/sources/move/status` `{ root }`, read scope; a project
server answers `nothing-to-move`). `ScientSourcesMoveStatus` by `state`:
`nothing-to-move`; `waiting` (a v1 store not moved, or a move interrupted
before it committed); `moving` with `progress`; `done` with `lines`;
`cleanup-pending` with `filesLeft` and `lines`; `restoring` with `progress`
(null when a move back stopped); `moved-back` with `restoredSources` and
`restoredPdfs`; `failed` with `reason`. A running move and a failure come from
memory, the rest from the journal (`readScientLibraryMoveStatus`). `lines` is
`scientLibraryMoveStatusLines`: the merge line, the git line, and "Undo for
bulk edits made before the move was not kept." when the v1 store had
`bulk-edits/` (the journal's `bulkEditUndo`). The organize action
`dismiss-move-summary` hides the lines of the latest run;
`migrations/<instanceId>/summary.json` records the dismissed run, so a later
run has a summary of its own. Agents see the same state as `move` in
`scient_sources_list` results (library mode, while it says something) and
dismiss it with `scient_sources_organize`.

**Review conflicts on the wire.** `systematicReview` carries
`conflictVersions` (when above zero) and `combineReport`.
`systematicReviewConflicts` (read) returns `{ current, versions,
combineReport }`. `systematicReviewConflict` (operate) takes
`{ root, reviewId, change }`, with `change` `{ action: "resolve", conflictId,
pick }` or `{ action: "dismiss-report" }`. In library mode
`scient_sources_systematic_reviews` lists `conflicts` and `combineReport` on a
review, and `scient_sources_systematic_review_update` takes `resolve-conflict`
and `dismiss-combine-report`. The library tool list is 112,261 bytes; the
project list is unchanged.

**The v1 record-change listener** (`startManagedBibliographySync`) skips a
root that is the personal library (`library.json` and no project file).

#### Highlights, the two notes and reading status (5e-2)

**Highlights on library PDFs.** On a moved project in library mode, the
annotation service (`ScientAnnotations.ts`) keeps a PDF's annotations in the
library's `annotations/v1/` when the library holds that PDF's bytes
(`files/sha256/<xx>/<sha256>.pdf`), and in the project's `.scient/annotations/v1`
otherwise. The hash and the library's files decide, never a path. Every caller
goes through this: the reader's routes, the `scient_annotations_*` tools, quote
anchoring (which reads the library's stored text for a library PDF) and the
listing. Reads resolve with `read` and never create the library or start the
move; writes resolve with `write`, so the first one moves an unmoved project
like any other library writer, and a library write holds the library lock. A
write that waits past the move bound fails with `scient_sources_library_moving`
on the route and the move's progress sentence for agents. The listing joins the
project folder's files with the library's files for the PDFs this project's
pins hold. The reader still names a Source PDF by its v1 store path
(`.scient/sources/files/sha256/...`); on a moved project that path reads the
library's copy when the library has those bytes. The move back joins the
library's annotation file for each PDF it restored into the project's file, in
the hold that publishes the restored store; the library keeps its copy. A
project that is not moved behaves as before.

**Two notes.** In library mode a source has the project note (on the pin) and
the person's own note (on the library record). `note` keeps meaning the project
note on every route. The detail adds `projectNote` and, only for a session
holding `orchestration:operate` on this environment, `personalNote`; list and
overview payloads never carry it. `updatePersonalNote`
(`POST /api/scient/sources/personal-note/update`, operate) sets it with the
record's revision. The authorization model has no finer notion of the
environment's owner than this grant: every connection holding it can already
change the library. In library mode `scient_sources_note_update` sets the
personal note and `scient_sources_organize` pin sets the project note.

**Reading status on the wire.** Library-mode overview and detail records carry
`readingStatus` and `starred` (a pin's snapshot has neither). The overview takes
`readingStatus` and `starred` filters; `scopes` still counts every source.
`setReadingState` (`POST /api/scient/sources/reading-state`, operate) takes
`{ root, sourceIds, readingStatus?, starred? }` and answers each ID with
`updated`, `unchanged` or `not-found`. Agents filter `scient_sources_list` by
both and set them with `scient_sources_update` (library mode: `metadata`
becomes optional; reading state alone is not checked against the revision).
The library tool list is 112,563 bytes; the project list is unchanged. Project
servers refuse both new routes.

#### The move in the Library panel (5e-3, switched off)

**Which server.** A library server marks every overview with
`libraryBackend: true`, also for a project it still serves from the project
folder (not moved yet, moved back, or a failed move), whose overview has no
`scopes`. A project server never sends the key, so its overview is unchanged.
The panel asks `moveStatus` only when the overview carries the mark
(`useLibraryMoveStatus`); a project server's panel sends no status request.

**When the panel asks.** Once when the panel opens, after every Library change
on that environment settles, landed or failed (`runSourcesCommand` notifies
`libraryWrites.ts`; highlight writes go the same way), and about once a second
after each answer while the state is `waiting`, `moving` or `restoring`, or
while this panel's own move back is running. A read that fails is tried again
every five seconds, so a panel whose first read failed still finds a running
move. Nothing is asked while the panel
is closed, and nothing animates: only the numbers change. When a move or a move
back that the panel saw running ends, the overview is read again, because the
project's store changed.

**The line** (`libraryMoveLine`, `LibraryMoveNotice`) sits above the store
notices, one line. A `done` or `cleanup-pending` summary is the server's lines
plus "Undo history of bulk edits from before the move was not carried over.",
which replaces the server's own bulk-edit line. `moveStatus` carries no
"dismissed" flag, so empty `lines` (dismissed, or a move with nothing to say)
show no summary; `cleanup-pending` still shows its files-left sentence. Dismiss
(organize `dismiss-move-summary`) is offered for a summary, and a failure offers
"Check again", which only reads the status. "Review" in the merge line is plain
text until the duplicates screen exists. A write refused with
`scient_sources_library_moving` shows "The Library is still moving. Try again
when it has finished." (`scientSourcesErrorMessage`, and the reader's highlight
toast).

**Move back** is a command in "More Library actions", offered on a `done` or
`cleanup-pending` project to a session holding operate, after a confirmation.
It calls organize `move-back`. A failed answer is not shown as an error when
the status then reads `restoring` or `moved-back`, since the move back runs on
after a lost answer. When no answer came back (a timeout or a failed
connection) and the status does not show the move back, or the status cannot be
read, the panel says the move back could not be confirmed, because the server
may still be waiting for the library's lock. It then asks every five seconds
for two minutes and does not offer Move back again meanwhile. It reports a
failure only when the server answered with one. On a library server, `move-back` on a project already
moved back answers `not-moved` (the route serves that project from its own
folder, where the action used to be refused). The project then stays on its own
store: lazy moves and the background pass skip `moved-back`, and nothing moves
it into the library again.

**Review versions.** A review whose detail has `conflictVersions` shows "This
review has another version from a copy of this project.", which opens a picker
read fresh from `systematicReviewConflicts`: the version in force and each
other version side by side, with "Keep this version", "Use the other" and
"Combine" (`systematicReviewConflict`, its own command and grant). The choices
are off until the versions have been read after the picker opened and after
each choice. The picker's read names the version in force by a hash of its file
(`currentRevision`; two versions can share an `updatedAt`), and the pick sends
it back; if another version is in force by then, the server changes nothing and
answers `version-changed`, and the picker says so and reads again. The agent
tool sends no such value. Combine's
report stays on the review, counts first and the lists behind "Details", until
dismissed. After a choice the review and the list are read again; nothing is
patched locally. A read-only session sees the line and both versions, with the
choices disabled and no Dismiss.

#### The Library in daily use (5e-4, switched off)

Everything here depends on the overview's `scopes`, not on `libraryBackend`: a
project the library server still serves from its own folder renders as on the
project backend, plus the move line. With `scopes` absent the details view,
rows, filter menu and bulk bar are unchanged.

**Words.** The interface never says "pin": a source is "In this project", and
the actions are "Add to project" and "Remove from this project". Library-mode
strings live in `LIBRARY_LABELS` (`libraryLabels.ts`), whose test keeps the
word out. Server error text does not reach the panel (routes answer with a
reason code), so the server's own "pin" messages are seen only by agents.

**Two notes.** Details show "Note for this project" (the existing editor, which
edits the pin's note) and "My note" side by side, or one under the other when
the panel is narrow (a container query on the notes). "My note" appears only
when the detail has the `personalNote` key, which a session without operate
never gets. It saves through `updatePersonalNote` with the library record's
`revision`; `stale` is handled like the project note. A source not in this
project has no project note: details show "My note" and "Add to project". Edit
results other than the personal note's own lack `personalNote`; the reducer
keeps the one on screen (`keepPersonalFields`), and when the revision moved the
panel reads the detail again in the background so a later save is not made on
an older note.

**Reading status and star.** Rows show an unread dot and a star; details show
"Mark read" / "Mark unread" and the star; the row menu has the reading change;
the bulk bar has "Mark" with "Mark read", "Mark unread", "Star" and "Remove
star", sent as one `setReadingState` request for every selected ID. A
`not-found` entry is counted in the toast ("1 source is no longer in the
Library."), not shown as a failure. Rows and details take the values from the
route's answer (`readingStateArrived`); nothing waits for a revision, since
reading state changes none. Opening details does not mark a source read. A
session without the command's grant sees the markers and no controls; a pin's
snapshot (`fromSnapshot`) has no reading state, so it shows neither. The filter
menu adds "Unread" and "Starred", applied in the panel over the overview's
records like the other filters and shown in `SourcesActiveFilters`; they live
beside `ScientSourceFilter`, not in it, so saved searches and agent filters do
not carry them.

**This project and All.** In "This project", the row action, the details menu
and the bulk bar offer "Remove from this project" (organize `unpin` by the
project key); the Library keeps the source. In "All", rows not in this project
offer "Add to project" (organize `pin`), as do details and the bulk bar, and
Move to Trash stays there. Details offer Move to Trash in either view, except
for a pin's snapshot, which this library lacks. A move to Trash says in its
toast how many other projects have the source (`alsoPinnedIn` from the removal
result); Undo restores it as before. Add and remove send one organize `change-pins`
request for the whole selection and then read the overview again. An import begun from "All"
(no `pinInstanceId` on the operation) ends with "They are in your Library, not
in this project." and an "Add to project" button for what it brought in; add
by identifier from "All" says the same in its toast.

#### The sources list at Library size (F5)

With Library scopes the list in `ScientSourcesPanel.tsx` is a virtual list
(`SourcesList.tsx`, `@legendapp/list/react`): only the rows near the view are
mounted, so a Library of thousands of sources renders a few dozen rows. The
project backend keeps the shared `ScrollArea` with every row mounted, so it
shows no change before the flip; `SourcesList` takes `virtualized` and the
panel passes it only when the overview has scopes. Each
row (`SourceRow.tsx`) draws its own divider, since mounted rows are positioned
rather than stacked; the university row is the list's header and the full-text
matches its footer. The estimate (`SOURCE_ROW_ESTIMATED_SIZE`, 63 px) is the
shortest row, a one-line title and one line of details, with or without the
star slot; real rows are taller, so the first render never leaves a gap, and
the list then uses the average of the rows it measured.

Data is not paged. The overview still carries every record, and sorting,
grouping and every filter, the reading filter included (`matchesReadingFilter`),
run in the panel over all of them; the virtual list bounds rendering only. A
server-paged list would send the overview's `readingStatus` / `starred` and
keep `scopes` for the counts.

The panel's pieces live beside it: the row menu (`sourceRowMenu.ts`), the
Library's project and reading actions with the snapshot-removal dialog
(`useLibraryProjectActions.tsx`), the import summary with its "in your Library,
not in this project" sentence (`ImportSummary.tsx`), the import review
(`ImportReview.tsx`) and the panel's header and empty states
(`PanelChrome.tsx`). The dialog is the panel's, not a row's, so a row scrolled
out of view and unmounted does not close it. `SourcesList.browser.test.tsx`
renders 3,000 rows over the real `useScientSources` and checks the window, a
star kept against an older overview through the reading overrides, the
snapshot dialog from a row reached by scrolling, and the project backend
keeping every row in the shared scroll area.

#### Bulk edits at Library size (F6)

A bulk tag or type edit reads the store once, not once per source.
`updateScientSourcesMetadata` takes the source-write lock and scans the
records once for the whole batch, and looks up the records an edited source
could duplicate by identifier and title key (`sourceMetadataMatchIndex` in
`duplicates.ts`), then runs `assessSourceMetadataDuplicate` on those only, so
each source gets the outcome `updateScientSourceMetadata` gives it alone. The
Undo receipt is written three times per edit (empty, every planned write,
every finished write) instead of twice per source; Undo writes it twice. Both
backends use the same path. What is left per source is two durable writes,
the record and its history revision, each with `fsync` (F_FULLFSYNC on macOS,
about 4 ms); running them concurrently gained 1.26x at best on an M5 Pro, so
they stay serial.

Add to project and Remove from this project send organize `change-pins`
requests of up to 2,000 changes (the route takes 20,000) and get one answer per change in
`pinChanges`, in order: `pinned`, `existing`, `unpinned`, `not-pinned`,
`not-found` or `refused`. `changeScientProjectPins` reads and writes
`pins.json` once and the route syncs the bibliography once; a refusal's
reason stays on the server, as a failed request's does.

Bulk Trash still sends one removal per source; the list is read again once
after the last instead of after each. One request for it would need a
one-request restore as well: Undo restores each source by its own request,
and each restore scans the store for a duplicate.

`pnpm run measure:bulk-edits` in `packages/scient-sources` times a bulk tag,
its Undo, and pinning and unpinning, on a synthetic store; `--part 100` sends
the edit in parts as the panel does and undoes them newest first.

#### Bulk edits above one request (F6b)

One bulk edit or collection change takes at most
`SCIENT_SOURCES_BULK_SOURCE_LIMIT` (500) sources, the cap the agent tool shares.
A larger selection in the bar is sent in parts by `apps/web` `bulkParts.ts`;
500 or fewer is still one request with the same toasts.

- **Tag, type and collection edits** go in parts of 100, one after another. A
  part took at most 2.4 s at 20,000 records on a quiet M5 Pro and its Undo
  1.3 s (the scale gate's numbers through the library route are below), so each stays under a third of
  the 15 s organize timeout at twice that on a loaded Mac. The bulk route's
  own client timeout is 120 s. Each part is its own bulk edit with its own
  receipt, so the store keeps the latest 250 receipts, enough for
  a 20,000-source edit and 50 others.
- **While it runs** the bar's count reads "Changing 400 of 1,200 sources" with
  **Stop**, which takes effect once the part in flight is answered. Undo of a
  multi-part edit shows "Undoing … sources" the same way, without Stop.
- **At the end** one toast gives the sum of `undo.sourceCount` over the parts
  and one Undo that undoes the parts newest first. The per-source problems of
  the answered parts (`bulkResultSummary`) are in that same toast, and Undo's
  failures and conflicts are summed with the one-request words. **Try again**
  after an Undo repeats only the parts with a failed entry or no answer. A
  repeated part that answers "already undone" was undone by the request whose
  answer was lost and is counted as undone. Any other part whose record is
  gone or was undone elsewhere is counted as not undone, with the server's
  reason.
- **A part that fails** ends the run: the toast says how many changed and how
  many other sources were not. **A part with no answer** (`isLostAnswerError`)
  ends it too and is counted as neither: the toast says its outcome is
  unknown. If the request reached the server its receipt exists there, but
  the client has no batch ID for it and no route lists receipts, so the one
  Undo does not cover it. The overview is read once at the end in every case,
  and the selection stays.
- **One at a time.** While a change in parts runs, another bulk edit, organize
  action or toast Undo is refused with "Another change is still running", and
  a refused toast stays open. The progress line and Stop show only in the
  project the run was started in.
- **New collection from a selection** over 500 sends `create-collection` with
  the first 500, then `add-to-collection` in parts of 500 (about 0.45 s each
  at 20,000 records). It has no Undo, as before; a run that does not finish
  says which sources were not added.

The other selection-sized requests: reading state and export take up to 20,000
IDs in one request and are refused above that, with an error and nothing
reported done; `change-pins` goes in requests of 2,000 changes (one request
of 19,000 took 36 s on a Windows runner, past the 15 s timeout; see the scale
gate below); Trash and its Undo go one source per request; Zotero send and refresh
from the panel name one source or none; Empty Trash names none; a systematic
review adds a selection in parts of 500.

#### Possible duplicates and merges (5f, switched off)

The Library panel's "More" menu offers **Possible duplicates** on a personal
Library (only when the overview has `scopes`). It opens a full-panel view, as
Systematic reviews does, with two sections: the possible pairs and **Merged**.

- **The read** is its own endpoint, `scientSources.duplicates`
  (`LibrarySourcesRoutes.ts` `libraryDuplicates`, engine
  `readScientLibraryDuplicates`). It lists the live records once, runs
  `assessScientLibraryDuplicates` with the stored distinct pairs and reports
  only `possibleDuplicates`. It never merges, never settles an interrupted
  merge and takes no lock; `mergeScientLibraryDuplicates` stays on the move's
  path only. Each pair carries both sides as overview rows plus
  `otherProjects` (other checkouts on this computer that use it, by folder
  name; one pin resolution per checkout) and `keptByDefault`, the design's
  survivor rule. The default side comes first. At most 200 pairs are sent;
  `pairsTotal` counts them all. A project server refuses the read.
- **Merges Undo can still reverse** come from `merges/*.json` with state
  `done` by Undo's own rule: the merged-away source is in the trash under that
  merge, or live again after an Undo that stopped halfway (Undo finishes it).
  All are checked before the list is cut, newest first, at most 100, with
  `mergesTotal` counting them all; this reads one trash entry per done merge.
  `requested` is false for the move's automatic merges. `keptSourceId` is the
  source the merge kept; `kept` is its row, or null when it was merged again
  or removed, and Undo then answers `survivor-missing`.
- **Cost at 20,000 records** (M5 Pro, Node 26, load 2): the assessment alone
  46 ms, the whole read 57 ms warm and 1.2 s cold (the cold part is the
  record listing the overview pays too). The assessment is not on the overview
  path; the view asks when it opens and after each change it makes.
- **Not duplicates** is `mark-distinct` on organize and its Undo
  `clear-distinct` (engine `markScientLibrarySourcesDistinct` /
  `clearScientLibrarySourcesDistinct`, `distinct-pairs.json`). Both sources
  must be live in the Library, or `mark-distinct` answers `not-found` as merge
  does (route and agent tool; the engine itself does not check). A project
  server refuses both like pins and merges (`isLibraryOrganizeAction`).
- **The view's changes** (Merge with the chosen side as `survivorId`, Undo,
  Not duplicates and its Undo) all go through `useSourcesOrganize`'s
  `organize`, one request per pair, so they are refused while a change in
  parts runs and then change nothing: the pair and the merge dialog stay. Toast
  actions are wrapped in `whenFree`, which also refuses while any other request
  of the hook is in flight, so a merge's Undo from its toast and its Merged row
  cannot both be sent. A successful change reads the overview again, and moves
  the hook's `changes` count, which the view reads again on; a toast's action
  from a view closed since therefore still updates the view open now. A merged-away source
  leaves the selection; an open detail of it closes because its row left the
  overview. Reading overrides are keyed by source ID and dropped by the next
  overview, so one held for the merged-away source neither shows on the kept
  source nor returns after Undo.
- **The move's line** "… kept different values: Review." gets a **Review**
  button that opens the view at Merged; the phrase is
  `SCIENT_LIBRARY_MERGES_TO_REVIEW`, shared by the line and the button.
- **Agents**: `scient_sources_list` with `duplicates: true` (library mode)
  returns the first 25 pairs and 10 undoable merges with both totals (each
  merge's `survivorId` is `keptSourceId`); project mode refuses it. `scient_sources_organize` takes `mark-distinct` and
  `clear-distinct` with two source IDs. The library tool list grew from
  112,563 to 112,832 bytes. `LIBRARY_ORGANIZE_ACTION_PARITY` maps every
  Library-only organize action to the tool's action(s), and its test checks
  the tool's schema names them.
- Not built: merging two sources the assessment did not pair.

#### The scale gate at 20,000 records (M3)

**The test library.** `pnpm run generate:scale-library` in
`packages/scient-sources` (`scripts/scaleLibrary.ts`) writes it from a seed
(default 20261112): 20,000 live version 2 records with 1,200 to 1,800
character abstracts (60% of articles also structured), up to 14 authors, DOIs
on most, PMIDs, arXiv IDs and ISBNs on some, none on about 10%, tags and
reading state; PDFs and extracted text for 5,000, highlights on 1,000; 300
collections, 240 of them nested; five saved searches; 60 same-DOI copies the
merge pass merges and 40 requested merges, leaving 400 possible pairs; three
registered checkouts pinning 5,000, 3,000 and 1,000 sources; and one review of
10,000 records with 2,000 screened, whose snapshot (37 MB) shards. `--move`
adds a version 1 project of 20,100 records (5,000 PDFs with text, 1,000
highlight files, 50 collections, a 10,000-record review, 100 DOI copies) to
move into an empty Library. The Library is 31,689 files and 311 MB. Record,
PDF, text, highlight and collection bytes depend only on the seed: the
records' digest was the same on all five machines. IDs and times the store
assigns itself are not.

**The measurement.** `pnpm run measure:sources-scale` in `apps/server`
(`scripts/measureSourcesScale.ts`) writes the library once, then runs each
measure in a fresh Node process through the Library route functions the HTTP
layer calls, with the store a project already in the Library resolves to.
The first call in the process is "first" (the OS file cache may be warm);
then five more give "warm". The list's wire cost is the contract schema's
encode on the server and parse and decode on the client. Each process
records its peak RSS and heap and its event-loop delay
(`monitorEventLoopDelay`, the 10 ms interval taken off). Bulk edits go in the
panel's parts of 100 and undo newest first; `change-pins` goes both as one
request and in the panel's requests of 2,000; the move runs with another
library writer taking the lock throughout, and `move-interrupt` kills the
move with SIGKILL halfway through its file copies, then resumes it in a new
process. `--heap-mib N` caps V8's heap. Raw JSON per round is in the Sources
roadmap's `gate/scale/` folder.

**Results** (median of three rounds; Node 26.12.1; a first call is in a
fresh process). Apple Silicon is the M5 Pro (18 cores, 48 GB, shared, load 4
to 5); the CI runners are GitHub-hosted: `macos-15` (virtual M1, 3 cores,
7 GB, load 10 to 24), `macos-15-intel` (Core i7-8700B, 4 cores, 14 GB, load
7 to 12), `windows-2025` and `ubuntu-24.04` (AMD EPYC 7763, 4 cores, 16 GB).
`change-pins` is from a second run after the read fix. Gate: the list under
1 s, a filter under 200 ms, a bulk tag of 1,000 under 3 s (read as progress at
once, about 11 ms per source), a part under 5 s.

| Measure                                                          | M5 Pro      | macos-15    | macos-15-intel | windows-2025 | ubuntu-24.04 |
| ---------------------------------------------------------------- | ----------- | ----------- | -------------- | ------------ | ------------ |
| Library list, first call (s)                                     | 1.03        | 3.06        | 6.62           | 3.53         | 2.23         |
| Library list, warm (s)                                           | 0.15        | 0.49        | 0.74           | 0.48         | 0.41         |
| … encode, parse and decode of 26.6 MB (s)                        | 0.23        | 0.73        | 1.47           | 0.67         | 0.75         |
| Slowest filter or sort (ms)                                      | 36          | 134         | 119            | 66           | 66           |
| Bulk tag of 1,000: first progress (s)                            | 1.62        | 2.45        | 3.43           | 3.89         | 2.30         |
| Bulk tag of 1,000: total (s)                                     | 12.2        | 14.3        | 25.0           | 18.2         | 10.5         |
| Its Undo through the route (s)                                   | 11.7        | 12.6        | 25.1           | 15.5         | 9.1          |
| Type change of 1,000: median part (s)                            | 2.42        | 4.05        | 5.53           | 4.69         | 3.37         |
| Duplicates read, first / warm (s)                                | 0.65 / 0.18 | 2.18 / 0.52 | 2.70 / 0.57    | 3.57 / 0.45  | 2.23 / 0.40  |
| Review of 10,000, open and screening, after the reviews list (s) | 0.21        | 0.76        | 0.66           | 0.52         | 0.51         |
| The move (min)                                                   | 5.4         | 4.7         | 8.8            | 3.5          | 2.2          |
| Move: longest time without progress (s)                          | 5.50        | 8.29        | 16.0           | 10.6         | 5.39         |
| Move: event-loop delay p99 / max (ms)                            | 1.6 / 99    | 13 / 370    | 5.2 / 544      | 24 / 346     | 4.2 / 318    |
| change-pins, 2,000 per request: slowest (s)                      | 0.73        | 2.44        | 5.84           | 4.59         | 2.33         |

**Changed by the scale gate:**

- The record index stats and reads 32 files at a time (above).
- After a bulk Undo or a type change the route refreshes only what changed
  (Pins and project keys, above); a tag-only Undo refreshes nothing.
- `changeScientProjectPins` looks pins up by source ID, resolved ID and key
  instead of scanning them per change, and `pins.json` may be 64 MiB.
- `resolveLibrarySourceIds` reads records 32 at a time.
- The panel sends `change-pins` in requests of 2,000.
- The move's `verifying` count covers the records and files it backs up.
- The list sorts with one `Intl.Collator`.

**Memory.** With V8's heap capped at 1 GiB (`--heap-mib 1024`) every heavy
measure finished on all five machines, at the same speed on four (the Intel
runner's single capped round was slower, at load 7 to 12); the highest peak
RSS was 1.05 GB for the move, 0.27 GB of which is the modules the measuring
process loads before it starts.
Uncapped, the heap reaches 1.0 to 1.4 GB during a review open, a type
change or 19,000 pin changes (up to 1.66 GiB RSS) because collection waits
while memory is free. The proposed bound at
20,000 records: the Sources work runs within a 1 GiB heap and adds at most
1 GiB of RSS to the server.

**Still open:**

- The Library list's first call after the server starts reads and decodes
  every record (0.7 to 1.0 s on the M5 Pro, 2.2 to 6.6 s on the runners).
  Warm, the server answers in 0.15 to 0.74 s, but the answer is 26.6 MB for
  20,000 rows (creators 6.8 MB, collection membership 4.2 MB, `origin`
  2.1 MB, diagnostics 1.5 MB), which costs another 0.23 s (M5 Pro) to 0.67 to
  1.47 s (runners) to encode, parse and decode.
- A bulk tag moves its progress line after the first part (1.6 to 3.9 s) and
  costs 10.5 to 25 ms per source. A type change's part costs 2.4 to 5.5 s at
  the median because each part refreshes this project's 10,000-record review
  snapshot and bibliography.
- The move takes 2.2 to 8.8 minutes for 20,000 sources; most of it is the
  durable record writes and the backups. Its longest silence is the start,
  reading the v1 store before the first count (up to 16 s on the Intel
  runner).
- One `change-pins` request of 19,000 still takes 8 to 32 s on the runners
  (it took 13 to 36 s before the read fix); the panel no longer sends one.

## Source truth and provenance

The persisted record has a first-class Scient source type and normalized
bibliographic fields. The original Zotero library ID, item key, item version,
and raw item type remain external provenance. Field provenance is recorded only
for values actually supplied by Zotero.

Abstracts use one provider-neutral representation: canonical plain text plus
optional titled sections derived only from explicit source markup, never
Zotero HTML, JATS XML, or provider presentation markup. The plain text remains
the searchable, editable, citation-compatible value; the sections preserve
structured-abstract meaning for presentation without guessing that a short
line is a heading. Every adapter, metadata edit, and final store write passes
through the same normalizer, so future source systems cannot accidentally
persist provider markup. Older records are normalized when read for
presentation without being silently rewritten; an explicit metadata edit
stores the canonical value in a new revision. A leading provider wrapper named
`Abstract` is discarded while its paragraphs are preserved, leaving only the
actual structured headings in the canonical document.
Provider HTML may place section bodies as bare text siblings after explicit
headings rather than inside paragraph elements. The boundary parser preserves
that text across inline markup and associates it with the preceding heading.
A legacy structured abstract containing headings but no body paragraphs is
treated as absent rather than displaying an invented heading-only summary.

Direct PDF intake uses an immutable per-upload candidate key while keeping the
content SHA-256 as the duplicate and storage identity. This prevents two
simultaneous reviews of the same bytes from overwriting each other's staged
metadata. It normalizes scalar and array-valued XMP fields independently, so a
malformed optional field cannot discard already readable metadata or prevent
first-page identifier extraction. It reads bounded document metadata and text
from at most the first two pages. A single unambiguous DOI or explicitly
labelled PMID may be resolved through the public DOI CSL JSON or NCBI ESummary
endpoint for bibliographic identity. The embedded date counts as the
publication date only from XMP `prism:coverDate` or `prism:publicationDate`;
the document-info `CreationDate` and Dublin Core `dc:date` describe the file
and are ignored. Records imported before this keep their stored date.

After a Zotero or local-PDF adapter has built its candidate, a shared
provider-neutral enrichment seam may fill a missing abstract using only that
candidate's exact DOI or PMID. The bounded resolver prefers NCBI EFetch for a
PMID, then Crossref `/works/{doi}`, with Europe PMC as an exact-identifier
fallback. Resolvers run in authority order and stop after the first verified
match; one shared deadline bounds the whole optional enrichment step instead
of waiting for every service. An abstract already supplied by Zotero, DOI
metadata, or a researcher is never replaced. Retrieved abstracts retain their
service, exact identifier, source field, and retrieval time in field
provenance.

Registry lookups read the user's research keys from Accounts through
`researchKeys.ts`: the API-key row whose sites match the service (OpenAlex,
Semantic Scholar, NCBI, Google Books at `www.googleapis.com`, and the Unpaywall
email), skipping a row set to Off. Tools take the resolver through
`keyedIdentifierLookup` and the batch lookups (identifier add, cite, reference
check) through `keyedBatchLookup`, which pass the keys as `Redacted` values; the
Effect HTTP client gets them as `Redacted` URL parameters so spans show them
redacted. Work outside a tool call reads the keys again at each use through
`researchKeysReader`, captured when the Sources HTTP layer starts: the
Library's add, refresh and save-page routes, and the background category pass
(`readSourceCategoryKeysFrom`), whose OpenAlex topics request sends `api_key`.
Google Books gets the key as `key`; when Google refuses the key (400 or 403)
the request is repeated once without it. Paper downloads send the OpenAlex key
and ask Unpaywall only when OpenAlex has no free copy. The Library's registry
contact email goes to OpenAlex as `mailto` and to Unpaywall when no Unpaywall
email is saved.

All NCBI E-utilities requests share one serialized, interval-limited lane.
The lane remains owned until the active network request settles and releases
in `finally`, preventing overlapping requests and avoiding a dead lane after a
failure.

Every registry request goes through `metadataHttp.ts`, which sends the
versioned `METADATA_USER_AGENT`. The Library setting
`scientSources.registryContactEmail` (Settings ▸ Documents) is followed by
`RegistryContact.layer`; when it holds an address, requests to
`api.crossref.org` and `api.openalex.org` (including redirect hops, such as
doi.org to Crossref) carry it as the `mailto` parameter and in the
User-Agent. No other host receives it, and an empty or malformed value sends
nothing. Adapters that pass the address another way (Unpaywall's `email`)
read `registryContactEmail()`; none keeps its own setting.

All metadata responses are HTTPS-only, time- and size-bounded, and
schema-decoded. Only the exact identifier leaves the project environment; the
PDF never does. Resolution failure is a normal offline fallback, not an import
failure. No visible-PDF abstract extraction, OCR, fuzzy bibliographic search,
or model inference is part of this slice because those paths need separate
identity and evidence safeguards before they can be trusted.

Generic embedded PDF Subject and Dublin Core description values may help locate
an exact DOI or PMID, but they are not treated as scholarly abstracts. Those
fields commonly contain citation strings or arbitrary publisher descriptions.
Scient stores an abstract only when an abstract-bearing source such as Zotero,
PubMed, Crossref, Europe PMC, or DOI metadata supplies one; absence is
preferable to presenting the wrong field as scientific content.

Researchers may correct canonical bibliographic metadata without changing the
source ID, project ID, external Zotero references, imported files, content
hashes, or import evidence. Each successful edit requires the revision the
researcher opened, increments the record revision exactly once, preserves the
previous record in immutable history, and atomically replaces the current
record. A normalized no-op does not create another revision and may safely
acknowledge a retry whose first response was lost. Changed fields receive
provenance naming their writer (`user`, or `agent` for edits through the
Sources toolkit); provenance for unchanged fields is preserved. Metadata, note
and attachment writes also record the writer as the record's `updatedBy`, and
an edit that changes identifiers drops the record's identifier verification.
The stable source-type enum remains deliberately small; records classified as
`other` may carry an optional researcher-defined label without widening the
transport or citation type systems for every new scholarly genre.

Metadata edits re-run exact-identifier and possible title/creator/year duplicate
checks against the other project records. Exact identifier conflicts cannot be
overridden. A possible metadata match requires an explicit per-save decision.
Concurrent edits are serialized by canonical project root within the owning
environment server; an edit based on an older revision returns the current
record as stale instead of overwriting it.

Each source may also carry one optional project-owned note. The note is stored
on the canonical record, not in Zotero or a UI-only sidecar, and follows the
same atomic revision/history rules as metadata. The details surface exposes an
anchored quick editor and one directly editable note below the reference; both
share one autosave state and retain the local draft when another writer changes
the note first. Notes are plain Markdown text with only lightweight bold and
italic controls in this slice. Their text direction is resolved by the browser
from the note itself, so Hebrew, Arabic, English, and mixed research notes do
not inherit an unrelated application direction.

Provider agents use the same canonical store through a bounded ten-tool
Sources MCP toolkit:

- `scient_sources_list` and `scient_sources_get` are bounded, read-only views;
- `scient_sources_note_update` and `scient_sources_update` use optimistic
  revision safety for notes and canonical metadata;
- `scient_sources_add` creates an idempotent source from supplied metadata or a
  project-relative PDF after checking its identifier (below);
- `scient_sources_attach_pdf` and `scient_sources_detach_pdf` change canonical
  attachments without exposing host paths; and
- `scient_sources_remove` moves a source to the trash through the same
  revisioned removal path as the UI, `scient_sources_list` with `inTrash`
  lists the trash, and `permanent` deletes a trashed source for good;
- `scient_sources_restore` puts a trashed source back; and
- `scient_sources_revert` makes a kept revision current again; and
- `scient_sources_check` checks a source's DOI or PMID with its registry again
  and records the verification and editorial status (below). With `refresh`
  it first does what **Refresh metadata** does, through the same
  `refreshAndCheckSourceMetadata` call credited to the agent: metadata from the
  DOI or PMID registry, or from the PDF when there is neither, then the check,
  and it reports `changedFields`.
  `scient_sources_get` returns the kept revisions with who saved each and which
  fields changed.

Paper downloads reach the store through `paperIntake.ts`. A `scient_paper_get`
or `scient_papers_queue` request with `addToLibrary` (or `sourceId`) needs the
`sources:write` grant; without it the PDF is only saved and the result says so.
From a client connection, `accounts.papers.getForSource` and an
`accounts.papers.request` with any `source` or `library` paper need
`orchestration:operate` on top of `settings:write`, the same grant as the other
Library changes (`scientPaperRequestScopes`, shared by the client command check
and the server's RPC authorization); a request that only saves PDFs needs
`settings:write` alone.
Once the queue has saved the PDF, the intake attaches it to the source whose DOI
or arXiv ID matches, at that source's current revision, or creates a source
through the same resolver as an agent add (`origin.intake: "paper"`, credited to
the agent, or to the user for their own queue). Its candidate holds only the
asked identifier; OpenAlex's title and year are kept, with `openalex`
provenance, only when no registry answers. The DOI in the PDF's own text is not
used, since it can be a cited work. A not-found DOI adds nothing, and a possible
metadata match is reported for the agent to decide. Each downloaded attachment
records `retrieval`: the route (`open-access`, `publisher`, `university`,
`library`) and the version (`published`, `accepted`, `preprint`, or `unknown`
when the repository did not say). A copy already in `papers/` records none.

Before an agent add writes anything, the server checks the source's DOI at
doi.org (CSL-JSON), or failing that its PMID through PubMed esummary on the
shared NCBI request lane, within a 6.5-second deadline. A DOI that doi.org
itself reports as unregistered, or a PMID PubMed has no summary for, returns
`identifier-not-found`; a registered work whose title does not match the
title the agent supplied returns `identifier-mismatch` with the registry's title, first
three creators, year and container. Neither writes a record. A confirmed
identifier makes the registry's bibliographic fields authoritative, with `doi`
or `pubmed` field provenance carrying the identifier and retrieval time, and
stores verification `verified`. A CSL title is read as plain text: Crossref
passes on the inline markup (`<i>`, `<sub>`, MathML) and line breaks of the
deposited XML, and Library titles are plain text. An unreachable or unusable registry adds the
source as given with `unchecked`; a source without a DOI, PMID, arXiv ID or ISBN
is `unverified`. An exact duplicate is reported without a lookup, and optional
abstract enrichment runs after the check. The same add path serves a person
adding by identifier (actor `user`), with the same refusals and states.

A found identifier also records `editorialStatus`: the retraction, withdrawal,
expression-of-concern and correction notices the registry reported, and the
most serious one as `state` (`none` when it reported none; absent when never
checked). For DOIs these come from the `updated-by` entries in the same
doi.org CSL-JSON response, which Crossref fills from publisher updates and
Retraction Watch; for PMIDs, from PubMed's `Retracted Publication` type.
Unrecognized or malformed entries are skipped without losing the metadata.

`checkSourceIdentifier` (the `scient_sources_check` tool, and the end of every
metadata refresh) re-resolves a source's identifier without touching its
metadata: found and matching the stored title is `verified` with fresh
editorial status; not found, or found with a different title, is `unverified`
with `problem` `not-found` or `mismatch` and no editorial status; an
unreachable registry keeps an earlier verdict for the same identifier and
otherwise records `unchecked`. A check that changes nothing but timestamps
writes no revision; otherwise it writes one credited to the actor. Editing a
source's identifiers clears both verification and editorial status, since
they vouched only for the old identifiers; reverting restores the ones saved
with the reverted identifiers.

arXiv IDs and ISBNs are registry schemes too, checked after DOI and PMID, each
in its own file registered in the resolver's scheme table
(`IDENTIFIER_SCHEMES`). An arXiv ID is looked up through the arXiv API
(`export.arxiv.org/api/query`, up to 50 IDs per `id_list` request, one request
every three seconds as arXiv asks); an ID missing from the feed does not exist.
Its record is a `preprint` with publisher `arXiv`, and the published version's
DOI from `arxiv:doi` joins its identifiers. Version suffixes (`v2`) are not
part of the identity. An old-style ID written with its subject class
(`math.DG/0211159`) is asked for without it (`math/0211159`): the API returns an
empty feed for the longer form. An ISBN must have a valid check digit and is stored as
ISBN-13. Open Library answers first (several ISBNs per request); an entry
without authors is not accepted, since the openly edited catalogue holds spam
listings under real ISBNs, and Google Books is asked instead, counting only a
volume that lists the same ISBN. A name Open Library lists twice (one person
under two author records) is kept once; its list can also include an edition's
translators, which the API does not mark. Not found needs both catalogues to say so;
otherwise the ISBN is unavailable. Field provenance names `arxiv`,
`open-library` or `google-books`. None of these requests carries the contact
email.

`resolveSourceIdentifierBatch` resolves many identifiers, each as its own work,
grouping them per registry: arXiv and Open Library answer many per request, DOI
and PMID lookups run four at a time so none waits out its deadline in the NCBI
lane, and each request has the 6.5-second deadline. At the deadline an ISBN
group keeps the books already found and starts no more Google Books requests;
only the ISBNs still waiting are unavailable. `SourceIdentifierAdd.ts`
uses it for adds by identifier: `scient_sources_add` with `identifierList` (up
to 50 entries in any common spelling, outcome `batch` with one result per
entry) and the user's **Add by identifier** (`POST
/api/scient/sources/identifiers/add`). Text is read by `detectSourceIdentifier`
and `parseSourceIdentifierList` in `packages/scient-sources`; a comma or
semicolon splits a list even without a space when a DOI, link or scheme prefix
follows it, and otherwise stays part of an old DOI. An identifier
already in the Library (a work-level identifier, or the ISBN of an existing
book) is reported as a duplicate without a lookup. Only a found identifier is
added, verified and credited to its actor; not found, unavailable and
unrecognized entries add nothing, since an entry has no other metadata to keep.

Agents with `sources:read` in a verified project get a short `## Scient Library`
awareness block naming the list, search, add and bibliography tools and asking
them to start literature work there before web search; `scient_sources_list`
returns the Library's size as `total`.

Connector results reach the Library as identifiers, not copied metadata. The
resolver also takes an OpenAlex work ID (`openalex`, `W…`) and a Semantic
Scholar paper ID (`s2`, a 40-character paper ID or `CorpusId:N`), tried after
every registry scheme. `ConnectorIdentifierLookup.ts` reads the catalogue entry
(OpenAlex at 10 requests a second, Semantic Scholar at one), follows its DOI,
then PMID, then arXiv ID through the ordinary scheme lookups, and keeps the
catalogue ID among the record's identifiers (both Semantic Scholar IDs, paper ID
and `CorpusId`, when it gives them). A registry that does not have the
identifier the catalogue names refuses the work like any other add
(`identifier-not-found`, naming that identifier in `named`). A registry that
cannot be reached returns unavailable with the catalogue's record, which the
agent add keeps as unchecked with the registry identifiers. A work no registry
names is the catalogue's own record (`catalogueOnly`, `openalex` or
`semantic-scholar` provenance) and is added unverified. A catalogue that does
not know the ID returns not found. OpenAlex and Semantic Scholar IDs are
work-level identifiers in exact duplicate matching.

Agent-added sources are not held for approval. Trust comes from that check,
from attribution (origin actor, field provenance, `updatedBy` and revision
history, all shown in the Sources panel) and from ordinary edit and removal.
New records always store origin review `none`; older records that still say
`pending` decode unchanged, and nothing gates on the value.

The toolkit is project-scoped, writes Zotero only through
`scient_sources_zotero_send`, and does not create a
second agent-owned notes or source format. Read and write capabilities are
separate, mutating tool descriptions require an explicit user request, and
normal agent tool authorization remains the approval boundary rather than a
separate Sources permission UI. Providers that receive Scient's MCP session
always receive `sources:read` and `sources:write`; these baseline capabilities
are independent of optional preview-browser control. The capability checks
remain the server authorization boundary, and exact project/worktree
resolution remains server-owned.

Metadata refresh is an explicitly destructive operation guarded by a compact
confirmation surface. The environment server re-runs the existing local-PDF
and exact DOI/PMID resolvers, rechecks the record revision after asynchronous
resolution, and writes only evidence-backed, non-empty candidate fields through
the normal revisioned metadata-update path. The refresh may replace prior
manual corrections, but it cannot change source identity, attachments, or the
imported PDF.

Source removal uses the same canonical-root write lane as imports and metadata
edits. It requires the revision the researcher reviewed and is idempotent when
a successful response is lost. Removal saves the current revision to history,
writes the whole record to `trash/<source-id>.json` with who removed it and
when, and only then deletes the live record, so a crash leaves the source
listed rather than lost. Restore writes the trashed record back as a new
revision credited to the restorer; it refuses when a live record with the same
ID exists (`exists`) or another live source has the same identifier
(`duplicate`). Importing a trashed source again supersedes its trash entry.

Neither removal nor detaching a PDF deletes PDF files. Permanent deletion
(one trashed source, or the whole trash) deletes the trash entries and their
revision history, then deletes every content-addressed PDF that no live or
trashed record refers to. It deletes no file at all while any record or trash
entry cannot be read, since that record might refer to it. Deleting one
trashed source takes the revision the caller saw and compares it under the
same write lock that deletes, returning `stale` when the source was restored,
edited or removed again in between; emptying the whole trash takes no
revision. Revert and history
listing do not keep PDFs alive: a revert whose revision names a deleted file
leaves that attachment out and reports `missingAttachmentCount`.

Revert copies an earlier revision's content into a new revision credited to
the actor, keeping the source's identity, `importedAt` and origin. It returns
`stale`, `not-found` (revision not kept), `unchanged` or `duplicate` (the
reverted identifiers belong to another live source) without writing. Each
source keeps its first revision and the most recent ones, 50 including the
current record; older revisions are pruned after each write.

Listing reads every record file independently. A `.json` entry that is not a
regular file (a symlink, for example) is never followed. It, and a file that is
not valid JSON, does not decode, belongs to another project or does not match
its file name, is skipped and reported in the overview's `unreadableRecords`
with its project-relative path; the UI shows one quiet line naming the files.
The trash listing reports its own entries the same way. Reading a single source
by ID still fails for that source alone.

The UI moves a source to the trash straight from the row's secondary-click
menu or the details page and offers Undo in the confirmation toast; **Trash** in
the Library header's overflow menu (`SourcesHeaderMenu`) opens a popover that
restores or empties it. The row's secondary-click
menu uses the existing host context-menu bridge.

Metadata completeness is derived from the record rather than persisted as a
possibly stale quality label. Missing title or creator produces a warning;
missing year or persistent identifier remains visible informational evidence.

Reference rendering uses the same stored record regardless of import origin.
The initial offline catalog contains Vancouver and APA 7. Creator roles remain
distinct when converted to CSL, corporate authors remain literal names, and
unknown fields are omitted rather than invented. The current schema is enough
for common journal articles; richer book, thesis, conference, and report
references require deliberate canonical fields rather than adapter-specific
extensions. The renderer stores only the project's selected style as a
versioned local preference; the source record and formatted reference remain
project-owned truth and derived output respectively.

Duplicate assessment is ordered from strongest to weakest:

1. exact external origin;
2. normalized work-level identifier (DOI, PMID, PMCID, or arXiv);
3. identical PDF SHA-256;
4. possible normalized title/lead-creator/year match; and
5. new source.

Possible metadata matches are never silently merged. They require a per-item
`allowPossibleMetadataMatch` decision persisted in the import operation. The
store permits that decision only for the weak metadata-match classification;
same-origin, identifier, and PDF-content matches remain non-overridable.
ISSN, ISBN, and unknown schemes are deliberately excluded from automatic work
identity. Completed operation items retain their duplicate disposition so the
web surface can report imported, already-present, and review-required counts
without deriving semantics from presentation text. Operations written before
that additive field remain readable.

When a project already contains PDFs, preflight validates and hashes the
selected local Zotero PDF before presenting the decision. Import revalidates
and hashes while copying, so the review and durable write use the same content
identity without trusting a stale path.

## Citation keys

Each record carries an optional `citationKey`, the key documents cite it by
(`[@key]`, `\cite{key}`). The rules live in
`packages/scient-sources/src/citationKeys.ts` and are applied by the store when
a record is created, under the same write lock as duplicate assessment:

- A key the importer brings (Zotero, Better BibTeX, a `.bib` entry) is kept;
  characters Pandoc or BibTeX cannot read are dropped. Importers set
  `citationKey` on the candidate and never generate keys themselves.
- Otherwise the key is generated from the lead author's family name, the year
  and the first significant title word in ASCII (`smith2020deep`).
- Keys are unique per project, compared case-insensitively as BibTeX does; a
  clash adds `a`, `b`, … `z`, `aa`.
- A key never changes on its own. Editable metadata without `citationKey`
  keeps the current key; a different value is a deliberate rename, validated
  for syntax and uniqueness and credited to the actor like any other field.

Records written before keys existed decode unchanged and have no key until one
is assigned.

## Managed bibliography

`apps/server/src/scient/sources/ManagedBibliography.ts` is the only writer of
the project's `references.bib` and `references.json` (CSL-JSON, `id` = citation
key), rendered by `@scientfactory/scient-citations/bibliography` and sorted by
key. Entries come from the same writers as Library export (`formatBibtex`,
`cslJsonItem` in `@scientfactory/scient-sources/bibliography`; notes and
abstracts stay out through `includeNotes: false, includeAbstracts: false`), so
a managed file holds an export's entry minus the abstract. Abstracts are left
out because they multiply the file size and turn every registry refresh into a
large diff, and nothing that builds a document reads them; explicit export
keeps them. The first sync after this change rewrote each file once: the file
still matched the written copy, so it was replaced quietly (no `edited`, no
`kept-` copy). Word
export and reference formatting read sources through the same CSL-JSON writer. The store reports every settled write through
`onScientSourceRecordsChanged`; the server coalesces those into one sync per
project, so writes from people, agents and every import path keep both files
current. A sync first gives keyless legacy records a key (oldest first).

Scient keeps a copy of what it last wrote in `.scient/sources/bibliography/`.
A project file that differs from that copy was edited by hand and is kept
(`edited`, with the keys added, changed or removed); a file Scient never wrote
is `unmanaged` and is never written over. Only an explicit `replaceEdited` from
the user or an agent restores the Library version. The project file is written
before the copy, so an interrupted write is adopted on the next sync instead
of reported as an edit. Nothing is written for a project without a Library.

Project files are published with `publishScientProjectFile`
(`@scientfactory/scient-sources/project-files`): a new file is linked in
without replacing one created meanwhile, and an existing file is moved aside
and checked against what the sync read; a save that landed in between goes back
in place (or is kept beside the file as `<name>.kept-<id>`) and the file reports
as `edited`. If writing fails after the move, the moved-aside text goes back in
place, or stays as `<name>.kept-<id>` and the error
(`ScientProjectFilePublicationError.recoveryPath`) names it; it is deleted only
once another copy is in place. Where hard links are missing (EPERM, ENOTSUP,
and EISDIR from Windows on FAT and exFAT) the file is created exclusively and
written; a write that fails part way moves the file to a private name and
removes it only if it is the one it created (checked by file identity), so a
partial copy never takes the managed name and another writer's file at that
name goes back in place (or is kept beside it). A sync reports
every `references.{bib,json}.kept-<id>` and leftover hidden `.replaced` file
at the project root in the file's `kept` list, whether the write failed in this
sync or an earlier one, automatic or explicit, until the person deletes it; a
failed write reports the file `edited` without changes. The Library's notice
and the `scient_sources_bibliography` result show the list. Windows coverage:
`ManagedBibliography.test.ts` and `projectFilePublication.test.ts` run in CI's
Overleaf Windows job. The copies folder is reached only through real folders
(`assertScientProjectDirectory`); a link anywhere on that path makes both files
`unmanaged`.

`importEdited` sends an edited file through the ordinary reference-file import
(`importBibliographyFile`). Only when the edit added entries and every added
key is then in the Library, with nothing changed or removed, is the file
written again; otherwise it stays edited for the person to decide.

## Citing

Documents cite by key. In Markdown, typing `[@` opens a list of Library
sources (`prosemirror/libraryCitation.ts`, ranked by
`sources/libraryCitations.ts`) and inserts the existing Pandoc `citation`
node; the LaTeX citation dialog appends Library sources after the document's
own `.bib` entries. A citation opens its source through
`librarySourceRequest.ts`, which the Library panel acts on once loaded.

A deliberate key rename goes through `updateScientSource`. It finds every
Markdown and LaTeX document first (any depth; hidden, tool and build folders
skipped; links never followed), then commits the key and rewrites only what the
parsers call a citation (`citationKeyRename.ts`): Markdown prose spans from
`markdownProseTextSpans`, so code, math, links, URLs and HTML keep their text,
and LaTeX `\cite`-family commands found by unified-latex, so comments and
verbatim text keep theirs. Each document is published like the managed files,
so a save made during the rename is never overwritten. `citationKeyRenamedIn`
lists the files changed and `citationKeyRenameSkipped` every document the
rename could not process (a link, too large, unreadable, kept changing, or
beyond 20,000 documents), with why. Nothing else changes a key, so a key a
document uses stays frozen.

`scient_sources_cite` (`LibraryCitation.ts`) runs the shared reference check
(`checkReferences` with a Library `sourceIds` target) on the sources about to
be cited and reports identifier, retraction, notice, published-version and
registry-detail findings next to the citation it returns; it never withholds
the citation.

Markdown Word export passes a CSL style to Pandoc: the document's `csl:`
front matter (a bundled `apa` or `vancouver`, or a project `.csl` file), else
the project's citation style, else the request's `citationStyle` from
Settings, else Pandoc's default. A project style that cannot be read becomes a
`resource-unresolved` warning naming it and the style used instead. Library
sources are the lowest-precedence references (`fallbackCitations`), after the
document's front matter and named bibliographies. Export only reads records.

### Citation styles

A project has at most one CSL style, owned by
`apps/server/src/scient/sources/CitationStyles.ts`. It lives in
`.scient/citations/` (never `.scient/sources`): `style.json` names the style
(`formatVersion`, `id`, `title`, `parent`, `updatedAt`, `updatedBy`) and
`styles/<id>.csl` holds the style file, plus its independent parent for a
dependent style. Files are written with `publishScientProjectFile`, parent
first and `style.json` last, so a reader never sees a setting whose files are
not there yet. `readProjectCitationStyle` returns `none`, `ready` with the XML
both engines render, or `unavailable` with a message naming the missing or
broken file; callers report `unavailable` and never substitute another style
silently.

A style is usable when `readCslStyle` accepts it, on save and on every read:
one CSL root, the identity in that root's `info`, every element closed in
order, and every macro a layout names defined. citeproc-js reports neither
fault itself: it renders markup that Pandoc rejects, and prints nothing for an
undefined macro. The check reads the text, so it covers branches for every
source type, and it does not print a sample, because a valid style may print
nothing for some types. It is one pass that reads the text as XML does:
comments skipped, CDATA kept as text, attributes in either quote with spaces
around `=` and character references decoded. A macro name therefore matches
its definition however each is written, and `renderableCslStyle` writes the
dependent style's locale at the root that pass found.

The web keeps one copy of the project's style per project
(`useProjectCitationStyle`). It reads the style when a reference or the picker
opens, on the live-refresh schedule the Library list uses, and when the pointer
or keyboard focus reaches an open reference, so a style an agent or another
window set is the one copied. A read that fails with nothing loaded shows a
notice naming the style shown instead.

Neither engine resolves a dependent style's parent here: citeproc-js has no
network, and Pandoc runs with `--sandbox`. `renderableCslStyle`
(`packages/scient-citations/src/cslStyle.ts`) gives both the parent's layout
with the dependent's `default-locale`, as CSL processors apply dependent
styles. Locales: Pandoc ships every CSL locale; citeproc-js gets
`@citation-js/plugin-csl`'s five plus the bundled `en-GB` (the default of
Nature, BMJ and The Lancet), and any other locale renders in `en-US`, as
citeproc processors do.

The catalogue is the Zotero Style Repository index
(`https://www.zotero.org/styles-files/styles.json`, about 3 MB, the same
styles as the CSL repository's release branch) and its style files
(`https://www.zotero.org/styles/<id>`). The server fetches them with the
Sources user agent and raised size and time limits, caches the index in
`<stateDir>/scient/citation-styles/v1/styles.json` for seven days, shares one
download among concurrent searches and waits a minute after a failure. A search
that cannot reach the catalogue uses the last saved index, else only the
bundled styles, and says so (`catalogueMessage`). Search and ranking are pure
(`searchCslCatalog` in `packages/scient-citations/src/catalog.ts`): an exact
name first, then bundled styles, then names starting with the query, with
independent styles before dependent ones.

The twenty bundled styles and the `en-GB` locale are byte-for-byte copies from
pinned commits of the CSL styles and locales repositories
(`packages/scient-citations/src/bundledStyles.json` and `bundledLocales.json`,
written by `pnpm run styles:bundle` in that package). They are CC BY-SA 3.0;
the attribution the repositories ask for is `packages/scient-citations/CSL-NOTICE`,
listed in `third-party-licenses.config.json`. The styles load only on the
server (`@scientfactory/scient-citations/catalog`); the web receives the one
style it renders from the `citationStyles` endpoint. `pnpm run
styles:live-check` in that package is the opt-in live check against the real
catalogue; no test touches the network.

HTTP: `scientSources.citationStyles` (read; the project's style and search
results) and `scientSources.citationStyleSet` (Library write; a failed download
or unknown ID comes back as `error` beside the unchanged style). Agents:
`scient_sources_list` with `citationStyles` searches, and
`scient_sources_bibliography` with `citationStyle` sets or clears (null) the
style and always reports it. The web keeps the copied-reference choice it used
before (`scient:sources:reference-style:<projectId>:v1`) only for projects
without a style.

## Annotations

Highlights and notes on project PDFs live in `.scient/annotations/v1/`, one
`<sha256>.json` per PDF, owned by `apps/server/src/scient/annotations/`
(`annotationStore.ts` for the file and its pure command logic,
`ScientAnnotations.ts` for the service the HTTP routes and the
`scient_annotations_*` tools share). Keying by the PDF's bytes means a Source
attachment and the same file elsewhere in the project share annotations, and a
changed file starts clean rather than showing marks on the wrong text. The file
records the project paths where the PDF was annotated as hints only; a file
whose hints are not portable project-relative paths, or whose recorded hash or
size differs from its name or the PDF, is treated as unreadable. The store
checks every folder from the canonical project root down and refuses
symlinked ones (`assertScientProjectDirectory` in
`packages/scient-sources/src/projectFiles.ts`, shared with the full-text store).

An annotation stores the reader's `PdfTarget` text selector and extractor, not
its document identity, so stored records hold no absolute paths. It needs a
highlight or a note. Every change names the revision it was made on; a stale
change returns the current record. Removal is a tombstone that restore undoes,
and the last ten revisions of each annotation are kept so `revert` can bring
an earlier note back as a new revision. Each record credits `createdBy` and
`updatedBy` (`user` or `agent`). A file that does not decode is never written
over and is reported, not hidden, in listings. Writes are serialized per PDF
inside the server process, like the Sources store. On the library backend,
highlights on library PDFs live in the library (see "Highlights, the two notes
and reading status").

The reader paints annotations per rendered page with the CSS Custom Highlight
API. The quote is searched on its page with its stored context, then alone, and
shown only when it occurs once; stored offsets alone never decide between
repeats. A create names the PDF path and is refused
(`material-changed`) when the file's bytes are no longer the ones the reader
loaded. An agent's quote is anchored server-side against the Sources full text
when it is complete, otherwise against a fresh pdf.js extraction in the same
text-layer profile, after folding case, whitespace, compatibility characters
and line-end hyphens; repeats are reported as ambiguous with their pages.

"Quote in my document" inserts into the Markdown or LaTeX editor of the same
project that was focused last in the window, using the PDF's Source citation
key (`[@key, p. N]`, `\cite[p.~N]{key}`), and copies Markdown when no editor
can take it. Page numbers are PDF page indices, not printed page labels. A
passage that crosses a page break keeps a line break there, so words stay apart
and a word split by a hyphen rejoins. The passage is inserted as literal text:
the Markdown serializer escapes `$`, and the copied Markdown is written by the
same serializer, so math or `[@…]` in the PDF text never becomes syntax.

## Reference check

`apps/server/src/scient/references/` checks a document or the Library against
the shared identifier resolver; the MCP tools (`scient_references_check`,
`scient_references_resolve`) and the `scientReferences` HTTP group call the
same two functions.

- Parsing is pure and lives in `packages/scient-sources`:
  `referenceDocuments.ts` reads citations, named bibliography files, bibitems,
  typed numbered lists and identifiers; `bibtex.ts` is the positional BibTeX
  reader the LaTeX editor also uses.
- A document check reads the file, the `.bib` or CSL-JSON files it names
  (relative to it, through the project-file guard in `projectFiles.ts`, which
  refuses paths in or linked into `.scient`), and the Library records whose
  `citationKey` matches an otherwise unlisted citation.
- Identifiers go to `resolveSourceIdentifierBatch` in batches; lookups not
  started within 90 seconds count as unavailable and the report says it is
  incomplete. Retractions and corrections come from Crossref `updated-by`,
  published versions from Crossref `relation` or an arXiv record's DOI, both
  carried on `ResolvedSourceMetadata`.
- `referenceComparison.ts` holds the comparisons (different work, registry
  status, field differences). A single-source check before citing reuses them.
- A finding's `fix` is self-contained: a `.bib` fix names its entry by key,
  carries the field's current text and is refused as stale when the file no
  longer has it; inserted fields keep the file's line endings. An entry whose
  key repeats in the file gets no fix, and a fix for such a key is refused, since
  no stable name tells the entries apart. A Library fix carries the expected revision and goes through
  `updateScientSource`, credited to the actor; fixes from one check to the same
  source are applied together as one revision. Fixes exist only for registry
  values; identifiers, retractions and published versions are left to the
  author.
- Ignored findings are kept in `.scient/reference-check/ignored.json`, outside
  the Sources store; a linked `.scient` or `reference-check` folder is never
  read or written through. A finding ID hashes the checked file, the reference, the
  kind and the registry value, so a changed record is reported again.

## Collections, saved searches and bulk edit

`packages/scient-sources/src/collections.ts` owns
`.scient/sources/collections.json`; `organize.ts` holds its schemas and the
one filter model (text, tags, collection, type, PDF, study design, topic) that the panel list,
saved searches and `scient_sources_list` all compile through
`compileScientSourceFilter`, so a search means the same thing to a person and
an agent.

- Collections are stored apart from records and never rewrite them. Members
  are source IDs; a removed source keeps its membership and is only hidden, so
  restoring it from the trash restores its collections too. Reads project
  members onto the sources that exist.
- A collection may have a `parentCollectionId`, one level only: a parent has
  no parent, and a collection with subcollections cannot become one
  (`too-deep`). Names are unique among siblings without regard to case.
  Creating a name that exists under the same parent returns that collection
  and adds the given sources, so a repeated agent request is harmless.
  Filtering by a collection includes its subcollections' members. A
  subcollection of a deleted parent is shown at the top level, and rejoins it
  when the parent is restored; nothing is rewritten. Deleting a collection or saved search marks it
  deleted (the latest 50 are kept) so it can be restored.
- Every change goes through `organizeScientSources` (one action union shared by
  the `organize` HTTP endpoint and `scient_sources_organize`) under one write
  lock, credited with `updatedBy`.
- A collections file that cannot be decoded is reported as an `issue` on the
  overview and hides collections, but never breaks the source list; writes
  refuse instead of overwriting it.
- `bulkUpdateScientSources` applies tag (case-insensitive, existing spelling
  kept) and type changes as ordinary metadata revisions, one per source with
  one retry on a stale revision, then membership changes. Each source is
  reported; one failure does not stop the rest. The revisions go through
  `updateScientSourcesMetadata`: one lock and one scan of the store for the
  batch, duplicates looked up by identifier and title key
  (`sourceMetadataMatchIndex`), each source with the outcome
  `updateScientSourceMetadata` would give it alone. Bulk removal is the trash
  removal per source, with one Undo for the batch in the panel.
- A bulk edit keeps a receipt in
  `.scient/sources/bulk-edits/<batch-id>.json` (latest 250 kept): each updated
  source's type, custom type and tags before and after with the revision it
  replaced, and each collection's exact added and removed members with the
  `updatedAt` it wrote. The receipt is published before anything changes, so
  an unsafe or unwritable folder stops the edit first. Every source revision
  is then written ahead as a `pending` entry in one receipt write (a
  collection's inside its write lock) and all are refused if that fails; once
  made, the entries are finished in one more write. If finishing fails, the
  entries stay pending, the first changed source carries the message, the
  collection changes are not made and are reported as failed, and the result
  still carries Undo. A receipt with nothing in it is removed.
- The result's `undo.batchId` passed back as `{ undoBatchId }` (HTTP and
  `scient_sources_bulk_update`) reverses it, credited to the actor: a type is
  restored only while it still has the bulk value, tags and memberships are
  reversed as the recorded additions and removals (restoring the original
  order when the tags are untouched), and anything left as it is comes back in
  `conflicts`. A pending entry is checked first: still at the recorded
  revision (or an older `updatedAt`) means it never landed and is skipped;
  changed to something else is a conflict. Each restore is written ahead as
  `restoring` with the revision it replaces (the `updatedAt` it writes), the
  sources' restores together in one receipt write; on a retry, a source past
  that revision with the restored values (a collection at that `updatedAt`) is
  done, anything newer is a conflict and kept. Each entry gets `undoneAt` when
  done, the sources' in one write; failed entries stay open, so the same batch
  can be undone again and only what is left is tried. If a receipt write fails
  during Undo, the rest is reported as failed. The receipt itself is marked undone
  when no entry is left.
- `{ themes: [{ name, parent?, sourceIds }] }` is the same bulk edit for
  sorting sources into collections: each named collection (and its parent, at
  the top level) is found by name or created, then filled. A collection it
  creates is written ahead as a `created` receipt entry; Undo, working newest
  first, empties it and then deletes it, or keeps it and reports a conflict
  when sources or subcollections were added since.

## Study design and topics

`apps/server/src/scient/sources/SourceCategories.ts` looks them up and
`packages/scient-sources/src/categoriesStore.ts` keeps them in
`.scient/sources/categories.json`, keyed by source ID and apart from records,
so a lookup never makes a revision, a bulk-edit conflict or a history entry.
Each entry records the identifiers it was looked up by (`basis`); once a
source's DOI, PMID, arXiv ID or OpenAlex ID changes, the entry no longer
applies and the source is looked up again. A damaged file is treated as empty
and replaced, since it is derived data.

- Study design: PubMed efetch XML for the source's PMID, or for the PMID that
  esearch (`"<doi>"[aid]`, 20 DOIs per request) finds for its DOI, matched back
  by the article's own `ArticleIdList` DOI (never a reference's). Publication
  types decide first (meta-analysis, systematic review, randomized trial, case
  report, review), then the design MeSH headings (case-control, then cohort,
  prospective, retrospective or longitudinal studies), else `other`. The raw
  publication types and design headings are kept. Requests share the NCBI
  lane.
- Topics: arXiv's primary and cross-list categories, read from the same feed
  the resolver already fetched when a source is added by arXiv ID (seeded in
  memory, so no extra call), else one id_list request per 50; and the top
  three OpenAlex topics with scores from one `works?filter=doi:…|…` request
  per 50 sources (PMID or OpenAlex ID when there is no DOI), with the contact
  email as `mailto` through `metadataHttp`.
- A background pass (`scheduleSourceCategorization`, one per project at a
  time) runs when the overview is read, after an add, and after a metadata
  refresh, which forgets the source's entry first. It saves each chunk of 50,
  so a pass that stops resumes where it left off. A registry that cannot be
  reached sets `retryAfter` (6 hours) on what it left unanswered; what was
  answered is kept. Passes run only on a server built with the registry
  contact layer, so tests make no requests. They use no Accounts keys.
- Clients get a `categories` summary (study design, topic names) on each
  overview record; agents get the same on `scient_sources_list`, the full
  entry on `scient_sources_get`, and counts (with how many are still being
  looked up) on `scient_sources_collections`.

## Systematic reviews

`packages/scient-sources/src/systematicReview.ts` holds the review schema, the
action union shared by the `systematicReviewChange` HTTP endpoint and
`scient_sources_systematic_review_update`, and pure functions for the PRISMA
2020 counts, possible duplicate pairs and the Mermaid diagram;
`systematicReviewStore.ts` reads and writes one file per review under one write
lock.

- Review records are Library source IDs: each logged search's `sourceIds`
  plus `otherSourceIds`. Nothing is copied out of the Library, and a review
  never changes a record.
- Counts follow from the file, never from stored totals. Identified records
  are each search's reported `resultCount` (or its records when none was
  given). Overlap between searches, which the Library has already merged on
  import, plus records marked as duplicates are "duplicates removed"; results
  never brought in and records no longer in the Library are "removed for other
  reasons". Identified minus removed always equals the records reaching
  screening; `screened` counts only settled include or exclude decisions, and
  maybe or undecided records are reported as pending.
- Retrieval is its own append-only log (`retrieval`, optional so older files
  decode): every report included at title and abstract is sought, and its
  outcome is the latest `record-retrieval` entry (`sought`, `not-retrieved`,
  `retrieved`). Without one, a full-text decision means retrieved, except a
  full-text exclusion with the reason "Full text not available" (the older
  default), which means not retrieved; no decision means retrieval pending.
  The store keeps the two logs consistent: a full-text decision on a report
  recorded as sought or not retrieved also records it as retrieved, and
  recording sought or not retrieved reopens its full-text decision. Reports
  assessed, excluded and included count only retrieved reports.
- Screening is an append-only log; the latest entry per source and stage is
  the decision in force, so changes stay auditable; `clear-decision` appends a
  `cleared` entry that reopens the record without erasing its history. Full-text decisions apply only to records included at
  title and abstract. Every entry records `decidedBy`.
- Repeats are harmless for agents: creating a title in use returns that
  review, and logging the same database, query and date replaces that search.
- Possible duplicates are pairs with the same normalized title (12 characters
  or more), ordered by when each entered the review; decided pairs are left
  out. A review file that cannot be decoded, or whose `reviewId` differs from
  its file name, is reported in the list's `issues`, not fatal; reading or
  changing it by ID fails instead. Writes go to the file that was read and
  validated, never to an ID taken from its contents, and a new review is
  created exclusively. Every directory from the project root to `reviews/` is
  checked for symlinks before any read or write (`assertScientProjectDirectory`).
  Deleting is a soft delete that `restore-review` undoes.
- The built-in `systematic-review` skill tells agents how to use these tools
  and that agent screening is not independent dual screening.

## Reference files

`packages/scient-sources/src/bibliography/` reads and writes BibTeX/BibLaTeX,
RIS, CSL-JSON and EndNote XML as pure functions with no new dependency (a
small XML reader handles EndNote). Every parser yields format-neutral entries
that keep the citation key (normalized by `citationKeys.ts`), the project note
and, per entry, the source fields that have no Scient field (`notKept`).
Entries that cannot be parsed are skipped with their line, so one damaged
entry does not lose the file. `planBibliographyImport` turns a parse into
candidates: it drops empty entries, repeats within the file (same content or
same work-level identifier) and entries already in the Library, and only then
takes the first `SCIENT_SOURCE_IMPORT_ITEM_LIMIT` new ones. An entry counts as
already imported when a record has the source ID the store derives from its
deterministic source key (`scientSourceIdFor`), whatever its metadata, and the
store reports such a repeat as a `same-origin` duplicate. Importing the same
file again therefore continues a large file instead of re-processing the first
batch. The BibTeX reader bounds `@string` expansion (256 Ki characters per
value, 16 Mi per file) and reports entries past it as unreadable; LaTeX
decoding and XML traversal do not recurse on plain nesting. Field provenance is `file` with `sourceField` `<format>:<field>`.

The server adapter (`BibliographyFileAdapter.ts`) bounds a file to 32 MB,
falls back to Windows-1252 when a file is not valid UTF-8, stages the batch as
one JSON file under `.scient/sources/staging/files/<operationId>.json` with its
report, and starts an ordinary durable operation (`adapter`/`intake` `file`).
Advancing reads candidates from that stage; the stage is removed when the
operation settles without failures or is cancelled, and kept for retry while
failed items remain. File imports record verification `unchecked` with their
DOI or PMID, or `unverified` without one: the identifiers are the file's, not
the registry's. Agents import a project-relative file with
`scient_sources_import_file`, which runs the same operation to completion;
files inside `.scient/sources` are refused. Adapter error messages are written
for people, while filesystem errors (which can carry host paths) are replaced
before they reach a model.

Linked files (BibTeX `file` in JabRef, Zotero and Mendeley syntax, RIS
`L1`/`L4`, EndNote `pdf-urls` including `internal-pdf://` under the library's
`.Data/PDF` folder, and `file:` URLs) are resolved when the batch is staged.
A PDF is attached only when its real path is inside the project (outside
`.scient`) or inside the reference file's folder; relative paths start from
that folder, else the project. Agents pass the project file's folder; the
upload route uses `sourcePath` only when the client is on the server's computer
and the named file holds exactly the uploaded bytes, so a client cannot name an
arbitrary folder. A filesystem root is never used as the folder. Up to
`SCIENT_SOURCE_LINKED_PDF_LIMIT` real paths per entry are staged; advancing
uses a path only if it still resolves to itself, passes the first through the
ordinary PDF intake (hash, validation, PDF duplicate check) and attaches the
rest with `attachScientSourcePdf`. Every other link is reported in `notKept`
under its field with a `reason`; the report's `linkedPdfCount` and the agent
result's `pdfsAttached` count what was attached.

Export (`exportBibliography`) writes the Library or a selection under each
record's citation key; a record without one gets a free key from the same
rules for that file only. Project notes are excluded unless requested.
`exportBibliographyFile` reads the written file back and returns `notKept`:
identifiers or the source type the format could not carry. arXiv IDs go to RIS
`AN` and EndNote `accession-num` as `arXiv:<id>`, PMCIDs to RIS `C2` and
EndNote `custom2`, and preprints to `M3`/`work-type` `Preprint`.
`scient_sources_export` writes a project file atomically and replaces an
existing file only with `overwrite`. It refuses paths outside the project,
`.scient/` and the managed `references.bib`/`references.json`, checked on the
requested path and again on the destination after resolving its folder's
symlinks, ignoring case on macOS and Windows.

## Zotero boundary

One reader (`ZoteroLibraryReader.ts`) works over two transports. The local
transport (`ZoteroLocalAdapter.ts`) uses Zotero's read-only local API v3 at the
fixed loopback endpoint `127.0.0.1:23119`, plus Better BibTeX's local JSON-RPC
`item.citationkey` for keys an item does not carry itself. The web transport
(`ZoteroWebAdapter.ts`) reads and writes the key owner's personal library, or a
group library, at `api.zotero.org`. Neither scans Zotero's database or accepts arbitrary hosts.
Responses are time- and size-bounded and decoded through explicit schemas;
mapping lives in `ZoteroItems.ts`.

The zotero.org key comes from Accounts (`ZoteroAccountKey.ts`): the newest
API-key account whose site is zotero.org or whose variable is `ZOTERO_API_KEY`.
Off always stops its use. For agents, the global agent switch and the account's
project scope apply and Ask counts as allowed, as for connector bindings: the
saved key is the user's approval. Each use is recorded in Accounts activity
without the value. The key is read on the server, sent only to
`api.zotero.org` (file redirects drop it), and never appears in tool output.
Key checks (`/keys/current`) are cached for five minutes by key digest; writes
check again.

Without a requested connection, the status check prefers Zotero on this
computer and falls back to zotero.org when a key works; the chosen connection
travels with browse, preflight and import requests, and a zotero.org import is
recorded with the `zotero-web` operation adapter so resumed steps read the same
library. Local item keys and zotero.org keys name the same items in the user's
personal library (local library ID `0` and the zotero.org user ID are the same
library).

### Group libraries

Groups are listed from `/api/users/0/groups` locally (Zotero answers
`{ data: [...] }` with the groups it syncs) and from `/users/<id>/groups` on
zotero.org, keeping those the key's `access.groups` (`all` or the group ID)
lets it read. A group reads from `/api/groups/<groupId>` or `/groups/<groupId>`;
the local API takes the zotero.org group ID and resolves Zotero's internal
library ID itself. The status endpoint carries `groups` when ready, and browse,
collections, preflight and both import requests take an optional `groupId`; the
import operation stores it (`zoteroGroupId`) so resumed steps read the same
group. A group item is linked with `libraryId` `groups/<groupId>` (My Library
keeps the bare user ID) and gets source key `zotero-group-<groupId>-<itemKey>`,
so a group item and a My Library item with the same key are two records and
same-origin duplicate checks compare library and key. Refresh opens one
transport per library found in the sources' links. Better BibTeX names group
items `<libraryID>:<itemKey>` with Zotero's internal library ID, which the local
API never shows; it is taken from `user.groups` when exactly one library there
has the group's name, otherwise group citation keys come only from the item.
Group files on zotero.org follow the key's group read access (keys have no
separate group file switch).

Connection states distinguish ready, access disabled (or a refused key),
incompatible API, malformed response, and unreachable. The local API alone
cannot honestly prove whether an unreachable Zotero installation is absent or
merely not running, so the product does not invent that distinction.

Library pagination advances by the number of raw Zotero items received, even
when notes, annotations and attachments are filtered from the Scient view.
Import re-fetches each selected item with all its children immediately before
storing it. Child notes (HTML) become the source note as plain text with
Markdown bold and italic; every stored or linked PDF is copied (the first with
the record, the rest attached), and a PDF Zotero cannot provide is skipped
rather than failing the item. zotero.org PDFs are streamed to a temporary file
that is removed after import. Identifiers Zotero keeps in Extra (PMID, PMCID,
arXiv, DOI for types without a DOI field) and the citation key (Zotero's field,
then Better BibTeX's `Citation Key:` line, then Better BibTeX's JSON-RPC) are
read; S2's key rules keep it.

Zotero collections are intake scopes when browsing. After an item is imported
it joins a Library collection (`collections.json`) named after each Zotero
collection it belongs to. One level of Zotero's nesting is kept as a
subcollection; a deeper collection's items join its ancestor at that level,
and the item's `note` in the operation (and the agent import result) names
each one flattened. A collection problem never fails the import. Scope discovery is capped at 500 importable references
per operation and fails with a request to choose a smaller scope above that
bound. Collection and whole-library actions skip the separate preflight
screen; each item is still validated, duplicate-assessed and committed by the
normal importer, and exact or possible matches are skipped. A zotero.org
preflight does not hash PDFs (that would download every file); identifier,
origin and metadata duplicate checks still run.

### Refresh and Send to Zotero

`ZoteroSync.ts` keeps, per source, what Zotero held at the last import,
refresh or send in `.scient/sources/sync/zotero/<sourceId>.json`, apart from
the record. Refresh (`ZoteroRefreshPlan.ts`) is a three-way merge against it:
a field Zotero changed is taken unless it was edited here (field provenance
`user` or `agent`), in which case the value here is kept and reported as a
conflict. A conflict keeps its old merge base, so it is reported again until
the user takes Zotero's value (`useZotero`) or keeps theirs (`keepLocal`).
Empty Zotero values never clear a field; tags merge as additions and removals;
notes follow the same rule as fields; new PDFs (by attachment key) are
attached; the record's Zotero item version is updated; an item gone from Zotero
is reported and left alone. Without a sync file (sources imported before this
existed), every difference counts as a Zotero change. The citation key is never
changed by a refresh.

Send to Zotero (`ZoteroWrite.ts`) is one way and needs the zotero.org key with
write access. A source without a Zotero item is created with a write token
derived from its project, ID and revision (a retry creates nothing new), with
the source note as a child note, and the source is linked to the new item. A
linked source is patched with only the fields that differ, using the item's
own field set and `If-Unmodified-Since-Version`; if the item changed in Zotero
since Scient last read it, nothing is sent and the user is asked to refresh.
Empty values here are never sent. Extra keeps its unmanaged lines and carries
the citation key and identifiers without a Zotero field. PDFs are not uploaded.
Without a `groupId` sends go to My Library. With one, the key is checked again
and the group must be writable: the key's group `write` and the group's
`libraryEditing` (`members`, or `admins` with the user as owner or admin);
otherwise the send is refused before any write. A source linked to a different
library than the target is created anew there and relinked; Zotero's own items
are never moved.

Agent tools `scient_sources_zotero_browse`, `_import`, `_refresh` and `_send`
give agents the same power (browse returns `groups`; browse, import and send
take `library`, a group ID, defaulting to My Library); their messages pass through only Zotero's own
explanations, never local paths.

## Operations and recovery

An import operation records its adapter and a bounded selection of unique
adapter source keys. Zotero uses its library/item identity; direct PDFs use an
immutable upload identity and retain their content hash separately. The
coordinator advances one pending item at a time. Each record/PDF unit is
durable before its operation item is marked imported. Replaying an operation or
item is safe because exact origins and content are assessed again. Within one
operation, the store reuses a record snapshot only while the records directory
fingerprint remains unchanged. Another source import, edit, or removal
invalidates that snapshot before the next item, avoiding repeated full-ledger
scans without making an in-memory cache authoritative.
Coordinator lane keys and store paths both use the canonical project root, so
filesystem aliases cannot create parallel lanes for the same operation.

The UI may stop after the current item. Completed work remains in the project;
pending items remain explicitly unprocessed in the cancellation receipt. An
operation left running with no pending items is finalized during the next
overview inspection. Recovery finalization re-reads and settles the operation
under the same operation lock used by progress updates and cancellation.
Long-running operations use a compact progress surface while leaving the
project ledger visible and usable.

The web continuation driver is independent of the mounted Sources panel. Once
an operation begins, navigating away only detaches presentation updates; the
same durable server operation continues to advance. A renderer-level registry
deduplicates continuation attempts when Sources is reopened while that work is
still active. If the renderer, app, or connection stops, no state is invented:
the persisted running operation is shown on the next overview and can be
resumed from its next pending item.

Only one import operation may be running for a project in an environment
server. Concurrent begin requests are serialized, same-ID replay remains
idempotent, and a new operation is accepted after completion or cancellation.
The current store assumes the normal application ownership model of one
environment server writing a project at a time. The filesystem remains durable,
and the normal single-server write paths invalidate cached snapshots. True
multi-process writers would require an explicit cross-process locking protocol
rather than a larger in-process map.

## Full text

Full text is derived data keyed by PDF `sha256`, never part of a record, so
several sources sharing one PDF share one text file and no record revision
changes when text is extracted. `packages/scient-sources` owns the stored
shape and pure search (`/full-text`) and its filesystem store
(`/full-text-store`); the server owns extraction (`SourceFullText.ts`).

- Each page is stored in the reader's text profile
  (`PDF_TEXT_PROFILE`: raw pdf.js item strings, a newline after `hasEOL`
  items) with its view box, rotation and user unit, so stored offsets and
  reader quotes describe the same text. A test pins the two profile names
  together.
- A background pass starts when the Library loads or a full-text tool runs. It
  parses one PDF at a time across all projects and yields between pages, since
  pdf.js shares the server's event loop. Library-wide search never waits for it
  and reports `pending`; reading one source's text or checking a quote against
  one source extracts that PDF on demand through the same lane.
- An unreadable PDF is recorded as `failed` and retried only after the pdf.js
  version changes. A text file that does not decode is treated as missing and
  extracted again. Text whose PDF file is gone from `files/` is pruned; text of
  a trashed source stays while its PDF does.
- Writes are atomic and every directory below the project root is checked one
  segment at a time, so a symlinked `text/` folder cannot redirect them.
- Extraction reads the PDF through `readScientSourceAttachmentPdf` (store):
  the canonical path must be the attachment's own path inside the project (no
  symlinked file or folder), and the bytes are read once and must have the
  attachment's size and `sha256` before pdf.js sees them. Any other PDF
  (annotations of a project file) goes through `readScientSourcePdfBytes`
  with its expected hash.

Reading one source's text (`scient_sources_read_text`) returns whole pages from
`fromPage` up to `maxCharacters` (default 12,000, at most 30,000) and the
`nextPage` to continue from. A page is never cut: one longer than the budget
comes back whole and alone. The sizes keep one result small enough for the
providers to pass inline instead of saving it to a file; none of the providers'
inline limits is stated in this repository or `.repos/`, so these are the
planned defaults rather than measured values. The tool is strict: an unknown
parameter (`page`, `pages`, `offset`) is refused with the accepted names, because
Effect's MCP server otherwise drops unknown keys and the agent reads page 1.

Search is a pure-JS scan of cached, folded page text rather than SQLite FTS5:
the text is project data in project files, while the server's SQLite holds app
state, and a second persistent index could drift from the files. Folding
lowercases, strips accents and punctuation and joins line-end hyphenation.
Terms score by rarity across PDFs and repetition inside a 360-character window,
quoted phrases are required, and terms of four or more characters also match as
prefixes. The cache is keyed by hash, since stored text never changes for a
hash, and bounded by entries and by cost: characters plus a fixed charge per
page and per entry. Text with no characters (a scan) is cached without pages.
A Library filter is sent as `sourceIds` and applied before ranking and the
result limit.

Quote checking matches verbatim first, then after folding spacing, ligatures,
quote marks, dashes, and line-end and intra-word hyphens on both sides. A
quote may span consecutive pages that have text; an empty page (unread, cut by
the size limit or blank) or a gap in page numbers ends the run, so text on
either side is never joined. Pages are joined by a line break that is not
stored, so a match across pages is `normalized`, never `exact`. It returns the
stored text with its page offsets and context, and calls a repeated quote
ambiguous instead of choosing one.
OpenAlex full text is not used: its content downloads need a key and are paid
per file.

### Answering from the Library

The Library awareness block (`buildScientLibraryAwareness` in
`apps/server/src/provider/ScientAwareness.ts`, sent with `sources:read` in a
verified project) carries four standing rules for literature questions: answer
from the papers' full text (`scient_sources_search`,
`scient_sources_read_text`), not memory; give the paper and page for each
claim; check quotes with `scient_sources_quote_check`; say when the Library
does not answer, and say when the web was then used. They are the rules the N7
evaluation measured (`reviews/sources-roadmap-20261110/ask-my-library` in the
workspace): with them, 19 of 19 paper questions got a correct page per claim
against 4 of 19 without, and the quote checker ran in 26 of 30 runs against 0.
Every driver composition builds its text through `buildScientAwareness`, so no
provider carries its own copy. They cost 299 bytes in the canonical tool names
(`scientAwarenessAllCapabilitiesBytes` 4,940 to 5,239), more where the provider
prefixes tool names.

With `skills:read` as well, the block ends by sending reference checks to the
`references` skill by name, as the Overleaf block does for `overleaf-sync`. The
turn's skill scope note carries only a count, and an agent that already has
the Library rules starts on the Library tools without listing skills: in the
support-check pilot the plain request "Check the references in X" loaded the
skill in 0 of 3 runs, and with the sentence in 3 of 3
(`reviews/sources-roadmap-20261110/support-check/followup-1` in the
workspace). It costs 76 bytes (`scientAwarenessAllCapabilitiesBytes` 5,239 to
5,315).

The `references` skill keeps a check-only request out of the project:
`scient_paper_get` saves a PDF and a queue file there, so the skill forbids it
for a check and reports a paper without a Library PDF as not read. It also asks
for every page as "PDF page N" (or "printed page N"). Before this, one of the
three plain check-only runs fetched four papers into the project and no reply
labelled its pages; after it, six runs fetched nothing, the project stayed
unchanged, and the last three labelled every page
(`reviews/sources-roadmap-20261110/support-check/followup-2` in the workspace).
The rule is about fetching, not about writing nothing: reading a Library PDF
whose text is not cached yet still writes that cache, and the runs started with
the caches built. The page is the 1-based position in the file, which is what
`scient_sources_read_text` returns; a viewer set to show a PDF's own page
labels can show a different number.
The skill text lives in both `built-ins/references/SKILL.md` and its embedded
copy in `BuiltInSkillSources.ts`; a test keeps them identical.

The Library menu's **Ask the Library** puts the same rules, as the tested
sentence (`ASK_LIBRARY_PROMPT` in `apps/web/src/scient/sources/askLibrary.ts`),
at the start of the open thread's draft through the composer handle's
`insertTextAtStart`. It never sends, keeps the draft that was there, and does
nothing to a draft that already starts with the sentence. Agents need no
equivalent: for them the rules are standing.

The attachment-preview endpoint returns the attachment's content-addressed
hash and size; the Sources PDF reader carries them as the descriptor's
`material`, so quotes from Library PDFs record proven bytes. A Library search
hit opens through the reader's quote reveal: the panel files the hit, and the
PDF preview turns it into a target with its own document identity once the
authorized preview names the file. Server and web pdf.js versions can differ,
so such targets are found again by their text rather than by offsets.

## Saving browser pages

`SourceWebPage.ts` saves a page through the same identifier-checked add path
as agent adds and downloaded papers (`origin.intake: "web"`). Identifiers come
from Highwire Press, Dublin Core and PRISM tags, then from DOI, PubMed and
arXiv addresses (`packages/scient-sources/src/webPage.ts`). A valid identifier
proves the work exists, not that the page is that work, so the page's
bibliographic title (`citation_title`, `dc.title`; the tab title only when
neither exists) must agree with the registry's title, or, for an identifier
already in the Library, with that source's title. Otherwise, or without any
title, the page is saved as a `web` source with no identifiers. A `web` source
is the same source as another with the same address (only an identifier-less
one when the page stated identifiers). The selection is appended to the note
once, headed by the page's address. On desktop, a fixed script reads the
tab's title, selection and meta tags; the address comes from the tab itself.
A PDF tab is fetched again through the tab's session (two-minute limit); the
response must have a PDF media type and `%PDF-` bytes, and its body is read
within 100 MB and cancelled once over, before it goes to the Library's normal
PDF import.

## Interface and agent parity

Agents can do everything a person can in the Library. The table in
`apps/server/src/mcp/toolkits/sources/libraryParity.ts` gives every Library
change command (`SCIENT_SOURCES_HTTP_COMMANDS`) and every read endpoint of the
`scientSources`, `scientPdf` annotation and `scientReferences` groups the agent
tool that does the same thing, with the tool input that selects it when the
tool does more. The only exemptions are one step of an interactive flow that a
single tool call covers (`flow-step`), a browser upload whose tool takes a
project path instead (`upload`), and an endpoint that serves pixels or files
for display (`display`); each names its tool or reason. "Not built yet" is not
an exemption: such a command is a `gap` with its reason, and
`libraryParity.test.ts` lists each gap as a named test. No gaps are left.

Adding a Library command or read endpoint fails typecheck until the table has
its entry. `libraryParity.test.ts` then checks that each named tool is
registered by a Library toolkit and listed in the `scient.sources` plugin
(`BuiltInPlugins.ts`), that a tool named for a change command requires
`sources:write`, and that a named input is in the tool's input schema. Add the
tool, or the input on an existing tool, in the same change as the button.

## Deliberate exclusions

This slice does not implement two-way Zotero sync, Zotero group libraries,
uploading PDFs to Zotero, attaching PDFs named in a reference file's `file`
field, source merging, automatic possible-duplicate merging, multi-source
bibliographies, per-document style pickers, LaTeX bibliography styles, evidence claims, OCR of
scanned PDFs, fuzzy metadata search, mobile UI, or a separate Studio route.
Later source systems should add adapters into the same domain and store rather
than add provider-shaped fields to the host application.

## Verification boundary

Package regressions cover schema diagnostics, duplicate strength, project
identity, idempotency, PDF integrity, cross-platform path safety, resumable
progress, and cancellation receipts. Adapter regressions cover normalized
metadata, abstract markup removal, and field provenance, including a JSON
round-trip through the public Zotero library response contract. Coordinator
coverage proves legacy abstract normalization and attachment
preview resolution without a persisted chat thread. Right-panel and General
Chat policy tests cover the only inherited UI-state seam. Citation regressions
prove the canonical CSL mapping and exact Vancouver and APA 7 output for a
journal article, and a dependent style rendering through its parent. Visual and interactive acceptance remains a manual user gate
in an isolated Scient (Dev) candidate.
