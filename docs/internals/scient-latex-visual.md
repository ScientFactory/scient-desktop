# Editable typeset view

Status: implementation candidate; human visual review pending.
Owner: ScientFactory. This extends [Scient LaTeX build](scient-latex.md).

## Decision

Keep `.tex` authoritative and the compiled PDF authoritative for settled
layout. Offer **Source / Split / Visual / PDF**. Visual uses the PDF.js page as
its stable fidelity layer and temporarily replaces the active, source-mapped
prose region with a native editing surface. Export continues to use the
existing immutable PDF artifact path. There is no new editable file format.

Exact typography and immediate feedback are separate requirements. TeX must
run before exact new line breaks, floats and page breaks are known. The active
prose surface provides immediate browser layout while the untouched page stays
the exact last PDF. Finishing the edit requests one TeX checkpoint. It does
**not** claim pixel-identical instantaneous editing of arbitrary LaTeX, nor
universal invertibility of TeX output. A changed paragraph can legitimately
repaginate the document; stable viewport does not mean freezing page breaks.

## Alternatives and evidence

| Architecture                                   | Benefit                                                                       | Cost for Scient                                                                                                      | Decision                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Overleaf-style source-backed structured editor | Source preservation, mature editing primitives, useful mathematical controls  | Editing presentation is not the final TeX page                                                                       | Borrow the source-preserving principle, not its primary presentation    |
| LyX-style native document model                | Strong structural editing and established document UI                         | Different authoritative format; screen typography can differ from output                                             | Wrong authority/fidelity tradeoff for existing `.tex` projects          |
| HTML/CSS or ProseMirror page recreation        | Responsive familiar text editing                                              | Second layout engine cannot guarantee the same TeX pagination and package output                                     | Not the fidelity layer                                                  |
| PDF plus source-backed editable paragraph      | Exact when settled, immediate direct typing, no page replacement during input | Active paragraph is provisional until TeX confirms it; complex objects need dedicated adapters                       | Implemented bounded foundation                                          |
| Actual PDF plus hidden keystroke input         | Same visible typesetting as export                                            | New text is invisible until compilation and makes compilation an interaction dependency                              | Rejected after interaction review                                       |
| Engine-integrated incremental typesetting      | Most promising route toward exact and fast updates together                   | Engine-specific provenance, checkpointing, package compatibility and page invalidation are substantial compiler work | Future separately qualified optimization, not an implicit engine switch |

Primary references, checked during investigation:

