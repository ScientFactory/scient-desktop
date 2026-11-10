# LaTeX Visual editing

Status: Draft
Owner: Yaacov
Created: 2026-10-19
Last updated: 2026-11-10
Purpose: Describe current LaTeX Visual capabilities, source and editing authorities, presentation, integration boundaries, and qualification limits.
Doc type: Current implementation

## Document rules

This is the capability and architecture owner for LaTeX Visual. It explains what
the mounted editor supports, how it changes physical source, and where its
browser presentation differs from compiled TeX. [LaTeX Help](../user/latex.md)
owns user instructions. The [document system map](scient-documents.md) routes
shared behavior; [LaTeX build and navigation](scient-latex.md),
[file saving](scient-file-saving.md), [document PDF export](scient-document-pdf-export.md)
and [keyboard ownership](scient-keyboard.md) own those contracts. Local document
creation and personal template behavior are included here because they construct
and reopen this source model.

The source baseline for this reconciliation is
`8006e7bbdab5d2a724a628a2f3c4d3c6d81821ea`, inspected on 2026-11-10.
Implementation statements below are source-backed unless a narrower verification
method is stated. Tests found in source, earlier passing tests and a current
manual acceptance run are different evidence. This documentation update did not
launch a candidate, use a live profile or rerun the October source-model probes.
Earlier probe and browser results below retain their original dates; changes to
source or tests require new evidence before treating a receipt as current.

Keep this owner current when a construct's parsing, editing, insertion or source
mapping changes, when a mounted control changes, or when a boundary gains new
qualification. Preserve the distinction between accepted source, unpublished
input, disk acknowledgement and compiled output. Future work belongs in the
[Visual authoring proposal](scient-latex-visual-authoring-proposal.md);
[performance evidence](scient-latex-visual-performance.md) retains dated workload
results. Neither is proof that a proposed feature or an earlier latency result
applies to this baseline.

## What Visual represents

The `.tex` files are authoritative. Visual projects supported source into a
disposable ProseMirror/Tiptap document, uses native fields and MathLive for nested
input, and presents browser-paged paper. A writing transaction does not run TeX or
call a web service. The compiler's PDF is the authority for final typography,
references and pagination.

Recognizing a construct, displaying it, editing its content, changing its
structure, inserting a new instance and undoing the edit are separate
capabilities. A rich preview can be read-only. An existing imported construct
can be editable without having an Insert command. Exact-source fallback keeps
unsupported source available; it is not a promise of rendered layout fidelity.
A successful compile also does not establish a Visual round trip.

