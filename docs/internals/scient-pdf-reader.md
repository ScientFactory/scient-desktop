# Scient PDF reader

## Ownership and boundary

Scient owns the PDF reader under `apps/web/src/scient/pdf`. The inherited Files
panel has one narrow routing seam: `.pdf` files mount the Scient reader instead
of T3's text editor. Every existing file-opening entry point converges on that
panel, so Files-tree, search, chat, and linked-path selection share the same
binary-safe route.

PDFs must never be read through `projects.readFile`. The workspace service keeps
its `WorkspaceBinaryFileError` protection. Instead, the reader requests an exact
file-scoped, short-lived asset capability and PDF.js reads the authorized URL.
PDF capabilities do not grant sibling-file access.

## Runtime

The reader pins `pdfjs-dist` exactly and ships its worker, character maps,
standard fonts, codecs, and annotation images locally. It makes no CDN or hosted
SDK request. Vite's `scientPdfAssets` plugin exposes the same local asset paths in
development and emits them into production builds.

The asset route supports `HEAD` and one HTTP byte range per request, returns
`Accept-Ranges`, `Content-Range`, `Content-Type`, and `nosniff`, and exposes the
range headers to approved remote web origins. Unsatisfiable ranges return 416.
Unsupported multi-range requests safely fall back to a full response. This
changes transport only; it does not weaken path containment or binary-file
protection. Exact PDF capabilities also carry the file revision they authorize;
the server refuses later ranges if that file changes, and the client's normal
capability renewal reloads the document without losing its reading state.

PDF.js `PDFViewer` owns visible-page rendering, text and annotation layers,
internal destinations, bounded canvases, and cleanup. The reader additionally
virtualizes thumbnails, loads outlines lazily, preserves fit modes across panel
resizes, and destroys loading/rendering work on file switches or unmount.
Teardown detaches the viewer, link service, and find controller from their
document before destroying its transport. PDF.js `cleanup()` alone does not
release the viewer's hidden copy helper and document listeners.

The pinned package has a narrow lifecycle patch in
`patches/pdfjs-dist@6.2.108.patch`, registered through `pnpm-workspace.yaml` and
the lockfile. PDF.js replaces its loading capabilities on detach; an old failed
page request must not reject the replacement document's promise. Both viewer
builds now check the captured attachment's abort signal and document identity
before startup, eager-page, metadata, or pages-loaded continuations act.
Optional-content configuration participates in the initial promise group so
its failure is observed before page views consume it. Current failures remain
reported; stale work is ignored by ownership, not by matching error text or
delaying transport destruction. The reader also observes active initialization
failure and presents its normal loading error instead of remaining on a spinner.

Resize and viewport restoration require connected nodes with usable layout.
An initially hidden reader retains its pending restore until width/height
recovery; hidden view events cannot replace its saved reading position. This
also avoids asking PDF.js to scroll a removed reader during React teardown.

The reader uses PDF.js's legacy/compatibility build at the same pinned version
as its worker. This keeps Electron compatibility without changing the parsing or
rendering engine. Search uses PDF.js's indexed text path with a short debounce,
progressive counts, stale-query rejection, and idle prewarming; Scient does not
maintain a second text index.

External outline URLs are accepted only for `http` and `https` and are opened
through Scient's desktop shell. Internal destinations remain inside the reader.

Save Copy is a local-shell operation rather than a renderer navigation. The
desktop host fetches the current authorized asset through Chromium's network
stack, streams it to a sibling temporary file at the user-selected destination,
flushes it, and publishes it with a same-filesystem rename. The renderer never
buffers PDF bytes or sends them over IPC. Expected cancellation, source renewal,
network, and write outcomes return through a producer-neutral typed contract;
temporary files are removed on every non-success path. The browser-only host
retains a Blob download fallback because it has no native filesystem dialog.

## Durable reading state

The reader stores page, PDF scroll coordinates, zoom or fit mode, rotation, and
sidebar mode in the client. Sessions are keyed by artifact authority plus logical
document key, never by a renewable asset URL or generated revision. Consequently,
an authorized-URL renewal or generated-document rebuild preserves the reading
state for the same logical document. A workspace PDF's current logical key also
uses its normalized absolute source path. The authorizing thread remains on the
source descriptor only for exact asset resolution, so the same path in the same
environment shares one reader session across threads while identical paths in
different environments remain isolated. Independent worktrees with different
paths remain distinct until a later fork feature explicitly maps them.

A direct PDF outside a workspace uses the same rule: its environment authority
plus a hash of its normalized canonical path forms the logical key, while the
path itself remains only on the resolvable source descriptor. A file recognized
by PDF signature without a `.pdf` suffix receives a valid `.pdf` download name
without changing its logical identity.

The versioned store retains the 100 most recently used document sessions. Writes
are coalesced and flushed on reader unmount and page teardown. Corrupt entries are
ignored, and unavailable browser storage degrades to in-memory state without
blocking the reader. Search queries, passwords, resolved asset URLs, and PDF
contents are not persisted.

PDF.js can emit transient view-area events while initial rotation and scale are
being applied. The reader ignores those events until the saved destination has
been restored and the following frame has begun, preventing initial page-one
layout from replacing a valid saved viewport.

## Product boundary

Existing PDF annotations and interactive forms render, but PDF.js annotation
editing is disabled. Scient annotation identity, provenance, persistence, and
cross-artifact behavior remain a later product layer. This reader exposes a
stable document/page navigation seam without inventing that data model early.

