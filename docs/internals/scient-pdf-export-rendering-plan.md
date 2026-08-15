# Scient PDF Export And Rendering Implementation Plan

Status: Implementation-ready repository plan; implementation not started
Planning baseline: `ScientFactory/scient-desktop-next` `origin/main` at
`cf4cfdab38289968336c147e7226eb2838519c77`
Prepared: 2026-08-12

## Purpose And Authority Boundary

This file is the repository-owned implementation plan for producing
high-quality PDFs from HTML and other renderable Scient content in the new
T3-derived desktop application. It defines the approved scope, ownership,
coordination contracts, sequence, and acceptance gates for this implementation
lane. Verified implementation behavior supersedes speculative details and must
be recorded in the maintained internal documentation named below.

The proposed Scientific Document Platform Roadmap and its source map remain the
cross-product planning owners. This plan adapts their direction to an
independently deliverable desktop implementation. It does not freeze the final
`DocumentSession`, `ArtifactReference`, `DocumentBuild`, conversion-receipt, or
package architecture.

The implementation must remain useful if those final platform contracts are
renamed or reorganized. It should emit a small versioned compatibility envelope
that can later map into the accepted platform types without replacing the
renderer or its tests.

## Decision Summary

Build a Scient-owned PDF export coordinator with qualified input adapters.

Use Electron/Chromium's live `WebContents.printToPDF()` path for live websites,
authenticated pages, local interactive HTML, and browser-hosted scientific
output. This retains current page state and uses the browser engine already
shipped with Scient.

Use a controlled, isolated Scient render document for Markdown, selected chat
content, images, SVG, reports, and future structured projections. Do not print
the application UI or a virtualized scrolling surface.

Structurally validate and register PDFs already produced by LaTeX, Typst,
Quarto, or another qualified native PDF producer. Do not reprint a PDF viewer.

Do not claim DOCX, XLSX, PPTX, ODF, archival, accessible, or press-ready
conversion quality until a format-specific adapter passes its own fixtures.

Every successful export must become a validated PDF artifact with a conversion
receipt and must open through the existing Scient PDF reader. Blank, corrupt,
partial, or navigation-raced output must not be reported as success.

## Product Promise

A researcher activates **Export PDF** from a supported surface and receives:

- immediate progress;
- no source mutation or page reload;
- the best qualified renderer for that source;
- a structurally validated PDF;
- selectable, searchable text in correct logical order — including RTL and
  mixed-direction content — acceptance-gated for controlled documents and the
  supported fixture corpus; for arbitrary third-party pages, logical order is
  measured and mismatches produce truthful warnings, because the author's
  intended reading order cannot always be derived from a complex DOM with
  columns, absolute positioning, shadow roots, and iframes;
- automatic opening in the Scient PDF reader;
- Save Copy, Reveal, Retry, and receipt/details actions;
- explicit missing-resource and unsupported-content warnings; and
- recovery rather than a blank, black, corrupt, or permanently loading panel.

The source remains authoritative. The PDF is an output connected to the source,
the source state used, the renderer, the selected profile, warnings, and the
producing operation.

## Terminology

PDF export/rendering and semantic extraction are different lanes.

- **PDF export/rendering** preserves a visual document in PDF form. This plan
  owns that lane.
- **Semantic extraction** produces searchable or agent-readable text,
  coordinates, tables, equations, citations, or document structure. AnyDoc,
  Docling, Kreuzberg, GROBID, OCR engines, and specialist parsers belong to that
  lane.

A good visual PDF does not prove semantic extraction correctness. Successful
Markdown extraction does not prove visual or round-trip fidelity. The lanes may
later share source identity and receipts but must not substitute for one
another.

Within the export lane itself, three fidelity dimensions are measured and
reported separately. They must never be collapsed into one pass/fail result:

- **Visual fidelity** — the PDF looks correct: layout, direction, fonts,
  colors, vectors, and pagination.
- **Text fidelity** — text in the PDF can be selected, searched, copied, and
  extracted in the correct logical order through the existing Scient PDF
  reader and PDF.js.
- **Semantic preservation** — software can recover equations, chart data,
  citations, headings, or structure. This dimension belongs to the semantic
  extraction lane and is not promised by this exporter, except for the
  bounded structural signals (links, headings) that controlled documents
  explicitly test.

A page can render perfectly while its copied sentences come out in the wrong
order. Acceptance therefore requires visual comparison and logical-text round
trips as independent checks, not screenshots alone.

## Supported-Source Strategy

One coordinator selects the best adapter for each source. There is no single
universal conversion engine.

| Source                                                    | Qualified route                                                     | Initial disposition                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Live website or authenticated web application             | Print the exact loaded Electron `webContents`                       | First vertical slice                                               |
| Local interactive HTML with JavaScript and granted assets | Print its existing browser surface                                  | First vertical slice, consuming viewer behavior                    |
| Static HTML report                                        | Chromium with document-layout profile                               | First vertical slice                                               |
| Quarto/Jupyter/Plotly/Vega interactive HTML               | Existing browser surface                                            | First vertical slice when the content already opens in Browser     |
| Markdown or Scient-generated report                       | Controlled export document in isolated Chromium                     | Second adapter slice                                               |
| Selected chat messages or thread export                   | Controlled non-virtualized export document                          | Second adapter slice                                               |
| PNG/JPEG/WebP/GIF still frame                             | Controlled image-to-page export document                            | Second adapter slice                                               |
| SVG                                                       | Controlled Chromium export, retaining vector output where supported | Second adapter slice                                               |
| Existing PDF                                              | Register/pass through without re-rendering                          | PDF-source foundation                                              |
| LaTeX native PDF                                          | Validate and register the producer's PDF artifact                   | Independent LaTeX lane after shared foundation; exporter unchanged |
| Typst/Quarto native PDF                                   | Validate and register the producer's PDF artifact                   | Later producer integrations; exporter unchanged                    |
| DOCX/ODT                                                  | Qualified Office/document adapter                                   | Deferred until fidelity corpus passes                              |
| XLSX/PPTX                                                 | Format-specific adapter                                             | Deferred                                                           |
| PDF/A, PDF/UA, PDF/X or press-ready PDF                   | Specialized validated profile/adapter                               | Deferred                                                           |

## Architecture

```text
Live/controlled renderable source
      |
      v
PdfExportCoordinator
      +-- LiveBrowserPdfAdapter ------> Electron/Chromium
      +-- ControlledDocumentAdapter --> isolated export document
      +-- future qualified conversion adapters
      |
      v
CandidatePdfStore
      |
      v
browser-export validation profile
      |
      v
AtomicArtifactPublisher -----> PdfConversionReceipt
      |
      +--------------------------------------+
                                             |
Native producer output                       |
(LaTeX/Typst/Quarto)                         |
      |                                      |
      v                                      |
producer-owned stable publication            |
      |                                      |
      v                                      |
producer-registration validation profile    |
      |                                      |
      v                                      |
ArtifactRegistrar -----------> DocumentBuild |
      |                                      |
      +--------------------------------------+
                                             v
                              GeneratedDocumentArtifact
                                             |
                              DocumentArtifactBinding
                                             |
Existing workspace PDF ----------------> PdfSourceDescriptor
                                             |
                                    PdfSourceResolver
                                             |
                                             v
                                Existing Scient PDF reader
```

Existing workspace PDFs do not enter the export coordinator. Native producers
own stable-file publication, after which their PDFs are structurally validated
and registered; they are never reprinted and never represented by a
`PdfConversionReceipt`. Browser candidate bytes are not completed artifacts:
`AtomicArtifactPublisher` exposes a Browser-export revision only after its
validation profile passes and atomic publication completes.

### Proposed Scient-Owned Areas

`packages/scient-document-artifacts/`

