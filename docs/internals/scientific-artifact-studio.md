# Scientific Artifact Studio roadmap

Status: proposed product architecture and staged implementation roadmap. This
document is the canonical coordination point for scientific artifacts, their
chat representations, and the future Studio. It is not a release record and
does not claim that planned formats are implemented.

## Decision

Scient should build a **Scientific Artifact Studio**: a workspace that consumes
durable scientific artifacts and lets people inspect, explore, compose, revise,
export, and insert them into scientific documents. The user-facing product may
still be called **Scientific Canvas**, but the architecture must not be a
single canvas-file renderer or a TSX preview feature.

The Studio is one presentation and authoring surface over producer-neutral
artifacts. Chat, file preview, Browser, the PDF reader, runtime result cards,
Office/manuscript editing, and the Studio remain distinct surfaces with clear
jobs. They reuse artifact identity and representations instead of duplicating
storage, viewers, or conversion pipelines.

The next implementation priority is not a broad Studio shell. It is the
artifact-to-chat bridge and reusable artifact presentation contract. That
foundation makes later Plotly, data-table, MATLAB, Python, HTML, TSX, and
domain-specific support additive rather than a sequence of unrelated patches.

## Product promise

A scientist should be able to:

- see an explanation, Mermaid diagram, declarative chart, result figure, or
  data table directly in chat;
- open the same result at full fidelity, preserving interactivity where the
  producer supplied it;
- identify the source, data, runtime, parameters, producing operation, and
  artifact revision behind a result;
- tell whether a result is current, updating, stale, partially available, or
  superseded by a failed attempt;
- compose figures, panels, labels, legends, annotations, and layouts without
  flattening the canonical source prematurely;
- ask an agent to make a reviewable change to the source or composition and
  see exactly what changed;
- export appropriate representations such as HTML, SVG, PNG, TIFF, and PDF;
- insert a stable artifact into an Office document, manuscript, LaTeX project,
  report, or presentation without making the editor own the scientific runtime;
- reopen the work later without losing provenance, revision identity, or the
  last successful view.

"Open it" and "show it in chat" must remain easy. Provenance, warnings, and
advanced actions should be available without turning every inline result into
a control panel.

## Terms

- **Source** is the canonical user- or project-owned input: code, data, a
  Mermaid or Vega-Lite fence, a notebook, a figure file, an HTML project, or a
  structured composition.
- **Operation** is the run, build, import, edit, or export that produces a
  result.
- **Artifact** is a durable scientific result with stable identity,
  provenance, and one or more immutable revisions.
- **Representation** is one usable form of an artifact revision, such as SVG,
  PNG, PDF, interactive HTML, Plotly JSON, Vega-Lite JSON, or native FIG.
- **Presentation surface** selects and renders a representation. Chat cards,
  the right panel, Browser, the PDF reader, and the Studio are presentation
  surfaces; they are not artifact authorities.
- **Studio composition** is a durable, structured arrangement of artifacts,
  data, controls, labels, and annotations. It references source artifacts
  instead of silently copying their pixels.
- **Manuscript surface** owns prose, citations, sections, pagination, and
  document semantics. It consumes artifacts; it does not replace the Studio.

## Product boundaries

| Surface                         | Owns                                                                                                        | Does not own                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Chat                            | Compact explanations, rich fenced source, artifact references, lightweight interaction, and handoff actions | Runtime output storage, arbitrary app compilation, or the canonical Studio document |
| File preview and Browser        | Opening files and applications at their natural fidelity, including local assets and interactive HTML       | Scientific composition history or manuscript semantics                              |
| PDF reader                      | Reading a PDF revision and preserving reader state                                                          | Producing the PDF or reconstructing editable source                                 |
| Runtime result UI               | Run status, diagnostics, captured outputs, provenance, and promotion                                        | A MATLAB-, Python-, or R-specific parallel viewer system                            |
| Scientific Artifact Studio      | Exploration, comparison, composition, declarative edits, review, export, and insertion                      | Full word-processing/manuscript behavior or a private execution engine              |
| Office/manuscript platform      | Prose, sections, citations, tables, document layout, collaboration, and publishing workflows                | Reimplementing chart runtimes or scientific artifact provenance                     |
| LaTeX/Overleaf-style experience | `.tex`, bibliography, assets, diagnostics, builds, SyncTeX, and PDF output                                  | Becoming the only artifact model or storing figures as opaque editor state          |

