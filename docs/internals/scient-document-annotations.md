# Document annotations — Phase 2A local candidate

Status: implementation and automated qualification candidate, not release or
visual acceptance. The Sources/evidence plan and Proposed ADR-0009/0010 in the
separate Scient repository retain architecture and product decision ownership.
This document owns the concrete desktop implementation, not another roadmap.

## One domain, several reading contexts

`packages/scient-annotations` owns schemas and persistence. It depends on project
identity and Effect schemas, not React, Electron, Sources, providers or T3.
Sources imports its canonical PDF text-capture contract, never the reverse.
The Scient-owned server coordinator supplies Source/file/resource adapters and
the web annotation component supplies one compact reader interaction.

An annotation has its own ID, revision, project owner, Region ID, resource ID,
exact material revision and native geometry. The current body is explicitly
`plain-text`; emphasis is independent. A live record requires a note or emphasis.
Raw selected text and attributed corrected text are separate. A saved selection
is not a verified scientific claim. Imported legacy actor labels are recorded as
unknown historical identity, never upgraded to authenticated human review.

Only project ownership is implemented now. Personal/library ownership, explicit
contribution and later formats extend this boundary after their own review; no
fake project, library account, Source registration or provider is needed to
annotate an ordinary project PDF.

## Activation and publication

The host requires `SCIENT_ANNOTATIONS_PREVIEW_ROOT` to match the exact canonical
project root. Unset or a different root means disabled. Use a disposable copy,
never the live research project. Opening is read-only. Preparing the first write
performs explicit migration and resource registration. This opt-in is temporary
qualification machinery, not the future settings/permission product.

HTTP uses existing environment authentication and read/operate scopes. The host
derives principal and session generation. The returned binding includes the
actual canonical root identity (filesystem identity plus project identity) and
generation fingerprints; mutation must present the same binding. Root swaps,
sibling worktrees, replaced sessions and revoked sessions are not interchangeable.
The session store orders short publication operations with local revocation and
session replacement; long PDF reads occur outside that critical section.

Each create/edit/remove/restore carries an operation ID. Edits use expected
revision; retries return the original durable result only for identical command
and authority. CAS conflicts return the current record, never overwrite it.
The persisted operation records the authenticated principal and generation
fingerprint, not credentials. These are annotation operation receipts, not
acceptance of the broader Scient-agent capability architecture.

## Layout and recovery

```text
.scient/evidence/v1/
  resources/<locator-hash>.json             resource identities and explicit aliases
  materials/<sha256>.pdf                    independently retained exact revisions
  annotations/<annotation-id>/<revision>.json  immutable record + command + receipt
  imports/legacy-v1/<annotation-id>.json     imported baseline commits
  imports/legacy-v1/sources/*.json           original Source records and history
```

Publication stages, flushes and exclusively links a complete revision file;
independent processes race on that same immutable revision name. No overwritten
head pointer or separately committed receipt can disagree with the visible
record. Reads validate schema, revision chain, immutable Region and owner.
Whole-project legacy import publishes a staged directory atomically. Inconsistent
imports fail closed. Original Source snapshots are retained verbatim; latest
Source metadata is simplified only after the complete import is readable.
Experimental format-1 rows with embedded passages have an explicit migration
decoder, not silent normal reads.

PDF bytes are independently copied before a durable annotation can refer to
them. Equal material revisions deduplicate within the project retention owner;
equal bytes never merge resource or annotation identities. Old Source cleanup
does not know or own these copies. The actual older Source implementation has
been exercised deleting the original Source and attachment after migration;
the new annotation and retained PDF survived.

`aliasResource` is an explicit same-owner handoff for an exact annotated revision
at a new path. It preserves Region/annotation IDs and refuses to merge an existing
different resource. Its storage-level move/registration proofs pass. **Automatic
file-move tracking and wiring every Source intake path to this handoff are not
implemented**; do not claim those workflows are qualified.

Removal publishes a tombstone; Undo publishes a restore revision. Neither is
secure erasure or storage reclamation. Retained bytes, legacy backups and history
are intentionally not garbage-collected by this candidate.

## Reader behavior

Select text for Highlight, Note, Copy, Cite and (where a composer exists) Add to
chat. Copy copies only text. Cite adds a short attribution/link and page number,
not a full manuscript bibliography. Neither saves an annotation. Add to chat
inserts a visible draft and never sends it. Note opens a two-row editor without
repeating the quotation; it does not force a highlight. Autosave serializes
typing after 900 ms and flushes on leaving. Cancel discards only unacknowledged
text. The opt-in annotation list uses page-ordered rows, with Remove and Undo.

