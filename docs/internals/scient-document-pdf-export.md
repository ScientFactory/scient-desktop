# Scient document PDF export

Scient turns a document bundle — a project Markdown file or a conversation — into a PDF by rendering it on one dedicated, complete document page and printing
that page in the desktop's Chromium. It is the PDF path of the
[conversation export and document conversion design](./scient-conversation-export-import-proposal.md);
there is one PDF path, not one per source.

## Document host ownership

Controlled rendering uses the separate authenticated `documents.hostConnect` /
`documents.hostRespond` rail. `DocumentHostBroker` acquires independent broker state;
interactive browser assignment cannot capture document requests. The desktop client
advertises the operations its bridge actually supports and consumes every request
from a direct subscription, independently of React rendering. Connection generations
fence responses and cancel retired work. This rail can present a PDF or LaTeX surface
without creating an interactive browser tab. Server-owned live Browser-tab PDF export
is a separate path and does not provide this document renderer.

## Flow

1. **Capture (server).** The server reads the source once and writes a _capture_: the document
   bundle's Markdown and the bytes of every image it shows, copied into a server-owned temporary
   directory (`<state>/document-exports/<capture id>/`). A project Markdown file is captured only
   at a verified revision: the editor saves pending edits first and sends the revision it saved;
   the server refuses a file whose SHA-256 differs. Workspace images resolve against the file's
   directory, must stay inside the project (symlinks included), and must be a supported image
   type. The Markdown file and each image are measured and then read from a verified open file
   handle with a hard byte cap: the Markdown file may be up to 8 MiB, one image up to 64 MiB, one
   export up to 1,024 images and 256 MiB, and destinations that reach the same file (by query,
   fragment, or symlink) share one copy. A file that changes between the check and the read is
   refused: the Markdown file fails the export, an image becomes an unavailable asset with a
   warning. Image destinations are rewritten to `scient-asset:<id>` inside each parsed image's own
   source span, using the rich editor's Markdown grammar (`@scientfactory/scient-markdown`), which
   treats a leading YAML or TOML block as front matter; the front matter's `title`, when present,
   titles the document, before its first level-one heading.
   macOS opens the canonical path with `O_NOFOLLOW_ANY`, rejecting an intermediate symlink
   replacement; Linux checks the opened file descriptor's `/proc/self/fd` target. On Windows,
   Node does not currently expose a safe handle-bound containment check here, so the Markdown
   file is read by path with the same byte cap and accepted only when its bytes are exactly the
   revision the editor saved; a file swapped in during the read has other bytes and fails with
   "The file changed while exporting. Try again." The agent tool has no saved revision to check,
   so on Windows it refuses to export a project file. Workspace images there are omitted, each
   with a warning, instead of relying on a raceable path recheck. This Windows image limitation
   must be resolved or expressly accepted before cross-platform release.

   The capture copies an image only when its bytes carry its format's signature (PNG, JPEG, GIF,
   WebP, AVIF, BMP, or an `<svg` element); a HEIC photo named `.jpg`, a text file named `.png`, or
   an empty file becomes an unavailable asset with a warning. Each copied image carries its SHA-256
   in the page input.

2. **Render (desktop).** The capture is exposed through a five-minute signed asset capability.
   The desktop opens the web client's standalone `scient-document.html` entry, served from its
   own app scheme, in a hidden window with a private, non-persistent session. That session can
   load only the page's own files and the one signed capture; permissions, navigation, popups,
   downloads, and every other request are denied. The page never mounts the app shell, connects
   to an environment, or reads settings.
3. **Readiness.** The page publishes a readiness report: capture id, document kind, source
   digest, block counts, unresolved captured assets, whether fonts, math, diagrams, and images
   finished, and diagnostics split into _fatal_ and _warning_. The desktop prints only when the
   report matches the requested capture exactly and has no fatal diagnostic
   (`scientDocumentReadinessRejection`, shared with the server). When it refuses, the client
   releases the capture (`documents.releaseDocumentPdf`) instead of leaving it to expire.
4. **Publish (server).** The server checks the report again, enforces the 64 MiB transport limit
   (`BROWSER_PDF_EXPORT_MAX_BYTES`), resolves a Markdown file's requested path again and requires
   the same canonical file with the captured revision,
   and publishes the bytes as an immutable `browser-export` revision in the generated-document
   store (`browser-export` structural validation). The capture is removed after publication;
   captures that never return expire after ten minutes and are swept when the server starts and
   before each new capture.
5. **Delivery (client).** The client saves the published PDF through the same Save dialog as every
   other export (`documents.saveAssetCopy` with a signed URL of the generated revision; a download
   in a browser). It suggests the same title-based name as the other formats: a conversation's
   `exportFileName(title, ".pdf")`, or a project file's own name with `.pdf`, never the stored
   revision's internal name. Cancelling the dialog keeps the export dialog open. The PDF stays in the
   generated-document store: the success notice's **Open** shows it in Scient's reader for the
   conversation or project it came from, navigating to that conversation first, so an export
   started from the sidebar never opens in a thread that is not on screen.

The readiness report and PDF bytes originate from the authenticated desktop client. The server
checks their structure, claimed capture identity, and saved source revision; it cannot independently
attest that the PDF's visible content matches the source. Consumers must not use `browser-export`
provenance as proof of rendered-content identity.

## Failure versus limitation