This separation lets each vertical slice remain useful on its own. A user can
run MATLAB and inspect a PNG before the Studio exists; use LaTeX without the
Office editor; and use the Studio without converting every project to one
proprietary document format.

## Complete product picture

```text
Producer sources
  Chat Markdown and agents
  MATLAB, Python, R, Julia and notebooks
  HTML, TSX, Quarto and scientific applications
  SVG, images, PDFs, native files and imported data
              |
              v
Producer adapters and build/run/import receipts
              |
              v
Artifact identity + immutable revisions + provenance
              |
              v
Representation set
  canonical/editable | interactive | static | publication | native
              |
              v
Shared presentation registry and authorized resource resolution
       +------+------+----------+-------------+
       |             |          |             |
      Chat       File/Browser  Studio     Office/manuscript
   compact card   full fidelity compose     insert/reference
```

## Foundations already present

The roadmap must extend, not replace, the following foundations:

- `ScientRichFence` is the one narrow Markdown presentation registry. Mermaid
  and Vega-Lite are implemented through that registry. Fenced Markdown remains
  canonical and unrecognized or streaming fences retain the inherited
  code-block fallback.
- Settled project-relative Markdown images use the Scient-owned workspace image
  card, with shared compact and expanded actions for supported raster formats
  and SVG. The referenced project file remains authoritative.
- `AnalysisArtifact` already models run-owned figures with hashed
  representations and `static`, `interactive`, or `native` presentation
  intent. `AnalysisArtifactStrip` already chooses static, interactive, and
  native actions and retains truthful current/updating/stale/partial status.
- The analysis runtime publishes immutable run results and can promote a run to
  a project-owned portable result with receipts and provenance. MATLAB currently
  captures bounded PNG and FIG representations.
- `GeneratedDocumentArtifact`, `DocumentArtifactBinding`,
  `PdfSourceDescriptor`, and `PdfSourceResolver` provide the independent
  generated-document lifecycle: immutable PDF revisions, stable logical
  document identity, last-success preservation, and renewable authorized URLs.
- Existing static artifact, Browser, file-preview, PDF-reader, right-panel, and
  floating-player surfaces already cover important presentations. The Studio
  should compose these capabilities rather than fork them.

Important gaps remain:

- chat cannot yet carry a durable typed reference to a run or project artifact;
- analysis artifacts are intentionally figure-only and support a small media
  type set;
- fenced diagrams and charts cannot yet be promoted into durable artifacts;
- artifact presentations and chat rich fences do not yet share a common
  renderer-adapter contract;
- there is no structured Studio composition, revision history, proposal/diff
  flow, or artifact-to-manuscript insertion contract;
- richer runtime producers, interactive tables, Plotly, capability-gated
  MATLAB SVG/HTML, project-resolved HTML, TSX applications, and specialist
  scientific renderers are not implemented.

## Authority and lifecycle rules

### Preserve the real source

An inline Mermaid or Vega-Lite fence remains authoritative inside its message.
A saved `.m`, `.py`, `.R`, `.jl`, `.tex`, `.html`, `.tsx`, notebook, or data
file remains project-owned source. A generated SVG, PNG, HTML, or PDF does not
silently replace it.

"Save as artifact" creates a durable artifact revision and receipt from the
source. It does not mutate the message, invent a hidden workspace file, or make
the disposable rendered DOM canonical.

### Keep artifact families distinct

Do not replace `AnalysisArtifact` and `GeneratedDocumentArtifact` with one
unstructured universal union:

- analysis artifacts are immutable outputs of a run and are naturally keyed by
  project, run, artifact, and representation;
- generated documents have a stable logical document binding, production
  generations, active revision, last successful revision, and rebuild
  lifecycle;
- imported project files retain file authority and revision semantics;
- future Studio compositions need their own structured source and revision
  contract.

They should share a small reference and presentation vocabulary, not all
producer-specific state. Common behavior should move into a shared contract
only after at least two real producers require the same semantics.

### Use typed references, never temporary URLs

A chat message, composition, manuscript insertion, or recent-item record stores
a serializable typed reference containing the owning authority and stable
artifact/revision identity. The host resolves that reference to current
capabilities and renewable URLs. Expiring asset URLs, absolute paths, thread
authorization IDs, and live renderer objects are never durable identity.

The first artifact-to-chat slice must inspect the current T3 message-part and
attachment contracts. Prefer an existing durable structured part if it can
round-trip without loss. Otherwise add one versioned Scient-owned message part
and one narrow host projection. Do not encode artifact identity in magic
Markdown comments or provider-specific tool text.