- producer-neutral `GeneratedDocumentArtifact`, `DocumentArtifactBinding`, and
  `PdfSourceDescriptor` schemas;
- source capability, validation-profile, warning, failure, and artifact-link
  vocabulary shared by Browser export and document-build producers;
- pure revision/binding transition logic;
- no Electron, React, Browser-export, TeX-engine, filesystem, or final
  document-session implementation.

`packages/scient-document-export/`

- export profiles;
- adapter and coordinator domain contracts;
- lifecycle, warning, error, cancellation, and receipt vocabulary;
- pure selection and state-machine logic;
- no Electron, React, T3 preview manager, filesystem, or final document-session
  implementation.

`packages/scient-pdf-validation/`

- one pinned, producer-neutral PDF.js structural validation core;
- bounded parsing, page-tree, metadata, thumbnail, checksum, and failure
  results suitable for host-side worker execution;
- existing-load and producer-registration validation profiles;
- no Electron, React, Browser source signals, TeX build orchestration, or
  artifact-storage policy.

`apps/desktop/src/scient/documentExport/`

- live browser adapter;
- browser-surface lease verification;
- readiness probes;
- media/profile transaction;
- `printToPDF` invocation;
- handoff of candidate bytes and Browser source signals to the document-artifact
  boundary;
- cancellation, cleanup, and operation telemetry.

`apps/server/src/scient/documentArtifacts/`

- atomic publication into the server-owned state directory;
- generated-artifact catalog and persisted document bindings shared by every
  producer;
- bounded host worker for the shared structural core;
- environment-authorized, renewable signed URLs with range support; and
- no Browser rendering, TeX build orchestration, or React reader logic.

Browser-specific source-versus-output blank detection remains in the desktop
export lane before it hands validated candidate bytes to this neutral server
boundary. The web host supplies source-scoped Save Copy/Reveal commands.

`apps/web/src/scient/documentExport/`

- Export PDF command/action;
- profile settings;
- progress, warning, result, and failure presentation;
- receipt details;
- open/save/reveal/retry actions.

`apps/web/src/scient/pdf/`

- generalize reader input from one workspace path to the shared
  `PdfSourceDescriptor`/`PdfSourceResolver` boundary;
- preserve the existing workspace-file path unchanged;
- add generated desktop artifact loading and renewal;
- do not duplicate the PDF viewer.

These are the intended ownership boundaries for the first implementation. A
name may change during the foundation PR only if the replacement preserves the
same producer-neutral dependency direction and is documented in that PR.

## T3-Upstream Separation

The substantive implementation stays in Scient-owned files. Inherited host
integration is limited to four narrow seams:

1. The preview manager issues and validates an opaque lease for the active
   tab's current web contents.
2. The existing server runtime/RPC and signed-asset boundary mounts the
   document-artifact service through one generated-document variant; the
   desktop IPC registry later mounts only the Browser renderer/export bridge.
3. The browser chrome mounts one `ScientPreviewExportActions` component.
4. The right-panel/PDF host accepts `PdfSourceDescriptor` and receives the
   host-supplied resolver/action capabilities without adding producer-specific
   reader branches.

Do not place printing, readiness, artifact writing, PDF parsing, validation, or
receipt logic inside `apps/desktop/src/preview/Manager.ts`.

Do not let the renderer select an arbitrary raw `webContentsId`. The desktop
must verify the tab-to-web-contents relationship and abort if that relationship
changes.

Add a seam-verification test or scoped source audit so future work cannot spread
the feature into unrelated inherited browser, file, chat, or state modules.

**Attach to Chat is deliberately outside the first production slice.** It is
not an undeclared fifth inherited seam. A later attachment integration must
reuse the existing universal attachment path, receive its own narrow seam
review, and pass file-lifetime tests before this product promise adds Attach.

## Minimum Compatibility Contracts

The first contracts should be versioned, narrow, and intentionally adaptable.
They must not claim to be the final document-platform kernel.

### Export Request

Carries:

- source kind and source-specific opaque reference;
- environment/thread context when relevant;
- requested export profile;
- page-size/orientation/page-range options;
- readiness policy;
- producing user action; and
- cancellation identity.

For a live browser source, the public request contains the preview tab ID, not a
trusted web-contents pointer.

### Generated PDF Artifact

Extends the producer-neutral `GeneratedDocumentArtifact` identity with:

- page count;
- bounded local artifact locator;
- producing operation/receipt ID;
- source identity and revision evidence when available;
- source URL/title or resource identity;
- renderer and Electron/Chromium version;
- selected profile; and
- PDF validation summary.

It does not carry `current`, `fresh`, or `stale` state. Artifact revisions are
immutable; those mutable relationships belong to `DocumentArtifactBinding`.

### PDF Conversion Receipt

Carries:

- schema version;
- requested, started, and completed time;
- final status: completed, completed-with-warnings, cancelled, superseded, or
  failed;
- source surface identity and navigation generation;
- renderer/profile/options;
- readiness observations;
- missing/failed resources;
- font and image timeouts;
- cross-origin-frame limitations;
- canvas/video/WebGL/animation/lazy-content warnings;
- validation result;
- failure code and recoverability; and
- cleanup outcome.

Successful PDF generation means validated PDF bytes were produced. It does not
mean every arbitrary third-party page feature was preserved perfectly. The
receipt makes the distinction visible.

## Rendering Profiles

### Current Appearance

Default for live Browser pages.

- emulate screen media;
- preserve current light/dark preference;
- print backgrounds;
- request exact color adjustment where practical;
- retain current form and DOM state;
- no generated browser headers/footers;
- locale-aware A4/Letter fallback;
- user-selectable portrait/landscape and page ranges.

### Document Layout

Default for controlled Markdown, reports, and publication-oriented HTML.

- honor print media;
- honor `@page` and CSS page size;
- use deterministic export styles;
- preserve semantic headings and links;
- optional page numbers and document metadata;
- locale-aware A4/Letter fallback when the document defines no page size.

### Deferred Profiles

- tagged/accessibility-oriented PDF;
- document outlines/bookmarks;
- PDF/A archival;
- PDF/UA;
- PDF/X and press-ready output;
- crop marks, bleed, color-profile, and institutional publishing profiles.

Electron's tagged-PDF and document-outline flags remain experimental. They must
be fixture-gated before becoming default behavior.

## Fidelity Commitments By Content Type

Each content type carries an explicit commitment per fidelity dimension.
"Required" means acceptance-gated; "tested" means measured and reported but
not blocking; "not promised" means the honest limitation is documented and,
where detectable, surfaced as a receipt warning rather than claimed silently.

| Content                                          | Visual fidelity                                                                      | Text/search/copy fidelity                                                                                                                                       | Semantic preservation                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| LTR text, tables, lists                          | Required                                                                             | Required, logical order verified                                                                                                                                | Structure not promised; links/headings tested in controlled documents |
| Hebrew/Arabic RTL and mixed-direction text       | Required                                                                             | Required for controlled documents and the fixture corpus, logical order verified through PDF.js extraction; measured with mismatch warnings for arbitrary pages | Structure where available; not promised                               |
| DOM/KaTeX/MathJax math (HTML or SVG output)      | Required                                                                             | Tested; selectable where the renderer emits text                                                                                                                | Original LaTeX/MathML recovery not promised; semantic-extraction lane |
| SVG charts                                       | Required, vectors retained where Chromium supports it                                | Labels tested                                                                                                                                                   | Chart data not promised                                               |
| HTML/CSS charts                                  | Required                                                                             | Tested                                                                                                                                                          | Not promised                                                          |
| Canvas content (charts, math, or unclassifiable) | Required stable frame or explicit warning                                            | Usually unavailable; receipt warning                                                                                                                            | Not promised                                                          |
| WebGL charts                                     | Best-effort capture with dedicated fixtures; warning when degraded                   | Not available; receipt warning                                                                                                                                  | Not promised                                                          |
| Animated charts                                  | Required stable state via readiness or `ScientExportReady` hook                      | Per underlying technology                                                                                                                                       | Not promised                                                          |
| Cross-origin iframe charts                       | Best effort; preflight may be unable to inspect or prepare them; receipt must say so | Not promised                                                                                                                                                    | Not promised                                                          |
| Citations and footnotes in controlled documents  | Required                                                                             | Required, logical order verified                                                                                                                                | Tested in controlled documents                                        |

