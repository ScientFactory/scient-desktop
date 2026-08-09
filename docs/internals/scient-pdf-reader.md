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
capability renewal reloads the document without losing its page, rotation, or
zoom.

PDF.js `PDFViewer` owns visible-page rendering, text and annotation layers,
internal destinations, bounded canvases, and cleanup. The reader additionally
virtualizes thumbnails, loads outlines lazily, preserves fit modes across panel
resizes, and destroys loading/rendering work on file switches or unmount.

The reader uses PDF.js's legacy/compatibility build at the same pinned version
as its worker. This keeps Electron compatibility without changing the parsing or
rendering engine. Search uses PDF.js's indexed text path with a short debounce,
progressive counts, stale-query rejection, and idle prewarming; Scient does not
maintain a second text index.

External outline URLs are accepted only for `http` and `https` and are opened
through Scient's desktop shell. Internal destinations remain inside the reader.

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