### Preserve last successful work

Rebuilds and reruns never blank a previously valid artifact. While a new
operation is running, surfaces show the last successful representation with an
updating state. On failure they preserve it with a truthful stale or
failed-latest state. A new revision becomes current only after publication and
the relevant validation profile succeed atomically.

### Retain provenance without leaking authority

Receipts record source revision, datasets or declared inputs, parameters,
producer and runtime identity, relevant tool versions, operation lineage,
content hashes, warnings, and output sizes. Portable promotion redacts machine
paths, credentials, renewable URLs, and private runtime details.

## Shared artifact reference and representation direction

The first bridge should define the minimum producer-neutral data required by
presentation surfaces. Names are illustrative until the contract PR is
reviewed; behavior is the decision.

### Artifact reference

A reference must identify:

- authority and project/environment scope;
- artifact family (`analysis-run`, `generated-document`, `project-file`, or
  `studio-composition`);
- stable logical identity and immutable revision where applicable;
- an optional preferred representation, never a required rendering URL;
- a display label and source/reveal capability resolved by the host.

### Representation descriptor

A representation should declare:

- representation ID, media type, content hash, byte length, and filename;
- format family separately from its declared schema/runtime version;
- presentation intent: canonical/editable, interactive, static preview,
  publication, thumbnail, or native continuation;
- dimensions or page count when known, without requiring them for every type;
- whether full fidelity needs local assets, network access, a runtime, or a
  native application;
- supported exports and whether interactivity can be serialized/restored;
- accessibility metadata such as title, description, units, and alternative
  text when the producer knows them;
- availability and validation warnings scoped to that representation.

Format family and source-schema version must not be conflated. For example, one
bundled current Vega-Lite runtime can accept compatible older specifications
after a non-mutating compatibility plan and reject unsupported future majors
honestly. Scient should not install one compiler per historical schema or tell
agents to hard-code whichever runtime version happens to be bundled today.

### Capability resolution

The host resolves `view`, `interact`, `edit-source`, `reveal`, `rerun`,
`download`, `export`, `compose`, and `insert` capabilities from the reference,
representation, current platform, and user authority. Components render those
capabilities; producers do not embed application policy into filenames or
media types.

## Presentation registry

The shared registry should let a renderer accept either settled fenced source
or a resolved artifact representation. Each renderer adapter declares:

- recognized language aliases, format families, and media types;
- source and decoded-data bounds;
- a lazy runtime loader and explicit disposal behavior;
- preparation and compatibility rules that never mutate canonical source;
- project-relative resource requirements and resolver capabilities;
- compact, expanded, loading, warning, source, and error presentations;
- interaction state capture/restore where meaningful;
- SVG, PNG, data, source, or other supported exports;
- accessibility behavior and keyboard interaction;
- desktop/web/mobile fallback behavior;
- a fixture corpus and focused lifecycle/performance tests.

Adding Plotly or a later renderer must add one Scient-owned registry entry. It
must not add another branch to inherited `ChatMarkdown`, another artifact
database, or a second browser/viewer framework.

Representation choice follows user intent and fidelity, not a fixed global
extension order:

1. honor an explicit requested representation when supported;
2. prefer a compatible interactive representation for exploration;
3. prefer SVG for scalable static scientific figures;
4. fall back to PNG for broad reliable display;
5. use PDF for paginated/publication reading;
6. retain native/source download and reveal actions even when Scient cannot
   render them;
7. show an actionable unavailable state rather than a blank surface.

## Chat integration

Chat has two complementary paths.

### Rich fenced source

Mermaid and Vega-Lite are appropriate when an agent can express the result as
small, self-contained, declarative Markdown. Plotly should be the next rich
fence because its declarative JSON covers scientific, statistical, 3D, and
high-volume interactive charts and is emitted by multiple language ecosystems.

Interactive data tables should follow Plotly. A table is often a more honest
first view than a chart and can support sorting, filtering, searching, types,
units, missing values, bounded export, and a deliberate "Chart selection"
handoff to Vega-Lite or Plotly.

Raw HTML and TSX are not the next chat fences. They need project assets,
dependencies, build receipts, navigation, runtime isolation, and a stable base
URL. Treat them as artifact/application representations and open them through
the appropriate full surface.

### Durable artifact cards

An artifact card should provide:

