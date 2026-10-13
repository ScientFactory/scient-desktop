# LaTeX Visual performance

Visual mounts the whole document once and never swaps blocks out, so its
performance depends on keeping every per-transaction and per-frame cost
independent of document length. The design is in
[LaTeX Visual](./scient-latex-visual.md#continuous-paper-and-reading); this page
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

- **open**: first readable screen, editable, settled (no long frame for 3 s),
  every formula rendered; long frames and blocking time.
- **scroll**: jumps to 25/50/75/95/10 % as a scrollbar drag would; time until
  the screen is ready, drift of the content under the reader from the first
  painted frame, and app scroll writes.
- **typing**: 68 keystrokes in a mid-document paragraph; Event Timing latency,
  movement of the edited paragraph and of the block above it, scroll writes.
- **structure**: Enter, typing, Backspace, then undo and redo; latency,
  stability, and that undo restores the source exactly.
- **memory**: repeated open/close cycles (`--cycles`), heap, nodes and
  listeners after garbage collection.

`--profile open|typing|structure` adds a sampled CPU profile, `--shots dir`
saves screenshots, `--skip-build` reuses the last build.

## Results

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

|                                         | Result                 |
| --------------------------------------- | ---------------------- |
| Loaded and editable                     | 4.9 s                  |
| Longest frame while loading             | 183 ms                 |
| Jump ready / drift                      | 48–73 ms / 0 px        |
| Typing p50 / p95                        | 24 / 32 ms             |
| Enter, Backspace, undo p95              | 0.5 s                  |
| JS heap / renderer memory, one document | 231 MB / 2.7 GB steady |

## Known limits

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