Consequences of this matrix:

- Chart fidelity depends on how the chart is produced. SVG is the best case
  and usually retains vectors and sometimes selectable labels; HTML/CSS is
  usually good; canvas is captured visually but flattened; WebGL needs its own
  fixtures and may need warnings; animated charts must reach a stable state
  through bounded readiness or the app-owned `ScientExportReady` hook.
- The first-release mathematics promise is visually faithful math with
  selectable text where the renderer supports it. Recovering editable LaTeX or
  MathML belongs to the separate semantic-extraction platform.
- RTL, math, or chart support is never declared complete merely because the
  resulting pages look correct. Search, selection, copy order, font embedding,
  vector retention, and truthful warnings are verified independently.
- Runtime preflight can detect that a canvas exists but generally cannot know
  whether it contains mathematics, a chart, or a photograph. The runtime
  warning for arbitrary pages is therefore the generic
  `canvas-content-flattened`. Richer classifications (flattened math, flattened
  chart) are used only for controlled content that declares its own type.
- Where a "not promised" limitation is detectable during preflight (canvas
  content, WebGL, cross-origin frames), the receipt and the user-facing
  warning surface must state it rather than let a visually plausible page
  imply full fidelity.

## Live Browser Export Transaction

### 1. Acquire And Verify The Surface

- Resolve the active preview tab on the desktop side.
- Issue a lease containing the tab ID, current web-contents ID, lifecycle
  generation, URL, and relevant appearance state.
- Resolve the Electron `WebContents` only after lease verification.
- Subscribe to main-frame navigation, web-contents replacement, close,
  destruction, unresponsive, and renderer-process-gone events.
- Abort rather than export a different document if the surface changes.

### 2. Bounded Readiness

Do not wait for global network idle. Many legitimate applications keep sockets,
analytics, polling, or streaming requests open forever.

Instead:

- wait for the top-level document if it is actively loading;
- wait for `document.fonts.ready` within a deadline;
- decode currently referenced images within a deadline;
- temporarily promote native lazy images to eager loading where reversible;
- wait two animation frames for layout stabilization;
- support an app-owned `ScientExportReady` hook for controlled charts and
  documents;
- record unresolved resources rather than hiding them;
- do not automatically crawl or scroll an infinite page to its end.

For app-owned export documents, readiness is deterministic and the complete
selected content must be rendered without virtualization.

### 3. Reversible Preparation

Inside a cleanup-guaranteed transaction:

- preserve the existing color-scheme and debugger/control-session state;
- apply screen or print media for the chosen profile;
- disable CSS transitions and animations after content readiness;
- apply exact print-color behavior for Current Appearance;
- avoid changing source data, navigation, form values, or persistent storage;
- ensure every injected style or emulation change is restored on success,
  failure, cancellation, crash, or interruption.

Canvas animation, video frames, WebGL, and inaccessible cross-origin frames may
remain imperfect. Detect them during preflight and attach explicit warnings.

#### Media Emulation And Debugger Ownership

Media selection is a production contract, not an implementation detail to
discover after the UI ships.

- The renderer must borrow a PreviewManager-owned, serialized CDP control lease
  for `Emulation.setEmulatedMedia`; it must never independently attach a second
  debugger, detach an existing debugger, close DevTools, or steal an automation
  session.
- Current Appearance requests screen media while preserving the active color
  scheme and other emulation features. Document Layout uses Chromium print
  media and its print stylesheet behavior.
- All emulation commands must be serialized with the existing appearance and
  browser-control commands, and the exact prior state must be restored through
  the cleanup-guaranteed transaction.
- If DevTools or another controller owns the debugger, Document Layout may
  proceed because it does not promise screen-media fidelity. Current Appearance
  must not silently or automatically downgrade to print media. Present two
  recoverable actions: close the conflicting controller and Retry, or explicitly
  choose **Export with Document Layout**. If the user accepts the downgrade, the
  receipt records `requestedProfile`, `actualProfile`, and a
  `screen-media-unavailable` warning.
- Injected CSS is not an acceptable general fallback: it cannot faithfully
  reproduce arbitrary `@media screen` rules or the page's complete cascade.

The permanent fixture and integration corpus must exercise debugger-unattached,
Scient-control-owned, DevTools-owned, cancellation, crash, and restoration
paths before Current Appearance is considered supported.

### 4. Produce The PDF

Invoke `WebContents.printToPDF()` with:

- `printBackground: true`;
- no header/footer by default;
- selected page range;
- selected orientation;
- profile-specific `preferCSSPageSize`;
- deterministic scale and margins;
- experimental tagged/outline options disabled unless their feature gate is
  explicitly enabled.

Start with a process-wide export semaphore of one, in addition to per-source
supersession and cancellation. This prevents concurrent Chromium printing,
validation rasterization, and artifact writes from creating unmeasured memory
and CPU contention. Raise global concurrency only after packaged macOS,
Windows, and Linux measurements establish safe budgets and restoration behavior.

### 5. Restore And Re-Verify

- Restore media and appearance state.
- Remove temporary styles/listeners.
- Verify the lease still refers to the same source.
- Mark a navigation-raced result superseded and discard its bytes.

## Controlled Document Rendering

Do not print ordinary application DOM for Markdown, chat, images, or future
manuscripts.

Create an isolated export document that receives a bounded, serializable render
model and local approved assets. It must:

- render without application navigation or toolbars;
- render all selected content rather than the visible virtualized window;
- reuse the same Markdown, math, bidi, code, citation, figure, and table
  rendering components where they are deterministic and export-safe;
- bundle fonts/styles locally;
- expose explicit ready/failure state;
- remain independent from the interactive app store;
- be destroyed after export.

The first controlled adapters should be Markdown/report, selected chat content,
and image/SVG. A structured manuscript projection can use the same adapter
later without changing the export coordinator.

The controlled renderer must not create a private math stack. Chat Markdown has
no shared production math renderer at this baseline; the planned shared
`remark-math` plus KaTeX work is therefore a dependency for rendered-math
fidelity. Before that dependency lands, the Markdown adapter may ship for
documents without math. Math-bearing input must either preserve the source TeX
visibly with a `math-renderer-unavailable` warning or be held behind the math
capability, according to the adapter's explicit policy; it must never silently
drop equations or claim rendered-math fidelity.

## Artifact Persistence

- Use a dedicated document-artifacts directory under the app's isolated
  desktop state directory, not the user's project or Downloads folder.
- Generate a collision-resistant artifact ID and temporary filename.
- Write into the final directory so atomic rename does not cross filesystems.
- Flush the temporary file before validation/rename.
- Never overwrite an existing artifact.
- Enforce containment before reveal, copy, save, open, or cleanup actions.
- Keep temporary/failed outputs separate and clean them through bounded,
  recoverable lifecycle rules.
- Save Copy writes a user-chosen copy only after the validated artifact exists.

Initial retention policy (named, configurable implementation constants):

- cap completed cache-backed artifacts at 500 MiB or 100 artifacts, whichever
  limit is reached first;
- delete failed and cancelled candidates immediately when possible, and remove
  orphan candidate/temp files older than 24 hours during bounded startup GC;
- never evict an artifact that is open in the reader, pinned/saved, referenced
  by durable product state, or participating in an active operation;
- evict only closed, unpinned, unreferenced generated artifacts, ordered by
  least-recent access; automatic opening does not make an artifact permanently
  ineligible after it is closed;
