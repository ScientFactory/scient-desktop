# Scient PDF reader

## Ownership and boundary

Scient owns the PDF reader under `apps/web/src/scient/pdf`. The inherited Files
panel has one narrow routing seam: `.pdf` files mount the Scient reader instead
of T3's text editor. Every existing file-opening entry point converges on that
panel, so Files-tree, search, chat, and linked-path selection share the same
binary-safe route.

Chat attachments are the second seam: `AttachmentFilePreview` mounts
`AttachmentPdfPreview` for PDFs instead of Chromium's built-in viewer. Its
`attachment-pdf` descriptor names a sent attachment by thread and persisted id,
and a draft by its composer file context id; the uploaded id, when a draft has
one, only says where its bytes can be fetched. A draft that is not uploaded
reads its local Blob through an object URL and saves a copy by downloading it in
the renderer, since native copy accepts only HTTP(S) sources. A preview with
nothing durable to name (no thread) keeps the browser's own PDF viewer.

PDFs must never be read through `projects.readFile`. The workspace service keeps
its `WorkspaceBinaryFileError` protection. Instead, the reader requests an exact
file-scoped, short-lived asset capability and PDF.js reads the authorized URL.
PDF capabilities do not grant sibling-file access.

## Keyboard ownership

Keyboard ownership, document-zoom defaults, and preference scope are specified in
[the shared keyboard contract](./scient-keyboard.md). Reader actions stay in this
module; shared dispatch must not turn read mode into source or PDF-content editing.

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
Page changes update navigation without scheduling resize settlement: fitting
each newly visible page would change the entire document's scale and scroll
position in mixed-size PDFs. Explicit Fit width uses the current page; actual
container resizes and rotation continue through the resize settlement path.

The reader uses PDF.js's legacy/compatibility build at the same pinned version
as its worker. This keeps Electron compatibility without changing the parsing or
rendering engine. Search uses PDF.js's indexed text path with a short debounce,
progressive counts, stale-query rejection, and idle prewarming; Scient does not
maintain a second text index.

Replacement loading is separate from the painted document's lifetime. Authorization,
download, or decode failures retain the previous PDF, page, zoom, scroll position,
and search query, with an update notice and **Try again**. Retry renews authorization
and starts a new candidate attempt even when its URL and revision are unchanged;
it never remounts the displayed reader. No candidate fetch begins while authorization
is pending. Only the newest ready candidate can replace the presentation.
Save Copy uses the painted document's source and authorized URL; SyncTeX remains
disabled until the requested PDF is the current painted presentation.

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
sidebar mode in the client. Sessions are keyed by artifact authority, logical
document key, and the hosting thread (or draft). Asset identity stays independent
of the viewer's scope: authorized-URL renewal and generated-document rebuilds
preserve reading state, while two chats viewing the same file can keep different
positions. A workspace PDF's logical key uses its normalized absolute source
path; identical paths in different environments remain isolated.

Existing document-wide positions are adopted once when a scoped reader first
opens. A fork seeds its own reading state from the origin without changing the
origin's position. New-worktree file paths are remapped from a frozen handoff
snapshot before the destination viewer mounts. A later restore cannot overwrite
an already established destination view.

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

## Quotes ("Ask in chat")

`scient/pdf/anchors` owns quoting. A quote is a `PdfCitation` (contracts): the
conversation plus a `PdfTarget` from `@scientfactory/document-artifacts`, the
neutral location format a later annotation store will reuse.

- **Target.** Document identity (authority, logical key, a scoped locator for
  workspace, Sources, generated, attachment or environment PDFs), proven
  material when a producer recorded it (`null` today), the extractor profile and
  pdf.js version, and per page (up to four consecutive) the page geometry, a
  hash of the page's text-layer text, the offsets, the quote and 64 characters
  of context. No rectangles: they are recomputed from the offsets.
- **Capture.** `readPdfTextSelection` maps the DOM selection to offsets in the
  text layer's text (raw item strings, a newline per line break) synchronously,
  and refuses diagonal text, unrendered or oversized pages and more than four
  pages with selected text (pages holding only the selection's start or end do
  not count). `PdfQuoteLayer` shows Ask in chat (or the refusal) next to the
  selection and inserts through the active composer (`ComposerHandleContext`).
  A host enables it by passing `citeThread`; a draft attachment has none.
- **Budget.** A new quote's link must fit 40,000 characters
  (`PDF_CITATION_CAPTURE_BUDGET`), or the button says "Shorten selection". Links
  are read back up to 240,000 characters, as file quotes are, so the longest
  comment (8,000 characters) never makes a quote unreadable; the message limit
  still applies when sending.
