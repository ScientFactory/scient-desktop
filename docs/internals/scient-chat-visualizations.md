# Scient rich chat visualizations

Status: Vega-Lite and Plotly implemented on the shared rich-fence presentation
seam. Source Markdown remains canonical.

## Architecture and ownership

Scient owns `apps/web/src/scient/presentation` and
`apps/web/src/scient/visualizations`. The presentation registry recognizes a
settled rich fence and routes it to a Scient-owned renderer. The inherited T3
host keeps one narrow branch in `ChatMarkdown.tsx`; streaming and unrecognized
fences retain the ordinary upstream code-block behavior. A static seam test
guards this boundary. Markdown file previews already use `ChatMarkdown`, so
they receive the same behavior without a second integration.

This is a representation layer, not an artifact database. The fenced JSON is
authoritative and `data-markdown-copy` preserves it during whole-message copy.
SVG, PNG, the Vega and Plotly runtimes, and interaction state are disposable local
representations. The [Scientific Artifact Studio roadmap](./scientific-artifact-studio.md)
defines how a future adapter resolves a durable `.vl.json` or `.plotly.json`
artifact and its project-relative datasets into these runtimes without moving identity,
provenance, or persistence into the chat card. It also defines the shared
renderer direction for tables, HTML artifacts, and later scientific
formats so they do not add more inherited Markdown seams.

## Runtime contract

Plotly uses the exact-pinned complete 3.7.0 browser distribution, dynamically
imported only for a settled visible Plotly fence. MathJax 3.2.2 is loaded in a
separate lazy chunk only when a figure contains TeX-like labels. The versions
are deliberately paired to the current stable Plotly integration;
upgrade Plotly and its math runtime together after compatibility verification.
The original JSON or JSONC is never rewritten: a structured clone receives responsive host
defaults, current light/dark presentation when the author supplied no template,
and local interaction policy. The host disables editing and cloud/Chart Studio
actions, hides Plotly's native modebar, and provides a small Scient-owned
interaction toolbar instead. The toolbar calls only Plotly's public relayout
and reset surfaces; it does not rewrite Plotly DOM or depend on private modebar
handlers. The Scient card exports the current live view.

The lazy Plotly runtime uses the full strict distribution, whose regl-based
traces avoid function constructors and therefore work under Scient's CSP
without `unsafe-eval`. Portable Plotly.py typed-array JSON, animation frames, 2D, 3D, WebGL, map,
financial, statistical, image, table, hierarchy, and flow traces are accepted
by the complete distribution. Encoded arrays are checked for a supported dtype,
complete base64 data, and consistent dimensions before reaching Plotly, so a
truncated payload produces a local source error instead of a misleading WebGL
fallback. Common named light/dark templates and compatible string title
shorthand are normalized only in the disposable render copy. Source is bounded to 1,000,000 characters,
500,000 inspected values, 512 traces, and 2,000 frames before the runtime is
loaded. Remote images, GeoJSON, map tiles, and Plotly geography topology retain
Plotly's normal network behavior and are labeled as network content; no CSP
exception or credential-bearing Scient loader is added.

Inline Plotly state is captured before a WebGL view is released offscreen and
when a figure moves to or returns from the expanded dialog. SVG figures remain
mounted after first use; WebGL and map figures release contexts after a short
offscreen grace period. A Scient-owned activity pool limits the conversation to
two simultaneously mounted WebGL figures, and one global mutation queue orders
Plotly mount and purge work. This stays below Chromium's bounded context budget
without virtualizing WebGL or changing the canonical figure. Before purging an
offscreen graph, the host uses the standard `WEBGL_lose_context` extension to
return its canvases immediately instead of waiting for browser garbage
collection. Plotly cards must not use `content-visibility: auto`: the viewport
hook mounts WebGL 500px before the card is on screen, and Chromium still skips
layout of those subtrees, so regl sees a 0×0 canvas. Inline charts also must
not force `.svg-container { height: 100% }`; that percentage computes to 0 when
the parent height is auto, which is the same `.no-webgl` failure. Fill-height
CSS is limited to the expanded dialog, which has a definite flex height.
Context loss, a zero-size layout, and true context exhaustion become local,
retryable card errors; Plotly's raw external WebGL fallback never becomes
viewer UI. Reset, SVG, PNG, and clipboard export operate on the current graph,
including
zoom, legend, and animation state. WebGL layers embedded in SVG export are
truthfully reported as rasterized.

The exact-pinned Vega 6.3.1, Vega-Lite 6.4.3, vega-embed 7.1.0, and
vega-tooltip 1.0.0 packages are bundled locally. The renderer and tooltip
adapter are dynamically imported only when a settled chart enters the viewport
margin. The runtime uses Vega's CSP-safe AST expression interpreter, not
`unsafe-eval`, and registers the missing `Math.hypot` interpreter function
until the upstream Vega release containing that fix is adopted.