- retain the receipt and mark its cached output expired if eligible bytes are
  evicted; and
- if the budget cannot be restored without deleting protected work, block the
  new export with a visible storage-management error instead of silently
  deleting protected artifacts.

The neutral store must not approximate this policy by deleting every revision
except the newest one or two. An older immutable revision may still be open,
serving byte-range requests through an unexpired signed URL, or referenced by
durable product state. Safe pruning therefore requires the protected-lifetime
and reference information above. Continuous-save producers such as LaTeX may
integrate against the foundation contracts, but their production release is
gated on this protected retention implementation; unbounded history and unsafe
"keep N" deletion are both unacceptable shipping states.

**Status — landed in the shared store.** `GeneratedDocumentStore` now performs
store-level accounting of every published revision (count and bytes across all
logical documents) in a `retention-index.json` beside the bindings, and enforces
the budget opportunistically after each publish with no background timer.
`GeneratedDocumentRetentionPolicy` carries the byte and artifact caps — the
plan's 500 MiB / 100 artifacts by default — plus a per-pass eviction bound, and
is overridable through `layerWith({ retention })`. The revision every binding
currently resolves to is never a candidate, and `retainRevision(ref)` adds
scope-held protection for a revision that in-flight work still references.
`resolveRevisionForAsset` also persists a lease through the exact expiry of the
signed reader URL it backs; startup reconstructs that protection, so a restart
cannot evict bytes while an already-issued capability remains valid. Eviction removes
the accounting entry before touching the filesystem, so an interrupted delete
strands an unreferenced directory rather than a referenced-but-deleted revision;
the bounded startup sweep re-adopts referenced directories the index has lost,
drops entries whose directories are gone, and reclaims orphans and crashed
temporary directories. A budget that cannot be restored without deleting
protected work is reported through a warning rather than satisfied. Two pieces
of the policy above remain open for the producer lanes: reader-open lifetime
beyond renewable URL leases and pinned/saved lifetime beyond the scope-held pin,
and blocking a new export with a visible storage-management error when only
protected work remains.

Integrity verification is performed when a renewable signed URL is issued,
not for each HTTP byte-range request. The initial implementation re-hashes the
immutable revision at that boundary; the client refreshes asset capabilities
at a substantially lower frequency than PDF.js range reads. Do not replace the
hash with a size/mtime-only cache: local content can be changed to the same
length and timestamps can be restored. A future performance cache is valid
only if it uses a platform-stable file identity/change signal and falls back to
the full hash whenever that evidence changes or is unavailable.

Slice 1 must test byte/count thresholds, protected-artifact pressure, startup
GC, failed cleanup retries, and reader-open lifetime. The initial numbers may be
raised only from measured artifact sizes and platform disk behavior.

## Validation And Blank-Output Detection

The exporter must not treat `printToPDF()` resolving as sufficient proof.

### Validation Profiles

One pinned PDF.js structural core serves every producer, but the complete
validation policy is profile-specific rather than one universal
`validatePdf()`:

- **Browser export**: structural validation plus source-versus-output
  blank-output detection as defined below.
- **Producer registration** (LaTeX/Typst/Quarto native PDFs): structural
  validation only. Compiler completion, stable-file publication, diagnostics,
  and expected-output checks belong to the producing lane. A deliberately
  blank or sparse page must not be rejected because a browser-oriented blank
  detector considered it suspicious.
- **Existing PDF pass-through**: structural loading behavior only.

### Structural Validation

- require PDF signature and nontrivial byte length;
- parse with the pinned PDF.js runtime in an isolated worker;
- require at least one page;
- load document metadata and page structures;
- render bounded low-resolution validation thumbnails;
- compute page count and checksum;
- reject parsing, xref, page-tree, or rendering failures.

### Content-Signal Validation

Capture source preflight signals:

- visible text length;
- image/SVG/canvas/video/iframe counts;
- coarse screenshot color/variance statistics where available;
- document dimensions and meaningful visible-node count.

Compare them with generated PDF signals:

- extractable PDF text length where applicable;
- page raster color/variance;
- non-background pixel coverage;
- link/heading presence for controlled documents.

If the source contains meaningful visible content but every PDF page is empty or
uniform, fail with a blank-output error. Do not reject a legitimate dark or
minimalist document merely because it is mostly black or white; compare source
and output signals rather than using one color threshold.

Validation proves structural usability and catches gross blank/corrupt output.
It does not claim full visual equivalence for arbitrary third-party pages.

### Atomic Completion

Only after validation:

- flush the temporary PDF and metadata, then atomically rename their revision
  directory so bytes and metadata cannot become independently visible;
- persist the final descriptor and receipt;
- expose the artifact to the PDF reader;
- report success.

No failed, partial, superseded, or unvalidated PDF should remain visible as a
successful artifact.

## Shared PDF Foundation And Reader Generalization

The existing Scient PDF reader remains the only PDF viewing surface. The
foundation that generalizes it is shared permanent infrastructure for every
PDF producer — browser export now, LaTeX/Typst/Quarto builds later — and it
lands as the **first** pull request of the implementation stack, before the
browser renderer, so both lanes can proceed concurrently against one agreed
contract.

### Neutral Data Contracts And Host Capabilities

A reader-facing union alone is not neutral enough; if `absolutePath` is simply
replaced with an unstructured union, producer-specific branches will
eventually grow inside the reader. The foundation therefore separates three
serializable data contracts from host capabilities:

- **`GeneratedDocumentArtifact`** — immutable artifact revision: schema
  version, artifact/revision ID, content hash, media type, byte length, creation
  time, provenance, and producing-operation identity. This is the neutral
  identity; the export lane's Generated PDF Artifact contract extends it with
  export-specific fields rather than replacing it.
- **`DocumentArtifactBinding`** — mutable, versioned relationship between a
  stable logical document key and its artifact revisions. It records the
  active revision, last successful revision, latest attempted operation/build,
  current/stale/failed-production state, and stale reason. A monotonic binding
  generation prevents an older completion from replacing a newer revision.
- **`PdfSourceDescriptor`** — small serializable reader input describing what
  to display: an existing workspace file, a cached generated artifact, or a
  producer build output. It carries the stable logical document key, selected
  artifact or workspace-file revision identity, filename/title, binding
  reference/snapshot when applicable, and serializable capabilities such as
  `canSaveCopy` and `canReveal`. It never carries executable callbacks or
  producer-specific path logic.
- **`PdfSourceResolver`** — host-specific capability that creates and renews
  the authorized URL for a descriptor. Separate host commands implement Save
  Copy and Reveal using the descriptor and its declared capabilities. The
  reader consumes descriptors plus injected host capabilities; it never
  resolves paths or performs producer-specific commands internally.

The foundation also supplies the reusable structural PDF validator. Its
existing-load and producer-registration profiles land in foundation PR 1 so a
LaTeX producer has no second infrastructure dependency. Browser-specific
source-versus-output blank detection remains in the Browser export lane.

Freshness/staleness is a property of the artifact-to-build/source
relationship, recorded by `DocumentArtifactBinding` and observed through the
descriptor — never written onto an immutable artifact and never hidden in
callback-heavy component props.

Initial source variants:

1. Existing workspace file source, unchanged.
2. Generated server-owned artifact source, proven in the foundation PR with a
   permanent multi-revision lifecycle fixture before the browser renderer
   exists.

The reader keeps byte ranges, PDF.js worker/assets, search, text selection,
links, password support, thumbnails, outline, zoom, rotation, virtualization,
and cleanup. Generated-artifact support must not weaken or regress exact
workspace-file capabilities.

### Binding Authority, Persistence, And Host Scope

- Logical document keys are stable, producer-defined, and namespaced by source
  authority so unrelated environments, projects, or producers cannot collide.