Source outside accepted patch ranges remains unchanged. Within a changed range,
the adapter can normalize spelling and whitespace; comments are retained but can
move. Native range admission checks ownership and expected text, while the format
adapter decides whether the replacement represents supported LaTeX. These checks
are valuable but not complete semantic proof. The
[known limits](#qualification-and-known-limits) include current counterexamples.

## Component ownership

Paths in this table are the starting points for a change; they do not imply that
all editing behavior lives in one file.

| Boundary                     | Current owner                                                                                                                                                                                                                                                    | Responsibility                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| File surface                 | [`ScientLatexSurface.tsx`](../../apps/web/src/scient/latex/ScientLatexSurface.tsx)                                                                                                                                                                               | View selection, hosted reader controls, document preparation, build diagnostics, export and Source integration.        |
| Project assembly             | [`LatexProjectVisualEditor.tsx`](../../apps/web/src/scient/latex/LatexProjectVisualEditor.tsx), [`latexProjectVisual.ts`](../../apps/web/src/scient/latex/latexProjectVisual.ts)                                                                                 | Assemble root and includes; retain virtual-to-physical spans and route edits to an owner.                              |
| Format adapter               | [`latexVisualDocument.ts`](../../apps/web/src/scient/latex/latexVisualDocument.ts), [`latexSourceSyntax.ts`](../../apps/web/src/scient/latex/latexSourceSyntax.ts)                                                                                               | Projection, source ranges, supported serialization, lexical helpers and replacement validation.                        |
| Edit authority and history   | [`latexSourceEditPlan.ts`](../../apps/web/src/scient/latex/latexSourceEditPlan.ts), [`LatexSourceStep.ts`](../../apps/web/src/scient/latex/LatexSourceStep.ts)                                                                                                   | Explicit original-coordinate patches, snapshots and physical inverse scripts in native editor history.                 |
| Canvas                       | [`LatexVisualEditor.tsx`](../../apps/web/src/scient/latex/LatexVisualEditor.tsx) and its object views                                                                                                                                                            | Transactions, local input, mounted commands, object activation and source publication.                                 |
| Object authoring             | [`latexObjectAuthoring.ts`](../../apps/web/src/scient/latex/latexObjectAuthoring.ts), `latexTableAuthoring.ts`, `latexObjectProperties.ts`                                                                                                                       | Bounded source transformations followed by projection and the ordinary transaction guard.                              |
| Root declarations            | [`latexDocumentMacros.ts`](../../apps/web/src/scient/latex/latexDocumentMacros.ts), [`latexEnvironmentDeclarations.ts`](../../apps/web/src/scient/latex/latexEnvironmentDeclarations.ts), [`latexPackages.ts`](../../apps/web/src/scient/latex/latexPackages.ts) | Literal supported macros, environments, packages and command requirements.                                             |
| Language and layout          | [`latexLanguage.ts`](../../apps/web/src/scient/latex/latexLanguage.ts), [`latexVisualLayout.ts`](../../apps/web/src/scient/latex/latexVisualLayout.ts)                                                                                                           | Supported language/direction/font declarations and CSS layout profile.                                                 |
| Counters and links           | [`latexEquationReferences.ts`](../../apps/web/src/scient/latex/latexEquationReferences.ts), `mathEquationNumbers.ts`                                                                                                                                             | Live target/counter presentation and equation-row tags.                                                                |
| Math boundary                | [`LatexMathField.tsx`](../../apps/web/src/scient/latex/LatexMathField.tsx), `mathLiveSelection.ts`, `mathSelectionSession.ts`                                                                                                                                    | Structured native math input, adapters, local drafts, selection and publication.                                       |
| Reading math                 | [`mathReadingNodeView.ts`](../../apps/web/src/scient/latex/mathReadingNodeView.ts), [`mathReadingPreview.ts`](../../apps/web/src/scient/latex/mathReadingPreview.ts), `mathFieldPool.ts`                                                                         | Passive markup, explicit field activation, worker/caching and guarded field suspension.                                |
| Selection                    | [`latexSelectionSession.ts`](../../apps/web/src/scient/latex/latexSelectionSession.ts), `latexObjectSelection.ts`, `latexVisualSelection.ts`                                                                                                                     | Participant ownership, retained menu state, nested/document handoff and source-backed captures.                        |
| Paper                        | [`latexPagedPresentation.ts`](../../apps/web/src/scient/latex/latexPagedPresentation.ts), [`latexPagedFlow.ts`](../../apps/web/src/scient/latex/latexPagedFlow.ts), `latexNaturalMeasurement.ts`, `latexPagedGeometry.ts`                                        | Measurement, incremental page/column plan, decorations and geometry.                                                   |
| Reading continuity           | [`latexReadingAnchor.ts`](../../apps/web/src/scient/latex/latexReadingAnchor.ts), [`latexReadingPosition.ts`](../../apps/web/src/scient/latex/latexReadingPosition.ts)                                                                                           | Resize correction and session-local reopening position.                                                                |
| Writing chrome               | [`writing/`](../../apps/web/src/scient/writing/)                                                                                                                                                                                                                 | Shared bars, names, icons, Insert primitives, find bar, reader controls and footer; editors retain their own commands. |
| Preparation and saving       | [`prepareLatexDocument.ts`](../../apps/web/src/scient/latex/prepareLatexDocument.ts), `latexDocumentInputs.ts`, shared document sessions                                                                                                                         | Settle input, discover relevant sources, flush owners and recheck preparation before build/export.                     |
| Recovery                     | [`visualRecovery.ts`](../../apps/web/src/scient/latex/visualRecovery.ts), `useLatexSourceRecovery.ts`, `visualTypingJournal.ts`                                                                                                                                  | Comparison-first accepted-source recovery and separate unpublished-input journals.                                     |
| Local creation and templates | [`documents/`](../../apps/web/src/scient/documents/)                                                                                                                                                                                                             | Starter selection, companion files, title-based naming and device-local personal templates.                            |

The shared file sessions are still implemented under
`markdownEditor/persistence/`; that inherited path does not make Markdown the
owner of LaTeX semantics. LaTeX has not consolidated all of its recovery stores
into the session registry.

## Source and editing

### Physical source and project context

`LatexProjectVisualEditor` displays the resolved root and supported included
sources even when Source shows an included physical file. The assembler expands
literal `input`, `include`, `subfile`, `import` and `subimport` directives,
records source spans, omits supported subfile document wrappers and represents
include page separators with synthetic spans. It interprets literal
`includeonly`. Missing files, cycles, dynamic includes and expansion limits can
block Visual with an explanation while Source and PDF remain available.

The client assembler is bounded rather than a TeX evaluator. In particular, its
`filecontents` opacity and conditional `includeonly` handling have known gaps.
The server dependency index uses a separate reader, so its more conservative
interpretation does not repair client preparation or projection.

An edit request carries a `LatexEditorSourceSnapshot` and explicit patches in
original source coordinates. `source` is the projected document's exact input;
`rootSource` is the physical root text; `setupSource` supplies assembled
declarations and is never itself a write destination. Parser IDs and offsets are
disposable facts. Persistence admission checks stable document identity and the
working `editVersion`, not just matching bytes. Returning to old bytes after an
intervening edit does not revive a stale snapshot.

The project mapper proves each patch's physical owner and expansion occurrence.
A zero-width boundary insertion supplies its `before`/`after` affinity. Synthetic
separators are not writable. Identical patches to repeated aliases can be
deduplicated; contradictory edits to repeated includes are refused. The mapper
must not guess a destination from a preferred path or a whole-source diff.

A Visual operation requiring two physical files is refused before publication.
This includes a chapter edit that also needs a declaration in another root file:
add that declaration in Source first. Independent saves of project files are
coordinated, not an atomic filesystem transaction. General multi-file source
transactions remain outside the implemented editor contract.

### Guarded transactions and history

Ordinary supported text input can paint locally before conversion. The input
check inspects the changed slot and its source block without serializing the
entire document. Structural changes and new formatting pass through the adapter
before the transaction is accepted. A refused structural transaction leaves the
previous document, selection and undo history in place.

The adapter reuses immutable-node signatures and reparses a bounded replacement
when possible. Structural/context changes can require full validation. A local
object operation obtains its retained source, transforms only owned ranges,
reprojects with setup and submits one ordinary transaction. It refuses an
unsupported result instead of flattening it to displayed text. A current limit
is that standalone object serialization can lose preamble context for some nested
custom environments; rendering an object does not prove every property action
will accept it.

Explicit `LatexSourceStep` operations attach physical inverse scripts to the
existing ProseMirror history. Setup-only edits must publish even when body
content is equal; position-neutral metadata repairs do not create a second undo
stack. Revision-only save receipts and same-owner, same-directory renames can
preserve history. External adoption, changed owners or a changed directory/context
invalidate obsolete history.

Do not promise byte-exact inverse replay for all typing. Earlier entries in a
coalesced typing batch can lose explicit source annotations and be reconstructed
through the adapter. Exact physical inverses for explicit source steps and native
math-field undo are separate paths. Changed-range comment placement and semantic
round-trip gaps also remain relevant to history qualification.

Projection reconciliation skips equal content and replaces only changed ranges,
retaining unaffected node views and mapping selections. Metadata attributes are
compared by value. Source acknowledgements preserve current field text and caret;
an external projection can map a surviving selection through changed content,
with a nearby caret fallback if its content disappeared. Reused parser IDs alone
are not sufficient selection evidence.

### Local input, conversion and save boundaries

Visual contains several input owners: document prose, nested rich cells,
MathLive, native text fields and exact-source fields. Each has local input that
can be newer than the accepted source. The small draft indicator refers to that
unpublished input, not to successful disk saving.

Ordinary prose conversion is coalesced after paint with a 120 ms quiet period and
a 1000 ms maximum batching wait. Text/math fields use a 180 ms quiet period;
rich cells use 120 ms, also with a maximum batching wait. Composition and
unfinished math commands wait for completion. These scheduling values are not
input-latency guarantees. Explicit structure operations and required flushes can
still use a synchronous guarded path.

Blur, field navigation and document preparation attempt publication. Preparation
visits every relevant mounted owner, including unfocused rich cells, and checks
composition before blurring or flushing. An owner in active IME composition
retains input/focus and refuses preparation until composition ends. Refused or
unexpectedly failed conversion keeps recoverable input; it must not silently
restore the previous accepted value. A source-conversion refusal or unresolved LaTeX recovery offer can pause further
editing. An ordinary disk-save failure instead keeps retrying without making
the editor read-only; it can still prevent build/export preparation from
establishing a fully saved source.

Working-source acceptance, recovery checkpointing and disk acknowledgement are
separate. Source and Visual lease the same physical-file session. An included
`.tex` file shares its session with a standalone Source tab. Non-LaTeX includes
retain their existing editor's owner and are read-only through Visual.
LaTeX does not use Markdown's automatic outside-edit block merge. The shared
coordinator defaults to saving the person's accepted text, preserving displaced
file content in history and offering Use the other version. This is distinct
from comparison-first startup recovery and from Overleaf's explicit conflicts.

The cross-window folder flush uses `editorFlush/flushFolderEditors.ts` in
addition to build preparation. `LatexDocumentInputs.commitWhere` commits only
inputs whose own physical files are inside the requested folder. A root inside
that folder can authorize inspection of an outside chapter's pending input,
not its modification. Background commit flushes supported table fields, active
math, typing and source edits without deliberately changing focus or selection;
composition returns `composing`, and input still lacking source returns
`unconverted`. The flush reports these failures and rechecks editors opened or
edited while it ran. Overleaf consumes this contract before sync. It does not
establish an ordinary native-quit save handshake.

## Control map

The controls below are the mounted composition, not a proposed menu system.
`ScientLatexSurface` supplies a `ReaderBarHost`; Visual's reader controls portal
into the file header. A standalone Visual component without that host retains
its reader controls in its own footer.

### Header and view selection

| Control                              | Current behavior                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Source                               | Shared source editor for a physical file.                                                                   |
| Split                                | Source beside PDF or Visual; the preview choice is remembered locally, with PDF the default.                |
| Visual                               | Supported browser writing canvas.                                                                           |
| PDF                                  | Last compiled artifact, with stale/build state kept distinct from the live draft.                           |
| Sidebar                              | Visual outline; PDF provides its own sidebar contents. Visual has no page-thumbnail sidebar.                |
| Previous, page field, total and Next | Active PDF pages or current Visual browser sheets. Visual paging does not require a PDF build.              |
| Zoom steps and percentage            | Shared reader stepping/range; the percentage button fits the page to the pane width.                        |
| Search                               | Finds through the active surface's search adapter. Visual's fuller Find and replace is in Document.         |
| Rebuild / Cancel                     | Prepare and save relevant sources, then request a build; the same slot cancels a cancellable build.         |
| Error/warning counts                 | Toggle a floating diagnostic card without moving paper. A failed-build message opens the same card.         |
| More                                 | Retains controls hidden as the header narrows; other views also expose format-specific export/actions here. |

The row does not horizontally scroll. Zoom steps, arrows and sidebar yield first;
labels compress, the Split preview selector moves into More, and search/zoom/page
fields yield later. Hidden commands remain available in More. Reader shortcuts
also attach to the hosted header slot, so a focused header control still owns its
zoom/find actions. Changing Split's preview returns focus to the new view switch.
Diagnostics close on outside interaction or Escape.

### Writing row

The permanent order is Undo/Redo, Text, Insert, Math, Lists, Document. Whole groups
move into More on narrow panes; selection-specific controls do not replace the
row or appear in a second row. Shared names/icons and chrome come from `writing/`;
LaTeX supplies availability and execution.

| Group       | Current actions and restrictions                                                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Undo / Redo | Active math field history while editing math; otherwise document history.                                                                                                                                      |
| Text        | Paragraph style, formatting, direction and alignment. Styles include supported headings, Part, Quote and Long quotation. Numbered headings changes the current heading or the choice for a subsequent heading. |
| Insert      | Figure, Table, Code block, Literal text; References; Theorems & proofs; Document blocks; Page break; other supported actions remain in a final group.                                                          |
| Math        | Inline math, Display math, Aligned equations, Brackets, Matrix, Cases and Symbols.                                                                                                                             |
| Lists       | Bullet list, Numbered list and No list. Existing description lists have their own supported editing controls.                                                                                                  |
| Document    | Title & authors, Document settings, References, Find and replace when editable, hosted template/export actions and Keyboard shortcuts.                                                                         |

Formatting targets the active prose or supported math participant. Inline code
uses Ctrl/Cmd+E; Link is in Insert > References and uses Ctrl/Cmd+K. Link insertion
is limited to supported ordinary text within one paragraph. List indentation is
through Tab/Shift+Tab, rather than separate indent menu items. Keyboard bindings
are configurable; the [keyboard owner](scient-keyboard.md) and runtime catalog
are authoritative for the effective binding.

Insert's References contains Citation, Cross-reference, Link and Footnote.
Theorems & proofs offers the supported statement family and Proof. Document
blocks contains Abstract, Table of contents, Bibliography and Verse. Long
quotation, Left-aligned text, Right-aligned text and Part remain reachable as
additional actions. Question/solution and Subquestions have no current creation
command. Imported algorithms, color boxes and column layouts also must not be
inferred to have a top-level creation action from their editable views.

Insertion availability follows the active schema, source and declarations.
An inline-only table cell cannot accept display math. Document insertion is
unavailable during active math; Math still edits that field. Unsupported choices
can remain visible with an availability reason.

`/` on an empty paragraph and Ctrl/Cmd+/ open Insert. Dialogs retain the source
snapshot and selection, finish closing before insertion and refuse stale
ownership. Cancel restores focus without a document mutation. Only explicit
supported prose selections are wrapped in a new statement; ordinary non-wrapping
insertion preserves the selection's contents. Figure upload starts on confirmation;
an uploaded asset is not rolled back merely because the subsequent document
insertion is refused as stale.

### Footer and object actions

The shared `DocumentFooter` is one constant-height line. Contextual object tools
sit on the left; caret/object position and estimated word count sit on the right.
Reader page, zoom and search controls belong in the header. Common object actions
are inline. Other tools use the stable portal destination in a named nonmodal
inspector. The hidden inspector is inert; Escape returns to its trigger.

| Active content                    | Current tools                                                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heading / Part                    | Heading label; heading numbering in Text. Part has its own numbering and label controls.                                                                                                        |
| Title                             | No separate title footer. Document > Title & authors focuses title, author or date on paper.                                                                                                    |
| Equation                          | Edit LaTeX, display numbering/label where supported, and Rows & columns at an array caret. Placement and Symbols remain in Math.                                                                |
| Table                             | Rows & columns (including Delete table), Cells (merge/split), Appearance, Caption and a label for a captioned table, subject to source constraints.                                             |
| Figure                            | Replace, Appearance, Caption and a label for a captioned figure. Appearance contains width/alignment, supported caption position, placement and Delete figure. Caption text is edited on paper. |
| Statement / proof                 | Available statement type, title and label; proof title.                                                                                                                                         |
| References, links and footnotes   | Supported target/key/body/argument editing; bibliography records open the References panel.                                                                                                     |
| Box, layout, listing or algorithm | Their supported source-owned appearance/body/row actions; recognition alone does not enable arbitrary structural changes.                                                                       |
| Exact-source block                | Source navigation, Apply LaTeX, Cancel and Delete in the block; no duplicate contextual footer.                                                                                                 |

The nearest active object wins, including nested math over its containing table or
statement. Activation is scoped to the Visual workspace. A plain object click
activates tools without automatically selecting the whole node; explicit node
selection, modifier clicks and drag ranges remain different actions. Table-border
clicks enter a cell. Whole-table selection is available through scope expansion
(Ctrl/Cmd+A from a cell), not a separate Select table item in the current footer.

Menu/popup ownership follows portals back to the active object. Menus retain the
caret or rectangle selection, restore it before a deferred command and release
it before a new pointer choice in the paper. Dismissal must not insert a
paragraph, take focus back from Source or collapse a deliberate range. Object
action failures use the document notice; field validation stays by its input.
Property controls never enter the measured paper or resize it on activation.

The word count is an estimate from `latexWordCount.ts`, after the document
boundary and excluding comments, math, literal code, command syntax and reference
keys. The selected count comes from the active selection; the displayed total
is at least that count. Recovery shares the footer and compresses to its
comparison control as space narrows.

### Find and replace

`useLatexVisualSearch.ts` reuses the shared document-text matcher and find bar.
Search transactions stay outside history and saving. It indexes supported inline
content in the root editor; math, exact-source blocks, title/caption attributes
and separately mounted table-cell editors are not a complete document-wide text
index. Source search is the alternative for exact LaTeX.

Replace is offered when editable. Replace all works from the last matching text
block backwards, commits one block, yields until after paint and gives each block
its own undo step. It stops on refusal, composition, typing, undo, outside
adoption, closing/restarting find or another semantic document change.
Position-neutral metadata repairs can continue the operation. The hook requires
a stable commit callback so a render does not redefine that boundary.

## Construct coverage

This table summarizes the implemented editing surface. The sections that follow
record important exceptions; no row means arbitrary package support.

| Construct                                   | Reading                                                                       | Editing and creation boundary                                                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prose, headings, inline styles              | Native editable text and supported marks.                                     | Narrow token edits; supported heading/style commands. Custom formatting/macros can fall back to source.                                                                  |
| Lists and description lists                 | Supported nested lists and literal numbering options.                         | Bullet/numbered conversion, removal, supported description terms and item controls; rich/nested conversions can be refused.                                              |
| Math                                        | Passive MathLive markup until activated.                                      | Structured input, placement, brackets, matrices, cases, symbols and bounded source edits; protected outer numbering restricts structure.                                 |
| Tables                                      | Supported ordinary, stretch, spanned and longtable projections.               | Inline cell content and bounded source-owned structure/styles. Generated/imported grids have stricter operations.                                                        |
| Figures and images                          | Supported image/boxed/subfigure layout.                                       | Image selection/import, captions and owned properties; unsupported structural artwork remains source-owned.                                                              |
| Statements and abstract                     | Editable native body with generated heading/counter presentation.             | Supported prose/math/children, literal title/label and available declaration conversion. Dynamic definitions remain source-only.                                         |
| Columns, minipages and alignment containers | Bounded CSS layout with editable children.                                    | Owned body/property changes; TeX global flow remains approximate.                                                                                                        |
| Color/frame boxes                           | Bounded literal options and editable regions.                                 | Supported content/title/appearance; generators have separate materialization limits.                                                                                     |
| Literal code                                | Exact body with optional syntax backdrop and listing presentation.            | Native body/caption fields; closing the environment through body input is refused.                                                                                       |
| Algorithms                                  | Supported algpseudocode lines, comments, indentation and counters.            | Line/caption edits; bounded step/block insertion, wrapping, branches, comments, moving and deletion. Unknown commands or drawing overlays use fallback/compiled preview. |
| Citations and links                         | Bounded reference labels, targets and preserved notes.                        | Key/target/argument editing and insertion where supported; no general project key rename.                                                                                |
| Footnotes                                   | Live markers and generated note bands.                                        | Supported inline body editing; custom counters/minipage semantics and multi-page fragmentation are not complete.                                                         |
| Bibliography                                | Manual entries or bounded compiled BibTeX presentation.                       | References edits original manual entries or linked `.bib`; generated `.bbl` is never a save target.                                                                      |
| Title and document controls                 | Supported standard title, chapter/appendix/page controls and generated lists. | Title/authors/date and bounded document settings. Custom title/class code remains Source-owned.                                                                          |
| Literal count loops                         | Bounded expansion into the existing document model.                           | An edit can materialize generated source; document-loop and color-box-loop safety differ.                                                                                |
| TikZ/pgfplots                               | Exact source until explicitly admitted compiled preview.                      | Drawing source/caption editing; no drawing editor. Opening/editing does not itself admit TeX execution.                                                                  |
| Unknown/executable syntax                   | Exact-source block with reason and source access.                             | Apply checks the captured source generation and original block. It does not evaluate arbitrary TeX.                                                                      |

### Prose, formatting, lists and language

`latexTextFormatting.ts` maps supported LaTeX to marks and serialization. Literal
accents, common Latin letters and text symbols project to editable Unicode while
retaining narrow source tokens. An accented grapheme is one token. Command aliases,
control-word delimiter spaces, empty argument terminators, `~`, thin spaces,
quotes/dashes and explicit breaks have distinct source handling. `\\` and
`\newline` break a line within a paragraph; a blank source line starts a paragraph.
Single ordinary source line endings/spaces collapse as TeX prose, while the active
session retains unfinished repeated spaces without moving the caret.

Supported inline styles include bold, italic/emphasis, typewriter, small capitals,
underline, roman/sans families and bounded standard font/size declarations.
Document copy/cut uses the source serializer when a selection contains math,
recognized inline-command atoms (including supported references/links/notes) or a
table. If the selected structure cannot be serialized, it falls back to text.
Plain prose and formatting-only selections use text export. Copy does not publish;
cut is an ordinary guarded deletion/history action.
Pasting a reference carries its key, not its target source or bibliography record,
and remains subject to the destination's admission.

Comments are hidden in supported prose, including standalone comment lines;
escaped percent signs and literal-code percent signs remain content. Comment line
endings do not add printed spaces. A comment-only document still has an editable
paragraph with insertion outside the comments. Replacement can relocate comments
inside the edited range; preservation is not positional identity there.

Supported `protect` wrappers share the source grammar. Unknown macros, unknown
control symbols, unsupported break options and category-code changes remain
protected/fallback. Some compound inline edits can patch around uniquely matched
unchanged top-level formulas/references. Nested, repeated or reordered atoms still
require the validated replacement path. The delimiter-deletion case in the
[limits](#qualification-and-known-limits) prevents a blanket semantic guarantee.

List conversions target the current list or split around explicitly selected
items. Choosing the current type is a no-op. Supported child nodes survive
conversion; removing a description list retains terms as bold prose. Numbered
splits retain the following start through supported `enumerate[start=N]` source.
The footer supports bounded numbering format/start/resume. Custom label macros
and unsupported rich/nested conversions remain Source-owned.

Root language/font interpretation is literal and bounded. English/Hebrew and
supported LTR/RTL wrappers feed shared node-view context. Babel `main` declarations
and literal language-specific fonts take precedence where recognized. Passage
wrappers can change language/direction without moving the paragraph; full
language/direction environments can change paragraph direction. Alignment follows
that direction, with math and source glyph flow isolated LTR. Unsupported or
unresolved setup shows a notice and automatic direction rather than claiming a
resolved language. Text > Direction exposes bounded paragraph LTR/RTL actions,
not a general language/macro manager.

Bilingual source wrappers are retained across styled runs and inline math.
Supported `texthebrew`/`textenglish` in math use screen-only language/font spans
and serialize back to the original command. Literal code is isolated LTR.
Declared package insertion respects late-loading direction packages. Custom class,
font shaping, hyphenation and `microtype` behavior remain compiler-owned.

### Math and outer metadata

MathLive handles structured math, with local fonts and no compute engine or
sound. The source adapter retains formula delimiters and surrounding metadata.
Display `label`, `tag`, `notag` and `nonumber` are kept outside MathLive's editable
body. Outer-row parsing excludes row separators in nested arrays/cases. A
numbered imported formula can therefore allow body edits while refusing an
outer-row-count or equation-type change. A single outer equation label has a
bounded independent patch; per-row labels and unsupported numbering remain
Source-owned. Malformed numbering, nested numbering and unsupported comments can
force source fallback.

Placement converts supported inline/display forms without losing the body;
inline-to-display splits the containing paragraph. Aligned/gathered bodies retain
an inner environment when their outer wrapper changes. Brackets offer matched or
mixed/invisible sides, automatic/normal/fixed sizes and a selection wrapper.
Matrix uses the shared size grid with a bracket choice. Row/column controls act on
the caret's actual innermost array, including nested matrices, with minimum/maximum
dimensions and fixed-column restrictions. Partial-cell selections cannot be
wrapped as if they were one expression.

Ctrl/Cmd+Enter runs the math row-split operation before document-exit handling.
It moves atoms into the next row through one native undo-aware mutation,
preserving following columns and nested surroundings; a single body can become a
two-row `gathered`. Nonempty selections and protected imported numbering refuse
the operation without deleting selected content. Existing row/column structure
commands share availability with the inspector and keyboard dispatch.

Text-menu formatting adapts to math/text slots and emits portable font commands.
Screen-only argument owners retain authored font groups, including empty groups
and scripts, across insertion/undo. Text commands enter their text slot;
math-alphabet commands keep math mode. Document overrides bypass this adaptation.
Legacy math fonts can be read silently and serialize to modern commands after an
edit. Empty editing placeholders never enter `latex-without-placeholders` output.
Math right-click actions are suppressed in favor of the writing menus/footer.

Color input normalizes supported CSS hex to explicit `xcolor` HTML syntax. A
loaded `color` package can satisfy single-color commands using supported standard
models instead. Literal rgb/RGB/gray forms, recognized declarations and supported
mixtures are bounded; unknown expressions and document overrides remain intact.
Clipboard, save and Edit LaTeX use portable syntax.

Edit LaTeX edits the live formula body, including unpublished input. It does not
own placement or numbering wrappers. Refused publication retains that full draft
and the admission reason rather than showing the old accepted formula. A package
request that crosses physical files is refused and reports the needed declaration.

### Tables and longtables

Each editable cell is a single-paragraph nested editor sharing formatting,
references, MathLive, source publication and document history. Display equations
are unavailable in these inline-only cells. Native text selection in a cell,
rectangular cell selection, whole-table selection and a document range containing
the table are separate owners. Clearing a rectangle is one history transaction;
after acceptance, stale field drafts are reset so delayed input cannot restore
cleared contents.

Cell copies use source-preserving cell serialization. Whole-table copies retain
caption metadata. Row/column identity retains surviving cell source, formatting
and field keys during supported structural operations. Empty targets reserve a
small stable width; guides do not change dimensions. Clicking text retains native
caret placement; blank cell space forwards focus to its field. Caption editing is
on paper, and an empty caption does not create a command until edited.

The table adapter supports bounded literal l/c/r and paragraph/stretch columns,
multicolumn/multirow cells, named xcolor mixes and common rules. Logical slots map
to owner cells; covered slots are not rendered as competing editors. Navigation
skips them and selections expand to complete merged owners. Content edits patch
inner ranges. Generic structural serialization is refused when it would normalize
unsupported spans; source-owned operations provide supported rule/color,
merge/split and grid changes. Unsupported reorderings remain disabled.

Paragraph columns wrap to retained widths; mixed tabularx natural columns use
intrinsic width and leave the remaining width to X columns. Uniform generated X
columns retain equal widths. Fit content does not impose a page-percentage minimum
or text-length cap. Alignment follows inherited direction and retained column
modifiers. Header rules do not themselves make text bold. Captions retain order
and independent wrapping; no caption means no empty caption field. Common
booktabs dimensions are approximated in CSS. TeX float placement and custom
caption code require the PDF.

`latexLongTable.ts` separates first/repeated headers, footers and body ranges.
It can create bounded virtual rows from literal required-argument macros whose
definition directly contains cells/row terminators. Cell edits inside a generated
row materialize that call only; other calls and definitions retain source.
Imported generated grids disable structural row/column operations. Recursive row
macros and advanced column dialects remain unsupported.

Continuation bands are read-only rendered rows outside the editable body, with
shared prose/math presentation, rules and inherited font. Measurements reserve
their space before a row break. Body rows keep one editable owner; `endlastfoot`
is preferred with `endfoot` fallback. Supported repeated-header authoring copies
rows rather than establishing one shared editable field. Exact TeX row/page breaks
and continuation definitions remain Source/PDF-owned.

Table guides use noninteractive SVG geometry to fill missing rule segments,
subtracting actual borders and merging duplicates. Bounded observers handle
resize and transformed page stages without observing their own paint. This must
not alter dimensions or printed output. There is no cell-slot marker over every
ordinary table cell.

### Statements, abstract and structured containers

Known theorem, lemma, proposition, corollary, claim, definition, example,
remark/remarks and proof environments can contain supported prose, references,
formatting, inline/display math and nested blocks. Body edits retain opening/end
commands, literal optional title, labels and unchanged equations. Abstract uses
the same structured body path.

`latexEnvironmentDeclarations.ts` recognizes top-level literal `newtheorem`,
starred forms, shared counters, section/chapter scope and standard
plain/definition/remark styles. Unknown counter setup suppresses inferred
numbers. The type menu offers available declarations and the current environment;
it is not environment/package management. Labels remain source nodes hidden on
paper and editable through their bounded control.

Standard statement headings run into the first editable paragraph at the local
inline start. Optional notes are upright; proof's optional argument replaces its
heading. Spacing follows the supported class/amsthm profile. The standard proof
square is generated presentation at the final inline end or after a final
block; custom QED/proof definitions disable that inference. It is not copied or
saved as an editor node. Titles can retain supported inline references.

Literal zero-argument quote wrappers with a supported prefix reuse structured
body editing while retaining their declaration/names. Dynamic definitions,
argument-heavy wrappers, custom theorem styles and unsupported title syntax
remain exact source. Root macro/environment setup must be carried into nested
projection and validation; accepting a wrapper does not prove every child or
property edit is supported.

### Columns, panels and boxes

Balanced formatting groups, literal local typography/colors, paragraph boxes and
supported floats can own editable bodies recursively. Their adapters retain
wrappers and owned argument ranges. A grid-only adapter refuses unowned surrounding
content; an enclosing edit cannot implicitly discard an opaque child.
Literal one-argument heading macros with only supported typography, spacing and a
rule can edit their call argument without rewriting the definition. Conditional,
recursive, executable and unsupported argument forms remain Source-owned.

Standard two-column class options and one/two-column transitions establish source
regions; a supported optional full-width title stays outside the columns. The
planner flows the first column, second column, then next sheet. `multicols`
retains a separate balanced indivisible region. These are different models;
transition/page-break gaps remain documented below.

`latexPageLayouts.ts` interprets bounded literal counts, widths, fixed heights and
inner/outer alignment for minipages/multicols. Layout bodies reuse structured
containers rather than acquiring statement counters or a separate saver. A
minipage row retains `hfill`, explicit `hspace`, whitespace or comment joins;
a blank source line prevents grouping. Width/alignment belong on the outer
node-view flex item, avoiding a second percentage width inside it. CSS supports
literal gaps and root-preamble column separation/rules; structural dimensions
outside that bounded interpretation stay in Source.

`noindent` retains a paragraph attribute. Paragraph terminators do not create
spurious empty lines, while isolated empty paragraphs remain editable.
Supported skip commands have bounded presentation. Root `vfill` consumes remaining
printable space before the next authored break without rewriting source.
A paragraph-boundary `columnbreak` and an inline break are distinct: inline
breaks preserve paragraph continuity and measure a widget after the containing
line. The `[4]` form follows that distinction; a source newline alone is not a
paragraph boundary. Final TeX splitting, float behavior and output routines remain
approximate.

Attributed inline color/frame wrappers preserve their expressions. Supported
`tcolorbox` upper/lower regions keep native children and the `tcblower` separator.
Literal title/frame/background/title colors, breakability and bounded corner,
shadow, dashed or west-border styles can be read. Mounted box appearance tools
edit supported background, border, corners, padding and breakability; Title focuses
or adds the supported title field. `tcblisting` with listings reuses the literal
code field. Unsupported options retain exact-source fallback. Breakable boxes
keep one editable body and allow supported paragraph-line pagination; CSS
continuation frames are an approximation.

### Literal text and algorithms

Inline `verb` is one command atom. Structure/comment/package scans skip its payload;
edits retain its delimiter or choose an unused one. Multiline input cannot become
inline literal source. `verbatim`, `verbatim*` and `lstlisting` retain exact body
and option ranges. Body changes patch the body; a line that would close its
own environment is refused. Caption fields use the existing inline mapper.

Listing presentation combines supported root `lstset` with local options:
language, simple captions/labels, common font/style/color settings, line-number
placement/start/step, blank-line numbering, tab width, supported frames, wrapping,
string-space visibility and caption position. Unknown options remain in source;
named styles and executable TeX are not evaluated. Numbering is the bounded
Visual listing sequence rather than an arbitrary custom counter.
The native textarea owns input and selection. A noninteractive CodeMirror/Lezer
backdrop paints supported syntax and separate numbers; language-load failure
leaves plain editable code. This adds no competing editor/session authority.

Standard `algorithm` floats with `algorithmic` have bounded algpseudocode line
editing: requirements/guarantees, State/Return, loops and if/else branches,
comments, indentation and line numbers. Captions and existing lines patch their
ranges. Enter/Add step inserts State; a row-count change serializes only the
algorithmic body. The mounted Steps menu also inserts supported step kinds or
balanced condition/loop blocks, wraps selected steps, adds comments or Else/Else
if branches, and moves/deletes complete supported structures. Paired ends and
branch boundaries move as editing units rather than separate loose lines; an
empty structural-line deletion can unwrap its pair while retaining enclosed
content. Appearance controls line numbers and floating placement, with Caption
and Label when applicable. These operations pass through
`latexAlgorithmEditing.ts`, `latexAlgorithmCommands.ts` and the ordinary source
guard; invalid structure is refused. Standard font declarations and supported
spacing are retained.
Unsupported pseudocode remains exact source. Algorithms with TikZ overlays can
use a compiled read-only preview of the complete float so minipage/brace layout
is retained; that execution follows the same explicit admission boundary as
other drawing previews. TeX owns float placement.

### Generated loops

There are two distinct adapters. `latexDocumentLoops.ts` recognizes one bounded
literal document-level count loop with a preamble-declared register, literal
bounds and increment by one. It can expand supported zero-argument paragraph
macros and literal counter reads. It rejects nested/dynamic forms and register
uses outside the expansion. Iterations are limited to 100, with separate source
and expansion budgets.

The virtual projection contains ordinary blocks and maps back to the loop's
physical range. An unchanged expansion collapses to the original loop. Editing
it can materialize ordinary source through the existing history path; matching
the original text can restore it within that session. The document-level
materialization result drives the notice that the loop is now ordinary LaTeX.

`expandColorBoxLoop` recognizes a different bounded newcount/advance/ifnum form
inside a box. It also keeps an unchanged loop and materializes an edited body,
but **does not provide the same notice or whole-document later-register guard**.
October 2026 model evidence shows it can remove a declaration still used after the
box. Do not document that conversion as universally safe or announced in the
footer. Exact byte restoration through a mounted typing/undo lifecycle needs its
own qualification; the generic existence of document history is not that proof.

### Figures and resources

Figure selection lists project images and allows PNG/JPEG import. Paste/drop of
one PNG/JPEG uses an upload bookmark and the root-relative `assets` destination,
with a 20 MB limit. The original selection is mapped while upload runs.
Choosing a local file in the insertion dialog creates only a preview candidate;
upload starts when Insert is confirmed. Existing
uploaded assets can remain after a later stale-insertion refusal.

Visual resolves images from the root directory and supported graphics search
paths/options. Literal boxed artwork/subfigures can project `fbox`, fixed-height
`parbox`, zero-width height rules, `rotatebox` and `includegraphics`, including a
bounded one-argument preamble macro of that shape. This is recognition, not macro
execution. Individual text/caption/label/path ranges can be edited without
rewriting wrappers, dimensions, rotation or separators. Structural layout changes
and unsupported artwork retain Source fallback.

Cropped images use supported physical-resolution trim/clip constraints. Rotated
bounds are measured without resize feedback from the transformed stage.
Figure/subfigure references derive standard bounded counters only when their
setup is known. Labels follow captions to bind the counter; `ref` can use the
full panel reference and `subref` the panel letter. Target navigation highlights
the panel/figure without selecting its text. Unsupported captions/counters and
TeX float placement require the compiled PDF.

### References, links, notes and bibliography

The live target index separates citation keys, reference labels and hyperlink
destinations. Duplicate targets are suppressed rather than guessed; unresolved
imported keys remain visible. Cross-reference insertion offers bounded default,
number and page-number forms. Citation selection can contain multiple keys;
package-specific natbib/biblatex forms are offered only for detected setup.
Changing keys retains the existing command and optional notes. This does not
provide project-wide key renaming.

`href`, supported hyperlink/hypertarget and optional-label hyperref retain their
argument structure. Plain link fields can be edited in the footer; formatted
labels use the supported read-only/source path rather than being flattened into
plain text. Navigation shares temporary highlighting and does not add source or
history. Same-file heading-label rename plans can update known reference
arguments while preserving comments/literal source; included files and dynamic
references remain outside that operation.

Footnote markers use live estimated counters; generated bands appear at the
containing page/column foot. Marker and note navigate to one another and share
supported inline body editing. The editor is kept within visible paper/pane
bounds for zoom, RTL and narrow Split panes. The focused block releases
containment so its field remains reachable. Enter/Tab/Escape or outside interaction
finishes that editor. Custom counters suppress inferred numbers; minipage-specific
numbering/placement and oversized multi-page note splitting are not complete.
Bands never enter source or history.

Document > References opens the adjacent panel, or a right-edge overlay on narrow
panes. Citation footer actions can open that panel at a key; insertion pickers
remain separate and retain their caret snapshots. The panel works with explicitly
linked bibliography files and manual `thebibliography`, not an unrestricted
workspace bibliography discovery service. It reads at most 24 linked files and
bounds search results.

`latexBibliographyModel` owns balanced entry ranges and single-entry rebase.
Untouched entries, unknown fields/string records and supported formatted manual
bodies keep their source. Existing keys remain fixed in the panel, advanced source
must retain that key, and removal confirms citation impact. Unsupported manual
markup stays exact source. Entry drafts remain bound to original document/path;
removing that target refuses saving instead of choosing another bibliography.

References and standalone `.bib` Source lease the same file session, including
revision/departure guards and save notices. An unrelated entry change can be
rebased; a changed submitted entry is refused. Success is reported only when the
confirmed session baseline contains the submitted key/text (with line endings
normalized), or confirms its removal. A clean lane alone is insufficient.
Duplicate submitted keys are refused. Failed/refused/superseded writes retain the
form. `.bib` and reference forms have session-local drafts but no general
startup bibliography draft-recovery offer. The shared registry still journals
exact publication intents for non-Markdown files, including `.tex` and `.bib`,
before transport admission and retains them until acknowledgement is known. That
publication journal does not checkpoint every newer ordinary draft or unfinished
reference form.

For external BibTeX, successful build evidence can contain a bounded generated
`.bbl` presentation, up to 1 MB. The client parses ordinary bibliography entries
without executing helper definitions and follows compiled citation order. When
current evidence is absent, project Visual can read a root-adjacent `.bbl` as a
last-compiled fallback; this does not create a saver or establish PDF currentness.
A matching successful build supersedes it. Missing presentation asks for a
rebuild. Generated `.bbl` is never edited by References, and BibLaTeX generated
presentation remains unsupported.

### Title, settings and generated document blocks

Title, authors and date are editable on paper where their source is supported.
Document > Title & authors focuses them if a title block exists; otherwise Add a
title explicitly creates/restores the standard block without clearing effective
metadata. Editing metadata does not itself insert a title block, and there is no
paragraph-to-title command. Clearing author/date can hide the corresponding
field. Default/today date presentation intentionally uses the current date; it
is not evidence of an unwanted source mutation. Custom title formatting/pages
remain Source-owned.

Document settings reads supported current values, retains an opening source
snapshot and applies only changed fields. It exposes supported page, style,
language and related layout choices; Apply refuses a changed source snapshot.
Margin edits retain untouched sides. Introducing geometry is bounded to supported
standard-class context; incompatible custom-class changes require Source.
Standard article/report/book class switches retain their compatibility guard.
Settings source-boundary detection still has a comment/literal-marker gap;
recognition by the general profile does not prove this dialog parses every
preamble identically.

Literal title/author/date, page-numbering and appendix controls can occupy
zero-height source-preserved positions. Effective title declarations before
`maketitle`, including supported in-body declarations, feed the title block.
Report/book chapter and appendix structure supplies bounded heading decorations,
counters and generated contents/figure/table lists. Supported titlepage setup
uses a printable page and chapters start fresh sheets. Contents retain levels,
leaders, live titles and targets; explicit contents metadata retains its block.
Custom classes/counters, float queues and two-sided blank recto pages need TeX.

The Visual contents page map is the current browser plan. Compiled `pageref`
markers are separate revision-bound evidence. There is no general `.aux`
reconciliation of Visual numbers. Reliability gates suppress some unknown
counter setups, but separate Part view/projection logic remains; do not promote
estimated numbers to compiler truth.

## Selection, keyboard and source navigation

### Participant and menu ownership

`latexSelectionSession.ts` coordinates document prose, nested editors, MathLive,
native text fields and table rectangles. Commands act on the active participant.
Menu snapshots retain bookmarks/stored marks or guarded model/value identity;
parent expansion/shrink crosses participants without borrowing an unrelated
document caret. A click, input, changed document or window blur invalidates stale
restoration. Owned portaled menus/selects preserve selection; other focus choices
release it.

Ctrl/Cmd+A expands from the innermost scope through parents, retaining distinct
owners even when their ranges coincide. Clicking/moving/typing resets that ladder.
Formatting entry follows authored outer-to-inner marks when the source projection
matches; otherwise it derives current mark runs. Leaving removes the active mark;
entry remains local to prose instead of escaping a math or table selection.
Formatting scopes are skipped during structural Tab traversal. Effective command
bindings come from the configurable keyboard catalog, not hard-coded menu hints.

Dragging within a cell/branch keeps local precision. Crossing an array boundary
selects the relevant rectangular cells or complete nested array; crossing a named
branch selects its owning fraction/script/bracket/label structure. Base and
script scope includes detached script atoms when the full base is selected.
Reversing into the original branch restores local selection. A plain click still
places the caret. Shift+Arrow uses the same owner normalization; vertical math
movement retains horizontal intent until horizontal movement/input/pointer resets
it. Boundary arrows can leave an array; Shift selects that array first.

A drag leaving nested math/table/source input transfers to one document range
including the starting/intervening objects. Returning can restore the inner
selector. Document-origin drags that cross objects use the same range rule.
The native-selection fence remains through release and the following click so
browser tracking cannot collapse the accepted range or open a newly selected
object. Table/model notifications preserve valid rectangular selection rather
than flattening it. Clearing math cells preserves dimensions; deleting an empty
cell can unwrap its nearest structure in native undo-aware order.

Document Undo/Redo that restores a formula resets the native MathLive model
silently before parsing, discarding stale cell/pointer state. An acknowledgement
of current source does not reset live input. Math/text mode navigation alone is
not a dirty source edit, but completed LaTeX command input still needs publication.

### Painting, caret and empty guides

Selection is a screen-only layer inside the zoom frame or active math wrapper,
using local coordinates derived from measured origin/scale. Scrolling and math
panning retain its attachment; clipping is native. Resize, selection, font,
image and relevant content changes request geometry. Measurements precede
presentation writes; unchanged styles are not rewritten. Active participants
control paint so inactive parents cannot paint behind a nested selection.

Document ranges measure visible leaf text, fields, math, cells, images and
artwork without overlapping wrapper fills. Generic atoms use node selection;
document scope uses AllSelection. Math measures ink/rules and excludes caret
sentinels, joining one outer-row fill while retaining separate cell rectangles.
Detached scripts join the base's coverage. Native math/browser text highlights
are suppressed where Scient owns paint; hidden measurement surfaces and controls
are excluded. Observer targets/listeners are released with the view.

Empty fields use stable gray corner guides from local draft emptiness, including
composition. Ordinary empty paragraphs and hover do not create guides. Math guides
resolve the innermost argument/cell from native model offsets; anonymous font
wrappers do not displace the authored slot. Empty cells retain larger hit targets
but compact painted guide/selection bounds. The current empty slot is not painted
twice; occupied guides yield to content selection. Zero-size baseline anchors and
local caret metrics keep entry from resizing the expression or translating its
caret. Guide margins scale with zoom. These are presentation invariants, not
new source tokens or history steps.

Active math and its containing paragraph release paint containment when needed;
inactive content retains it. MathLive shadow DOM/VBox selectors, internal atom
bounds and ProseMirror DOM-observer APIs are private library dependencies.
Their presence is a maintenance boundary, not proof of a leak or current latency.
An upgrade must qualify caret, guides, hit-testing, undo and serialization, rather
than only type-checking the adapter.

### Visual, Source and chat captures

In Split, Visual double-click can reveal the owning physical source without
replacing/blurring Visual; normal word selection happens first. Source double-click
can reveal the mapped Visual block without changing its editing selection.
Both directions require current published source/project spans and refuse stale
or ambiguous mappings. Outside Split, Visual double-click does not switch views.
Math's second-tap path supplies equivalent navigation when native double-click
is suppressed.

Supported field/cell/caption/title/footnote/literal offsets use authored slot
ranges. Paragraphs/headings use token maps; math can refine to a verified cell or
unique selected fragment. Repeated ambiguous grids retain a containing-block
mapping instead of guessing. Reveal waits for publication/layout, scrolls only
its target pane and highlights briefly. Source interactions cancel delayed
navigation guards. The shared Source surface stays mounted and uses Pierre
`setViewState` for verified selection to avoid focus/scroll side effects.

Chat quotation uses model-owned content/geometry, current source ownership and
draft identity. Nested math/cell quotes preserve selected content while anchoring
to their containing source block. Unpublished fields and stale models cannot
authorize a capture. Cross-file selections currently require separate quotes.
`FileCitation.latex` adds root/source-anchor identity; it is distinct from raw
UTF-16 `sourceSelection` captured by the shared Source citation actions.

In the original workspace, reopening a Visual quotation uses Split and validates
draft/hash/context before painting a range. A uniquely verified moved anchor can
be adopted; an unverified quote falls back to its recorded line with a notice.
Source quotes reopen Source, retaining a LaTeX root for included files. If the
conversation has moved to another workspace, citation navigation opens the original
file read-only with a notice instead of applying those Split/Source reveal options
to a different file. A focus handoff to the quote action can
retain it, while changed source requires a new capture. Source/PDF SyncTeX remains
a separate compiled navigation authority described in
[build and navigation](scient-latex.md). Source inspection does not establish
all of these cross-pane/browser interaction outcomes on this baseline.

## Paged paper and reading

### Measurement and page plan

One ProseMirror document owns content, selection and undo. The pager measures
natural content, computes a pure page/column plan, then applies presentation
decorations. Generated sheets, furniture, gaps, repeated table bands and footnote
bands are not source or competing editable models. Translated fragments retain
native text hit testing through `latexPagedGeometry.ts`.

`latexNaturalMeasurement.ts` excludes presentation gaps/bands and uses passive
math markup rather than allocating native fields. Suitable visible content can
be measured in place with zoom-normalized rectangles; offscreen, fragmented or
actively edited content can use detached copies. The native-caret paragraph is
not repeatedly revealed just to measure it. Math fonts precede initial planning;
formula/image/font completion invalidates affected measurements. Cached heights
and immutable-node measurements survive cancelled batches when still valid.

`latexPagedFlow.ts` checkpoints continuation state and backs up affected keep
and elastic groups before reusing an equal suffix. Display skips can shrink
within a bounded allowance rather than scaling the formula. Global profile
changes invalidate measurements. Work yields in batches, rejects obsolete
generations, waits through composition and skips panes without usable geometry.
The suffix-deletion counterexample below shows that incremental equality is not
complete under every edit.

Paper dimensions are inches converted to CSS pixels at 96 per inch; typography
starts from TeX-point/source profile values. Supported class/package geometry,
font size, spacing, paragraph indents, headings, list options, table sizes and
literal local declarations feed CSS. Custom class code and executable package
behavior do not. Browser wrapping is not TeX paragraph optimization, glue,
hyphenation or float placement. Matching page counts on a fixture does not
establish pixel fidelity.

Content visibility keeps offscreen mounted blocks cheaper, with measured height
hints. Fragmented paragraphs, active fields, run-in heading pairs and bands remain
rendered where geometry/selection needs them. A revealed skipped block invalidates
the relevant suffix only when its natural size needs new layout; an unchanged
observed size does not restart pagination. Intrinsic-size reservations are numeric
heights, while visibility and ResizeObserver state track which reveals need work.
Block origins are read from one layout, and previously published spacer/flow
offsets within one CSS pixel of their new value are retained to let geometry
settle. ProseMirror widgets such as gaps and gap cursors do not recursively
schedule another pass when painted. Static natural measurements and style reads are batched
before presentation writes. ProseMirror's DOM observer is paused for owned
presentation-attribute writes so it does not redraw those decorations as foreign
mutations. The chunked live-block idle measurement is a non-paged fallback;
it deliberately stops while the paged-layout owner is active, because paging
uses its own natural-copy measurement. That guard is not evidence of a missing
paged recovery path.

### Pages, zoom, notes and running furniture

Reader page count/navigation uses the current Visual plan and sheet stride, not
last build markers. Current-page tracking reads at most once per animation frame.
The outline starts collapsed and contains document headings, not page thumbnails.
There is no ruler. Supported run-in paragraph/subparagraph headings, nested-list
spacing, contents number columns, abstracts and ordinary caption/rule sizes use
bounded standard-class approximations.

Footnote bands reserve space at their page/column foot, with a separator at the
inline start for the document direction. Unchanged bands keep their DOM.
Minipage semantics and oversized notes are not generally fragmented/reconciled.
Simple running headers/footers can show supported page/section tokens, first-page
style and odd/even fields outside the editor model. Custom executable page styles
remain compiler-owned.

Visual shares reader zoom stepping, 25–500% manual range, fit-width calculation,
stable scrollbar gutter and navigation sidebar geometry with PDF. Fit uses a
40 CSS-pixel total page inset and the unscaled observed pane content width,
excluding borders/scrollbar. Initial fit measures before paint; hidden panes
retain their last useful dimensions. Explicit fit measures the current pane.
Observer-free compatibility measurement occurs after editor paint.

Overfull display math keeps its natural size and can extend into the margin;
the paper/frame clips horizontal ink so it cannot enlarge outer document scroll
geometry. Only an active formula gets a horizontal math viewport. Trackpad,
Shift+wheel and caret following share it; hidden native scrollbars and matching
padding preserve normal-flow geometry. Leaving releases active panning; keyboard
re-entry can restore its offset, while a new pointer target takes precedence.
Viewport state never enters source/history. Formula struts retain natural height
and guide space rather than imposing a fixed field height.

### Opening and reading continuity

The entire document remains mounted after progressive loading; reading does not
swap blocks for placeholder models. `latexProgressiveLoading.ts` begins around a
remembered reading block with an approximately 8,000-character JSON budget, then
adds slices above/below after animation frames. Its time estimate and minimum
fraction of loaded content bound the number of slices. Loading transactions do
not enter source publication/history and editing remains disabled until the
full projection is installed. A changed projection stops old loading before
adoption. Reference positions/counters account for the opening slice, then settle
against the full document.

`latexReadingPosition.ts` remembers up to 32 documents for the app session, using
a top-level block plus visual offset. Restoration waits through progressive page
plans. Explicit page/zoom navigation cancels restoration through a reader-owned
event; disposal also retires scheduled work. This was repaired in
`05468a46ebfedd753f804af3f86ac3adaa8b69bc`. The prior revalidation ran the maintained
two-test Chromium fixture for progressive reopening and reader zoom cancellation.
Outer-scroller/scrollbar interaction is a separate residual source risk: current
interaction listeners are on the editor DOM, so those targets need their own
mounted qualification. Do not describe all reader navigation as still broken or
as fully proven safe.

The browser's own `overflow-anchor` is disabled. `latexReadingAnchor.ts` maps a
visible line/block anchor through transactions and compensates for resized
content above it, including formulas/fonts/images and prepended loading blocks.
Appends below do not require correction. Caret reveal establishes a new anchor;
zoom re-captures it. Shared visible-target hit testing accounts for margins and
column gutters. This resize anchor is distinct from remembered reopening position.

### Compiler page evidence

Matching successful build evidence can supply SyncTeX page anchors. The surface
requests `/api/scient/latex/synctex/pages` for the relevant artifact/source state
and aborts obsolete requests. The server derives real page count from the bounded
SyncTeX index, locates at most the first 2,000 page anchors and rejects an
unavailable batch rather than publishing partial query success. Results are
cached by build revision; the shared batch has its own bounded lifetime.

The project mapper places an anchor only when physical file revisions match the
build. Repeated inclusion can make an occurrence ambiguous and leave it without a
marker. Multiple pages may begin at one source line/block. Markers remain
zero-height compiled evidence; printed marker rules are hidden during Visual
paging. They never replace a newer browser page plan or authorize a source edit
from PDF coordinates. A SyncTeX page/point is not an exact layout rectangle,
column assignment or general compiler geometry map.

## Saving, preparation and recovery

The [file-saving owner](scient-file-saving.md) defines disk publication,
conflict/departure handling and platform durability. Visual adds input settlement
and recovery responsibilities before that owner can save a complete document.

Markdown, `.tex` and `.bib` lease one shared document coordinator and save notice.
Accepted source saves retry automatically with the current retry ladder and
manual-save bypass; the notice offers Save a copy for a lasting failure.
Successful local-wins publication preserves displaced content through file
history and can offer Use the other version. Server publication is plain on
every host; this format owner does not promise the older native retained-file
semantics. Plain text/code still use the separate generic coordinator.
Publication-intent journal admission remains a durability requirement, so a
storage failure can prevent a save from reaching transport even while typing
remains available. See the saving owner for platform and publication limits.

`prepareLatexDocument.ts` synchronously asks relevant mounted views to finish
input, discovers literal includes from current working source and flushes actual
sessions even if Visual has never opened. Clean unopened dependencies are read,
not assigned competing savers. A conflict, failed save, unfinished field or
unsaved generic include blocks preparation. Unresolved includes also make
independently pending workspace input relevant because the dependency set cannot
be proven complete. Explicit linked bibliography setup remains an incomplete
ownership boundary: pending/attention-needed bibliography sessions block rather
than being implicitly flushed. Fully resolved unrelated files do not block.
The receipt is checked again immediately before build/export.

Autosaving can continue while the surface is focused. LaTeX's accepted-source
journal observes Source-only edits as well as Visual input; Source/Split exposes
the same comparison-first recovery offer. Recovery is not silent session adoption
and is not a second disk authority.

| Retained material             | Current recovery boundary                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted source               | Accepted copy plus its held base revision, coalesced storage writes and explicit compare/apply/discard.                                             |
| Unconverted prose             | Token-owned changed-block journal in the shared recovery database; a complete synchronous snapshot remains for exit/legacy/failure paths.           |
| Native object/math/text input | Drafts retain observed base/field identity; on reopening they transfer to readable recovery rather than being blindly installed at an old position. |
| Unapplied raw block           | Exact fragment text, including invalid/incomplete LaTeX; View/Copy does not treat it as a complete document.                                        |
| Bibliography form             | Session-local retained form; no general startup `.bib` checkpoint offer.                                                                            |

Accepted-source checkpointing uses a coalesced 200 ms leading deadline, with no
synchronous full-document hash on each input. An offer from storage is parked
before its original live slot is retired, so later typing cannot replace it.
The file changes only after explicit comparison and choice, using the exact source
the user compared, then revision-checked saving after intervening accepted writing
has been published. A record already equal to the file can compare as no
difference. Apply/Discard re-read and act on the exact offered record, preserving
another view's work.

A multi-file assembled recovery cannot be applied as one physical-file save;
it is offered for comparison/copying. If storage cannot park an offer, that live
slot remains the recovery source and editing can remain read-only until resolved,
so new checkpoints do not overwrite it. An applied copy remains live until save
acknowledgement. Storage failures report a notice rather than becoming permission
to overwrite a file.

A source checkpoint gains ownership through a successful write or explicit
adoption of an exact stored copy already accepted on opening or recovery.
Merely observing an occupied slot does not permit replacing a different record.
Opening also does not release another recovery offer's hold on its live slot.
These identity guards are not an atomic multi-window storage transaction.

Raw-block Apply checks original block text, base source and snapshot identity.
After source acceptance its raw fragment is retired only once the accepted source
checkpoint is durable. Failed completion stays read-only/recoverable and retries
the checkpoint rather than publishing the edit twice. Cancel retires only that
interaction; another view's raw input survives. Source changes/new owners cannot
silently reuse the old fragment as a whole document.

Ordinary typing recovery omits native source maps. Rebinding must prove surviving
item correspondence from authored content; ambiguous repeated origins remain
readable recovery. Unknown/retired formats are not mutation authority. Stored
text/math/field records use version/base checks before replacing or retiring
observed data. These checks are not an atomic cross-window storage transaction;
position-keyed fields and storage races still need operation-specific testing.
A normal editable-file read restores a hash-proven BOM before session admission;
raw hash-helper differences alone do not establish a BOM defect in that path.

PDF freshness, automatic build modes, cancellation and export are owned by
[build and navigation](scient-latex.md) and
[document PDF export](scient-document-pdf-export.md). Visual contributes its
current file/dependency receipt and pending-input guard. An observational build
status request does not compile. A PDF may remain readable while stale. Neither
Visual page count nor local editor cleanliness establishes current compiled output.

## Local creation and personal templates

There is no `scient:documents` hub route. The side-panel Document card, Files
New menu and folder New document here menu call `useCreateNewDocument`. It uses
`placeNewDocument` and `useNewDocumentFiles` with the requested folder base; the
file panel then mounts `useNewDocument` and the LaTeX surface. Built-in source lives in
`documents/templates/`. Starter/language/compiler preferences are device-local.
An untitled source opens in Visual; after title editing finishes its first saved
title can supply the filename. Titleless starters use a name field. Numbered
candidates and create-only publication protect existing paths; the server retains
filesystem authority.

Before body editing, the start strip can change starter/language while preserving
the title. Folder starters create `main.tex` and recorded companions; Thesis has
chapters and an initially empty bibliography. Companion changes and title-driven
moves use expected revisions/shared owners. They are coordinated operations,
not an atomic directory transaction. Partial/uncertain results retain a review or
repair outcome and compensation is limited to confirmed owned files.

Save as template is hosted in Visual's Document menu and the other views' More
menu. An associated personal template also offers Update. The name dialog detects
trimmed names case-insensitively and offers Save/Replace. Capture flushes the
selected physical lease and recognized includes, clears the selected title and
stores source, included text and an optional sanitized page picture in device-local
IndexedDB `scient-document-templates`. BroadcastChannel reloads other windows'
lists; this is not server storage, cross-device synchronization or a portable
project backup.

Current capture limits are consequential:

- It captures the selected physical file, not necessarily Visual's assembled
  root. Saving from a chapter can therefore capture that chapter.
- Its separate include collector sees only one braced input/include/subfile per
  line, omits supported import/unbraced forms and can misread an escaped percent.
  Every queued path is resolved from the original folder, losing subfile context.
- It bounds capture to 40 included files and a nominal 2 MiB measured as UTF-16
  string lengths, not encoded bytes. Recognized unreadable/truncated dependencies
  refuse capture; an undiscovered dependency cannot trigger that refusal.
- It does not collect image bytes or bibliography content. Instantiation can
  create empty named `.bib` companions.
- The preview chooses the first visible paper globally rather than a supplied
  document identity; it can be absent or belong to another visible pane.
- Asynchronous reads have no one document-wide revision receipt. Completed
  replacements are unconditional puts, so overlapping updates can finish out of
  order. Template rename alone uses its own IndexedDB read/write transaction.

Template-capture correctness therefore needs its own fixtures; new-document
rename/creation tests do not establish complete project capture. These are
current implementation limits, not a decision that portable resource capture
has been rejected.

## Dependencies and explicit execution

### Declarations, symbols and library adapters

`latexPackages.ts` combines known package providers, emitted changed-block source
and symbol metadata. Required declarations are guarded source edits, retain
existing options and are inserted before relevant late-loading packages. Known
`color` support can satisfy a bounded single-color request; other requests can
need `xcolor`. Non-overwriting color definitions retain authored names.
An edit requiring another physical owner is refused with the required source
change; the native field retains its draft.

Document macro/color/environment setup is bounded literal interpretation, shared
through nested projections and passive/active math. Ordinary calls remain calls;
a supported delimiter macro can edit its body while retaining the wrapper, but
structural changes can serialize the expanded occurrence. Arbitrary executable
macros, custom category codes, dynamic package setup and class code are not TeX
execution in Visual. Setup caches are keyed by exact preamble input and bypass
large cases; they are optimization facts, not stronger source authority.

The symbol catalog supplies command/Unicode/package facts. Presentation families,
search, previews, recents/favorites and supported document macros are separate
from catalog IDs. Preferences store IDs locally, never hidden document macros.
Glyphs unavailable to MathLive can use bundled TeX outlines with per-instance SVG
IDs. Preview recipes and spacing illustrations affect presentation only.
Palette package discovery is still subject to source admission. The footer-hosted
palette retains the document/selection; moving it is screen-only and bounded to
the workspace/window.

Backslash command completion is explicit. MathLive inline shortcuts are disabled;
bare words/punctuation pairs are not silently converted. Shared templates preserve
typed arguments, create supported empty slots and matching environment ends, and
use literal root color/reference/citation inventories for argument completion.
Math, prose/table and Source have different adapters; Source inserts through
Pierre's edit/undo API. Moving the caret, blur, disposal or disabling completion
closes suggestions. Blur can accept a typed formatting command without taking
focus back. Document macro overrides retain their own meaning.

MathLive is pinned with a maintained dependency patch. It affects command menu
lifetime/focus and the readable development/production bundles, among other
adapter contracts. Per-field capture reads native model, selection and undo state;
incompatible capture keeps the live field rather than discarding it. Private
ProseMirror observer/doc-view and MathLive atom/shadow-DOM contracts require
interaction/source regression tests on upgrade. Source import count alone does
not prove duplicate font faces: reading CSS removes font declarations, and
printable shortcut HTML is a different document.

### Drawing preview authority and resources

Complete TikZ/pgfplots blocks can be recognized without interpreting their drawing
commands. Opening, mounting, editing source or editing captions does not authorize
execution. Run this drawing preview admits only the mounted request's current
document/source/preamble/environment/algorithm context. A context/source change
requires a new action; an admitted width change can rerender that same text.
The authenticated endpoint and `LatexTikzPreview` require the explicit host-execution
declaration before reads, toolchain probing or launch. The declaration is not
server proof of a human click or trusted workspace.

TeX/Lua has the selected environment's filesystem authority. `-no-shell-escape`
is not a sandbox. The private preview does not publish generated documents or
establish document PDF currentness. Its `preview` package crop can be painted by
PDF.js. If `pdfinfo`/`pdftoppm` resolve and bounded geometry/process checks succeed,
the service can return PNG pixels for native paint; missing tools, uncertain
geometry, process or decode failure retain the PDF.js path. Temporary PDF
resources/workers/blob URLs are released after paint.

The service may retain at most eight safely retired private build directories,
limited to 16 MB each, for aux reuse. Every request invokes the compiler driver.
Content/path/search evidence covers recorded dependencies, package/font files,
compiler identity, explicit search roots and relevant shadow candidates. Unknown
or excessive evidence forces reprocessing; it is not a source-string output cache.
Nonrecursive search avoids unrelated descendants; explicit recursive search is
bounded. Tectonic has no `.fls` proof and compiles each request with only cached
bundle files.

One directory permit covers preflight, execution, process/output retirement,
postflight and cleanup. A successor cannot enter before predecessor finalizers
settle. Ordinary failed/interrupted/oversized runs discard owned directories;
uncertain process retirement quarantines them and refuses same-key successors.
Startup reclaims only marked contained directories of demonstrably dead same-host
owners with settled retirement evidence. Unknown/live/foreign/symlink-escaping
ownership remains untouched. These rules protect concurrent instances; they do
not constrain the submitted TeX/Lua's own filesystem authority.

Preview does not invoke the managed installer. Missing-package errors direct an
explicit document build. Toolchain/concurrency/cancellation/output/timeout bounds
are owned by the preview service; execution timeout begins after permit admission.
Cross-picture references, document-body definitions and externalization are not
provided by this private preview. Source stays editable after a diagnostic.
Production responsiveness and native-platform behavior need separate qualification.

## Loading and performance boundaries

These implementation choices explain how costs are bounded; they are not a
current responsiveness verdict. The historical workload measurements and proposed
budgets remain in [performance](scient-latex-visual-performance.md).

- Visual is lazy-loaded; Source does not need MathLive. Once opened, Visual can
  remain mounted while Source/PDF is shown so synchronization/recovery continue.
  The theme-bearing surface key can remount it; the exact user effect is not
  inferred from the key alone.
- Main-canvas inactive formulas use plain-DOM shadow-root previews with one local
  style element and shared event/reference subscriptions. Nested editors retain
  their own object views. Native fields mount on pointer/touch/keyboard/insertion,
  not hover or a save-only flush.
- Native field activation stages behind the readable preview until rendered ink
  and geometry are ready. Cancellation/context/selection/focus/readonly/disposal
  invalidates the staging. Eligible simple key input can be buffered, but paste,
  drop and composition payloads are suppressed before admission and cancellation
  discards that buffer. Input retention during staging is incomplete; wait for
  the editable field when testing ordinary input rather than treating suppression
  as successful recovery.
- A soft pool of eight recent fields suspends only inactive collapsed acknowledged
  models. Drafts, composition, commands and retained selections pin fields. Captures
  are field/source/macro/display scoped; outside adoption cannot revive stale data.
- The serial math-preview worker deduplicates equivalent in-flight requests while
  preserving each subscriber's cancellation/viewport priority. The last cancelled
  subscriber can retire active work. Its conversion deadline is three seconds,
  startup is 15 seconds in production/60 in development, output is bounded and
  30 idle seconds releases the worker. Timeouts fall back to exact source;
  transient startup/transport failures permit bounded retry instead of a cached
  permanent rejection. These deadlines do not preempt an active native MathLive
  operation.
- `latexReadingCache.ts` has a 24 MiB estimated budget including keys/overhead,
  with viewport-aware admission. Equivalent immutable macro/color contexts share
  identity. DOM publication yields after small batches, prioritizes input and uses
  cancellable scheduled tasks with a timer fallback; an individual failed callback
  does not starve later previews. A local style avoids constructed-sheet updates
  scaling across every shadow root.
- Large initial projection, quiet ordinary-text conversion and large reference
  work can use the serial Visual-processing worker. Requests retain document,
  source, projection and setup identity. Cancelled/failed work cannot publish.
  Worker bases are bounded to four entries/eight MiB, delta blocks require content
  proof, and an evicted base retries guarded full input. Startup/job/idle bounds
  are separate from synchronous structure/flush paths. Short deeply recursive
  input can still fail before a worker is involved.
- Reference positions map through ordinary typing; semantic counter/caption/label
  changes trigger recounting. Equal recomputation retains presentation identity.
  Bibliography catalogs notify only on relevant presentation change; toolbar
  subscribers avoid full editor-state publication for unchanged collapsed-caret
  input. Stable authoring/notice contexts avoid unnecessary object subscriptions.
  These mechanisms do not eliminate every document walk or React render.
- A dense table still mounts a rich editor and some global registrations per cell,
  with matching cleanup. That is scaling debt, not an established listener leak.
  Long-paragraph line grouping retains a quadratic worst-case scan, and certain
  structural edits can lose local-setup identity across a structured clone.
  Current end-to-end costs and dominant latency require a fresh profile.

<a id="remaining-fixes"></a>

## Qualification and known limits

The table records current consequences or boundaries, not a list of assumed
bugs for every use of the feature. Source/model reproduction is narrower than a
mounted save/reopen/compile or native-input run. Detailed issue evidence and
priorities belong in the separately maintained document-platform issue register;
this owner records the contract a maintainer must not overstate.

| Area                      | Current boundary and evidence                                                                                                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Round-trip semantics      | October 2026 source-model probes reproduced deletion of a control-word delimiter that is admitted as changed meaning. Changed-range comments can be retained at a different position. Native range ownership does not fix either adapter behavior.                                                                      |
| Generated box source      | An October 2026 model reproduction showed an edited color-box loop can remove a register declaration still used afterward and supplies no materialization notice. The document-loop adapter has a separate outside-use guard.                                                                                           |
| Dependency interpretation | October 2026 assembler probes reproduced a false include inside `filecontents` and inactive `includeonly` excluding active content. Server opacity does not prove client interpretation.                                                                                                                                |
| Document boundary         | Conditional document-ending commands are not generally evaluated; October 2026 model cases truncated projection.                                                                                                                                                                                                        |
| Reader/parser setup       | October 2026 model cases showed `newif` affecting heading-macro detection, a percent-comment brace breaking a minipage width, and block-local object serialization missing needed root declarations. Other private readers mask comments before parsing; duplication alone is not a demonstrated defect in all of them. |
| Deep projection           | An October 2026 Node model with 5,000 nested groups in roughly 10,000 characters threw RangeError below the mounted 12,000-character synchronous threshold. Exact browser limits/recovery need separate qualification.                                                                                                  |
| Source/history exactness  | Explicit source steps retain physical inverses; general coalesced typing can reconstruct through the adapter. A full mounted byte-restoration matrix has not been established.                                                                                                                                          |
| Incremental pagination    | October 2026 pure-planner reproductions found a stale keep-with-next break after suffix deletion and incomplete column-transition/newpage/clearpage semantics. Rendered/compiled comparisons remain separate.                                                                                                           |
| Footnotes                 | Whole-note allocation has no general oversized-note fragmentation; October 2026 model allocation demonstrated that limit. Minipage notes and custom counter behavior also remain incomplete.                                                                                                                            |
| Reading continuity        | Progressive reopening and explicit zoom cancellation have prior passing Chromium evidence after `05468a46eb`; outer-scroller cancellation remains a source-only residual risk.                                                                                                                                          |
| Input staging             | Current admission code suppresses paste/drop/IME before a native field is ready. Eligible key buffering is limited and discarded on cancellation; native payload-recovery is not established.                                                                                                                           |
| Find                      | Root inline-model search excludes attribute fields and separately mounted cells/math/source blocks; it is not a complete search of all visible text.                                                                                                                                                                    |
| Derived presentation      | Counters/page maps are bounded estimates, not general `.aux` reconciliation. Default/today dates are intentional. Landscape projection/presentation interactions and theme remount effects need mounted qualification before asserting a visible defect.                                                                |
| Recovery identity         | Base/version and dirty-field checks exist. Position-keyed recovery alone does not prove wrong adoption, and same-window checks are not atomic cross-window storage. Normal editable BOM restoration is hash-proven; sessionless paths need separate investigation.                                                      |
| Templates                 | Selected-file capture, include grammar/context, resource omission, global preview selection and unsequenced replacements have the concrete scope described above. Capture is not a complete project snapshot.                                                                                                           |
| Performance               | Current structural/cost mechanisms exist, but historical latency numbers are not fresh measurements. Dense-cell scaling, full-document scans, native editing and production builds need workload-specific evidence.                                                                                                     |

### Verification sources and remaining qualification

Maintained source coverage includes projection/source syntax, native source steps,
project assembly, authoring operations, macros/declarations, tables/layouts,
references/bibliography, preparation/recovery and pure pagination. Browser fixtures
cover math/selection participants, object fields, menus, Visual opening,
presentation, reading position and full-canvas stability. The dedicated
`latexSelection.vitest.config.ts` supports isolated selection qualification without
a live profile; the file's existence is not proof of a run.

The earlier document issue audit, at the revisions recorded in its logs, passed
selected maintained tests and executed bounded source-model/planner probes.
The two reading-position Chromium tests qualify progressive reopen and reader
zoom cancellation on that audited candidate. The model observations in the table
retain their October dates. Parser and adapter source was inspected for this
reconciliation, but paging, input and persistence have changed; the affected
fixtures need fresh runs before those outcomes qualify a new candidate.
Current tests and exact run results must be recorded alongside the candidate
being qualified, not inferred from historical owner acceptance.

The October guide reconciliation also ran bounded Node probes for exact
delimiter-only deletion, changed-range comment relocation, block-local setup,
box-loop materialization, conditional document endings, deep nesting and pure
pagination. Those runs used the actual source models at the then-recorded
revision; they did not run a native editor, disk save, TeX compiler or rendered
page comparison, and were not rerun for this update. A related deletion-plus-typing control is protected by explicit `{}`
serialization, so the delimiter failure must not be generalized to every edit
beside a macro.

The owner reviewed an earlier Visual candidate on 2026-10-08 and reported further
responsiveness, math-caret/selection and renderer concerns on 2026-10-15. Earlier
compiled comparisons of representative thesis/template documents established
coverage/page spans for those candidates, not arbitrary-package or pixel identity.
Their repair direction remains in the
[renderer regression plan](scient-latex-visual-authoring-proposal.md#renderer-regression-repair-plan--2026-10-15).
The [historical command-placement record](../design/editing-commands-placement.md)
is context, not a second menu authority.

#### Dated owner review and open reports

The 2026-10-08 running-app review recorded Ctrl+A as owner-verified, along with
the other then-reviewed workflow checks. This is dated owner evidence, not a
fresh automated or installed-candidate qualification at the November baseline.

The responsiveness, math caret/selection positioning and rendering-completeness
reports remain open pending requalification. Named rendering cases include the
supplied mixed-column `tabularx`, the reported `\mathbf{n}` appearance and
`29_long_photo_and_heavy_components.tex`. They must not be silently closed by
this reorganization. The 2026-10-15 renderer-plan lineage also records landed
repairs and thesis/template page-span comparisons; those remain historical
evidence through the linked plan, not proof that all reported cases now pass.

For a construct or library change, qualify each affected operation independently:
source projection and opaque preservation; narrow/body and structural edits;
package/physical ownership; exact refusal; source-step and typing undo; retained
input and recovery; external adoption; selection/keyboard/menu behavior; and
browser-versus-compiled layout where it matters. Representative combinations are
necessary: spans plus rules, nested math plus RTL/zoom, includes plus root setup,
columns plus notes/furniture, and materialized generators plus later references.
A green narrow model test cannot stand in for the disk, native, compiler or
platform boundaries it did not exercise.

## Extending Visual

Extend bounded command/environment adapters that own recognition, physical source
mapping, rendering, round-trip validation, package requirements and operation
availability. Preserve unsupported source visibly and refuse an operation whose
ownership/semantics cannot be proven. Reuse the existing editor history, shared
file sessions and source preparation; do not add a new saver or infer mutation
authority from rendered/PDF coordinates.

The current UI shares chrome with Markdown, not its format adapter. There is no
general capability registry proving every menu/construct pairing, no arbitrary
TeX execution in the editable model, and no complete shared Visual–TeX geometry
map. Proposed compiler calibration, broader source operations, consolidated
recovery and cross-file transactions retain their proposal/decision boundary.
SyncTeX navigation points may inform future mapping but are not content rectangles.
Update this owner when implementation and qualifying evidence change, while keeping
future scope in the existing authoring proposal.

Any future compiled geometry map must retain artifact/input revision, coordinate
system, units, rotation, origin and precision, and allow multiple fragments for a
source range. Unknown columns/rectangles must stay unknown. Projection-local
ordinal IDs alone are not durable build keys. Invalidate evidence when source,
includes, preamble, compiler configuration, fonts or other build inputs change;
stale compiled placement must never override a newer draft. This is an extension
constraint, not an implemented geometry API.

A future coverage catalog should distinguish parsing, preservation, rendering and
layout effects. For example, recognizing vertical fill does not establish its
behavior inside both a source column and a fixed-height panel. Compile/browser
comparison should measure placement relationships for combinations of columns,
titles, fill, notes, floats and nested direction/font changes, separately from
edit/undo preservation. That proposed catalog adds no current compatibility banner
or new source authority.