- [Overleaf's best-effort parsing presentation](https://tug.org/tug2025/av/d3-t25-jakobsen-parsing-editing/d3-t25-jakobsen-parsing-editing-slides.pdf): source-backed visual editing and parser limitations. This supports preserving source, not replacing it with a normalized visual AST.
- [LyX](https://www.lyx.org/Home), [native-format compatibility](https://wiki.lyx.org/FAQ/Compatibility), and [screen fonts](https://lyx.org/LyX/Fonts): WYSIWYM is not an exact-PDF editing claim.
- [i-LaTeX](https://github.com/exsitu-projects/ilatex): research precedent for interacting with objects through their PDF output. Its supported objects need custom commands/environments; it is not a ready-made prose editor. The repository is MIT but documents more restrictive bundled dependencies. No code was copied.
- [Texpile](https://github.com/texpile/texpile) and [its engine setup](https://texpile.com/docs/getting-started): relevant engine-aware visual/source editor. Its previously circulated architecture URL was unavailable during this investigation; no unverified latency claims or implementation details are adopted here.
- [SyncTeX's original design](https://tug.org/tugboat/tb29-3/tb93laurens.pdf): synchronization is not a lossless character-level inverse compiler. Source lines are useful evidence, not permission to overwrite an arbitrary source range.

No external editor/compiler dependency was added. Existing PDF.js, workspace
CAS writes, build supervision, artifact storage and the verified SyncTeX helper
remain the runtime foundation. This is original integration code; adopting an
external editor later requires its own license and dependency review.

## End-to-end ownership

1. `LatexBuildService` hashes known workspace dependencies immediately before
   invoking the engine and compares them with the after-build evidence.
   Only a successful non-truncated, unchanged dependency set supplies
   `visualSourceRevisions`. New dependencies disable visual mapping until a
   subsequent compile has observed them on both sides. Restored old artifacts
   do not manufacture this evidence.
2. The normal authorized build-status contract transports those source byte
   identities with the published artifact revision. No new write authority or
   filesystem access is granted to the renderer.
3. The reader exposes an interaction host with actual loaded revision,
   viewport container and PDF-coordinate conversion. Document lifetime is
   separate from revision-request lifetime: asset callbacks do not reload the
   viewer, and a new revision does not tear down the displayed pages. A sized,
   invisible staging surface prepares the next PDF while the old surface stays
   interactive. Publication waits for visible canvases and text layers plus two
   stable animation frames, not merely `pagesinit`. Superseded stages are
   cancelled; failed stages leave the old presentation intact. Loaded URL and
   revision checks prevent old geometry authorizing new source edits or sync.
4. A click measures the invisible PDF text layer and asks the existing
   revision-scoped inverse SyncTeX endpoint for the source line. Blank space
   resolves geometrically to the nearest unambiguous line on the same page;
   an ambiguous column gutter fails closed. The initial client source must
   match the build identity.
5. `packages/shared/src/latexVisual.ts` projects supported literal prose runs
   and keeps display-to-source boundaries. Normalization is comparison-only.
   Ligatures, escaped punctuation, whitespace and basic TeX punctuation can be
   matched without normalizing the source file. Ambiguity fails closed.
6. A native textarea receives keyboard, clipboard and IME input directly over
   the mapped prose geometry. It uses the PDF text layer's font metrics and
   masks only that prose region while active. The resulting minimal source
   splice preserves unrelated syntax, comments and whitespace. Pasted TeX control
   characters are escaped as literal prose, not executed as new commands.
   Globally unique local matches can buffer keystrokes while SyncTeX is in
   flight, but cannot write until it agrees. Rejected or interrupted drafts
   survive mode/tab switches in an environment/file-keyed in-memory recovery
   store. This store is not crash-durable and does not claim to be saved source.
7. Source and Visual share the existing `useFileSaveCoordinator`, with a
   150 ms save debounce, optimistic source cache and expected-revision writes.
   Visual also compare-and-sets against the current in-memory source. Saves
   replace one 1.5-second checkpoint timer instead of compiling. An active
   Visual transaction suspends that timer and status-currentness polling;
   leaving the edit requests the latest revision once. Explicit Rebuild remains
   an override. Failures retain the last successful artifact and existing
   conflict-resolution UI.
8. A mapping session pins the source and SyncTeX identity of the displayed PDF.
   Minimal Visual splices are recorded as positional changes, allowing later
   clicks on the stable page to rebase into newer source without compiling
   first. An external source replacement invalidates the session rather than
   guessing.
9. Prepared output and its interaction host are published together before the
   next paint; only then is the old runtime disposed. Preparation follows live
   scrolling and zooming instead of imposing an earlier viewport snapshot.
   An optional source-neutral anchor provider lets visual editing keep a
   source-backed visible prose line at its screen Y position. Anchor lookup
   can materialize a nearby page after reflow (within two pages); ambiguity or
   distant restructuring falls back to preserved scroll coordinates. Status
   notices do not alter viewport dimensions. The completed editing transaction
   is anchored through publication so genuine TeX reflow does not reset the
   viewport to an unrelated page.

## Supported and explicitly unsupported

Supported: upright left-to-right literal prose; recognized text formatting and
heading arguments; selecting within a single literal run; insertion, deletion,
paste, paragraph insertion and native textarea composition. Native undo is
scoped to the active text-input session, not a new cross-mode undo system.

Opaque: equations, tables, TikZ, verbatim, unknown command paragraphs, dynamic
syntax primitives and text without a unique mapping. Unknown environments are
not recursively guessed. Arbitrary custom packages can still defeat lexical
projection; this is a conservative compatibility subset, not a proof that all
TeX expansion is reversible. Source remains the escape hatch.

Current limitations requiring further product work:

- A click in an included file does not silently switch the active file's save
  owner. The user must open that source first. Multi-file, single-canvas
  transactions need a document-level session owner with per-file leases.
- Cross-formatting selections, equation/table editors, continuous document-wide
  undo, keyboard-only activation and complete screen-reader page navigation
  are not finished capabilities of this candidate.
- Hyphenated line fragments and short glyph spans can be refused. The active
  paragraph's browser line breaking is provisional and can differ from TeX;
  the exact result returns only after the transaction ends and compiles.
- Compilation runs on the workspace, not an immutable filesystem snapshot.
  Before/after digests detect ordinary concurrent changes, but are not a proof
  against an adversarial change-and-restore during engine execution. Stronger
  provenance requires isolated build input snapshots or engine-observed input
  digests, and a richer glyph/source map than SyncTeX.
- First document loading still has a loading state; background revision
  replacement does not. Prepared-page publication requires native visual
  acceptance in addition to DOM lifecycle tests. Genuine layout changes,
  ambiguous text anchors and large repagination cannot promise immobile text.

## Long-term progression and acceptance gates

The immediate review tests direct-input stability, whitespace caret placement,
provisional paragraph geometry and the transition back to exact PDF output.
Measure edit response, edit-finish-to-published and published-to-painted
latencies on short papers and long projects; do not call a debounce value a
latency guarantee. User visual review is still required.

Next, establish a document session with versioned per-file buffers, grouped
undo, persistent logical selections and compile input snapshots. Replace the
bounded scanner incrementally with a lossless concrete-syntax tree and explicit
package/command adapters; preserve unknown syntax as opaque source islands.
Do not serialize the whole document or run an LLM on every edit.

Then qualify object-specific editors and compiler-produced provenance. A future
engine adapter should produce `(source version, source range, glyph/box id,
geometry, capability)` records. An incremental renderer may replace full
compilation only when the same engine validates affected page output and
invalidates dependent floats, counters, references and later pages correctly.
The full compile remains the correctness oracle. Do not switch existing
pdfLaTeX/Tectonic projects to LuaLaTeX automatically.

Release acceptance requires source-splice fuzzing, stale-revision and conflict
tests, real-engine round trips, failed-build recovery, multi-page viewport and
caret checks, IME/clipboard/accessibility checks and rendered-page comparison
against the exported PDF at the same zoom. DOM tests are not visual QA.