- The server artifact catalog owns authoritative bindings for registered
  generated PDFs, regardless of producer. Browser export and LaTeX build
  coordinators advance those bindings through the same producer-neutral
  service. The reader only observes a descriptor and cannot declare a revision
  current by itself.
- Every descriptor carries enough environment/host identity for capability
  routing. A resolver must reject a descriptor owned by another host rather
  than accidentally opening a same-named local path.
- Browser **Export Again** advances the existing export chain's binding; a new
  independent export creates a new logical document key. LaTeX rebuilds retain
  the logical key derived from the resolved root document and build target.
- Binding state needed after restart is persisted by the owning producer or
  artifact catalog; transient UI callbacks are never the source of truth.
- If descriptors or binding events cross the authenticated RPC boundary, their
  Effect schemas are exposed through `packages/contracts` by importing the
  neutral schema rather than defining a second wire shape.

### Renewal And Rebuild Lifecycle Contract

Refresh-in-place semantics are a precise contract, not a naming convention,
so browser export and LaTeX cannot implement incompatible lifecycles under
the same names:

- each successful production creates an immutable artifact revision with its
  own content hash; revisions are never mutated in place;
- the logical document key remains stable across revisions of the same
  document;
- binding updates compare their monotonic generation so late/superseded
  completions cannot replace a newer selected revision; the authoritative
  store allocates generations under its binding lock and returns the resulting
  production handle, rather than requiring each producer to read/increment a
  shared counter;
- the reader reloads only after the new PDF is complete and has passed its
  validation profile; partial producer output is never exposed;
- a failed production leaves the last successful revision visible, marked
  stale with a visible failed-production state, rather than blanking the
  reader;
- reload preserves page, zoom, sidebar, and reading position where possible;
- search results are rebuilt against the new revision; and
- revision-scoped auxiliary data (for example future SyncTeX mappings)
  identifies the exact artifact revision it belongs to.

### Binding Change Notification Seam

Refresh-in-place also needs one producer-neutral notification path. Before the
first continuously rebuilding producer ships, add a narrow authenticated
binding-change subscription keyed by authority and logical document key. Its
payload is the new binding generation and descriptor (or an invalidation that
causes `getDescriptor` to run); it is not a LaTeX-, Browser-, Typst-, or
Quarto-specific event. Delivery may be coalesced, so the persisted binding
remains authoritative and reconnect always re-reads it. Polling may be a
temporary diagnostic fallback, not the product lifecycle.

**Status — server-internal seam landed.** `DocumentBindingChange` is a neutral
schema in `packages/scient-document-artifacts` carrying the change kind
(`begin`, `publish`, `fail`, `abandon`, `supersede`, `reconcile`), authority,
logical document key, artifact ID, binding generation, status, active revision,
and update time. `GeneratedDocumentStore.changes` is a `Stream` over an
in-process replaying `PubSub` that announces every binding transition, including
startup reconciliation. This is the foundation contract only: no wire or HTTP
surface exists yet, so the authenticated subscription still has to be built on
top of it by exposing the neutral schema through `packages/contracts` rather
than defining a second wire shape.

**Status — cancellation and restart semantics landed.** The lifecycle now
separates two outcomes that previously shared one transition. `failProduction`
keeps its meaning — the inputs are discredited, so a surviving revision is
marked stale — while `abandonProduction` releases a production that was
cancelled or superseded without discrediting anything: a published current
revision stays current and is never staled, a never-published binding settles to
the new `unbound` status, and the call is idempotent so a cancel path can run
unconditionally against a handle that no longer owns the binding. A server
interruption no longer leaves persisted `producing` state unreconciled: the
store sweeps its bindings on layer initialization and routes every still-running
attempt through the same abandon transition, restoring the prior published
revision where one exists and logging what it reconciled.

The foundation PR proves this lifecycle with permanent fixtures, not one static
file: open revision A; publish validated revision B; preserve reader state while
reloading B; reject a failed or invalid revision C; keep B visible with a stale
failed-production state; renew an expired authorized URL; rebuild search for B;
reject partial output; reject a late superseded completion; and prevent
auxiliary revision data from attaching to the wrong artifact.

## User Experience

### Entry Point

- Add a visible **Export PDF** action to Browser chrome or its More menu.
- The single-click action uses the source's recommended profile.
- An adjacent settings path exposes profile, page size, orientation, margins,
  and page ranges without forcing a modal on every export.
- Add command-palette/keybinding entry only after checking the repository's
  multi-entry-point conventions and establishing one shared action.

### Progress

Show real phases:

1. Preparing content.
2. Waiting for fonts and images.
3. Rendering PDF.
4. Checking PDF.
5. Opening result.

Do not show an indeterminate spinner with no phase for a potentially long
document. Allow cancellation after the operation starts.

### Success

- Open the generated artifact immediately in the Scient PDF reader.
- Keep the receipt accessible but nonblocking.
- Offer Save Copy, Reveal, and Export Again.
- Preserve the source Browser tab and its state.

Attach to Chat is deferred until the existing attachment path can consume the
generated-artifact lifetime contract without adding a second storage model.

### Warning And Failure States

Examples:

- The page changed while it was being exported. Try again.
- The PDF was created, but two images were unavailable.
- This interactive frame could not be included.
- The page did not finish preparing within the export limit.
- Scient created a PDF, but its pages were blank, so it was not saved.
- The browser renderer stopped responding.
- Scient could not validate the generated PDF.
- Scient could not write the generated file.

Warnings and failures belong in a durable result surface with Retry and details,
not only in a disappearing toast.

## Relationship To The HTML Viewer And Universal Opener

The exporter consumes the current Browser surface. It does not create a second
HTML viewer, duplicate local-asset grants, or redefine file-opening policy.

This makes the exporter independently implementable:

- it works for any page the Browser already renders;
- its core and tests do not wait for the universal opener;
- it does not require final `DocumentSession` contracts;
- local-HTML viewer improvements automatically improve the source being
  exported;
- its Browser request requires only the current preview tab ID.

The HTML viewer remains responsible for correctly loading local HTML,
interactivity, local assets, navigation, and its loading/failure states. The
exporter remains responsible for readiness, PDF production, validation,
receipts, and result UX.

The legacy fixture pack from
`ScientFactory/scient-desktop/docs/manual-testing/html-preview/fixture-pack`
should be copied into this repository's own synthetic test corpus when tests are
implemented. Tests must not depend on a sibling repository at runtime.

## LaTeX And Typesetting Producer Alignment

A separate collaborator lane implements LaTeX (and later Typst/Quarto)
compilation. That lane is not part of this plan and this plan does not block
on it. This section fixes the boundary between the two lanes so each can ship
independently while sharing one set of contracts. The LaTeX implementer should
read this section before their first build-output milestone.

### Owned Here And Reused By The LaTeX Lane

The following are produced by this plan and are the single shared
implementations. The LaTeX lane must consume them rather than re-derive them.
The shared foundation (pull request 1) lands **before** either lane's
substantive feature work, so both lanes implement against one agreed
contract:

- **The shared PDF foundation.** `GeneratedDocumentArtifact`,
  `DocumentArtifactBinding`, `PdfSourceDescriptor`, and `PdfSourceResolver`
  distinguish workspace files from generated artifacts and build outputs, not
  Browser export from LaTeX.
  Compiled LaTeX PDFs open in the existing Scient PDF reader through this
  boundary. There is no LaTeX-specific PDF viewer, reader branch, or private
  reader source.
- **Renewal, freshness, and rebuild lifecycle.** The lifecycle contract in
  "Shared PDF Foundation And Reader Generalization" — immutable artifact
  revisions, stable logical document key, reload only after validation,
  stale last-success on failure, preserved reading position, revision-scoped
  search and auxiliary data — exists specifically so a rebuild can renew the
  open document in place. The LaTeX lane should validate these semantics
  against its build loop early and request contract changes here rather than
  forking a variant.
