# Scient browser HTML → PDF export

This slice adds a first-party export action to the desktop integrated Browser. Its compact menu
offers **Open PDF** and **Save PDF…**. Both print the currently loaded Chromium guest with
`webContents.printToPDF()`; neither reloads, serializes, nor reconstructs the page. The browser tab
remains intact while an immutable PDF revision is published to the existing generated-document
store. Open activates that revision in the existing Scient PDF reader. Save keeps the reader closed,
resolves the published revision through the same authorized asset boundary, and opens the native
destination picker.

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
  headers and footers are disabled. A user-initiated Browser export gets a deterministic
  one-sixth-inch fallback margin (16 CSS px at Chromium's 96 px/in reference ratio) in place of
  Chromium's larger implicit margin. A controlled agent document build instead adds zero host
  margin: its source-authored `@page` size and margins are the sole physical page geometry, avoiding
  a hidden second margin. Electron's `printToPDF` margin values are inches, even though its
  printer-margin type declarations describe pixels.
- Chromium prints the live DOM rather than a screenshot. For ordinary HTML, Chromium retains text as
  selectable/searchable text, lays out RTL and mixed-direction runs with its bidi engine, and carries
  surviving anchors into PDF link annotations. Author CSS, font behavior, and browser engine changes
  can still affect those properties, so the RTL fixture corpus must qualify visual order and PDF.js
  logical-text order independently. Canvas, video, and WebGL remain flattened content and carry the
  warnings below.
- The server structurally validates the complete PDF before publication using the `browser-export`
  profile: PDF.js must parse the document and every page operator list. It does not yet reject a
  visually blank but structurally valid PDF. Screen-mode DOM counts are not sufficient evidence for
  that decision because valid `@media print` and `beforeprint` behavior can intentionally change or
  remove content. A future hard blank-output gate must compare print-time source evidence with
  bounded PDF rasters; until then, source warnings cover missing images, canvas/WebGL-like
  flattening, video frame capture, embedded frames, and readiness timeout without risking a false
  rejection.
- Local-file exports use a stable source identity derived from the environment authority and the
  normalized canonical source path. Authorizing thread IDs and renewable asset URLs never enter
  that identity, while same-named files in different directories and identical paths in different
  environments remain separate. Ordinary web pages retain canonical URL identity. Receipt URLs
  never retain query credentials or signed asset capabilities.
- The existing JSON-RPC boundary carries the PDF as URL-safe Base64 only for the publication
  command; bytes do not enter React state or persisted atoms. Raw browser exports are capped at 64
  MiB so Base64 plus JSON framing stays below the current 100 MiB WebSocket payload ceiling. This is
  an export-transport limit, not a reader limit: general PDF validation remains 256 MiB, Sources PDF
  storage remains 512 MiB, and the reader keeps its range-capable asset path. A future binary upload
  capability can remove the 64 MiB ceiling without changing the renderer, artifact, or reader
  contracts.

For local HTML, Scient retains one small thread-scoped relation per logical document after the
Browser opens the file. The Browser tab and renewable asset URL are replaceable renderer bindings,
not document identity: reopening the same source rebinds the existing relation and preserves its
artifact history, while persisted legacy per-tab relations collapse to that document relationship.
The server watches the exact file (through its parent directory so atomic editor saves remain
observable), and watcher readiness as well as later change hints trigger an authoritative
synchronization after the first user-requested export. Scient coalesces rapid hints, renews the
authorized asset URL, and reloads the bound Browser tab. After a PDF has been exported once, a
successful reload publishes a new immutable revision into the same artifact and replaces the
already-open PDF surface without stealing focus. Concurrent changes are serialized per logical
document; a revision rendered from an overtaken source generation or a replaced Browser binding is
not presented. Failure leaves the last successful PDF readable and exposes a compact, always-visible
manual Update action beside the generated document title. Reopening a missing source tab resumes a
pending update. Automatic updating stops rather than redirecting a Browser tab that the user has
navigated away from the tracked file. External web pages remain explicit one-shot exports because
Scient has no authoritative local source to watch.

The generated revision is immutable, authority-bound, retained by the existing 500 MiB / 100
revision policy, and resolved through the existing signed `generated-document` asset path. The PDF
reader therefore keeps its normal refresh, download, search, navigation, and session-resume
behavior. The generated-document surface mounts that reader directly as the remaining flex child,
so the PDF canvas receives the full available pane height rather than a zero-height nested region.
On desktop, Save Copy uses the reader's shared native asset-copy capability: a modal Save dialog,
streamed main-process transfer, and atomic destination publication. It does not navigate the app or
open the authorized asset URL in an external browser. HTML Save PDF and reader Save Copy use that
same capability and the same result presenter. A confirmed native save shows one compact success
notice with **Show in Finder**, **Show in Explorer**, or **Show in Files**, as appropriate; the
action reveals the exact destination selected by the user. Browser-only downloads truthfully report
that the download started but cannot offer a reveal action because the browser does not disclose the
final filesystem path. Generated document and right-panel titles use content-derived text direction,
so Hebrew and Arabic titles align and truncate naturally. PDF rotation remains available under the
reader's More menu rather than appearing as a second ambiguous refresh-like icon.

## Agent-authored project documents

Providers that receive Scient's MCP session get baseline document-build authority and expose
`scient_pdf_build`, independently of optional preview-browser control. A PDF is produced only when
the tool is invoked with the path of an existing project-relative HTML document and an explicit
project-relative `.pdf` output path. The server resolves the thread's current project or worktree on
every call, canonicalizes the source, rejects absolute, traversing, non-HTML, missing, and
symlink-escaping source paths, validates that the output and its existing ancestors remain inside
the project, and fingerprints the source bytes before rendering. It then
issues a two-minute internal asset capability and asks the connected desktop to print the document
in a hidden, sandboxed Chromium window. The renderer permits only that signed document, sibling
assets under the same capability, and `data:` or `blob:` content; it denies permissions,
navigations, downloads, new windows, and external network requests, and clears the nonpersistent
session after every outcome.

The desktop returns PDF bytes only over the authenticated host rail. They never enter the public
tool result or a preview tab. Before publication, the server re-reads the canonical source and
abandons the attempt if its path or fingerprint changed. It then applies the same 64 MiB transport
ceiling as user-initiated exports. An existing non-file output is rejected before rendering. After
the source checks, the server stages and fsyncs the candidate PDF in the resolved project output
directory. Immutable publication applies the `browser-export` structural validation and commits
the same bytes as a `controlled-render` revision; only then does the server atomically rename the
staged file over the requested project output. Rendering, source-currentness, output staging, or
publication failure cleans the stage and leaves an earlier project output untouched.

The final rename is the only residual cross-store race: if the destination changes after staging,
the immutable revision remains valid and the tool returns an explicit `partial-publication` receipt
containing its descriptor and the unwritten `outputPath`. It does not claim that project file exists.
Scient still asks the desktop to open the available revision. If presentation alone is interrupted,
the build remains successful and reports a `presentation-unavailable` warning rather than
encouraging a duplicate build. The tool reports structural validation and source warnings
truthfully; it never represents this as visual inspection. Publication failure marks the acquired
production failed, while render, authorization, invalid-response, source-race, and pre-publication
output failures abandon the attempt without discrediting the last successful revision.

Substantive implementation stays in Scient-owned modules. The Browser action reuses the inherited
chrome's existing trailing-action slot; it does not add PDF-specific state or props to that component.
Inherited Browser, server, desktop IPC, and right-panel files contain only the narrow mounts recorded
in `UPSTREAM.md` and enforced by the browser-export seam audit.

## Explicitly deferred

Current-appearance capture, additional controlled-document adapters, page-range and paper controls,
Attach to Chat, a binary upload transport for exports above 64 MiB, agent-visible page inspection,
and packaged cross-platform acceptance remain later slices. They must extend this contract rather
than bypass the generated-document store or the PDF reader.