- a responsive static preview or compact interactive view when cheap;
- label, producing source, runtime, revision, and concise status;
- current, updating, stale, partial, and failed-latest states;
- primary Open/Explore behavior plus an overflow menu for source, data,
  download, export, reveal, rerun, compose, and insertion actions;
- existing right-panel and floating-view behavior where compatible;
- a readable fallback when the client lacks the renderer;
- stable message persistence through a typed reference.

The card should reuse current artifact presentation selection and status logic.
It should not duplicate `AnalysisArtifactStrip` as a second runtime-specific
UI.

### Agent awareness

Provider instructions remain short, provider-neutral, and capability-based:

- use Mermaid when relationships or sequences are materially clearer;
- prefer Vega-Lite for compact declarative statistical charts and linked
  views;
- use Plotly when the needed chart, 3D/WebGL behavior, or producer ecosystem is
  better served by Plotly;
- use a typed artifact reference for durable runtime or project results;
- when generating content intended for the chat area, prefer capabilities
  known to be available in Scient instead of app-specific visualization skills
  whose result Scient cannot display;
- preserve accessible titles, labels, units, and source/data context;
- use prose or ordinary code when a rich visual would not improve clarity.

Instructions should describe stable capabilities, not package versions, and
must not forbid valid alternatives or silently rewrite user prompts.

## Scientific Artifact Studio experience

The first dedicated Studio workspace should be earned by the multi-panel figure
and interactive exploration workflows. It should consume the artifact
foundation above rather than start as a blank infinite canvas.

### Explore

- inspect interactive data and controls;
- switch among representations without losing artifact identity;
- compare revisions, runs, parameter choices, or conditions;
- inspect source, inputs, units, warnings, and provenance;
- pin useful views or selections as reviewable derived state.

### Compose

- arrange figures and subfigures into grids or free layouts;
- align, distribute, crop viewports, resize, and preserve aspect ratios;
- add panel labels, annotations, arrows, scale bars, legends, captions, and
  accessible descriptions;
- bind multiple panels to shared selections or parameters where supported;
- retain each panel's source artifact and chosen revision;
- warn when a source becomes stale or an export would flatten interactivity.

Manual edits should be declarative operations over a structured composition
when possible. Destructive pixel edits may be useful, but they create a derived
raster representation and never overwrite the canonical figure silently.

### Agentic editing and review

Studio state should be project-visible, deterministic, diffable, and
schema-versioned. An agent proposes operations against stable node and artifact
IDs. The user can review, accept, reject, or revert the proposal. Regeneration
must not erase manual annotations or layout unless the user accepts that
change.

The agent should be able to:

- add or replace a representation;
- edit declarative chart or composition source;
- change labels, encodings, styles, annotations, and layout;
- update data bindings and parameters;
- rerun the responsible producer through its owned runtime adapter;
- request an export or manuscript insertion through explicit host
  capabilities.

It should not manipulate opaque screen coordinates as the primary persistence
model or patch generated SVG/HTML when canonical source is available.

### Export and insertion

Exports are immutable derived representations with receipts. The initial
targets are HTML for preserved interactivity, SVG for vector figures, PNG for
broad compatibility, TIFF for publication workflows that require it, and PDF
for paginated or print-oriented output.

The Studio should reuse the browser/HTML-to-PDF coordinator for a live or
controlled HTML surface and the generated-document foundation for published
PDF revisions. It should not add its own Chromium printing path.

Office/manuscript and LaTeX integrations consume artifact references plus an
explicit chosen representation:

- Office/manuscript editing owns caption placement, citations, anchors, flow,
  and page layout;
- LaTeX materializes a compatible SVG, PDF, PNG, or other declared asset into
  the project/build input and records the originating artifact revision;
- a refreshed artifact can be offered as an update without silently replacing
  a manually pinned manuscript revision;
- future structured Scient manuscripts may project to DOCX, JATS, HTML,
  LaTeX, and PDF with fidelity reports, while original file-native Office and
  LaTeX projects remain canonical in their own modes.

This foundation is therefore long-lived for a future Overleaf-style
experience. The LaTeX editor/compiler adds authoring and build behavior on top;
it does not make artifact identity, representations, provenance, or insertion
temporary.

## Relationship to adjacent product areas

### Universal file opening and Browser

The universal opener decides which existing surface can display a file. The
Studio decides how a scientific artifact is explored, composed, revised, and
reused. They meet through the presentation registry:

- ordinary images, SVG, PDF, source, HTML, and native files should open without
  first becoming Studio documents;