- **PDF validation boundary with profiles.** The isolated PDF.js structural
  core is reusable for any produced PDF. Compiler output uses the
  **producer-registration** validation profile: structural checks only, with
  compiler completion, publication, diagnostics, and expected-output evidence
  owned by the LaTeX lane. Browser-oriented blank detection never rejects a
  deliberately blank compiled page. A compiler-produced PDF is never reprinted
  through the browser renderer.
- **Shared operation vocabulary, distinct records.** `PdfConversionReceipt`
  describes conversion/rendering operations. A LaTeX compilation is a
  `DocumentBuild`, which the LaTeX lane owns; it must not be disguised as a
  conversion receipt. Both reuse artifact references, warning/diagnostic
  shapes, failure categories, and terminal outcome vocabulary where their
  meanings match. They do not share one lifecycle enum: builds require states
  such as queued, running, cached, and superseded that an export receipt does
  not.

### Owned By The LaTeX Lane And Out Of Scope Here

- compilation, typesetting engines (Tectonic, installed TeX/`latexmk`), root
  discovery, recipes, and diagnostics parsing;
- the `DocumentBuild` lifecycle: streaming progress, cancellation,
  supersession, dependency tracking, and last-success management;
- where compiled output bytes live. Build output may remain in the project or
  a configured output directory rather than this plan's bounded artifact
  store; this plan's storage quotas and eviction rules govern only its own
  generated artifacts. `PdfSourceDescriptor` must remain open to a
  build-output variant without reader changes;
- SyncTeX and source-PDF navigation; and
- build-execution security: shell-escape policy, per-project trust, and
  process-tree cleanup.

### Alignment Requirements For The LaTeX Implementer

1. Start immediately on engine discovery, root resolution, build
   coordination, diagnostics, and fixtures — none of that waits on this plan.
   But do not implement a private PDF reader source, artifact identity,
   artifact binding/freshness model, or validator before the shared foundation
   contract (pull request 1) is agreed and landed.
2. Open compiled PDFs through the shared foundation contracts. If build
   output needs a new descriptor variant (for example, project-directory
   output with revision evidence), extend `PdfSourceDescriptor` in
   coordination with this lane. Do not modify the reader itself and do not add
   producer-specific branches inside it.
3. Implement last-success and stale-preview behavior through the shared
   renewal/rebuild lifecycle contract, not a private staleness flag inside
   build state.
4. Never reprint, re-render, or re-export a compiler-produced PDF through the
   browser renderer. Register it under the producer-registration validation
   profile.
5. Keep records distinct: a compilation produces a `DocumentBuild`, not a
   `PdfConversionReceipt`.
6. Own a producer-specific fidelity corpus. The HTML-to-PDF fixtures in this
   plan do not validate PDFs produced by a TeX engine; a LaTeX PDF can look
   perfect while its text layer is unusable, and structural validation cannot
   detect that. The LaTeX corpus needs at least: Hebrew and Arabic with the
   selected Unicode engine and bidi packages; mixed Hebrew/English, numbers,
   punctuation, references, footnotes, and tables; embedded fonts, missing
   glyphs, and `ToUnicode` mappings; PDF.js search, selection, and copied
   logical order; equations and equation numbering; TikZ and PGFPlots vector
   output; raster figures, SVG conversion, bibliography, hyperlinks, and
   cross-references; and XeLaTeX/LuaLaTeX/Tectonic differences where
   supported.
7. Follow the same T3-upstream separation rules as this plan: substantive
   implementation in Scient-owned directories (`apps/*/src/scient/…`,
   `packages/scient-…`), integration through your own explicitly declared
   narrow seams into inherited code, and a seam-verification test or scoped
   source audit. Do not widen this plan's four seams; LaTeX integration points
   receive their own declared seams and their own review.
8. If a shared contract defined here blocks the LaTeX lane, change it here as
   a versioned contract revision reviewed by both lanes, instead of forking a
   private variant.

## Engine And Open-Source Posture

### Production Default

Electron/Chromium `WebContents.printToPDF()` is the production renderer for
live and controlled browser content because it uses the loaded page, session,
cookies, local assets, form state, and browser engine already present in the
desktop app.

### Acceptance Automation

Use Playwright for real-Electron/Chromium acceptance where it adds confidence.
Do not launch a second production browser merely to produce the same Chromium
PDF while losing the live page state.

### Optional Later Adapters

- Paged.js: optional controlled publication-layout adapter after fixture proof;
  not injected into arbitrary pages.
- Vivliostyle: publication and press-oriented behavior reference; no default
  embedding without license and operational review.
- WeasyPrint: possible controlled report/archival adapter; not a full browser
  and not the renderer for authenticated or interactive live pages.
- Quarto/Pandoc/MyST: publishing producers behind document-build or conversion
  receipts; native PDF results are registered rather than reprinted.
- AnyDoc/Docling/Kreuzberg/GROBID: semantic extraction only.
- Flyfish: possible broad viewer, not default PDF production authority.

Reject wkhtmltopdf as a new dependency because its old Qt WebKit implementation
and archived upstream do not provide a credible modern browser-fidelity path.

Do not add another production engine until the frozen corpus demonstrates a
specific Chromium failure that the candidate solves, and the candidate passes
license, packaging, update, rollback, performance, and quality gates.

## Test And Fixture Program

### Existing HTML Controls To Port

- `static-brochure.html`: layout, color, local SVG, and table.
- `interactive-demo.html`: current JavaScript state, form values, module, fetch,
  worker, and linked local navigation.
- `long-report.html`: pagination, tables, code blocks, and long content.
- `broken-page.html`: missing asset with usable remaining content.

### New HTML/PDF Fixtures

- screen versus print CSS;
- `@page`, page sizes, margins, breaks, widows/orphans;
- local and web fonts, delayed fonts, and missing fonts;
- Hebrew and Arabic paragraphs;
- mixed RTL/LTR text, such as Hebrew prose with English terminology;
- numbers, dates, punctuation, parentheses, citations, URLs, and equations
  inside RTL context;
- RTL tables, lists, captions, footnotes, and multi-column layouts;
- embedded fonts and missing-font fallback in RTL scripts;
- KaTeX and MathJax output, including canvas-flattening warning paths;
- vector SVG;
- canvas and animated canvas;
- Plotly, Vega, Mermaid, and representative scientific charts;
- lazy-loaded images;
- fixed and sticky headers;
- very long tables and code blocks;
- current form/input state;
- cross-origin iframe;
- video/WebGL warning paths;
- light/dark pages;
- malformed CSS and missing assets;
- pages that never reach network idle;
- navigation during export;
- renderer crash/unresponsive;
- tab close;
- disk write and permission failure;
- cancellation and supersession;
- huge page/page-count budgets;
- controlled Markdown/chat output with all selected content rendered;
- image/SVG page fitting, orientation, and transparent backgrounds.

### Test Layers

1. Pure unit tests for profiles, selection, state transitions, receipt
   construction, containment, and error mapping.
2. Desktop adapter tests with a fake/controlled web-contents host.
3. Real Electron integration tests invoking `printToPDF` on the synthetic
   corpus.
4. PDF.js structural and page-render validation tests.
5. Rasterized golden-page comparisons with tolerances.
6. Semantic assertions for text, links, page count, headings, current form
   state, and vector behavior where inspectable.
7. Logical-text round trips: PDF.js-extracted text order compared against the
   source's logical reading order for RTL, mixed-direction, table, list,
   footnote, and multi-column fixtures; plus selection, search, and copy/paste
   verification through the existing Scient PDF reader, not merely
   screenshots.
8. Regression tests for existing Browser screenshot, recording, color-scheme,
   DevTools/control-session, workspace PDF, and right-panel behavior.
