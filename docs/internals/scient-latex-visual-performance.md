# LaTeX Visual performance

Visual mounts the whole document once and never swaps blocks out, so its
performance depends on keeping every per-transaction and per-frame cost
independent of document length. The design is in
[LaTeX Visual](./scient-latex-visual.md#paged-paper-and-reading); this page
holds the gates and how to measure them.

## Gates

Measured on a production build in Chromium, on a real 104-page thesis and on a
synthetic 300-page manuscript.

1. **The app never freezes.** No frame is blocked for more than 50 ms while
   opening, scrolling or typing (Long Animation Frames, with attribution).
2. **Opening.** The first screen is readable within 1 s of parsing; the whole
   document is loaded and editable within 3 s on the thesis.
3. **Ordinary typing.** p50 at most 16 ms and p95 at most 32 ms, input to paint
   (Event Timing).
4. **Stability.** Content that did not change moves 0 px, except when the caret
   is brought into view or on explicit navigation. While typing the app makes no
   scroll writes other than caret-into-view; writes are counted by
   instrumentation.
5. **Memory.** Renderer memory is stable across repeated open/close cycles.
6. **Correctness.** The source round-trips byte-exactly; loading creates no undo
   entries and publishes no source; the Visual suites stay green.

## Measuring

```bash
node apps/web/scripts/latex-visual-benchmark.ts --pages 300
node apps/web/scripts/latex-visual-benchmark.ts --fixture path/to/paper.tex --json out.json
```

The script builds `latex-visual-benchmark.html` with
`latexVisualBenchmark.config.ts` (the app's Vite config, unminified), serves it,
and drives Chromium with Playwright. Without `--fixture` it generates a
deterministic manuscript (`visualBenchmark/latexBenchmarkDocument.ts`); a
fixture is read locally and never copied. Scenarios (`--scenarios`):

- **open**: first readable screen, editable, page plan available, settled
  (the planner's completion receipt and no long frame for 3 s), every formula
  rendered; long frames and blocking time. Formula completion must also leave
  the planner settled before interaction scenarios begin. A timeout records an
  incomplete opening and skips those scenarios. Readability and editability have
  separate timestamps; an unfinished planner has no settled timestamp.
- **scroll**: jumps to 25/50/75/95/10 % as a scrollbar drag would; time until
  the screen is ready, drift of the content under the reader from the first
  painted frame, and app scroll writes.
- **typing**: 68 keystrokes in a mid-document paragraph; Event Timing latency,
  movement of the edited paragraph and of the block above it, scroll writes.
- **structure**: reopen the original document, then Enter, typing, Backspace,
  undo and redo; latency, stability, and that undo restores the scenario's
  starting source exactly. Undo stops at that source receipt.
- **memory**: repeated open/close cycles (`--cycles`), heap, nodes and
  listeners after garbage collection.

`--profile open|typing|structure` adds a sampled CPU profile, `--shots dir`
saves screenshots, `--skip-build` reuses the last build.

## Results

The measurements below are historical baselines. They predate the restored
incremental page planner and recent source-validation changes, and do not
qualify the current paged editor. Recheck opening, scrolling and typing together
with PDF fidelity before treating the performance gates as passed.

Event Timing reports only interactions of 16 ms or more, so faster keystrokes
are shown as "<16". Renderer memory is the resident size of Chromium's renderer
processes; it includes the browser's own baseline (about 0.8 GB with an empty
page in the benchmark).

On the thesis (104 pages, about 3,600 rendered formulas):

|                                        | Result                                       |
| -------------------------------------- | -------------------------------------------- |
| First screen readable                  | 0.22 s                                       |
| Loaded and editable                    | 0.55 s                                       |
| All formulas rendered                  | 3.6 s                                        |
| Longest frame while opening            | 107 ms (one frame)                           |
| Jump ready / drift                     | 28–42 ms / 0 px                              |
| Typing p50 / p95                       | <16 / 16 ms, 0 px movement, no scroll writes |
| Enter, Backspace, undo p50 / p95       | <16 / 152 ms, 0 px movement                  |
| JS heap, one document open             | 84 MB peak, 76 MB steady                     |
| JS heap, three documents open          | 152 MB peak, 112 MB steady                   |
| Renderer memory, one / three documents | 1.1 / 2.0 GB steady                          |
| Six open/close cycles                  | heap +1 MB, no node growth                   |

On the synthetic 300-page manuscript:

|                                         | Result                  |
| --------------------------------------- | ----------------------- |
| Loaded and editable                     | 7.3–8.6 s               |
| Every block rendered once (settled)     | 26–29 s, ~10 s blocking |
| Longest frame while loading             | 218 ms                  |
| Jump ready / drift                      | 58–83 ms / 0 px         |
| Typing p50 / p95                        | 24 / 32–40 ms           |
| Enter, Backspace, undo p95              | 0.7 s                   |
| JS heap / renderer memory, one document | 254 MB / 1.5 GB steady  |

## Historical limits

These limits describe the continuous-paper baseline above, before restored
paging. They do not establish current qualification; rerun the complete
opening, scroll, typing and source checks for the candidate being reviewed.

- **Rendering every block once costs more since PR #353's editor work was
  merged.** On 300 pages the idle pass that renders each block once (so jumps
  land exactly) now keeps the main thread busy for about 10 s over 26–29 s
  after opening, in short frames, against 1.4 s before; opening is 7–8.5 s
  against 4.9 s. The 104-page thesis is unaffected in practice (editable
  0.8 s, settled 1.9 s). The cause is not yet profiled.

- **Per-transaction cost still grows with length.** Tiptap's React node-view
  registry copies every renderer when one mounts and re-renders every portal,
  and ProseMirror compares the document's top-level blocks on each update. On
  300 pages this keeps loading frames near 100–180 ms and typing at 24 ms.
- **Structural edits** (Enter, Backspace across blocks, undo) re-project the
  edited source synchronously and recount references; on 300 pages the slowest
  take about half a second.
- **Opening** builds the whole parsed document once and counts its references
  before the first slice (loading then reuses those nodes), and the final slice
  recounts once; with the first formula results this gives one frame near
  100 ms on the thesis. Gate 1 (no frame over 50 ms) is therefore not met while
  opening; it holds while scrolling and typing on the thesis.
- **Memory** grows with the mounted document: a whole thesis adds about
  0.3–0.4 GB of renderer memory (its DOM is about 0.5 M nodes, formulas
  included).

## What made it slow, and must not return

Editing now validates paragraph splits, joins, deletion and source-history
inverses against the changed source window and its adjacent blocks. Exact source
patch checks and semantic round-trip checks remain mandatory. Setup changes,
generators, source-only syntax and document-wide column composition retain the
full projection fallback. Unchanged model subtrees and document encodings retain
their immutable identities; new split blocks receive distinct rendering IDs.

Reference updates compare cached counter dependencies before recounting. Prose
structure, formula bodies with unchanged row commands and table-cell writing
map existing targets. Changed headings, captions, labels, equation rows, compiled
bibliography or source-wide counter controls invalidate the count. Deleted target
positions and manual contents entries retain conservative recounting.

Offscreen measurement and formula warming wait for an input pause and the end of
composition or dragging. Visible layout and explicit math editing stay immediate.
Paragraph remeasurement retains flow-unit identities when line dimensions and
break constraints are unchanged. If their mapped source ranges and placements
also agree, paging keeps its current decorations without publishing another
presentation transaction. Wrapping and structural changes still run the planner;
font, width and document-style changes invalidate the measurements. Column
boundaries keep their identities while their mounted container survives an edit.

Reading anchors map through edits below the reading line without synchronous
hit testing. Capturing a new anchor uses the page geometry to find visible text
before falling back to browser hit testing. Resize deliveries share one anchor
correction before paint and ignore blocks entirely below the reading line;
page layout, zoom and edits above the anchor retain their correction paths.
Paging reads repeated-table heights before writing intrinsic sizes, and checks
footnote sizes after writing the complete group of positions.

Superseded typing may let its worker finish under the existing deadline without
publishing its abandoned result or restarting the parser. Wrapper-only React
views avoid refreshing for body edits; presentation-only transactions do not
refresh the toolbar.

Unconverted writing checkpoints use the shared document recovery database,
with token ownership and changed-block writes in one IndexedDB transaction.
The first checkpoint stores the baseline and all authored blocks; later ones
store changed blocks, remove obsolete blocks and replace the small owner record.
Accepted source marks that input clean while keeping its block encodings warm.
Opening imports pending input into the established recovery workflow before
retiring its exact token. Explicit exit and storage failures retain the existing
synchronous snapshot fallback. The journal limits each document to 4 MiB and
retains at most 32 document owners; exceeding a limit uses that fallback.

These are implementation changes, not new benchmark results. The recorded
measurements above predate them; qualify interaction latency and PDF/layout
fidelity together when running the benchmark and browser checks.

Each of these was found by measurement and costs time in proportion to the
document on every transaction or frame:

- per-object editor, document and window listeners (one shared set per editor
  instead);
- `useEditorState` selectors in node views that recompute on every transaction
  (`useLatexReferenceState` recomputes when references are counted again);
- a constructed stylesheet adopted by every formula's shadow root (one `<style>`
  per root instead);
- universal sibling selectors such as `> * + *` (a test forbids them);
- slices sized only by a time budget, which shrink to one block when the fixed
  cost per transaction grows (slices grow with the loaded document);
- toolbars searching the workspace on every render (only the active one does);
- attribute writes to ProseMirror-owned blocks without pausing its DOM observer,
  which makes it redraw the block.