- a user may deliberately add an opened file to a composition by stable file or
  promoted-artifact reference;
- interactive HTML should use the full Browser/artifact surface with normal
  scripts and local assets, not a restricted imitation inside the Studio;
- Studio actions such as source, reveal, open, and export should route back to
  the universal surfaces.

This keeps the opener broad and smooth while preventing every file type from
growing a second viewer inside the Studio.

### PDF rendering, reading, and semantic extraction

These are separate operations:

- HTML, chart, and composition **rendering to PDF** produces a visual
  representation through the shared PDF-export coordinator;
- the **PDF reader** presents the produced or existing PDF and preserves reader
  state through its stable source descriptor;
- **semantic extraction** produces text, coordinates, equations, tables,
  citations, or structure through qualified extraction adapters and receipts.

The Studio can consume extracted figures, tables, or structured data when an
extractor publishes them as derived artifacts with page/region provenance. It
must retain the original document as canonical evidence and must not treat a
good screenshot or successful PDF export as proof of semantic correctness.

### Sources, citations, and literature

The Sources system owns literature records, attachments, metadata,
deduplication, and citation identity. A Studio artifact may cite or derive from
one or more Sources records, but the Studio does not create a second reference
library. Manuscript insertion can carry the artifact reference, caption, and
related citation IDs to the document surface without embedding the complete
library record in the figure.

### Agent tools and host awareness

Inline declarative rendering does not require an agent tool: an agent emits a
supported fenced block and Scient presents it. Durable operations do require
explicit host capabilities. After the artifact bridge exists, Scient can expose
small provider-neutral tools for resolving, saving, composing, exporting, and
inserting artifacts.

Those tools return typed references and receipts, not magic text or temporary
URLs. Provider instructions state that the capabilities exist inside Scient;
an agent running outside Scient will not see the tools and should fall back to
portable Markdown, files, or ordinary prose. App-specific skills must not make
an agent assume that a Codex-only visualization surface is available in Scient.
Tool names and schemas should be fixed only when the underlying artifact
operations exist.

## Producer strategy

### Agent-authored chat content

- Mermaid: current diagram family.
- Vega-Lite: current interactive visualization family.
- Plotly: next declarative scientific chart family.
- Tables: next structured-data presentation after Plotly.
- Promotion: later save fenced source as a durable artifact without changing
  the message source.

### MATLAB

Keep one general analysis-artifact flow:

- retain PNG as the reliable static fallback and FIG as native continuation;
- add SVG capture when the discovered MATLAB release supports it and record a
  failed optional representation without failing the calculation;
- add interactive HTML/web-canvas capture only when runtime capability
  detection proves support;
- keep PNG/SVG available beside HTML so chat, export, older clients, and failure
  recovery never depend on the interactive representation;
- route HTML through the shared artifact/Browser surface and PDF through the
  shared reader and generated-document boundaries.

MATLAB documentation currently identifies SVG export from R2025a and
interactive HTML web-canvas export from R2026a. Capability detection, not a
hard-coded optimistic format list, remains authoritative.

### Python, R, Julia, and notebooks

These are producer adapters, not separate viewers:

- Matplotlib, Seaborn, ggplot2, Makie, and similar static systems publish SVG
  plus PNG fallback where supported;
- Plotly-producing runtimes publish declarative Plotly JSON plus a static
  fallback;
- Bokeh, htmlwidgets, and similar systems may publish interactive HTML plus a
  static fallback;
- Jupyter-compatible execution should ingest a bounded MIME bundle and retain
  the useful representations instead of scraping notebook DOM;
- producer receipts bind outputs to code revision, inputs, environment, and
  parameters.

The Jupyter MIME-bundle pattern is a useful interoperability reference because
one result can carry multiple representations and the frontend selects an
appropriate one. Scient still owns artifact identity, validation, retention,
and authorization.

### Imported files and applications

- SVG, images, and PDFs should use existing file/static/PDF surfaces and may be
  promoted into a Studio composition by reference.
- Interactive HTML is a first-class artifact representation. It needs a stable
  project base, authorized local assets, normal JavaScript execution, explicit
  loading/error/navigation states, and static/export fallbacks where available.
- TSX is source code, not a visual file format. A later application adapter
  should identify an entry point, dependency lock, data inputs, build/runtime
  receipt, preview URL, and last successful bundle. It should open through an
  application/Studio surface, never by evaluating raw TSX inside chat.