9. Packaged-app acceptance on macOS, Windows, and Linux.

Do not compare PDF binaries byte-for-byte. Renderer metadata and valid engine
changes can alter bytes without altering visible output.

## Performance And Resource Quality

The fast path must:

- reuse the loaded page;
- avoid URL reload;
- avoid spawning another browser;
- avoid copying PDF buffers repeatedly across renderer/server boundaries;
- stream or write once on the desktop side;
- bound readiness, rendering, validation, and thumbnail work;
- queue per tab;
- clean up isolated controlled renderers after each operation.

Establish performance thresholds only after measuring the fixture corpus on
representative macOS, Windows, and Linux machines. Track at minimum:

- time from click to render start;
- readiness time by cause;
- Chromium PDF time;
- validation time;
- peak memory;
- PDF size/page count;
- cancellation latency;
- cleanup completion;
- queue behavior for simultaneous exports.

The first release must define reasonable failure budgets for extremely large or
pathological pages rather than hanging indefinitely or exhausting the desktop.

## Platform Implications

### Desktop

Desktop is the first complete host because the live page and Electron
`webContents` exist there. The action is explicitly desktop-capable.

### Web/Remote

A remote web client may request export only when the connected desktop host
advertises the capability and the target Browser surface belongs to that host.
Do not show a local-only action as universally available. Server-side Chromium
rendering is a separate future adapter, not an assumption in this slice.

### Mobile

Mobile can later read/download/share produced PDF artifacts. It does not need a
local Chromium export engine for this implementation.

### macOS

Verify ARM64/x64, packaged Electron, fonts, page dialog/save-copy behavior,
Unicode paths, artifact cleanup, signing/notarization implications, and dark
appearance.

### Windows

Verify x64/ARM64 where supported, long/Unicode paths, file locking, antivirus
interaction, atomic replacement semantics, temp cleanup, and A4/Letter locale
defaults.

### Linux

Verify packaged distribution, fonts, headless/graphics behavior, desktop
portals for Save Copy/reveal, artifact cleanup, and Chromium PDF consistency.

## Implementation Sequence

### Slice 1: Complete Production Browser-To-PDF Vertical

Purpose: ship the first real, permanent product capability end to end. A user
opens HTML or another page in Scient's Browser, activates **Export PDF**, and
receives a validated artifact opened in the existing PDF reader. Every layer is
the production layer later sources will reuse. There is no prototype,
throwaway spike, test-only renderer, duplicate API, or temporary integration
path.

Implement it from the foundations upward in one coherent slice:

#### 1A. Shared PDF Foundation And Reader Generalization

- Create the producer-neutral `packages/scient-document-artifacts/` boundary
  with `GeneratedDocumentArtifact`, `DocumentArtifactBinding`,
  `PdfSourceDescriptor`, validation-profile/warning vocabulary, and pure
  binding-transition logic.
- Add `packages/scient-pdf-validation/` with the pinned structural core and its
  existing-load and producer-registration profiles, executable through a
  bounded host worker.
- Add the server-owned artifact publication/resolution boundary, renewable
  signed asset URLs, and host-injected `PdfSourceResolver` plus source-scoped
  Save Copy/Reveal commands.
- Generalize the existing reader to accept descriptors and injected host
  capabilities while preserving the current workspace-file source unchanged.
- Preserve byte loading, cleanup, Save Copy, source switching, search, text,
  links, outlines, thumbnails, zoom, rotation, password behavior, and
  capability renewal.
- Implement the complete renewal/rebuild lifecycle, including monotonic binding
  generations, immutable revisions, stale last-success, reader-state
  preservation, revision-scoped search/auxiliary data, and reload only after
  validation.
- Prove the foundation with the permanent multi-revision lifecycle fixture
  defined above before either producer lane integrates.
- Land this foundation as the first standalone pull request so Browser export
  and LaTeX can consume the same contract immediately.

Foundation PR 1 is ready for downstream consumption only when:

- existing workspace PDFs retain exact loading, range, password, search,
  selection, outline, thumbnail, zoom, rotation, renewal, and cleanup behavior;
- descriptor and binding schemas round-trip through serialization without
  executable callbacks or raw producer paths;
- resolver host/environment mismatch fails closed with a typed, recoverable
  result;
- existing-load and producer-registration structural validation profiles pass
  the permanent valid, corrupt, sparse, deliberately blank, and password
  fixtures;
- the multi-revision lifecycle fixture passes every transition listed above;
- an integration test proves the reader contains no Browser-, LaTeX-, Typst-,
  or Quarto-specific source branch; and
- the LaTeX lane can import the neutral contracts and structural validator
  without depending on `scient-document-export` or desktop Browser code.

#### 1B. Permanent Browser Renderer And Export Contracts

- Create the permanent synthetic exporter fixture corpus inside the new
  repository.
- Add the production Scient-owned `BrowserPdfRenderer` service in
  `apps/desktop/src/scient/documentExport/` with its intended ownership
  boundary.
- Add the narrow, versioned request/result/warning/error contracts the
  coordinator, artifact, and UI layers consume.
- Resolve the current preview tab through a verified desktop-side lease.
- Render the exact loaded web contents through `printToPDF` without reload.
- Implement Current Appearance and Document Layout profiles.
- Implement PreviewManager-owned CDP media emulation, debugger-conflict choices,
  actual-profile receipts, and exact restoration; do not use injected CSS as a
  general screen-media substitute.
- Enforce a global export concurrency limit of one.
- Implement bounded font/image readiness.
- Restore all page state after success, failure, cancellation, navigation, or
  renderer failure.

#### 1C. Browser Validation, Publication, And Artifact Storage

- Invoke the shared structural validator for generated output and add the
  Browser-export profile's source-versus-output checks.
- Detect gross blank output without rejecting legitimate dark pages.
- Write candidate bytes separately, then publish validated artifacts atomically
  through the shared artifact boundary.
- Compute checksum, page count, source/renderer metadata, warnings, and the
  conversion receipt.
- Reject navigation-raced, corrupt, blank, partial, cancelled, superseded, and
  failed outputs before artifact completion.
- Enforce the initial 500 MiB/100-artifact limits, protected-artifact rules,
  receipt-preserving LRU eviction, and bounded startup/temp cleanup.
- Open a real exported Browser PDF through the same reader once the renderer
  lands.

#### 1D. Real Product Experience

- Mount **Export PDF** in Browser chrome through the narrow Scient seam.
- Show real preparation, rendering, validation, and opening progress.
- Support cancellation.
- Present durable warnings and recoverable failures.
- Open the validated result automatically in the existing PDF reader.
- Provide Save Copy, Reveal, Retry, and Export Again.
- Keep the source Browser tab open and unchanged.

#### Slice 1 Exit Criteria

- a user can export a real currently loaded Browser page with one action;
- static brochure, long report, current interactive state, broken-resource,
  dark-page, RTL/math, SVG, canvas, lazy-resource, and never-idle fixtures
  produce the expected result or an explicit truthful warning;
- RTL and mixed-direction fixtures pass both dimensions independently: visual
  comparison and PDF.js logical-text round trips with selection, search, and
  copy order verified through the existing reader;
- each content type meets its committed fidelity-matrix result, and every
  detectable "not promised" limitation (canvas content, WebGL, cross-origin
  frames) produces its receipt warning rather than silent visual plausibility;
- screen and print profiles work and restore correctly;
- DevTools/control-session conflicts never steal the debugger, and the user can
  retry exact Current Appearance or explicitly accept a receipted Document
  Layout downgrade;
- navigation, tab close, cancellation, supersession, renderer failure, disk
  failure, and blank output recover correctly;
- the generated artifact passes PDF.js validation and opens in the existing
  reader;
- the shared foundation's multi-revision lifecycle fixture passes, including
  monotonic supersession, renewal, state preservation, stale last-success,
  partial-output rejection, and revision-scoped search/auxiliary data;
