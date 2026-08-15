# Scient rich chat diagrams

Status: implemented on top of the chat-math foundation; Mermaid source remains
canonical chat Markdown.

## Product and ownership boundary

Scient owns `apps/web/src/scient/diagrams`: the lazy Mermaid runtime, inline
card, expanded viewer, export helpers, styles, and tests. The inherited T3 host
has one renderer seam in `ChatMarkdown.tsx`: a settled fence whose language is
`mermaid` is passed to `MermaidDiagramCard`. Streaming and every other code
fence continue through T3's existing code-block path. A static seam audit keeps
that integration narrow during upstream refreshes. Because Markdown file
previews already share `ChatMarkdown`, they receive the same behavior without a
second viewer integration.

There is no wire-format, database, attachment, artifact-store, or Markdown AST
fork. The source already present in the assistant message is authoritative;
SVG and PNG are disposable local representations. This is intentionally the
first presentation layer for the future Scientific Artifact Studio, not a
second artifact model. A future “save as artifact” action should consume the
studio's producer-neutral artifact contracts rather than adding persistence to
the diagram card.

## Rendering pipeline

The exact-pinned `mermaid` 11.16.1 package is locally bundled and dynamically
imported only when a settled diagram enters a 400 px viewport margin. The
initial chat bundle does not import Mermaid. Rendering is serialized because
Mermaid configuration is process-global. Identical source/appearance renders
are deduplicated in flight and cached in a bounded LRU (100 entries / 20 MiB).

Cached SVG contains marker, mask, link, style, and accessibility ids. Every
consumer receives a rebased copy with unique ids and rewritten fragment and
ARIA references, so duplicate diagrams do not target one another's SVG
definitions. The card uses `content-visibility` and an intrinsic placeholder
to keep long conversations cheap.

The runtime accepts the full Mermaid package rather than a reduced grammar so
scientific explanations can use flowcharts, sequence/state/entity diagrams,
mindmaps, architecture diagrams, Gantt/timeline diagrams, and Mermaid's math
labels. Source is capped at 50,000 characters and graphs at 500 edges. Mermaid
runs with `startOnLoad: false`, strict mode, suppressed error diagrams, and the
current light/dark appearance. The app inserts only Mermaid's sanitized SVG
and deliberately does not call `bindFunctions`, so source-authored callbacks
do not run. No remote renderer, CDN, custom icon pack, or remote asset loader is
registered.

## UX and recovery

The settled card has explicit loading, ready, source, and error states. A parse
failure shows a concise error, the complete readable source, and retry; it
cannot fail the surrounding Markdown render. The expanded dialog supports fit,
25-400% zoom, actual-size layout, and two-dimensional scrolling. SVG download
adds standalone namespaces and an appearance background. PNG copy/download
rasterizes the same SVG at up to 2x, bounded to 8192 px per dimension.

`data-markdown-copy` carries a complete fenced source block, so selection and
whole-message copy never serialize the generated SVG. Individual source-copy
uses the untouched diagram text. Fence title metadata becomes the visible
title and a portable export filename.

## Agent capability discovery

Agents do not infer renderer capabilities from the UI. The Scient server adds
a short capability contract through supported provider-level seams:

- Codex receives it in both default and plan developer instructions.
- Claude Code receives it as an append to its preset system prompt.
- OpenCode receives it through the SDK's supported per-prompt system field.
- Grok receives it through the CLI's supported `--rules` system append.

The instruction recommends diagrams only when a relationship is materially
clearer visually, requires ordinary self-contained Mermaid, asks for accessible
metadata when useful, and distinguishes inline representation from a durable
artifact. Cursor can still render Mermaid it emits, but its ACP transport does
not currently expose a clean system/developer seam; Scient does not silently
inject capability text into the user's prompt.

## Platforms and fallback

Desktop and web use the rich card. Mobile's native Markdown stack is unchanged,
so a Mermaid fence remains a readable source code block there. Older clients,
exports, and external Markdown readers get the same fallback. This progressive
representation is why no protocol negotiation or message migration is needed.

## Verification and upstream maintenance

Co-located unit tests cover source bounds, SVG id/reference rebasing, portable
filenames, standalone export preparation, Markdown round-tripping, and the
single `ChatMarkdown` seam. Server tests assert the capability contract reaches
both Codex modes and Claude query options. The production build is the bundle
gate: Mermaid must remain in lazy chunks rather than the entry bundle.
`docs/fixtures/scient-chat-diagrams.md` is the manual light/dark corpus for the
major diagram families, math labels, RTL/Unicode, duplicates, export, copy, and
recovery states.

When T3 changes `ChatMarkdown.tsx`, reapply only the import and settled-fence
branch, then rerun the diagram seam test. When T3 adds equivalent rich Mermaid
support, prefer retiring this seam and adapting Scient's export/accessibility
UX around the upstream renderer rather than maintaining two renderers.