- Quarto and notebook reports may produce HTML and PDF document
  representations while exposing figures and tables as separately reusable
  artifacts when the producer can identify them.

## Format roadmap

| Capability                       | Value                                                                 | Dependency                                                                  | Disposition                                     |
| -------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| Mermaid                          | Explanatory relationships and workflows                               | Shared rich-fence seam                                                      | Implemented                                     |
| Vega-Lite                        | Compact interactive statistical charts                                | Shared rich-fence registry                                                  | Implemented                                     |
| Artifact cards in chat           | Connect real results to conversation                                  | Typed artifact reference and resolver                                       | Next foundation                                 |
| MATLAB SVG and HTML              | Higher-fidelity and interactive native output                         | Runtime capability detection and representation opt-in                      | Next producer extension                         |
| Plotly JSON                      | Scientific, statistical, 3D, and cross-language charts                | Shared registry plus artifact representation                                | Next rich renderer                              |
| Interactive tables               | Universal data inspection and chart handoff                           | Typed bounded dataset representation                                        | Follow Plotly                                   |
| Python/R/Julia/Jupyter producers | Broad scientific-computing coverage                                   | Runtime adapters and MIME/representation ingestion                          | Follow artifact cards and core renderers        |
| Project-resolved HTML            | Reports, Bokeh/htmlwidgets, MATLAB web canvas, and applications       | Full HTML viewer, local asset resolver, lifecycle states                    | High-value artifact surface, not raw chat fence |
| Studio composition               | Multi-panel figures, reviewable edits, provenance, and exports        | Artifact reference, renderer registry, and at least two real producers      | Begin after bridge/renderers prove the workflow |
| TSX application adapter          | Agent-built dashboards, simulations, and custom interfaces            | Project build manifest, dependency/runtime receipts, and Studio app surface | Later Studio capability                         |
| Domain renderers                 | Molecules, volumes, medical images, meshes, genomic tracks, and trees | Pluggable registry plus domain fixtures and metadata                        | Add by validated scientific workflow            |

The remaining order is:

1. add typed artifact references and reusable artifact cards in chat;
2. add MATLAB SVG and capability-gated interactive HTML representations;
3. add one Plotly runtime shared by fenced source and artifact
   representations;
4. add bounded interactive scientific tables and chart-selection handoff;
5. add Python, R, Julia, and Jupyter producer adapters;
6. complete project-resolved interactive HTML artifact handling;
7. implement the first composition-focused Studio workspace;
8. add the TSX/custom-application adapter through that workspace;
9. add domain renderers according to validated scientific workflows.

## Implementation slices and exit criteria

### Slice 0: Current rich-visualization foundation (landed)

- keep one settled-fence branch in inherited `ChatMarkdown`;
- retain lazy loading, bounded input, recovery states, source round-tripping,
  full interaction, current-state export, and mobile/source fallback;
- retain provider-neutral capability instructions without package-version
  coupling;
- land the architecture and fixture documentation.

Exit: Mermaid remains regression-green; compatible older Vega-Lite source
renders without version-only noise; future majors and malformed specs fail
actionably; layered interactions, export, disposal, long-chat laziness, and
production chunking pass.

### Slice 1: Artifact-to-chat bridge

- verify the durable T3 message-part/attachment seam before defining storage;
- add the smallest versioned typed artifact reference;
- add host resolution to capabilities and renewable resources;
- reuse presentation selection, freshness status, static surfaces, right-panel,
  and floating behavior;
- render one compact artifact card with honest fallback and recovery;
- prove cross-thread/project/environment identity and authorization behavior.

Exit: a real retained analysis figure can be attached or referenced in chat,
reopened after restart, and resolved after URL renewal without copying the
payload into the message or losing provenance.

### Slice 2: Rich producer representations

- capability-gate MATLAB SVG and HTML capture while retaining PNG/FIG;
- define format-family metadata and representation validation;
- add partial-publication receipts and fallback selection tests;
- reuse Browser/static/PDF surfaces rather than special MATLAB viewers.

Exit: supported MATLAB releases publish the richer representations; older
releases and partial capture remain successful with truthful fallback.

### Slice 3: Plotly

- exact-pin and lazy-load one local Plotly runtime;
- share parsing, bounds, theme, interactions, state transfer, disposal, and
  export between a `plotly` fence and Plotly artifact representation;
- support compatible producer JSON rather than HTML scraping;
- retain static fallback and source/data access;
- add accessible, RTL/Unicode, large-data, 3D/WebGL, malformed, and long-chat
  fixtures.