- global concurrency is one and artifact quotas, protected lifetimes, eviction,
  temp cleanup, and storage-pressure behavior pass integration tests;
- existing workspace PDFs and Browser screenshot, recording, appearance,
  navigation, and automation behavior do not regress;
- focused unit, desktop integration, web integration, and PDF-reader tests pass;
- packaged macOS acceptance passes before calling the slice ready for Yaacov's
  review;
- Windows and Linux automated evidence is included where CI supports it, and no
  full cross-platform claim is made without packaged acceptance;
- all substantive code lives under the approved Scient-owned boundaries;
- the next source adapter uses these production contracts without replacing
  the renderer, validator, artifact store, reader source, receipt, or UX model.

This slice may be implemented as a dependency-ordered stack of small reviewable
commits or pull requests. Those are integration steps inside one production
vertical, not separate prototype phases.

### Slice 2: Controlled Scient Content

- Add isolated controlled render document.
- Add Markdown/report adapter.
- Add selected chat-content adapter.
- Add image and SVG adapters.
- Add complete/non-virtualized content and local math/font fixtures.
- Reuse the shared chat math renderer when it exists; until then, gate
  rendered-math fidelity and preserve raw TeX with an explicit warning rather
  than introducing a private export-only math implementation.

### Slice 3: Cross-Platform And Release Hardening

- Packaged macOS, Windows, and Linux acceptance.
- Performance and resource budgets.
- Visual golden corpus.
- Crash/cancellation/disk/cleanup acceptance.
- Optional tagged PDF and outline evaluation.
- User and internal implementation documentation after behavior is verified.

### Deferred Adapter Slices

- additional producer registrations beyond the independently coordinated
  LaTeX lane;
- Office/ODF qualified conversion;
- archival/accessibility/press-ready profiles;
- server/remote render hosts;
- complete document-platform session/build integration.

## Pull-Request Shape

Keep concerns separable and reviewable:

1. Shared PDF foundation: `GeneratedDocumentArtifact`,
   `DocumentArtifactBinding`, `PdfSourceDescriptor`, `PdfSourceResolver`,
   reader generalization, host actions, shared structural validator with
   existing-load/producer-registration profiles, and the complete
   renewal/rebuild lifecycle, proven with the permanent multi-revision fixture.
   This is permanent production infrastructure required by both Browser export
   and LaTeX, and it lands first.
2. Browser renderer, export contracts, and permanent fixtures.
3. Browser blank-output validation, export artifact store, and receipts.
4. Browser one-click UX completing Slice 1.
5. Controlled Markdown/chat/image/SVG adapters.
6. Cross-platform hardening and shipped documentation.

Do not combine universal-opener implementation, HTML-viewer repair, Office
conversion, LaTeX compilation, or document-session architecture into these
pull requests. Those lanes should integrate through the defined adapters.

## Independence And Coordination

This plan can start immediately from current desktop `origin/main`.

It does not wait for:

- final Scientific Document Platform acceptance;
- final document-session schemas;
- the universal file opener;
- LaTeX compilation;
- structured manuscripts;
- Office engine selection;
- collaboration or Overleaf decisions.

Coordination points:

- The HTML viewer must eventually render local content correctly; the exporter
  consumes its Browser surface rather than repairing it privately.
- The universal opener can later call into the export/result contracts; the
  exporter does not depend on its path policy.
- The LaTeX/typesetting lane consumes the shared PDF foundation contracts,
  renewal/rebuild lifecycle, validation profiles, and receipt vocabulary
  defined here; the boundary and the implementer's obligations are fixed in
  "LaTeX And Typesetting Producer Alignment".
- Final artifact/session architecture can adapt the versioned compatibility
  envelope; renderer implementation and quality tests survive.

## Regression Invariants

- Existing workspace PDFs open exactly as before.
- Browser screenshots and recording continue to work.
- Browser color-scheme emulation is restored after every export path.
- DevTools/debugger ownership failures remain understandable and recoverable.
- Export never navigates or reloads the source page.
- Export does not expand local-file or network permissions.
- Existing Markdown, image/SVG, browser, diff, terminal, and external-open
  surfaces retain their behavior.
- Remote/mobile clients do not receive a lying local capability.
- No truncated or partial content is presented as complete.
- No failed artifact is returned as success.

## Estimated Effort

- Complete production Browser-to-PDF Slice 1: estimate after the shared
  foundation PR establishes the real reader, capability, and lifecycle cost.
  Acceptance gates, not a calendar estimate, determine completion.
- Controlled Markdown/chat/image/SVG plus three-platform acceptance: total
  first scope approximately 4-6 focused engineering weeks for one experienced
  engineer.

Office fidelity, semantic extraction, LaTeX compilation, and press-ready
publishing are separate efforts.

## Approval Recommendation

Approve immediate implementation of Slice 1, the complete production
Browser-to-PDF vertical. Its internal work begins with the permanent shared PDF
foundation, followed by the Browser renderer and validation/publication path.
Approval is for the real end-to-end user capability rather than an experiment
or disposable intermediate feature.

Approved defaults should be:

- live Electron/Chromium renderer;
- Current Appearance for Browser pages;
- Document Layout for controlled documents;
- backgrounds enabled;
- no browser headers/footers by default;
- bounded readiness rather than global network idle;
- validation before artifact completion;
- automatic opening in the existing Scient PDF reader at the first shippable
  milestone;
- explicit receipts and warnings;
- Scient-owned implementation with four narrow inherited host seams;
- no alternative production renderer until corpus evidence justifies one.

## Completion Criteria For The First Shippable Milestone

The Browser vertical is complete only when:

- the exact loaded page can be exported without reload;
- current interactive state is represented where Chromium supports it;
- current-appearance and document-layout profiles work;
- fonts/images have bounded readiness and warnings;
- navigation, close, crash, cancellation, and disk failure recover correctly;
- generated bytes pass structural and blank-output validation;
- the artifact opens in the existing Scient PDF reader;
- Save Copy, Reveal, Retry, and Export Again work;
- the source page remains unchanged;
- existing Browser screenshot/recording/appearance and workspace-PDF tests pass;
- synthetic static, interactive, long, broken-resource, RTL/math, SVG, canvas,
  lazy-resource, and dark-page fixtures pass on both visual and logical-text
  dimensions per the fidelity matrix;
- packaged macOS acceptance passes, with Windows/Linux evidence completed before
  claiming full cross-platform readiness;
- no unrelated inherited T3 code owns the implementation;
- no proposal is described as final accepted document-platform architecture.

## Durable Documentation And Evidence

This repository plan is committed implementation authority for its lane, but
durable verified evidence must not wait until the whole program ends:

- the first production renderer PR adds a dated, maintained
  `scient-desktop-next/docs/internals/scient-pdf-export.md` recording verified
  Electron behavior, debugger/media ownership, tagged-PDF findings,
  canvas/WebGL limitations, platform evidence, and current contracts; this is
  implementation evidence, not a separate disposable-spike report;
- a separate documentation-owner follow-up should register the plan-recommended
  engine dispositions in the Scientific Document Platform Source Map now:
  Electron/Chromium as current host, Paged.js and WeasyPrint as watch,
  Vivliostyle as behavior reference, and wkhtmltopdf as excluded. This docs-only
  lane does not block or widen the desktop implementation worktree.

After shipped behavior is verified:

- record actual code ownership, contracts, failure behavior, and maintenance in
  `scient-desktop-next/docs/internals/`;
- record shipped user behavior in `scient-desktop-next/docs/user/`;
- refine the Scientific Document Platform source-map dispositions when verified
  implementation evidence changes the initial research classification;
- promote only accepted hard-to-reverse artifact or conversion architecture
  into the appropriate Scient architecture owner/ADR.