Valid JSONC conveniences (comments and trailing commas) are accepted, but the
untouched source is retained. Source is bounded to 1,000,000 characters,
100,000 inline rows, and 250,000 inspected values. Unsized unit/layer charts
receive non-mutating responsive presentation defaults. Multi-view facet,
repeat, and concatenation specifications retain authored child sizing because
there is no single container-width rule that preserves both horizontal and
vertical composition; agents should choose their dimensions deliberately. A
Scient-owned render plan removes schema metadata from its disposable input so compatible older
specifications do not produce Vega-Embed's version-only warning; a declared
future major is rejected before compilation. The same plan scopes an otherwise
unscoped layered selection to one deterministic view, including layers nested
inside facet and concatenation specifications. Generated owner names are
unique across the complete composed chart, avoiding duplicate Vega signals
while every layer can still reference the shared selection. A
legend-bound selection preserves a compatible shared legend when sibling
layers suppress it. These corrections affect only the disposable render copy.
The renderer uses SVG for crisp text and current-state export; Vega-Lite's
complete grammar and signals remain available for selections, tooltips, bound
controls, and linked views.

Inline and `data:` resources stay local. Absolute HTTP(S) resources are loaded
by the viewing web or Electron client without credentials, with a 15-second
timeout and a 20 MiB decoded-response limit. Public servers therefore need to
allow browser cross-origin access. HTTP(S) loopback and private-network
addresses remain intentionally available for local scientific data servers;
`localhost` means the device viewing the chart, not necessarily the project
environment. The card discloses this before loading with a `Network data`
badge, and network failures mention availability and CORS. Relative paths and
local protocols fail with an actionable explanation because chat has no stable
project base. This explicit viewing-client policy remains isolated behind the
loader so a future project-file resolver can add authorized local assets
without changing chat's network semantics. If shared-chart policy later needs
consent, add an explicit load gate rather than an incomplete hostname
blacklist.

## Interaction and UX lifecycle

The card has explicit idle, loading, ready, warning, source, and error states.
A chart can be retried without affecting its message. The expanded dialog owns
a second live Vega view: current signal/data state moves into it on open and
returns to the inline chart on close. Its toolbar retains source copy/download,
reset, SVG, PNG, and clipboard actions. Expanded exports operate on that live
view; compact-card exports operate on the inline view, never a stale
source-only rerender. A theme-only remount snapshots and restores the current
Vega state, preserving brushes, legend selections, and bound controls while
still recompiling theme-dependent presentation. State is not transferred when
the authored chart or an explicit incoming state changes.

Plotly keeps direct manipulation, hover, legends, animation controls, and 3D
orbit inside the figure. A fixed horizontal Scient interaction row replaces
the native modebar: Cartesian figures expose zoom, pan, box selection, lasso
selection, and reset through the view controller, while other trace families
show the universally valid reset action. This keeps the controls stable across
mounts without pretending that two-dimensional drag modes apply to every
Plotly subplot type.

Tooltips use Vega's formatter and viewport-aware mark positioning, but a
Scient-owned adapter suppresses redundant DOM measurement while pointer events
continue over the same item and content. A compiled-spec patch supplies a
crosshair only for tooltip-bearing marks that have no cursor; Vega's native
pointer, link, legend, brush, and author-defined cursors always win. Neither
policy mutates the fenced Vega-Lite source or routes hover state through React.

Only responsive charts observe their available width. Height-only and
subpixel measurements are ignored; meaningful width changes are
animation-frame coalesced and serialized per view. This prevents chart output
height from feeding back into another Vega resize. Every unmount finalizes the
Vega view, including a late async mount. Charts outside the viewport do not
load the runtime, and `content-visibility` bounds layout work in long
conversations. Theme defaults provide readable axes, legends, headers, and
titles without replacing the author's semantic color encoding.

## Provider discovery and platform fallback

Scient's compact shared awareness contract names Mermaid, Vega-Lite, and Plotly,
requires self-contained source, and distinguishes chat representation from a
durable artifact. Provider delivery and capability gating are governed centrally
by [the provider architecture](./providers.md#scient-awareness), not by each
renderer. No renderer injects hidden user text or project instruction files.

Desktop and web render the rich chart. Mobile and older clients continue to
show readable fenced JSON. No protocol negotiation or message migration is
required.

## Verification and upstream maintenance

Unit tests cover registry aliases, Markdown round-tripping, JSON diagnostics,
bounds, responsive preparation, real Vega-Lite compilation and Vega parsing
of root and composition-nested layered hover/legend selections, resource
policy, fetch/CORS diagnostics, limits, theme-state remount policy, theme
defaults, stable tooltip deduplication, cursor preservation, export bounds,
lazy-runtime/CSP invariants, Plotly source limits and typed arrays, runtime
state transfer, animation lifecycle, math loading, server fallback, and the
single T3 seam. Provider tests cover the shared contract, its conditional
preview block, and every built-in delivery decision. A production build must
keep both engines in lazy chunks.
`docs/fixtures/scient-chat-visualizations.md` and
`docs/fixtures/scient-chat-plotly.md` are the interactive light/dark and
recovery corpus.

On a T3 refresh, reapply only the shared settled-fence branch in
`ChatMarkdown.tsx`. If upstream gains an equivalent extensible rich-fence
registry, retire the inherited seam and adapt the Scient-owned cards to that
host contract rather than maintaining parallel Markdown forks.