Exit: agent-authored and Python/R/MATLAB-produced Plotly figures use the same
renderer and behave consistently inline, expanded, and when reopened.

### Slice 4: Interactive scientific tables

- define a bounded typed dataset representation with fields, types, units,
  missing values, and provenance;
- support sorting, filtering, searching, column visibility, copy, and bounded
  export;
- preserve exact values and distinguish display formatting from source data;
- send an explicit selection or view into Vega-Lite/Plotly without mutating the
  source dataset.

Exit: representative CSV/TSV/Arrow-or-equivalent/JSON producers can present a
large but bounded table with correct types, Unicode/RTL, missing values, and
reproducible chart handoff. The final binary format choice requires an evidence
spike rather than an invented universal schema.

### Slice 5: Additional runtime and notebook producers

- add producers one at a time behind the existing runtime registry;
- normalize output into artifact representations and receipts;
- ingest bounded MIME bundles for notebook-compatible execution;
- prove cancellation, stale-source refusal, partial outputs, restart recovery,
  and cross-platform discovery per runtime.

Exit: each producer is independently useful and passes a real-runtime corpus;
no producer adds a new artifact viewer or message storage mechanism.

### Slice 6: Project-resolved HTML

- open static and interactive local HTML with a stable document base and
  authorized relative assets;
- run normal page JavaScript and interactions in the full Browser/artifact
  surface;
- distinguish loading, ready, missing-resource, malformed-document,
  navigation, crash, and retry states;
- preserve current live state for HTML-to-PDF export where possible;
- provide static fallback metadata when the producer supplies it.

Exit: static reports, MATLAB web canvas, Quarto/Jupyter reports, and one
additional interactive producer pass local-asset, interactivity, navigation,
error-recovery, and PDF-export fixtures on supported desktop platforms.

### Slice 7: First Studio workflow

- implement artifact exploration and multi-panel figure composition;
- store schema-versioned project-visible composition source;
- add stable node IDs, revisions, agent proposals, diff/review, and stale-source
  handling;
- export HTML/SVG/PNG/TIFF/PDF through qualified adapters;
- insert a pinned representation into one manuscript/Office/LaTeX workflow
  without coupling their storage models.

Exit: a scientist can compose a publication figure from at least two producer
families, accept an agent-authored revision, regenerate one source, review the
stale/update state, and reproduce exports after restart.

### Slice 8: TSX and custom applications

- define a project-owned application manifest with entry point, dependency
  lock, data inputs, commands, and output capabilities;
- build through a bounded host service with diagnostics, cancellation, last
  successful preview, and receipts;
- preview through the application/Browser surface and embed/reference it in the
  Studio;
- keep app dependencies outside the chat renderer and the inherited T3 UI.

Exit: a real agent-authored scientific dashboard survives rebuild failure,
restart, dependency mismatch, and source revision changes without losing the
last valid preview or becoming an opaque chat blob.

## Quality and test contract

Every format or producer adds evidence at the correct layer:

- schema/contract round trips, migrations, corrupt-state recovery, and stable
  identity tests;
- resolver tests for URL renewal, authority isolation, missing payloads, and
  platform fallback;
- renderer tests for parsing, bounds, lifecycle disposal, resize, theme,
  interactivity, state transfer, export, accessibility, and error containment;
- producer tests for source revision, inputs, receipts, hashes, partial output,
  cancellation, retry, restart, and last-success preservation;
- integration tests covering producer -> publication -> reference -> resolver
  -> card/viewer -> reopened session;
- fixture corpora for Unicode and RTL, accessibility, large inputs, math,
  vectors, raster output, 3D/WebGL where relevant, missing resources, malformed
  source, and unsupported versions;
- real-runtime acceptance for each runtime-specific producer;
- manual light/dark and compact/expanded visual review for user-facing changes;
- production-build verification that large renderers stay in lazy chunks.

Focused unit and integration suites belong with their packages and run in
normal CI. Heavy real-runtime, browser-matrix, and large-corpus checks should be
separate scheduled or release evidence when they would materially slow every
documentation or frontend-only change. Do not weaken the required aggregate CI
gate to hide expensive tests.

## Platform behavior

- Desktop is the first full-fidelity target for local runtimes, native files,
  interactive HTML, Studio composition, and filesystem-backed artifacts.
- Web/remote can render compatible resolved representations but depends on
  server capabilities and cannot assume local native applications or paths.