Drafts are schema-checked recovery copies scoped to environment, root, target,
binding and editor. Uncertain saves retain the exact command. A conflicting
draft stays visible while the canonical version refreshes. Recovery clears its
original journal only if that snapshot has not changed elsewhere.
Hard app termination, browser-profile loss and independent-window recovery
arbitration still need qualification; local storage is not canonical truth.

Native PDF geometry also supports a selected area without text extraction or
OCR. Mouse drag or keyboard arrows/Shift-resize and Enter capture it; Escape,
scroll, zoom and rotation cancel an unfinished area. No quotation is invented.
Notes/highlights paint only on matching material. Open annotated version resolves
the retained resource through the host and reuses the normal PDF asset resolver,
reader and Save Copy path. Return to current PDF is explicit.

## Bounds, storage budget and proof

Current bounds: 100 MiB per PDF; four consecutive pages, 256 rectangles and
8,000 raw UTF-16 selected units; 8,000 note characters; bounded record reads and
10,000-entry collection/history read guards. These are safety guards, not a
promise that a 10,000-document interactive library is fast. Full immutable
record snapshots currently repeat capture metadata with each revision. The host
allows at most two complete material operations concurrently and queues at most
64 others; overflow asks the caller to retry. This bounds buffering across
requests, not just the size of each individual PDF.

The measured synthetic stress fixture creates 200 annotations with four
revisions each and one retained PDF. Its automated ceilings are 50 s total and
10 s for the final read; ordinary local runs completed the store suite in about
9–11 s. This is backend qualification, not long-PDF visual performance.
`retainedStorage()` reports unique retained revisions and bytes. Plan additional
disk use as one copy of each distinct annotated PDF revision, plus JSON histories
and original Source snapshots—not one PDF per annotation. There is no global
storage quota or reclamation policy yet; inventory guards do not enforce a
transactional project-wide creation quota. Measure a realistic copied corpus
and decide that policy before broad activation.

Focused proofs cover separate-process CAS, lost replies, changed/corrupt bytes,
root/generation mismatch, revocation ordering, metadata-preserving migration,
older-writer deletion, 200-annotation stress, canonical MCP reads, autosave,
conflict/cancel/retry, Undo and geometry-only capture. Run from the desktop root:

```sh
pnpm exec vp test run packages/scient-annotations apps/server/src/scient/annotations apps/web/src/scient/annotations apps/web/src/scient/pdf/passages apps/server/src/auth/SessionStore.test.ts apps/server/src/mcp/toolkits/sources
```

The old-writer test additionally requires `SCIENT_LEGACY_SOURCE_WRITER` pointing
at the trusted older checkout's `packages/scient-sources/src/store.ts`. It runs
that actual module against a fresh synthetic project, never user data. The
checkpoint exercised locally is `6a4294a371`.

## Remaining gates, not claims of completion

The 2026-09-10 nonvisual pass exercised 401 focused regressions, including the
actual older-writer deletion case, then added and passed the stale-replay UI
regression. The repository-wide typecheck, build, formatting, error-level lint
and brand checks passed; existing repository lint warnings remain.
The full test run had one `UND_ERR_SOCKET` failure while the server router test
opened its bootstrap session. That test passed alone, and all 209 tests in its
file passed on rerun. Record this distinction: the original full run was not
green. Automated Electron startup smoke also passed, but no computer use,
screenshots or visual acceptance was performed. The pre-existing review app
remains on its older checkout; this candidate has not been activated in it.

- User visual/keyboard review on representative long, multi-column, rotated,
  scanned and mixed RTL/LTR PDFs. Selection can still be semantically wrong on
  difficult text layers even when offsets match; area capture is the fallback,
  not a claim that all PDFs select correctly.
- Explicit rename/Source-registration handoff integration; robust discovery
  after the last reference and its normal navigation entry disappear.
- Native restart, hard termination and cross-window draft recovery qualification;
  copied-real-project storage measurement and activation/retention review.
- Phase 2B agent proposal/accept/reject and provider delivery. The existing
  bounded read tool remains available; this does not certify new agent writes.
- Phase 2C local library/contribution, later OCR/document formats and release
  migration/rollback approval. These remain planned, not abandoned.

Do not downgrade a migrated live project by deleting `.scient/evidence`.
For a disposable rehearsal, rollback means restoring the complete pre-migration
copy. Keep originals and backups if recovery detects inconsistent data.
