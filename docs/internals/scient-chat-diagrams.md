# Scient rich chat diagrams

Status: implemented on top of the chat-math foundation; Mermaid source remains
canonical chat Markdown.

## Product and ownership boundary

Scient owns `apps/web/src/scient/diagrams`: recovery and caching, the inline
card, expanded viewer, export helpers, styles, and tests. Rendering uses the
upstream Pele lazy loader and sanitized mount in
`components/chat/MermaidDiagram.tsx`; there is no parallel Mermaid runtime. The inherited T3 host
has one renderer branch in `ChatMarkdown.tsx`, inside a marked `SCIENT-FORK`
region of the `pre` renderer: eligible rich fences pass through
`scient/presentation/ScientRichFence.tsx` to their owned renderer, including
`MermaidDiagramCard` for Mermaid. A closed Mermaid fence may render while the
rest of the message streams. Unfinished streaming Mermaid fences stay on the
source-code path; Plotly and Vega-Lite fences wait for the message to settle.
Ordinary fences use Scient's `MarkdownCodeBlock`
(`scient/presentation/MarkdownCodeBlock.tsx`, a copy of T3's code block).
Mounted consumer tests protect these boundaries during upstream refreshes.
Because Markdown file previews already share `ChatMarkdown`, they receive the
same behavior without a second viewer integration.

There is no wire-format, database, attachment, artifact-store, or Markdown AST
fork. The source already present in the assistant message is authoritative;
SVG and PNG are disposable local representations. This is intentionally the
first presentation layer for the future Scientific Artifact Studio, not a
second artifact model. A future “save as artifact” action should follow the
[Scientific Artifact Studio roadmap](./scientific-artifact-studio.md) and its
typed artifact-reference boundary rather than adding persistence to the
diagram card.

## Rendering pipeline

Pele's `pele/lazy` entry loads its core and each diagram family separately.
An eligible card starts rendering within a 400 px viewport margin, including
a closed Mermaid fence during streaming. Chat, file previews, the editor,
Word capture and the PDF document page all call
`renderMermaidDiagram(source, theme)`. This uses the shared upstream
`renderMermaidSvg` snapshot seam rather than a second engine or a hidden frame.
Pele targets Mermaid syntax with its own layout and visual style; the old
Mermaid `dagre`/`classic` rendering is not retained as a fallback.

The upstream mount disables links, images and built-in zoom, and retains the
author's direction. Pele escapes labels; DOMPurify additionally removes active
elements, navigation/resource attributes, authored stylesheets and CSS-bearing
attributes that can fetch. Math labels load KaTeX only when needed and use
`trust: false`, MathML output, `maxSize: 20` and `maxExpand: 1000`.
The MathML sanitizer admits the bounded presentation vocabulary, not image
glyphs, annotations, script or resource-bearing attributes. Unsupported TeX
remains readable as source. Its resolver caches at most 256 results and removes
its measuring probe after use.

Snapshot measurement uses a temporary offscreen host in the current document,
waits for bundled fonts to settle, refreshes layout and then destroys the mount
and removes the host. It does not change the page's image-loading APIs, mirror
styles into a frame, register a startup scanner or execute diagram callbacks.
No remote renderer, CDN or remote icon/asset loader is registered.
Source is limited to 50,000 characters and graphs to 500 edges. Rendering remains
serialized, with identical source/appearance work deduplicated in flight and
successful SVG/provenance cached in a bounded LRU (100 entries / 20 MiB).
Failures are not cached; failed core/diagram chunks can be retried.

Pele can omit an image or style before emitting SVG. Consequently,
`blockedMermaidResources` inspects authored HTML/CSS/configuration and the
sanitized output. Image/icon notices come only from flowchart node data and
sequence participant properties in the same already-loaded Pele parser's
bounded model; label prose, suffix words and comments are not resource fields.
Labels that merely mention `url(`, `image(` or a web address are not CSS.
`stripSvgExternalResources` supplies another output
check, including CSS escapes, presentation attributes and animations that can
set a resource link. The card's "Outside content not loaded" note names omitted
addresses; explicit web links in that note open separately with
`noopener noreferrer`. Those links are not diagram-authored interactive SVG.
Appearance values are frozen into the snapshot for the dialog and native
image exports. Each consumer receives unique SVG IDs with rewritten fragment
and ARIA references. Inline SVG scales with its container without changing
source or export inputs; the card retains its intrinsic placeholder and
`content-visibility` behavior for long conversations.

The PDF page uses this same resource-disabled renderer, not a separate page
mode. Omitted addresses become export warnings. Typed Pele syntax, unknown-family,
semantic and size/edge-limit errors print the original labelled Mermaid source;
unexpected renderer/chunk failures are fatal readiness errors and prevent printing.
Only results for the current source and capture tracker can update the page or
its diagnostics. Replaced work is released from readiness tracking, and current
work finishes only after its rendered/fallback state commits.

Word capture uses the same original-first recovery operation and native PNG
exporter. Before drawing, its additional policy checks only authored style lists
and decoded configuration from YAML frontmatter or JSON-style init directives.
Supported theme/layout/per-family settings remain available; unsupported
CSS-bearing keys, fetching values, excessive configuration nesting or settings
that cannot be checked fall back to source. Each config is checked independently,
so a later override cannot hide an unsafe value. A renderer-reported omitted
resource, unsafe recovered projection, failed draw or rasterization also falls
back independently to the original labelled source. PNGs are limited to 2 MiB
each and 8 MiB total; failed encoding does not consume the aggregate budget.
The capture keeps the server-selected diagram IDs and source digest, and
publication still rechecks source identity.

## UX and recovery

After a recognized syntax failure, the runtime may attempt one local recovery
render. `mermaidRecovery.ts` proposes exact UTF-16 edits against the original
source. The supported rules are deliberately family-specific:

- Explicit diagram declaration/direction casing and header comment placement;
  no inferred diagram family or direction.
- Literal flowchart label quoting (including nested parentheses and literal
  quotes), short/dotted link tokens, and explicit subgraph ID/title delimiters.
  The scanner supports parallel nodes, named edges and semicolon-separated
  statements while leaving unrelated multiline labels and modern node data alone.
- A missing square closer immediately after a complete quoted label and before
  an explicit link. Bare unclosed labels and mismatched shapes are not guessed.
- Sequence message/note separators with explicitly declared participants,
  including full-width colons at that boundary only.
- Pie label quoting/separators (including the common quoted-label dash typo),
  literal XY/quadrant chart label quoting, and the narrow quadrant coordinate
  delimiter repair from `(x, y)` to `[x, y]`, without changing values or chart
  data.
- The exact C4 `Persons(...)` command typo is corrected to `Person(...)`;
  other C4 commands and identifiers remain opaque.
- Top-level class/state short arrows, accessibility metadata placement in
  supported families, and a small command-position Git graph typo allowlist.

`mermaidRecoverySyntax.ts` retains original UTF-16 offsets and protects comments,
frontmatter, directives, rich labels, accessibility prose and class/state bodies.
Unsupported spans do not prevent independent safe repairs elsewhere. It never
invents nodes, targets, cardinalities, values or missing block endings. Numeric
suffixes are bounded before matching to avoid pathological backtracking.

All compatible edits form **one candidate**, capped at 256 edits and the existing
source limit. Intermediate candidates are never published. Original rendering
must fail first; a successful original bypasses recovery entirely. Only a full
native render accepts the candidate. Any remaining syntax, layout or rendering
failure discards it and exposes the original diagnostic and source through the
existing error UI. Resource/loading failures do not trigger syntax recovery.
Original and recovery rendering share one serialized operation; successful
recovery provenance is cached with the SVG under the original source/theme key.

This is a disposable rendering projection, not a chat or document correction.
The menu identifies recovered diagrams and offers **Copy recovered source**,
separately from **Copy original source**. Source inspection, the document-owned
source editor, context-menu source copy, whole-answer copy and citation identity
retain the original. Opening a recovered preview cannot create an editor
transaction or save a file. No agent invocation, extra validation tool, or
layout-changing recovery notice is added.

The diagram card has explicit loading, ready, source, and error states. A parse
failure shows one compact error line with adjacent repair, copy, and retry icons.
The failed diagram has no separate toolbar or diagram menu. Its source sits
directly below, using the same `MarkdownCodeBlock` as ordinary chat fences:
language/title header, highlighting, source copy, and line wrapping. The shared
block has no extra outer margin in this slot. Editable Markdown files retain
their mounted source editor instead. Successful diagrams keep their existing
toolbar, viewer, and export actions. A diagram failure does not prevent the
surrounding Markdown from rendering. In chat, **Ask agent to fix** uses the
existing `ComposerHandleContext.citeAssistantText` API to insert a reviewable
`AssistantCitationChip` at the caret, using the same serialization, editable
comment, removal, and provider expansion as selected-text citations,
preserving the draft and attachments and respecting the composer's busy state.
Insertion owns deferred focus: an immediate extra focus call would publish the
editor's previous snapshot before its controlled update. It does not submit or
mutate a past message. The containing `AssistantCitationSource` provides the
actual message/thread identity. Shared range capture quotes the displayed source
without changing native selection; if the source cannot be captured, it quotes
the visible error and includes the full source in the comment instead. No source
offsets are invented. Prefilled repair citations do not automatically open a comment popup.
The existing 8,000-character quote/comment limits remain; oversized contexts are
not silently truncated and can still be copied. **Copy error and source** provides
the same request when no composer is available. Requests include the original Mermaid source,
Pele renderer version and parser diagnostic (bounded to 8,000 characters, without its
stack); nested Markdown fences are escaped by the shared export helper.
Only results matching the current source, theme and retry generation may be
displayed or used for repair. Pending edits keep the error source editor mounted,
but replace obsolete diagnostics with a single-line pending label and disable
repair until the new result arrives. Copy success uses an icon checkmark and a
screen-reader announcement, not a layout-changing message row. Action failures
use the shared error notification. The Markdown editor's isolated node-view
roots do not receive the chat composer context; they retain source editing and
the copy action rather than offering a nonfunctional repair action.

The expanded dialog supports fit, 25-400% zoom, actual-size layout,
two-dimensional scrolling, source copy, and
the same SVG/PNG export actions as the compact card. SVG download adds
standalone namespaces and an appearance background. PNG copy/download
rasterizes the same SVG at up to 2x, bounded to 8192 px per dimension.

Export preparation parses Pele's sanitized HTML-compatible output in an inert
template and serializes it as XML. This preserves XHTML/MathML namespaces and
HTML line breaks without changing the Mermaid source or on-screen rendering.
PNG conversion assigns an intrinsic viewport and uses the shared
`loadCanvasImage` helper: SVG bytes become a self-contained data URL because
blob-backed HTML labels can taint the canvas. The regular image viewer uses the
same decoder; its authorized asset fetch and original-file download are unchanged.
Raster formats retain object URLs, which are released after decoding. No remote
renderer or relaxed browser security is required. SVG remains vector content;
external editors still need support for its HTML labels.

The inline card uses the renderer-independent `VisualCardToolbar` shared with
workspace images and interactive charts. It removes the full-width header bar
and reduces stage padding; the controls' default slot stays above the diagram.
Dragging the dotted corner or empty toolbar space translates only the toolbar
within the card, leaving action buttons unchanged. The shared
movement lifecycle is documented in [chat images](scient-chat-images.md).
An authored fence title stays visible, while the generic label and diagram type
remain available in the menu. SVG sizing, lazy rendering, export, and the
expanded dialog retain their existing behavior.

`data-markdown-copy` carries a complete fenced source block, so selection and
whole-message copy never serialize the generated SVG. Individual source-copy
uses the untouched diagram text. Fence title metadata becomes the visible
title and a portable export filename.

## Agent capability discovery

Agents do not infer renderer capabilities from the UI. Scient's compact shared
awareness contract names Mermaid, places the diagram declaration before its
contents (not necessarily before valid frontmatter/comments), and distinguishes
inline representation from a durable artifact. Provider delivery and capability gating are governed centrally by
[the provider architecture](./providers.md#scient-awareness); the diagram
renderer does not inject hidden user text or project instruction files.

## Platforms and fallback

Desktop and web use the rich card. Mobile's native Markdown stack is unchanged,
so a Mermaid fence remains a readable source code block there. Older clients,
exports, and external Markdown readers get the same fallback. This progressive
representation is why no protocol negotiation or message migration is needed.

## Verification and upstream maintenance

`pnpm --dir apps/desktop test:svg-export` exercises actual Chromium serialization,
image decoding, PNG download/copy, and saved-SVG copying across the diagram corpus
in both themes. CI runs it under Xvfb. It checks label painting, namespace and ID
preservation, bounded output, and non-interactive image security. The test uses a
temporary profile and captures output bytes without touching the user's clipboard.
DOM mocks alone cannot establish these properties.

`pnpm --dir apps/desktop test:mermaid-render` qualifies the actual shared Pele
snapshot path in a hidden Electron window. It retains the manual corpus in both
themes, exact immutable recovery projections, parsed shape/label/connectivity
semantics, ambiguous-source refusal, concurrent cache consumers and native PNG
signatures. It also checks resource refusal, inert callbacks, MathML and measuring
host cleanup. Its Vite server and Electron profile use disposable state, provider
credentials are not inherited, and outbound requests are denied and fail the
gate. An already installed repository-version Electron binary is required; the
gate does not repair runtimes or invoke candidate lifecycle operations.

Co-located unit tests cover source bounds, declaration-first parsing with
accessibility metadata, SVG id/reference rebasing, portable
filenames, standalone export preparation, and Markdown round-tripping.
`ChatMarkdown.browser.test.tsx` covers the actual rich-fence consumer, including
metadata, rendered appearance, and Mermaid versus chart streaming behavior.
Card interaction tests measure inline geometry and exercise the expanded
dialog's source and image actions through the export boundaries. Real-Pele
browser cases cover each resource-bearing construct, safe textual URLs,
generated/hostile MathML, inert callbacks, both appearances and native PNG bytes.
Word capture tests retain per-image/aggregate byte budgets, decoded configuration
refusal, isolated per-diagram fallback and source identity. PDF diagram tests
cover typed content-versus-execution failures, readiness and obsolete results.
The Plotly loader and server awareness/provider-delivery tests retain their
separate responsibilities. Production bundle qualification must verify the
Pele core and per-family lazy chunks rather than an eagerly bundled renderer.
`docs/fixtures/scient-chat-diagrams.md` is the manual light/dark corpus for the
major diagram families, math labels, RTL/Unicode, duplicates, export, copy, and
recovery states.
Mounted interaction tests cover review-before-send, draft preservation,
repeated clicks, missing composer/clipboard and stale asynchronous results.
The immutable recovery corpus protects exact family-specific source edits;
real-Pele cases render all recovered fixtures, while transaction tests cover
original-first acceptance, atomic rollback, non-syntax failures, concurrent
consumers and source/theme cache separation. Fixtures establish specific
qualified cases, not a guarantee that arbitrary malformed Mermaid can be
repaired without guessing.

Run focused web tests from `apps/web`:

```sh
pnpm exec vp test run --project unit src/scient/diagrams src/scient/wordExport/captureDiagrams.test.ts src/scient/wordExport/diagramSafety.test.ts
pnpm exec vp test run --project browser src/scient/diagrams src/components/chat/MermaidDiagram.browser.test.tsx src/scient/wordExport/captureDiagrams.browser.test.ts src/scient/documentPage/ScientDocumentPage.diagrams.browser.test.tsx src/scient/documentPage/ScientDocumentPage.browser.test.tsx
```

Native serialization, image decoding, clipboard and saved-SVG qualification
remain separate from mocked unit/component tests. A parser-only or renderer-only
check does not establish native export success; use disposable synthetic
profiles and the unchanged export inputs, not live user state.

When upstream changes `ChatMarkdown.tsx`, preserve the narrow owned rich-fence
mount and the closed-Mermaid streaming boundary. When it changes
`chat/MermaidDiagram.tsx`, carry forward the shared lazy loader, sanitizer,
math limits and snapshot seam used by Scient's card and exports. Do not restore
a second Mermaid renderer to preserve recovery or export actions. Run the actual
mounted Markdown, card, Word/PDF consumer and native-export conditions rather
than accepting source-text wiring checks or old frame-internal assertions.