- Mobile must retain readable source/static fallbacks before adding rich
  renderers. No message migration should make older clients blank.
- Runtime discovery, executable behavior, fonts, browser graphics, SVG/TIFF/PDF
  output, and process cancellation require separate macOS, Windows, and Linux
  acceptance.
- Artifact identity is independent of renewable URLs, authorizing thread IDs,
  and platform-specific paths.

## T3 upstream separation

- Keep producer, artifact, renderer, and Studio implementations under
  Scient-owned packages and `apps/*/src/scient` roots.
- Keep the inherited Markdown integration to one shared settled-fence registry
  branch and protect it with a static seam test.
- Reuse inherited preview, Browser, editor, right-panel, attachment/message,
  and project-navigation contracts through narrow mounts. Do not copy those
  systems into a Scient-only shell.
- If durable artifact references require a shared message contract, make the
  addition versioned, generic, and as small as possible; first check whether an
  existing T3 structured part already satisfies the lifecycle.
- When T3 gains equivalent extensible presentation or artifact capabilities,
  adapt the Scient-owned registries to that host and retire redundant seams.
- Each PR names its inherited seams and carries a seam-verification test so an
  upstream refresh cannot silently drop Scient behavior.

## Source and behavior map

| Source                                                                                                                  | Use                                                                                                    | Disposition                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `packages/scient-analysis`                                                                                              | Run-owned artifact identity, hashed representations, receipts, and runtime-neutral producer vocabulary | Current Scient foundation; extend deliberately                                 |
| `packages/scient-document-artifacts`                                                                                    | Generated PDF identity, rebuild binding, last-success lifecycle, and reader source resolution          | Current Scient foundation; do not merge into analysis artifacts                |
| `apps/web/src/scient/presentation`                                                                                      | Rich fenced-source registry and shared presentation utilities                                          | Current Scient-owned registry; grow into the artifact renderer registry        |
| `apps/web/src/scient/analysis` and `apps/web/src/scient/artifacts`                                                      | Representation selection, freshness projection, static surfaces, right-panel, and floating behavior    | Reuse for artifact cards and Studio                                            |
| Existing Browser, file preview, PDF reader, editor, and project surfaces                                                | Full-fidelity file/application viewing and navigation                                                  | Reuse through narrow Scient mounts                                             |
| [Jupyter messaging](https://jupyter-client.readthedocs.io/en/latest/messaging.html#display-data)                        | Multi-representation MIME-bundle behavior                                                              | Interoperability reference; Scient owns durable identity and policy            |
| [Vega-Lite](https://vega.github.io/vega-lite/docs/) and [Vega-Embed](https://vega.github.io/vega-lite/usage/embed.html) | Declarative grammar, compilation, interaction, and embedding behavior                                  | Bundled renderer; adapt around Scient lifecycle and UX                         |
| [Plotly.js](https://plotly.com/javascript/)                                                                             | Declarative cross-language scientific, statistical, 3D, and WebGL figures                              | Next renderer and producer representation; do not depend on Chart Studio cloud |
| [MATLAB `exportgraphics`](https://www.mathworks.com/help/matlab/ref/exportgraphics.html)                                | PNG/PDF, SVG from R2025a, and interactive HTML web canvas from R2026a                                  | Capability-gated producer behavior; retain fallbacks                           |
| Overleaf/LaTeX, Quarto, notebook, and Office ecosystems                                                                 | Authoring, build, publication, and interchange behavior                                                | Integrate through artifacts and qualified adapters; do not copy wholesale      |

External projects are sources of behavior, interoperability formats, fixture
ideas, and UX patterns. Their licenses, maintenance posture, runtime size,
security model, accessibility, and offline behavior must be reviewed before a
dependency is added. This roadmap does not authorize copying or importing an
entire application.

## Approval gates

Before each slice begins, confirm:

- the irreducible user workflow and why an existing surface is insufficient;
- the owning package and exact T3 seams;
- the canonical source and durable identity;
- supported representations and truthful fallbacks;
- resource, platform, accessibility, and performance budgets;
- producer and renderer fixture corpora;
- migration and retirement behavior if an upstream equivalent lands;
- coordination with active LaTeX, Office/manuscript, HTML/PDF, and runtime PRs.

The recommended next approved implementation is **Slice 1: Artifact-to-chat
bridge**. Plotly is the next renderer, but it should land on that bridge rather
than become another isolated inline-only feature.
