# Scient document PDF export

Scient turns a document bundle — a project Markdown file or a conversation — into a PDF by rendering it on one dedicated, complete document page and printing
that page in the desktop's Chromium. It is the PDF path of the
[conversation export and document conversion design](./scient-conversation-export-import-proposal.md);
there is one PDF path, not one per source.

## Flow

1. **Capture (server).** The server reads the source once and writes a _capture_: the document
   bundle's Markdown and the bytes of every image it shows, copied into a server-owned temporary
   directory (`<state>/document-exports/<capture id>/`). A project Markdown file is captured only
   at a verified revision: the editor saves pending edits first and sends the revision it saved;
   the server refuses a file whose SHA-256 differs. Workspace images resolve against the file's
   directory, must stay inside the project (symlinks included), and must be a supported image
   type. Each image is measured and then read from a verified open file handle with a hard byte
   cap: one image may be up to 64 MiB, one export up
   to 1,024 images and 256 MiB, and destinations that reach the same file (by query, fragment, or
   symlink) share one copy. Anything else becomes an unavailable asset with a warning. Image
   destinations are rewritten to `scient-asset:<id>` inside each parsed image's own source span,
   using the rich editor's Markdown grammar (`@scientfactory/scient-markdown`).
   macOS opens the canonical path with `O_NOFOLLOW_ANY`, rejecting an intermediate symlink
   replacement; Linux checks the opened file descriptor's `/proc/self/fd` target. On Windows,
   Node does not currently expose a safe handle-bound containment check here, so workspace
   images are omitted with an explicit warning instead of relying on a raceable path recheck.
   This Windows limitation must be resolved or expressly accepted before cross-platform release.
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
   (`scientDocumentReadinessRejection`, shared with the server).
4. **Publish (server).** The server checks the report again, enforces the 64 MiB transport limit
   (`BROWSER_PDF_EXPORT_MAX_BYTES`), resolves a Markdown file's requested path again and requires
   the same canonical file with the captured revision,
   and publishes the bytes as an immutable `browser-export` revision in the generated-document
   store (`browser-export` structural validation). The PDF opens in Scient's reader, where Save
   Copy works as for any generated PDF. The capture is removed after publication; captures that
   never return expire after ten minutes and are swept before each new capture.

The readiness report and PDF bytes originate from the authenticated desktop client. The server
checks their structure, claimed capture identity, and saved source revision; it cannot independently
attest that the PDF's visible content matches the source. Consumers must not use `browser-export`
provenance as proof of rendered-content identity.

## Failure versus limitation

An execution failure stops publication: the page did not load or start, its input was missing or
invalid, it reported a different capture, kind, or revision, a diagram or image did not finish,
Mermaid itself failed (for example, its code did not load), a captured image failed to load, a
font the page used failed or did not finish loading, the source changed, the PDF is invalid, or
it is larger than 64 MiB (the message suggests a shorter document or range, or leaving out the
work log).

A known content limitation does not: a missing, unsupported, or undecodable image prints as a
labelled placeholder, a remote image is not downloaded, a Mermaid diagram with a syntax error
prints its source (the full parse error is in the notes), TeX that KaTeX cannot typeset prints as TeX, Plotly and Vega-Lite fences print as source,
and raw HTML outside GitHub's safe subset is removed. Each becomes a warning returned with the
result and listed under **Export notes** at the end of the PDF. The page re-renders until those
notes include everything its final inspection found, so a reported limitation is always printed.

## The document page

`apps/web/src/scient/documentPage` renders the page with chat's Markdown grammar
(`scientMarkdownProfiles.ts`: GFM tables, task lists, alerts, `$…$`/`$$…$$` math), KaTeX
typesetting, the Mermaid runtime, and bidirectional text handling, but with none of chat's
interaction: web and in-document links stay links; workspace links, citations, and chips print as
text; `scient-asset:` links to attachments print their names. Chat's own renderer keeps its plugin
lists; a parity test holds both to the same grammar and order. The **document** profile joins
single line breaks; the **chat** profile keeps them. A conversation bundle already writes its hard
breaks, so the page parses both bundle profiles as documents and uses the profile only for the
conversation layout.

The print stylesheet (`scient-document-page.css`) owns A4 geometry through `@page`, the running
title header (except on the first page), and `n / N` page numbers in Chromium's page-margin boxes.
Headings keep with the following content; short code blocks (up to 18 lines), figures, diagrams,
and table rows stay whole; long code blocks and tables split, and table header rows repeat. Code
blocks wrap and are printed without syntax colour. Tagged PDF and the document outline are
enabled; headings become bookmarks.

## Entry points and availability

- **Markdown editor → More actions → Export ▸ PDF.** Available only in the Scient desktop app.
  A browser client, or a desktop too old to have the document page, shows the item disabled with
  the reason.
- **Thread menu → Export… → PDF.** The dialog's work-log, reasoning, and range options select the
  snapshot; `documents.prepareConversationPdf` builds the conversation's bundle with the
  conversation package and captures it; the desktop prints it and the PDF opens in the reader. The
  format is registered in the export format registry and is unavailable, with the reason, without
  a current Scient desktop.
- **`scient_document_export`** (agent tool). Exports an existing project-relative `.md` or
  `.markdown` file to an explicit project-relative `.pdf` path. It uses the same workspace
  authority, output staging, and partial-publication receipt as `scient_pdf_build`, which is
  unchanged. Without a connected desktop it fails with "A current connected Scient desktop is
  required to export this PDF."

## Qualification

`pnpm --dir apps/desktop test:document-pdf` renders a fixture set through Vite and the real
desktop renderer in Electron — long code and tables, inline and display math, Mermaid, captured,
missing, and remote images, mixed Hebrew and English, headings near page ends, a long
conversation, and a conversation built through the real export path (the conversation package's
snapshot and bundle, then the server's page-input builder) — and checks the PDFs with PDF.js: page counts, logical text order, bookmarks,
tagging, repeated table headers, and refusal of a stale, wrong-kind, or invalid capture. It writes
the PDFs to `build/document-pdf-fixtures/` for visual review. Like the pagination check, it needs
the locked Electron runtime and a graphical session.
