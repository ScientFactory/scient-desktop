# Editable typeset view

Status: implementation candidate; human visual review pending.
Owner: ScientFactory. This extends [Scient LaTeX build](scient-latex.md).

## Decision

Keep `.tex` authoritative and the compiled PDF authoritative for settled
layout. Offer **Source / Split / Visual / PDF**. Visual, and the preview half of
Split, use the PDF.js page as their stable fidelity layer and temporarily
replace the active, source-mapped prose region with a native editing surface.
PDF remains the read-only/navigation view. Export continues to use the existing
immutable PDF artifact path. There is no new editable file format.

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
   `visualSourceRevisions`. Before every engine invocation the prior candidate
   PDF, compressed and plain SyncTeX indexes, and dependency recorder are
   removed; a cleanup failure stops before compilation, so no run can inherit
   an earlier run's proof. A complete recorder must name the actual root. If it
   discovers new inputs or a known input changes during compilation, the same
   production performs one bounded stabilization pass. A second concurrent
   change fails that production and leaves the last verified PDF in place
   rather than blessing an uncertain one. Both latexmk's `.fls` recorder and
   Tectonic's `--keep-intermediates --makefile-rules` output feed this boundary.
   Missing or incomplete recorder output keeps the PDF readable but Visual
   conservatively read-only. The source identities
   are encoded before publication as a bounded revision attachment. The PDF,
   artifact metadata, and Visual proof are fsynced in one staging directory and
   renamed into the immutable revision before its binding commits, so they share
   one visibility and retention boundary. Restart restoration occurs only after
   ordinary build evidence proves that exact revision still describes the
   workspace; missing, corrupt, or mismatched Visual evidence fails closed
   without discrediting the readable PDF. Evidence that cannot fit the document
   store's attachment budget is omitted before publication, so the valid PDF
   still commits and remains readable while Visual stays unavailable.
   Cancellation claims one exact coalesced build pass atomically. A request
   arriving after that claim starts a fresh generation, and an older committed
   pass cannot clear the successor's cancellation state.
2. The normal authorized build-status contract transports those source byte
   identities with the published artifact revision. No new write authority or
   filesystem access is granted to the renderer, and a revision can never
   borrow edit permission from a different PDF.
3. The reader exposes an interaction host with actual loaded revision,
   viewport container and PDF-coordinate conversion. Document lifetime is
   separate from revision-request lifetime: asset callbacks do not reload the
   viewer, and a new revision does not tear down the displayed pages. A sized,
   invisible staging surface prepares the next PDF while the old surface stays
   interactive. Publication waits for visible canvases and text layers plus two
   stable animation frames, not merely `pagesinit`. Superseded stages are
   cancelled; failed stages leave the old presentation intact. At the final
   paint fence, Visual also rechecks that no edit is active and that the
   candidate's source digest is the exact current editor buffer. A candidate
   invalidated while staging is disposed, so A can remain interactive until
   exact revision C replaces it without an A-to-B-to-C flash. The first readable
   PDF is always admitted even when Visual evidence is unavailable, leaving
   legacy, truncated, or unsupported documents visible but read-only. Loaded
   URL and revision checks prevent old geometry authorizing new source edits or
   sync.
4. Entering Split or Visual verifies that the retained PDF carries Visual
   source identities. A current PDF that predates those identities receives one
   automatic compatibility build for that source revision. A toolchain whose
   recorder still cannot produce complete evidence is never put into a rebuild
   loop. Ordinary PDF viewing pays no compatibility-build cost. When a
   revision's PDF.js text layer appears, the client builds a local,
   revision-pinned edit manifest before interaction. Authorization belongs to a
   complete literal source run: its normalized text must occur exactly once in
   the complete compiled PDF, and one materialized page must carry a unique,
   ordered, gap-free cover. Individual PDF.js words and short fragments may
   repeat inside that proven paragraph. A click is therefore a synchronous
   lookup and never invokes SyncTeX. Blank space resolves only to a nearby
   already-proven span on the same page, and an ambiguous gutter fails quietly.
   The initial client source must match the build identity. PDF mode keeps
   double-click inverse SyncTeX navigation; Source/Visual editing proof never
   uses SyncTeX as write authorization.
5. `packages/shared/src/latexVisual.ts` projects supported literal prose runs
   and keeps display-to-source boundaries. Normalization is comparison-only.
   Ligatures, escaped punctuation, whitespace and basic TeX punctuation can be
   matched without normalizing the source file. Serializer-owned literal
   commands round-trip back into the same editable run. Opaque-environment
   scanning ignores commented terminators and accepts verbatim termination only
   on a delimiter line; an uncertain or missing delimiter consumes the rest as
   opaque source. Ambiguity fails closed.