An execution failure stops publication: the page did not load or start, its input was missing or
invalid, it reported a different capture, kind, or revision, a diagram or image did not finish,
Mermaid itself failed (for example, its code did not load), a captured image was not served, was
refused or blocked, or was served with bytes that differ from the capture's digest, a font the
page used failed or did not finish loading, the source changed, the PDF is invalid, or it is
larger than 64 MiB (for a conversation, the message suggests leaving out the work log and
reasoning, or exporting it as Markdown; for a file, a shorter document).

Every captured image the page shows is fetched once more and its bytes compared with the digest
the capture recorded, whether or not it decoded; the final inspection refuses a shown image that
was never checked. The browser reports an image it could not fetch and one it could not decode
the same way, so a captured image that does not display (an error, or a load with no measurable
size, such as an SVG with only a `viewBox`) is a content limitation only when that check found
its bytes served and matching.

A known content limitation does not stop publication: a missing, unsupported, or undecodable
image prints as a labelled placeholder, a remote image is not downloaded, a picture a Mermaid diagram names (an image shape, an actor
icon) is never requested and the diagram prints without it, a Mermaid diagram with a syntax error
prints its source (the full parse error is in the notes), TeX that KaTeX cannot typeset prints as TeX, Plotly and Vega-Lite fences print as source,
and raw HTML outside GitHub's safe subset is removed. Each becomes a warning returned with the
result and listed under **Export notes** at the end of the PDF. The page re-renders until those
notes include everything its final inspection found, so a reported limitation is always printed.

A request the page's isolation refused is that isolation working, not a failure. A refused
request for a captured asset is fatal (above) and a remote image is a placeholder; any other
refused request, such as a font or stylesheet, does not stop publication, but the desktop adds
"N web resources were not loaded." to the page's export notes before printing, and the server
returns the same note as a warning.

The capture record keeps every warning. Each list that has a limit (the page input's and the
export result's 512, the agent tool's 64) is bounded from that complete list, keeps room for the
notes that must always be reported, and ends with one entry giving the exact number it left out.

## The document page

`apps/web/src/scient/documentPage` renders the page with chat's Markdown grammar
(`scientMarkdownProfiles.ts`: GFM tables, task lists, alerts, `$…$`/`$$…$$` math), KaTeX
typesetting, the Mermaid runtime, and bidirectional text handling, but with none of chat's
interaction: web and in-document links stay links (an in-document link that names no heading or
note, or whose target is not valid URL encoding, prints as written); workspace links, citations, and chips print as
text; `scient-asset:` links to attachments print their names. Chat's own renderer keeps its plugin
lists; a parity test holds both to the same grammar and order. The **document** profile joins
single line breaks; the **chat** profile keeps them. A conversation bundle already writes its hard
breaks, so the page parses both bundle profiles as documents and uses the profile only for the
conversation layout.

The page drops a leading YAML (`---`) or TOML (`+++`) front matter block with the same grammar
the capture used, so metadata never prints or becomes a bookmark.

The print stylesheet (`scient-document-page.css`) owns A4 geometry through `@page`, the running
title header (except on the first page), and `n / N` page numbers in Chromium's page-margin boxes.
It also owns every break rule: the desktop prints the page without the HTML-export pagination
defaults (`paginationDefaults: false`), which would keep every quote and details block whole.
Headings and a details block's summary line keep with the following content; short code blocks
(up to 18 lines), figures, diagrams, images, alerts, table rows, and each export note stay whole;
long code blocks, tables, quotes, work logs, and reasoning split across pages, and table header
rows repeat. Code blocks wrap and are printed without syntax colour. Tagged PDF and the document
outline are enabled; headings become bookmarks.

## Entry points and availability

- **Markdown editor → More actions → Export ▸ PDF.** Available only in the Scient desktop app.
  A browser client, or a desktop too old to have the document page, shows the item disabled with
  the reason. The PDF is saved through the Save dialog; **Open** shows it in the editor's thread.
- **Thread menu → Export → PDF (.pdf).** The dialog's work-log and reasoning options select the
  snapshot of the whole conversation; `documents.prepareConversationPdf` builds the conversation's bundle with the
  conversation package and captures it; the desktop prints it and the client saves it. The format
  is registered in the export format registry, whose `produce` saves the file itself and resolves
  `null` when the user cancels saving; it is unavailable, with the reason, without a current
  Scient desktop.
- **`scient_document_export`** (agent tool). Exports an existing project-relative `.md` or
  `.markdown` file to an explicit project-relative `.pdf` path. It uses the same workspace
  authority, output staging, and partial-publication receipt as `scient_pdf_build`, which is
  unchanged. Without a connected desktop it fails with "A current connected Scient desktop is
  required to export this PDF."

## Qualification

`pnpm --dir apps/desktop test:document-pdf` renders a fixture set through Vite and the real
desktop renderer in Electron — long code and tables, inline and display math, Mermaid, captured,
missing, remote, and undecodable captured images, mixed Hebrew and English, headings near page
ends, YAML and TOML front matter, a long work log, long reasoning, and a long quotation that must
start under their message and continue across pages, a long conversation, and a conversation
built through the real export path (the conversation package's snapshot and bundle, then the
server's page-input builder) — and checks the PDFs with PDF.js: page counts, logical text order,
bookmarks, tagging, repeated table headers, and refusal of a stale, wrong-kind, or invalid capture
and of a captured image the capture does not serve. It writes
the PDFs to `build/document-pdf-fixtures/` for visual review. Like the pagination check, it needs
the locked Electron runtime and a graphical session.
