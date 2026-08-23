# Scient browser HTML → PDF export

This slice adds a first-party export action to the desktop integrated Browser. It prints the
currently loaded Chromium guest with `webContents.printToPDF()`; it does not reload, serialize, or
reconstruct the page. The browser tab remains intact while the immutable PDF revision is published
to the existing generated-document store and opened through the existing Scient PDF reader.

## Current contract

- Profile: `document-layout`.
- Chromium print is serialized globally so concurrent tabs cannot compete for print resources.
- Export is leased to the exact live main-frame URL selected by the user. A page that is already
  loading is rejected, and navigation, tab closure, or renderer loss before printing finishes
  invalidates the operation. Any bytes produced after invalidation are discarded; the in-flight
  Chromium print is still allowed to settle before the global print slot is released.
- Fonts, images, and two animation frames are given a bounded readiness window. The exporter never
  waits for network-idle, because interactive pages and long-polling applications may never become
  idle.
- Chromium's native print media is used without borrowing the Browser debugger session. This honors
  the page's `@media print`, `@page`, and native fragmentation rules. Content that the author
  explicitly hides for print is omitted; visible anchors remain PDF link annotations and headings
  remain available to Chromium's generated document outline.
- A reversible, zero-specificity pagination stylesheet supplies conservative defaults for tables,
  rows, figures, blockquotes, code blocks, details, common box/card containers, headings, widows, and
  orphans. Source-authored rules retain precedence. A keep-together element taller than a complete
  page must still fragment rather than overflow or disappear. The stylesheet is removed after every
  successful, failed, or navigation-raced export.
- Background graphics, CSS page size, tagged PDF, and document outline generation are enabled;
  headers and footers are disabled. A deterministic 16 px margin on every edge replaces Chromium's
  larger implicit margin, leaving a small readable boundary while source styles control the
  document's internal spacing.
- Chromium prints the live DOM rather than a screenshot: text remains vector text with Unicode maps,
  RTL and mixed-direction runs retain Chromium's bidi layout, and surviving HTML anchors become PDF
  link annotations. Canvas, video, and WebGL remain flattened content and carry the warnings below.
- The server validates the complete PDF before publication using the `browser-export` structural
  profile. A deliberately blank page is not rejected. Source signals and truthful warnings cover
  missing images, canvas/WebGL-like flattening, video frame capture, embedded frames, and readiness
  timeout.
- Logical identity is derived from the canonical page URL, with renewable `/api/assets/<capability>`
  segments removed. Receipt URLs never retain query credentials or signed asset capabilities.
- The existing JSON-RPC boundary carries the PDF as URL-safe Base64 only for the publication
  command; bytes do not enter React state or persisted atoms. A future binary upload capability can
  replace that transport optimization without changing the renderer, artifact, or reader contracts.

The generated revision is immutable, authority-bound, retained by the existing 500 MiB / 100
revision policy, and resolved through the existing signed `generated-document` asset path. The PDF
reader therefore keeps its normal refresh, download, search, navigation, and session-resume
behavior. The generated-document surface mounts that reader directly as the remaining flex child,
so the PDF canvas receives the full available pane height rather than a zero-height nested region.
On desktop, Save Copy uses the reader's shared native asset-copy capability: a modal Save dialog,
streamed main-process transfer, and atomic destination publication. It does not navigate the app or
open the authorized asset URL in an external browser.

## Explicitly deferred

Current-appearance capture, controlled-document adapters, page-range and paper controls, Attach to
Chat, and packaged cross-platform acceptance remain later slices. They must extend this contract
rather than bypass the generated-document store or the PDF reader.