6. A native textarea receives keyboard, clipboard and IME input directly over
   the mapped prose geometry. It uses the PDF text layer's font metrics and
   masks only that prose region while active. The resulting minimal source
   splice preserves unrelated syntax, comments and whitespace. Pasted TeX control
   characters are escaped as literal prose, not executed as new commands.
   A browser-local, source-aware recovery record is updated before the source
   debounce and remains until the matching file revision is confirmed saved.
   Where browser storage accepts that record, an unmount, renderer restart or
   crash between optimistic buffer acceptance and disk persistence does not
   silently drop input. It does not masquerade as saved source: a rejected
   compare-and-set or failed save is shown as explicit recovery text.
7. Source and Visual share the existing `useFileSaveCoordinator`, with a
   150 ms save debounce, optimistic source cache and expected-revision writes.
   Visual also compare-and-sets against the current in-memory source. Keystrokes
   change only the active draft. After 700 ms of quiet input, one minimal source
   checkpoint enters the normal save owner. Workspace persistence and
   compilation are both suspended for the entire document editing transaction;
   the optimistic source buffer and durable recovery journal remain current in
   the meantime. Blur and movement between prose blocks are not session
   boundaries. Escape, an intentional mode command, or pointing outside the PDF
   flushes the last source checkpoint and resumes the revision-checked save.
   The build hold is released only when that exact final buffer is confirmed on
   disk, rather than after a timing guess; the normal 1.5-second build window
   then coalesces the confirmation into one compile of the latest source.
   Manual Rebuild is disabled while the transaction owns uncommitted input.
   A conflict keeps the hold through Retry until the exact source is confirmed;
   Discard adopts the authoritative disk state and releases every hold not
   owned by a still-active input. Failures retain the last successful artifact,
   durable recovery, and the existing conflict-resolution UI.
8. A mapping session pins the source and SyncTeX identity of the displayed PDF.
   Minimal Visual splices are recorded as positional changes, allowing later
   clicks on the stable page to rebase into newer source without compiling
   first. An external source replacement invalidates the session rather than
   guessing.
9. Prepared output and its interaction host — including the revision identity
   that actually owns the painted container — are published together before the
   next paint; only then is the old runtime disposed. Preparation follows live
   scrolling and zooming instead of imposing an earlier viewport snapshot.
   An optional source-neutral anchor provider lets visual editing keep a
   source-backed visible prose line at its screen Y position. Anchor lookup
   can materialize a nearby page after reflow (within two pages); ambiguity or
   distant restructuring falls back to preserved scroll coordinates. Status
   notices do not alter viewport dimensions. The completed editing transaction
   is anchored through publication so genuine TeX reflow does not reset the
   viewport to an unrelated page. While a successor is staged, the old painted
   revision stays ready and editable; the requested revision cannot disable or
   authorize its interaction. Collapsed diagnostics are not mounted over the
   page, and an explicitly opened diagnostic panel participates in normal layout.

## Supported and explicitly unsupported

Supported: upright left-to-right literal prose; recognized text formatting and
heading arguments; selecting within a single literal run; insertion, deletion,
paste, paragraph insertion and native textarea composition. Qualified PDF text
is keyboard-focusable and Enter, Space or F2 opens the same native editor;
Escape checkpoints and returns focus to the originating text. Native undo is
scoped to the active text-input session, not a new cross-mode undo system.
Repeated words and short PDF.js text fragments are supported when the complete
single-page paragraph has a unique compiled occurrence.

Opaque: equations, tables, TikZ, verbatim, unknown command paragraphs, dynamic
syntax primitives and text without a unique mapping. Unknown environments are
not recursively guessed. Arbitrary custom packages can still defeat lexical
projection; this is a conservative compatibility subset, not a proof that all
TeX expansion is reversible. Source remains the escape hatch.

Current limitations requiring further product work:

- Opening a fragment with one nearby root that directly `\input`s or
  `\include`s it compiles that root, so the fragment can be edited against the
  complete PDF. Multiple containing roots are reported explicitly and require
  a `% !TEX root` comment. A click while the root file itself is active does
  not silently switch the save owner to an included file; true multi-file,
  single-canvas transactions still need a document-level session owner with
  per-file leases.
- Cross-formatting selections, equation/table editors, continuous document-wide
  undo and complete screen-reader page navigation are not finished capabilities
  of this candidate.
- Hyphenated line fragments and paragraphs split across pages can be refused.
  The active paragraph's browser line breaking is provisional and can differ
  from TeX; the exact result returns only after the transaction ends and
  compiles.
- Recovery currently serializes the complete intended source synchronously on
  each native input and falls back to renderer memory if browser storage rejects
  the write. Before release, replace this with a compact, crash-consistent
  journal whose commit record is atomic, and surface any loss of durable
  recovery explicitly; a multi-key partial promotion is not sufficient.
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