- **Showing a quote.** A chip opens its document through the right-panel opener
  for its locator, after the active editor's pending save as file quotes do, and
  files a pending reveal keyed by the document (`pdfRevealRequests`). A quote
  from another workspace opens the original file by its full path. A generated
  PDF opens at its current revision (`/api/scient/documents/current`); only when
  the environment no longer knows the document does the captured revision open.
  Anything the user does meanwhile wins: a later quote click, any change to the
  thread's panel (another view, closing it), or leaving the conversation
  abandons a quote still waiting for a save or a lookup (a view only abandons a
  quote it started). Once opened, the pending reveal lives while its PDF stays
  the panel's active view; the reader's outer shell claims it from its first
  render and keeps it through authorization and loading (a slow download, a
  password); closing that reader, or leaving the PDF before a reader claims it,
  cancels it. No timer is involved, so a slow PDF still shows its quote and an
  abandoned quote never replays later. The reader shows the quote once its
  presentation is current. Stored offsets are reused only when the live page text
  proves them (`verifyPdfTarget`: same extractor, geometry, text hash, quote and
  context); otherwise the whole document is searched as one ordered text for a
  unique quote-with-context, then a unique quote (`relocatePdfText`), within a
  3-second budget. Repeats are reported as ambiguous and an unfinished search as
  incomplete; neither is guessed. A cancelled reveal (another quote, another
  document, the reader closing) stops before it scrolls or highlights. The highlight uses the CSS Custom Highlight API,
  one name per reader, repainted on `textlayerrendered`, and clears on the next
  pointer press in the reader.
- **Agent view.** `pdfCitationForProvider` sends the document, pages, text and
  context; hashes and offsets stay in the stored quote.

## Product boundary

Existing PDF annotations and interactive forms render, but PDF.js annotation
editing is disabled. Scient annotation identity, provenance, persistence, and
cross-artifact behavior remain a later product layer. This reader exposes a
stable document/page navigation seam without inventing that data model early.

OCR is likewise out of scope. The reader samples only the opening pages for text
and describes that limited observation rather than declaring the whole document
to be scanned.

## Upstream maintenance

Keep future reader behavior inside `apps/web/src/scient/pdf`. Changes to inherited
T3 code should remain limited to file-kind routing and host integration. The
server's generic exact-asset and byte-range behavior is intentionally reusable
and should remain independent of PDF UI decisions.

PDF.js is distributed under Apache-2.0. Its bundled support-data license files
and root license remain in the emitted `pdfjs-assets` tree.

## Page editing and immediate publication

Page selection is immediate and independent of the editing worker. Only a page
mutation loads the PDF worker. Ordinary reading, opening a context menu and checkbox
selection do not parse a second copy of the document. The virtualized thumbnail
list explicitly invalidates its items for selection and busy-state changes.
Opening a page's context menu does not change checkbox selection. Commands on
an unchecked page receive its ID as an explicit target; checked-page commands
use the selected group.
Drag data captures explicit page IDs at pickup: an unchecked page drags alone,
while a checked page drags the checked group. Drop targets use those IDs without
changing checkbox selection. Group drags use a canvas-backed stacked preview
with a page-count badge.
The context menu's Move… command captures explicit page IDs and opens a shared
popover anchored to the thumbnail, using the insertion form's spacing and controls,
with one Before page field. It converts the current page number to an
insertion boundary; page count + 1 means the end. It uses the same save and undo
path as dragging. Gap menus only insert blank or imported pages.
Checkboxes, the Rotate/Move/Duplicate/Delete context menu, page dragging and
the zero-height gap insertion controls stay in the existing sidebar. No edit
toolbar, mode, or additional thumbnail spacing is introduced.

`pdfEditSession.ts` serializes changes and undo/redo. It assembles candidate
bytes off the UI thread, then calls the environment's authenticated multipart
`POST /api/scient/pdf/save` endpoint. The displayed revision and history advance
only after a successful save. Failures leave the candidate out of the current
history. The PDF reader retains its existing document identity and zoom state.

The transport calls `PdfFileEdits.save`; the server owns all destination paths.
Workspace/environment PDFs use the shared binary-file mutation boundary with
a SHA-256 expected revision and a unique operation ID. A concurrent writer is
never silently overwritten. Generated PDFs and environment PDFs outside known
writable projects publish independent, validated revisions through
`GeneratedDocumentStore`, under a PDF-editor-owned binding. Later saves check
that binding's expected revision under a per-binding lease. The original PDF
remains immutable; only registered workspace files use the workspace writer.
The client remembers the edited-copy descriptor and view choice by reader scope
in local storage, so the copy remains openable after closing or restarting the
reader. Quote metadata follows the saved copy's identity.
Attachments retain the existing read-only experience.

The worker rebuilds from the base PDF context, retaining the catalog, metadata,
attachments and original page references. Removed-page destinations are rebound
to a surviving page. Copied pages rebind explicit and named internal links to
inserted targets; external links and non-link annotations retain their objects.
Inherited resources and page boxes are materialized before reparenting original
page nodes. Distinct duplicated page nodes can be rotated independently. Unsupported forms,
certificate permissions and encrypted documents fail before publication.
The session retains up to 100 undo steps; undo/redo uses the same save precondition.
Generated source revisions have separate editing sessions. An unpublished cache
is invalidated before actions are enabled on a replacement presentation. The last
subscriber releases history and the worker after admitted saves have finished.