OCR is likewise out of scope. The reader samples only the opening pages for text
and describes that limited observation rather than declaring the whole document
to be scanned.

## Development passage-capture proof

Development builds offer **More PDF actions → Passage capture proof**. This is
an opt-in maintainer experiment, not saved highlights or a released Sources
capability. The control and lazy-loaded probe are excluded from production JS.
It uses the existing reader for both workspace PDFs and exact Source attachments;
it adds no authority, server operation, provider tool, or project-state namespace.

Select text, choose **Capture selection**, then **Reopen PDF** and **Return to
passage**. Reopen destroys and reconstructs the PDF runtime while preserving one
capture in React memory. Return checks the newly loaded material before marking
the captured character ranges. Closing the proof, unmounting the reader, or
reloading the app discards the capture; **Clear** also removes it. Existing
Source notes and ordinary durable reader viewport state are unchanged.

The implementation lives in `apps/web/src/scient/pdf/passages/`:

- `pdfPassageModel.ts` owns the transient descriptor, bounds, and pure exact-match
  checks. It is **not** a persisted Region schema or an untrusted-input decoder.
- `pdfPassageCapture.ts` snapshots DOM selection offsets and character-range
  rectangles, checks them against raw PDF.js extraction, hashes the actual
  loaded bytes, and paints temporary marks in native PDF coordinates.
- `PdfPassageProbe.tsx` owns the review controls, stale-operation rejection, and
  lifecycle cleanup. `useScientPdfReader.ts` owns runtime reconstruction.

Exact means matching PDF SHA-256 and length, PDF.js version, extraction profile,
page text hash, quote/offset/context, and intrinsic page geometry. The profile
uses raw text-item strings and explicit end-of-line markers with UTF-16 offsets;
it does not normalize ligatures, dehyphenate, or invent spaces. DOM/extractor
disagreement is refused. Repeated quotes are never searched for a substitute.
Changed material or extractor identity requires review even if words look alike.
There is no automatic relocation, accepted rebinding, OCR, or durable annotation.

The UI describes an exact result as **same PDF and text location verified**, not
verified wording. The extracted quote is visible immediately for comparison with
the page: an unchanged hidden OCR layer can still disagree with visible pixels.
Neither continuity nor an accurate quotation establishes scientific meaning.
The current rectangular geometry supports axis-aligned text and quarter turns;
diagonal text is explicitly refused before collecting misleading bounding boxes.
Faithful oriented highlights remain a separate geometry acceptance gate, not an
implemented capability. The trusted in-memory verifier does not authenticate
arbitrarily edited capture rectangles or guarantee that a scheduled mark painted.

The proof bounds capture to four consecutive rendered pages, 8,000 selected
UTF-16 units, and 256 non-empty range rectangles, including duplicates. Traversal
stops above 250,000 text units or 50,000 visited nodes per page; selected text and
rectangle budgets are enforced during collection, not only afterward. Empty,
ready, and refused selections are distinct; refused selections explain the limit
or unsupported geometry without discarding a prior capture.

The proof checks download size before buffering PDFs up to 100 MiB, rechecks the
actual byte length, honors PDF copy restrictions, and shares one material read
and hash per runtime (retrying failed reads). Full-file SHA-256 runs in a dedicated
`pdfPassageHash.worker.ts` worker over the exact byte view; its buffer is
transferred, not copied again for hashing. The worker terminates on success or
failure. There is no synchronous full-file fallback. PDF.js still supplies a
full-byte copy; this is not streaming or an end-to-end zero-copy guarantee.
Clear, runtime replacement, and unmount ignore late results and clean up marks;
they do not cancel a bounded hash already in progress.

Run focused tests from `apps/web` with
`pnpm exec vp test run --project unit src/scient/pdf/passages`. The read-only
corpus harness can compare the pinned engine with a separately supplied trusted
PDF.js module without changing app dependencies:

```sh
node scripts/scient-pdf-passage-corpus.mjs /absolute/reference/pdf.mjs /absolute/fixture.pdf
```

Run that command from the repository root with Node 24 and installed locked
dependencies. Each extractor runs in its own process to avoid PDF.js fake-worker
version collisions. Output contains material hashes, page text hashes, page
geometry, and cold timings, not document text. Use licensed, non-sensitive
fixtures; the supplied module is executable code. Matching outputs on a small
corpus do not certify arbitrary PDFs, OCR quality, or extractor-version stability.

Expand real-corpus coverage and validate selection, geometry, recovery,
accessibility, and performance before proposing persistent data. Workspace
authority and durable operations must reuse their separately reviewed foundation;
this reader proof does not accept those architecture decisions. Update this
section whenever the proof, extraction profile, limits, or persistence boundary
changes. Public Help should not advertise this development-only experiment.

## Upstream maintenance

Keep future reader behavior inside `apps/web/src/scient/pdf`. Changes to inherited
T3 code should remain limited to file-kind routing and host integration. The
server's generic exact-asset and byte-range behavior is intentionally reusable
and should remain independent of PDF UI decisions.

PDF.js is distributed under Apache-2.0. Its bundled support-data license files
and root license remain in the emitted `pdfjs-assets` tree.

On a PDF.js upgrade, re-evaluate and preferably retire the lifecycle patch if
the upstream fix covers it; do not carry it blindly. Run
`pdfViewerLifecycle.test.ts` against the installed viewer (not a mock), plus
runtime/layout/viewport tests and real rapid-switch/reopen QA. The patch changes
viewer ownership only, not PDF parsing, extraction identity, the worker, or
asset authority. Retain the Apache-2.0 notices.
