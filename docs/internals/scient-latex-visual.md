# Source-derived writing canvas

Status: implementation candidate; human visual review pending.

The [Visual authoring proposal](./scient-latex-visual-authoring-proposal.md)
describes planned capabilities, source ownership, minimal menu placement and a
phased implementation sequence. It is a proposal, not implemented behavior.

## Review direction and implementation boundary

Yaacov's [architecture note](https://github.com/ScientFactory/scient-desktop/blob/claude/shared-editor-layer-design-20260926/docs/internals/scient-latex-visual-architecture-note.md)
and [editable-content proposal](https://github.com/ScientFactory/scient-desktop/blob/claude/shared-editor-layer-design-20260926/docs/internals/scient-latex-visual-editable-content.md)
explain the target shared architecture. This file describes the implementation
on this branch, including shared document-session saving and the existing
comparison-first LaTeX recovery journal. The broader patch-contract migration,
recovery-store consolidation and future timed-build scheduler remain integration
work owned by the maintainers.

The [contributor request](https://github.com/ScientFactory/scient-desktop/blob/claude/shared-editor-layer-design-20260926/docs/internals/scient-latex-visual-contributor-request.md)
separately asks for an operation-by-operation capability table with exact-source
test evidence. The control map below explains UI behavior; it is not evidence
that every operation preserves every supported LaTeX construct.

## Component ownership and edit flow

| Layer                                    | Owner                                                                                                        | Responsibility                                                                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document view and compilation            | `ScientLatexSurface.tsx`                                                                                     | Source/Split/Visual/PDF selection, save-before-build entry points, export availability and build diagnostics.                                                                                                                                              |
| Project assembly                         | `LatexProjectVisualEditor.tsx`, `latexProjectVisual.ts`                                                      | Resolve the root and included files; route accepted edits to their physical file. Ambiguous boundaries can refuse edits.                                                                                                                                   |
| Source adapter                           | `latexVisualDocument.ts`                                                                                     | Project supported source into editor nodes, retain source ranges, validate proposed changes and preserve opaque source.                                                                                                                                    |
| Interactive canvas                       | `LatexVisualEditor.tsx` and object views                                                                     | ProseMirror/Tiptap transactions, MathLive fields, selection, menus and contextual editing.                                                                                                                                                                 |
| Equation, statement and table references | `latexEquationReferences.ts`, `mathEquationNumbers.ts`                                                       | Derive one live number/label index for navigation; align equation tags with rendered MathLive rows without changing source or history.                                                                                                                     |
| Math setup                               | `latexDocumentMacros.ts`, `LatexDocumentMathContext.ts`                                                      | Parse bounded literal preamble definitions once, pass the root macro dictionary to every MathLive field, preserve calls in source, and expose setup in Document settings.                                                                                  |
| Environment declarations                 | `latexEnvironmentDeclarations.ts`                                                                            | Interpret literal theorem names, standard styles, shared/scoped counters and simple quote wrappers; preserve declarations and reject unsupported definitions.                                                                                              |
| Literal text and code                    | `latexLiteral.ts`, `LatexLiteralCodeView.tsx`                                                                | Bound literal source and listing options, paint supported syntax and presentation, and reuse native fields for body/caption edits.                                                                                                                         |
| Title conversion                         | `LatexTitleStep.ts`                                                                                          | Keep the source before/after a paragraph-to-title conversion in the existing undo history.                                                                                                                                                                 |
| Writing chrome                           | `writing/dockChrome.tsx`                                                                                     | Shared button/menu styling and priority overflow. Visual opts into a permanent row and labels-before-overflow compression; other consumers retain their defaults.                                                                                          |
| Reading controls                         | `writing/DocumentReaderControls.tsx`, `writing/readerBarHost.ts`                                             | Shared PDF/Visual sidebar, page, zoom and search controls. Format adapters supply navigation and search operations. With a `ReaderBarHost` they are drawn in the host's header row instead of a bar of their own.                                          |
| Contextual footer                        | `writing/DocumentFooter.tsx`, `LatexContextTools.tsx`, heading/table/object toolbars                         | Shared one-line strip under the document. The selected object's options sit on the left in a stable portal destination that keeps fields mounted inside one nonmodal object inspector at every pane width. Caret position and word count sit on the right. |
| Shared writing pieces                    | `writing/commandNames.ts`, `writing/commandIcons.tsx`, `writing/InsertMenu.tsx`, `writing/ScientFindBar.tsx` | One name and icon per command that both editors offer, one Insert menu, and one find and replace bar. Each editor supplies its own items and carries out its own commands.                                                                                 |
| Persistence                              | Shared document sessions and LaTeX recovery journal                                                          | One saver per physical LaTeX or `.bib` file across its session-backed views. Pending fields are settled before document save/build/export; LaTeX recovery remains comparison-first.                                                                        |

References and a standalone `.bib` Source tab acquire leases on the same registry
session. Both use its current source, revision checks, pending/departure guards
and conflict notices. Non-Markdown sessions do not use the registry checkpoint
store. LaTeX source and Visual input have their own comparison-first journal;
`.bib` files and reference entry forms have no startup recovery offer and write
no bibliography checkpoint. Form drafts remain available during the app session.
Reference saves, including manual `\bibitem` edits, clear the form and announce
success only when the owning sessions' confirmed baseline contains the submitted
entry with the same key and line-ending-normalized text, or confirms its absence
for a removal. A clean persistence lane alone does not prove the submission was
published. A refused, failed or superseded save retains the form; save failures
also expose the session's persistence notice.
Drafts stay bound to their original document identity and path. Removing that
destination from the document refuses the save and retains the draft rather than
selecting another bibliography. Publication confirmation checks only the submitted
key; unrelated duplicate keys or malformed BibTeX records do not invalidate its
confirmed text. A duplicated submitted key is refused before writing. Project
confirmation combines session baselines with read contents for sessionless files,
including read-only TeX dependencies.

A supported edit passes from the canvas transaction to the source adapter, then
to the project/file save path. Accepted source is projected back into the editor;
an unsupported edit retains its pending input or uses the exact-source editor.
Navigation, zoom and search do not rewrite LaTeX. A PDF build consumes saved
source and publishes a separate artifact; CSS page layout is never proof of
compiled output.

### Basic inline text

The source adapter and its edit mapper share one inline grammar. Supported prose
includes bold, italic/emphasis, typewriter text, small capitals and underlining;
roman/sans families and scoped standard size/font declarations are also editable.
`mathTextFormatting.ts` adapts Text-menu font actions to MathLive's math and text
slots, retaining the math selection and exporting portable LaTeX font commands.
Math right-click menus are suppressed; Text, Math and the footer own the actions.
Style-state notifications update the toolbar only when formatting changes.

`latexTextFormatting.ts` owns the command-to-mark mapping used by the canvas and
serializer. Imported styling stays in the text; it does not add toolbar controls.
Standard-class font metrics supply the scoped sizes, with CSS approximating TeX
typography rather than promising identical glyphs or line wrapping.

Text accents, common Latin letters and text symbols render as editable Unicode.
The source map treats an accented grapheme as one token and retains the original
command spelling during narrow edits. Control-word delimiter spaces, empty
argument terminators, nonbreaking `~`, thin spaces, TeX quotes/dashes and explicit
line breaks have distinct handling. `\\` and `\newline` insert a break inside a
paragraph; a blank source line still starts a new paragraph. Unknown macros and
breaks with unsupported spacing/placement options retain exact-source fallback.
Automated regressions cover these source projections and edits. Human visual
qualification remains pending.

Visual choice fields use the shared themed Select primitives through
`LatexSelect.tsx`, including matrix brackets, insertion dialogs, document settings
and object footer choices. Their popups retain shared keyboard navigation and
focus handling rather than using operating-system option lists. A popup carries
the ID of its owning field. Shared writing menus and matrix submenus also
carry ownership markers; `latexContextEvents.ts` follows that chain through
portaled submenus. Footer dismissal and table selection treat those choices as
interactions with the same current object. Field drafts, disabled choices and source restrictions remain
owned by each feature.

## Control map

### Document header

| Control                               | Role and behavior                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source                                | Open the shared text editor for the physical LaTeX file.                                                                                                                                                                                                                                                                                                                                                                  |
| Split                                 | Show Source beside PDF or Visual. The preview choice persists locally.                                                                                                                                                                                                                                                                                                                                                    |
| Visual                                | Open the supported visual editing canvas.                                                                                                                                                                                                                                                                                                                                                                                 |
| PDF                                   | Show the compiled artifact; opening an absent/stale PDF requests a build when prerequisites permit.                                                                                                                                                                                                                                                                                                                       |
| Error / warning counts                | Toggle the build messages card. A failed build also shows "Build failed · View details", which toggles the same card.                                                                                                                                                                                                                                                                                                     |
| Sidebar                               | Toggle Pages/Outline navigation for Visual. PDF supplies its own sidebar content.                                                                                                                                                                                                                                                                                                                                         |
| Previous / page number / total / Next | Navigate the local Visual page map or compiled PDF page map. Page input uses shared validation. Previous/Next remain in More when hidden to make room.                                                                                                                                                                                                                                                                    |
| Minus / percentage / Plus             | Shared PDF zoom stepping and range. The percentage displays a whole number; clicking it fits the page to the pane width.                                                                                                                                                                                                                                                                                                  |
| Split preview: PDF / Visual           | Choose the right-hand view; sits before Rebuild, and moves into More when the row runs out of room.                                                                                                                                                                                                                                                                                                                       |
| Search                                | A quiet field before the view switch (`ReaderSearchField`): type to search, Enter and the arrows move, Escape clears. Visual searches supported prose; Document > Find and replace opens the full bar with Replace. PDF uses its own search engine.                                                                                                                                                                       |
| Rebuild / Cancel                      | Save and request a manual PDF build; while cancellable, the same slot cancels it. The prior PDF stays available.                                                                                                                                                                                                                                                                                                          |
| More actions                          | Only what the row does not show right now: zoom steps, Fit width, the sidebar, search, page arrows, the split-preview choice and build messages appear while their own control is hidden by the narrowing order. Visual keeps Find and replace and Export in its writing row’s Document menu. The other views keep the PDF/Word Export submenu here, alongside format-specific PDF actions. There is no Actual size item. |

PDF, Visual and Split share this one row. `ScientLatexSurface.tsx` passes a
`ReaderBarHost` (`writing/readerBarHost.ts`) whose slot is
`.scient-latex-reader-slot` in the header. `DocumentReaderControls` portals into
that slot and reports back through `onHosted`; the host supplies the view
switch after Search and the Split preview switch after the page controls, and its own items at the end of the
reader's More menu. Source has no reader controls, so the surface draws its own
Rebuild and More there, and does the same until some controls are drawn in the
slot. Export lives in Visual’s Document menu and the header’s More menu in
other views; the file header’s download button offers the same exports.

The row never scrolls horizontally. As the pane narrows it gives up, in order,
the zoom steps, page arrows and sidebar button; build messages and Rebuild
keep their icons; search shortens; the Split switch moves into More; search
keeps its icon; separators, the zoom percentage and the page field disappear
last. `ScientLatexSurface.tsx` measures the row and applies this order only while
its contents do not fit. Hidden actions stay in More.

Build messages open in a floating card anchored under the header
(`.scient-latex-diagnostics-anchor`), as wide as its longest message and
without a heading. Opening it does not move the document. A count toggles it, a
press anywhere outside the card closes it, and Escape closes it from inside the
card or from the header row, where focus stays after a count opens it.

Hosted controls are drawn outside the pane they belong to. Each pane therefore
attaches its reader shortcuts to the header slot as well
(`useHostedReaderShortcuts`), so zoom and find work while a header control has
focus. When Split's right pane changes, the surface returns focus to the
PDF/Visual switch in the new pane's controls.

### Permanent writing row

| Control     | Role and behavior                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Undo / Redo | Use the active math field's history while editing math; otherwise use document history.                                                                                                                                                                                                                                                                     |
| Text        | Shared menu categories for Paragraph style and Formatting, with editor-specific commands. Paragraph style offers Text, supported headings and Quote; Formatting includes Bold, Italic and Inline code (Ctrl/Cmd+E). Link (Ctrl/Cmd+K) lives in Insert > References and is unavailable outside ordinary text or across paragraphs (`linkUnavailableReason`). |
| Numbered    | Inside Text > Paragraph style: update the current heading without closing the menu, or choose numbering before applying a heading to ordinary text.                                                                                                                                                                                                         |
| Insert      | Insert tables, figures, statements, references, footnotes, bibliography, abstract, contents and page breaks where supported. Root declarations and source context can restrict insertion.                                                                                                                                                                   |
| Math        | Inline math, Display math, Aligned equations, Brackets, Matrix, Cases, and Symbols.                                                                                                                                                                                                                                                                         |
| Lists       | Bullet list, Numbered list and No list; existing description lists remain editable. Check the current type and disable unsupported conversions. Tab and Shift+Tab indent and outdent; the menu has no indent items.                                                                                                                                         |
| Document    | Edit title/authors/date, add a standard title block, manage References in a side panel, open Document settings, Find and replace, Export, or Keyboard shortcuts (a plain text item without an icon).                                                                                                                                                        |
| More        | Retain lower-priority groups as the pane narrows. Contains only overflowed toolbar groups; no additional source or shortcut actions.                                                                                                                                                                                                                        |

The row stays at the top and follows the Markdown bar's order. Command names
and icons that both editors offer come from `writing/commandNames.ts` and
`writing/commandIcons.tsx`. Text and Insert use word buttons; Document uses its
file icon. Math keeps its word label without an icon. Narrowing moves complete
groups into More; menus
keep their full labels and accessible names. Selection-specific fields belong
in the footer, not in an extra row or on the document paper.

### Find and replace

| Control                        | Role and behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find / match case / whole word | Search supported prose. Search transactions stay out of undo history and the save lane.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Previous / next / close        | Navigate matches or close find; Enter/Shift+Enter and Escape use the same shared interactions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Replace / Replace all          | Offered while the document is editable. A replacement is an ordinary text edit, so it is written to the LaTeX source the same way typing is. The source owner takes one changed text block per update, so Replace all edits one block, writes it, and continues after a paint (`replaceByBlock` in `useLatexVisualSearch.ts`); it stops when a block is refused, during composition, or as soon as the document is anything other than what its previous replacement left (typing, undo, a newer file), and each block is one undo step. Pass the hook a stable `commit` callback, not an inline function. |

### Contextual footer

| Control                         | Role and behavior                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Caret position                  | Right side: the current style or object, for example Text, Section, Bullet list, Equation or "Table · row 3, column 2" (the table reports its active cell through `LatexFooterPositionContext`). |
| Word count                      | Right side: "1,284 words", or "12 of 1,284 words" while text is selected. The total is an estimate from the source (`latexWordCount.ts`).                                                        |
| Recovered work                  | Offered at the start of the footer when stored work differs from the file.                                                                                                                       |
| Heading / Part                  | Numbered button and reference label for the selected heading.                                                                                                                                    |
| Title                           | Author visibility and automatic/custom/hidden date. Title, author and date text are edited on the paper.                                                                                         |
| Equation                        | Placement, numbering, reference label, structure actions, Symbols, and Edit LaTeX. Imported row metadata stays protected.                                                                        |
| Table                           | Row and column insertion/deletion/movement, alignment, table style/width, header, caption, reference label and deletion, subject to source constraints.                                          |
| Figure                          | Alignment, width, placement, image path, reference label and deletion. Caption text is edited on the paper.                                                                                      |
| Statement                       | Supported theorem/proof/remark type, optional title and deletion. Supported body prose and math are edited inside the block.                                                                     |
| Reference / footnote            | Choose a cross-reference target from the live index; edit supported footnote text or link fields.                                                                                                |
| Bibliography / description list | Open Document References for bibliography records; add/remove supported description items.                                                                                                       |
| Exact-source block              | Open its source, Apply a valid replacement or Cancel the local edit.                                                                                                                             |
| Draft indicator                 | Indicate pending field input that has not been accepted into source; it does not assert a successful save.                                                                                       |

The footer is the shared `writing/DocumentFooter.tsx`: one 28px line that is
always present, with the selected object's options on the left and the caret
position and word count on the right. Page, zoom and search controls are not in
it. Every pane width uses one trigger named for the object, such as Equation or
Table. `LatexContextTools.tsx` opens a nonmodal inspector above the footer. Its
portal destination stays mounted when closed or resized; a hidden inspector is
inert. Escape restores focus to the trigger, while outside interaction closes it.
Document and footer menus, including owned popup choices, preserve the active
editing target and cell selection. Portaled controls do not enter the paper's
focus handlers; choosing another position in the document ends that selection.
Editing menus contain controls without instructional paragraphs or duplicate
cell-position summaries. Keyboard shortcut labels and concise empty-result states
remain in pickers. Merge is disabled for a single cell. Object action failures
use `useLatexActionNotice` and the document's existing notice area instead of
placing explanations in the menu; field validation remains beside its input.
The current object takes precedence over the heading fallback. Selecting an
object never adds controls to the paper or changes the page layout. Recovery shares the line and collapses to a comparison button
or dot as the pane narrows. Its comparison opens above the footer. The word count comes from
`latexWordCount.ts`: it reads the source after `\begin{document}` and leaves out
comments, math, literal code, commands and reference keys. The selected count
comes from the editor's selection, and the total never reads below it.

`LatexVisualEditor.tsx` draws this footer when a `ReaderBarHost` is present,
which is always the case inside `ScientLatexSurface.tsx`. Without a host it
keeps the reader controls in its own footer, with the object options between
zoom and Search.

Plain clicks activate context controls without implicitly selecting an entire
preview node. `latexObjectCaret.ts` keeps a collapsed document caret for generated
blocks, retains native field/button focus, and sends statement-heading clicks
into the first editable paragraph. Explicit object selection, modifier clicks
and drag selections remain distinct actions. Table border clicks enter a cell;
the Select table command remains the whole-table selection action.

Table operations are grouped by rows, columns, appearance, caption/reference
and selection. Content edits and structural edits have separate availability;
the source guard remains authoritative. Row/column actions confirm their
attribute update was accepted before moving the caret. Captions are edited on
paper rather than in a second footer field. `LatexReferenceLabelField.tsx` uses
the existing field draft journal, retaining invalid text with a validation
message instead of silently restoring an older label on blur.

Citation controls search and change cited keys while preserving the command
and notes. Record editing opens Document References. Cross-reference targets
come from the live label/anchor index; unresolved imported keys stay visible.
Statement conversion lists only available document declarations and the current
environment. These controls do not implement project-wide key renames or new
package/environment management from the proposal.
Math fields release their internal node-selection anchor when editing is
dismissed, including focus moves to Source and view changes. Dismissal does not
focus Visual, insert a paragraph, or clear a deliberate drag/Shift selection.

## Fidelity target

The writing surface should remain a comfortable CSS-based document editor, with
matching the selected TeX compiler's PDF as a first-class design requirement.
The target is: the latest successfully built revision is exact in PDF mode;
ordinary supported edits update locally and stay as close to TeX as practical;
changes that depend on TeX execution are shown as pending until a rebuild. Do
not imply that an unbuilt edit is final output.

For the CSS surface, derive page size, margins, font family and size, line
spacing, paragraph spacing/indent, headings, lists, math sizing, and supported
table rules from the actual document/build configuration. Prefer build evidence
to source-text guesses when available. Bundle or resolve compatible fonts and
calibrate line breaking, hyphenation, and pagination against representative
compiled PDFs. Keep this evidence revision-scoped so a changed preamble or
dependency cannot silently style a new source revision using an old profile.

Before measuring pagination, `latexParagraphSpacing.ts` fits short justified
text paragraphs that exceed one line only by shrinkable interword space.
It measures the rendered fonts and applies the smallest spacing reduction,
bounded to one third of the normal space advance. Node decorations keep this
adjustment out of source and undo history; glyph sizes, margins and indentation
remain unchanged. Results are cached by paragraph and typography, and refreshed
after font loading. Longer paragraphs, explicit line breaks, inline objects and
unsupported font features retain browser wrapping. This is a bounded fit rule,
not TeX's full paragraph optimization.

Classify edits by their layout reach. Prose and edits inside supported math or
table objects can update the CSS document immediately; local pagination is a
best-effort preview. Macros, packages, document class, global style, references,
floats, and page-breaking commands can affect distant content and need a TeX
rebuild to settle. Keep the current PDF available as the exact last-built
revision, indicate when the source is newer, and adopt a successful rebuilt PDF
without losing the editor's focus or scroll position. Do not compile per
keystroke; any background rebuild policy should coalesce edits and preserve the
last good artifact while it runs or fails.

CSS cannot promise pixel identity for arbitrary TeX: the engine's font shaping,
glue, hyphenation, package code, and global pagination are part of the output.
The practical fidelity strategy is therefore a compiler-calibrated CSS editor
for the supported subset, fast local previews for ordinary edits, and the actual
compiled PDF as the authority whenever exact layout is required. Measure drift
on representative documents before widening the supported subset.

## Current architecture

### Local document workflow

The Documents surface (`scient:documents`) is an additive panel surface. Its
project-scoped hub lists local `.tex` files and creates built-in starters through
the existing `projectEnvironment.writeFile` command with `createOnly`. Template
copies use the existing bounded file reader and remain beside their source so
relative includes retain their base. The backend retains filesystem authority.
Recent-document paths are stored per environment/project in device local storage.
Navigation uses the host's pending-file-save guard and opens documents in Write.

Built-in starters live in `apps/web/src/scient/documents/templates/*.tex`, imported
as bundled text. Creation needs only a filename and Enter; its basename becomes
the default printed title, and a clean article is the default. An optional template
picker stays in the same form. Known filename collisions receive a numbered suffix;
exclusive creation still prevents overwriting files that appear concurrently.
Metadata is escaped and substituted once. Exclusive file publication flushes the
temporary file using a writable handle, as required on Windows, before linking
it to the destination without overwriting an existing file.

The writing toolbar owns the shared Insert menu, with `/` on an empty
paragraph and Ctrl/Cmd+/ shortcuts. Actions use the existing source adapter and
editor transactions. Figure selection lists project images and offers PNG/JPEG import. Windows file selection creates no asset until Insert is confirmed. Pasting or dropping
one PNG or JPEG image in Write saves it to an `assets` folder beside the root
document and inserts an editable figure at the original selection; the upload
limit is 20 MB. Citation selection
reads explicitly linked project bibliography files through the existing reader.
Literal BibTeX fields are indexed for selection, not executed or resolved. Object
references are scoped to the open file. PDF export delegates to
the existing PDF save-copy hook and requires current revision/dependency evidence.
These writing features introduce no hosted service, new compiler, or second save
path. Project creation remains owned by the project sidebar.

Imported boxed artwork and subfigure groups use a bounded `figureLayout`
projection in the existing rich-preview node. The source adapter recognizes
literal `\fbox`, centered fixed-height `\parbox`, zero-width height rules,
`\rotatebox`, and simple `\includegraphics` within panels. It also recognizes
one-argument literal preamble macros whose definition has this supported box
shape; it never executes arbitrary TeX or rewrites a macro call into its expansion.
Text, captions, labels and image paths retain individual source ranges. Edits
patch those ranges, preserving dimensions, wrappers, rotation and separators.
Structural layout changes remain in Source; unsupported artwork uses exact-source
fallback. The view consumes this geometry and existing draft-aware text fields.
Rotated bounds are measured from the untransformed artwork, with no observed-stage
resize feedback. Panel and figure tools use the existing contextual footer.

The live reference index derives ordinary article/book/report figure counters
and default subfigure letters, suppressing numbers when counter setup is unknown.
Labels must follow their caption to bind the corresponding counter. `\ref`
uses the full panel reference (for example `1a`); `\subref` uses the panel letter
(`a`), following the [subcaption package's default reference rules](https://mirrors.ibiblio.org/CTAN/macros/latex/contrib/caption/subcaption.pdf).
Navigation highlights the panel or complete figure without selecting its content.

Insert is the shared `writing/InsertMenu.tsx`, with each editor's own arrangement
of its actions and no search field; the menu is as wide as its longest item. `LatexInsertMenu.tsx`
supplies the LaTeX actions and layout, and `LatexInsertMenuContent` is used in
both the regular and overflow menus.
Its top level is Figure, Table, Code block, Literal text, References,
Theorems & proofs, Document blocks and Page break. References contains Citation,
Cross-reference, Link and Footnote. Theorems & proofs groups the statements and
Proof, followed by Question and solution and Subquestions. Document blocks contains
Abstract, Table of contents, Bibliography and Verse. A final group keeps every
unplaced action reachable (currently Long quotation, Left-aligned text,
Right-aligned text and Part). Unsupported insertion
contexts keep these choices visible with a reason instead of changing the menu.
`DocumentTableSizeMenu` keeps the shared grid and exposes an optional custom-size
callback used by Visual's numeric dialog; existing callers retain their behavior.

`insertLatexBlock` preserves non-wrapping selections, groups insertion with
`closeHistory`, and focuses the new block. Only explicit supported prose selections
are wrapped in a new statement. Dialog workflows capture the document and selection,
wait for close-complete before inserting, and refuse a stale document snapshot.
Cancelling restores focus without an editor mutation. Figure import begins on
confirmation and disables dismissal during the upload; uploaded assets survive a
subsequent stale-document refusal.

References and citations have separate pickers. Citation selection supports
multiple keys; natbib/biblatex forms are offered only for detected package setup.
Cross-references expose document-default, number and page-number forms without
inventing rendered numbering. Links retain both `href` arguments in the inline
schema and source-token map. Plain labels and addresses use footer fields;
formatted labels remain source-editable. Bibliography setup preserves existing
styles and delegates package-specific rendering to TeX. Standard manual
`thebibliography` blocks project supported formatted prose into read-only entries.
The live reference index keeps citation keys separate from cross-reference labels,
derives default numeric and literal optional entry labels, suppresses duplicate
targets, and supports individual links in multi-key `\cite` commands. A bounded
optional-note parser retains the original note when citation keys are edited.
Bibliography entries participate in pagination at entry boundaries. Document's
References action opens an adjacent panel; a narrow pane docks it over the right
edge. Citation footer actions open the same panel at the selected key, with known
entry details kept in the footer. Entry controls never appear on the paper, and
selection does not change the top writing bar. Insert's citation and cross-reference
pickers retain their caret snapshots and remain independent of reference management.

`latexBibliographyModel` owns balanced entry parsing, source ranges, literal field
drafts, add/remove/replace operations and rebasing a single unchanged entry over
unrelated writing. The citation picker uses the same parsers. Manual entry labels,
formatted bodies, unknown BibTeX fields, string records and untouched entries
retain their slices. Existing keys remain fixed in the panel; advanced entry
source is validated against the same key. Removal confirms the effect on citations.
Empty manual lists keep their environment and can accept new entries again.
Unknown entry markup keeps exact-source fallback on paper.

`LatexReferencesPanel` consumes these projections and existing explicitly linked
resources, preserving their paths and the document's bibliography approach.
It reads at most 24 linked files and bounds visible search results. Linked `.bib`
writes lease the shared file save coordinator, reuse its revision checks, optimistic
query cache, save resolution and owner callbacks (including PDF freshness).
Read-only/truncated files are not written. Failed saves retain drafts; entry form
drafts are cached by the Visual workspace identity for the current app session.
Concurrent changes to the same entry are rejected, while unrelated changes are
merged by source range and key. Abstract, contents and bibliography actions
navigate existing open-file blocks; a bibliography already configured in the root
is reported instead of duplicated. Cross-file discovery remains limited to the
explicitly linked bibliography files and root setup.

The Visual writing bar uses the shared `writing/dockChrome.tsx` button/menu
primitives, the same ones as the Markdown bar, with its own
LaTeX action groups, in the Markdown bar's order: Undo/Redo; Text; Insert; Math;
Lists; Document. Formatting lives inside Text; Link lives in Insert > References.
The row stays visible at the top and never collapses or scrolls horizontally.
Math keeps its word label without an icon. As the pane narrows, lower-priority
groups move into More.
The Text menu keeps its name while the paragraph style changes; selection
does not rename or replace the top-row controls. Settings and keyboard shortcut help live
under Document. The document header hosts the reader controls for Visual and
PDF. Its view tabs, reader controls, Rebuild and More
share one non-scrolling row; action labels yield to icons on narrow
panes. Cancel reuses the build button while a build is running. Text > Paragraph
style contains Text, headings,
and Quote with plain labels and a current-style checkmark. Heading levels are
grouped under Headings with a small Numbered toggle button centered below the group label.
Its filled gray pressed state and checkmark indicate numbering is enabled; the
unchecked button is outlined. The menu and footer use the same state treatment. It changes the selected heading without closing the menu, or sets the
numbering for the next heading chosen from ordinary text. The footer uses the
same wording and reads the same heading attribute; tooltips explain the scope. Heading-level changes
preserve that choice. Heading
numbering is also available alongside other object controls
in the fixed-height footer without changing page layout. Narrow panes use menus named for the
selected object; previous/next page actions remain available in More.

`latexListEditing.ts` owns list conversions and removal. A caret targets the
current list; an explicit item selection splits the list around those items.
Selecting the existing type is a no-op. Conversions retain supported child
nodes, and removing a description list retains its terms as bold prose. The
description adapter accepts plain paragraph conversion; unsupported rich or
nested conversions are disabled. Splitting a numbered list preserves the
remaining items' starting number through supported `enumerate[start=N]` source.
Detailed list numbering and appearance controls in the footer remain deferred.

PDF and Visual both render `DocumentReaderControls`, hosted in the document
header. Visual's controls use the same page input validation, five-percent
zoom steps, 25–500% manual range, percentage button that fits the width, and
keyboard interactions as PDF. Fit width is in More only while the percentage is
hidden. Each uses `pdfFitWidthScale` with the same 40 CSS-pixel total page inset and a stable
scrollbar gutter. Visual's physical page width is inches times 96; PDF's page view
uses the same CSS-pixel baseline. Navigation sidebars use matching widths and
breakpoints, so matching paper and pane geometry produce matching fit percentages.
Each surface supplies its own navigation/search adapter. Visual's sidebar contains Pages and
Outline; its pages follow the local editor page map and can differ from PDF.
Both readers use `ReaderPageThumbnail` for page navigation. Visual previews
snapshot only rendered blocks intersecting nearby pages, including running
headers, footers and MathLive's formula markup. Snapshots live in inert shadow
roots, without additional editors, selection overlays or interactive targets.
They refresh after input settles, and disappear outside the sidebar's nearby
viewport; opening Pages does not compile the document or change its source.
MathLive's compact content allows glyph overflow. Display equations retain their
natural size and placement when inactive; an overfull equation starts at the text
boundary and can extend into the margin.
The paper's content layer clips at its physical horizontal edges so overfull math
cannot enlarge the canvas or change the document's outer scroll position.
`latexMathViewport.ts` enables horizontal panning only during Visual editing.
The same padding and natural formula height
are retained in both modes. Native scrollbars are hidden, so entering a formula
does not move surrounding content. The formula host retains its intrinsic width
so overflow remains measurable. Trackpad horizontal gestures, Shift+wheel and
caret following use the same viewport, without a Scroll range control. Wheel
capture lets this viewport handle panning before MathLive's inner content.
Leaving restores the normal display; keyboard re-entry restores the saved offset
and reveals the caret. Clicking a new symbol takes precedence over the saved offset.
Viewport state is local to the mounted field and never enters LaTeX or history.
Resize observation and coalesced post-paint work handle edits, zoom and column-width
changes without continuous polling. Vertical overflow is explicitly hidden only
in the active viewport. Formula struts retain the height of braces, limits and
matrices; no fixed height is imposed. Page thumbnails omit active viewport state.
PDF keeps `DocumentSearchBar`, which only finds. Visual shows the shared
`writing/ScientFindBar.tsx` under the writing row, through
`useLatexVisualSearch.ts`. It uses the shared document-text plugin for supported
prose; title
attributes, math fields and exact-source objects are not indexed by that plugin.
Replace and Replace all dispatch ordinary text edits, so the source adapter
writes them like typing.
Navigation does not edit LaTeX. PDF/Word Export is in Visual's Document menu
and the header's More menu in the other views.

Title, author and date remain editable on paper. Editing existing metadata
never inserts a title block. Document > Title & authors shows Edit title, authors
and date while a title block is displayed, and only **Add a title** while none
is; that explicitly creates or restores the standard block while preserving
existing metadata. There is no command that turns a paragraph into the title. Custom title pages and
unsupported title formatting remain source-owned. Standard article/report/book
classes can be selected in Document settings; incompatible switches and custom
classes stay protected.

Document has Title & authors, Document settings, References, Find and replace
(when editable), Export (when hosted) and Keyboard shortcuts. Document settings opens one card showing
the current values read by `latexVisualLayoutProfile`, with a draft of changes only, explicit Apply/Cancel, and a source snapshot checked again
before mutation. Unchanged fields remain source-controlled. Margin updates carry
only edited sides; adding geometry to a standard class retains the other projected
margins. Custom classes without an explicit geometry setup require Source for this
operation. Orientation updates class/geometry options and the Visual layout reader.
Title help and source actions finish their dialog close before transferring focus.

Shared writing menus execute queued commands after the closed state commits;
their exit animation must not delay edits in a suspended or background renderer.

### Empty editing positions

Insertion helpers leave editable content empty instead of generating sample text.
`LatexTextField` marks emptiness from its local draft, so guides update immediately
while typing or composing. Description fields mark the same state. The shared
selection overlay paints the same gray corners for active and empty controls
within the active environment. Empty controls keep identical measurements when
entered. Hover and ordinary empty paragraphs do not reveal guides. Ordinary table
cells have no slot markers. `latexTableEditingGuides` measures rendered cell and
table borders, including CSS presets and longtable bands. A noninteractive SVG
layer fills only missing edge segments, subtracting real rules on adjacent cells
and merging duplicate guides. This handles partial rules and merged cells without
overpainting actual borders. The SVG viewBox uses screen coordinates so strokes
and dash spacing stay thin and consistent at every zoom. Bounded mutation/resize observers refresh geometry,
including page-stage transform changes that do not trigger a layout resize;
the guide's own changes are ignored. Real rules and cell dimensions remain
unchanged. Print and page previews omit the layer. New tables use the
grid preset and focus their first inline cell after mounting.
Empty caption editors do not create source caption commands until edited.
Caption markers follow the centered text position within the caption field.

`mathEditingGuides` decorates MathLive 0.108's rendered array cell boxes inside
its shadow root. Its bounded DOM observer and focus/selection listeners schedule
updates when rendering or the active environment changes. The current array's
atom ID limits faint gray markers to its own empty cells, including when arrays are
nested. `mathEditingGuideRects` measures compact empty-cell rectangles from the
existing VBox strut and local font size. Active and empty slots use the same
overlay renderer, without extra outline padding or duplicate current-slot marks.
Occupied guides exclude the starting caret anchor so an accent's body marker
fits its contents instead of including the enclosing accent or neighboring atom.
No inline guide nodes are inserted. Minimum cell
targets apply through the structural selector from the first render, independent
of observer attributes, focus and emptiness, so decorating a replacement render
does not resize the formula. Markers disappear when editing leaves the structure,
while menu ownership retains them. The active empty slot keeps its marker beside
the caret. Content/cell selection suppresses guides.
The adapter never modifies math atoms, selection history, or serialization.
Empty-cell clicks resolve through the owning array's atom ID in the existing
MathLive adapter. Native placeholder atoms reserve invisible figure-space
targets; the adapter marks their rendered font boxes as slots, including those
inside accents and scripts that have no native placeholder CSS class. Only the
faint gray guide appears in the active structure. Empty array cells suppress
duplicate slot guides beneath their cell guide. Publication and copying continue to use
`latex-without-placeholders`. Revisit the VBox selectors when upgrading MathLive.

### Source code editing

Source uses the inherited `EditableFileEditor` from the shared file surface. Its
edits and the Visual editor publish to the same revision-checked save coordinator.
Split places Source on the left and PDF or Visual on the right. The last selected
right-side view is stored locally, including selections made in a standalone view;
PDF is the default. A source-line double-click in Source + PDF uses the existing
SyncTeX authority with an unknown column. Failed builds retain the last good PDF.

### Source and editing

`.tex` is authoritative. `latexVisualDocument.ts` projects supported source
ranges into a disposable ProseMirror model. `LatexVisualEditor.tsx` uses the
existing Tiptap editor stack for native selection, composition, formatting,
lists and undo. MathLive supplies structured math input; fonts are bundled
locally, sounds and the optional compute engine are disabled. No web service
or TeX process participates in a writing transaction.

The transaction guard verifies the exact source generation and validates the
changed block. Immutable ProseMirror nodes cache their JSON and signatures; plain
text and object edits reparse only their replacement block. Structural changes
and document-context changes retain a whole-document validation fallback. Unchanged source, comments, preamble and opaque blocks remain
byte-for-byte intact. The session retains editor whitespace and undo across
local transactions; adopting external source resets editor history so Undo
cannot replay an edit from an obsolete revision. Bounded inline text changes preserve original command aliases, dash spelling,
nonbreaking spaces and soft line breaks. Structural changes may serialize the
changed block; unaffected blocks remain exact. This is a bounded source adapter, not a complete TeX
parser or macro evaluator. Category-code changes fail closed.

Plain object fields retain exact local text and caret position while accepted
changes pass through the same source guard. Whitespace is compared using TeX
semantics without trimming the live field. Composition and rejected intermediate
input remain local; document-scoped field journals retain unacknowledged drafts.
Source acknowledgements do not replace the focused field. Accepted edits share
document undo; incomplete field text keeps its native undo. A draft indicator
distinguishes uncommitted field text from saved source, and PDF rebuild/export
wait for active field drafts to be resolved. Custom formatted metadata remains
protected rather than being flattened into plain text.

Source and Visual use the same physical-file session and compare-and-set writes.
An included LaTeX file shares that session with its own tab. Non-LaTeX includes
remain read-only in Visual and retain their existing editor's save owner.
Outside changes over unsaved source keep both versions; LaTeX does not use
Markdown's automatic merge.

Unfinished fields retain their original source and field identity. An outside
update waits while those fields, composition, or raw text own input; a delayed
field callback cannot adopt a newer base silently. Rejected input remains in
recovery. Document preparation synchronously asks every relevant mounted view
to finish input, discovers literal includes from current working sources, and
flushes their actual sessions even when Visual was never opened. Clean unopened
files receive ordered reads, not additional savers. A conflict, failed save,
unresolved field, or unsaved generic include prevents the action. When includes
need TeX to resolve them, independently pending workspace files also prevent
preparation because ownership cannot be established. Linked bibliography commands
also leave ownership incomplete: preparation refuses while bibliography sessions
have unsaved changes or need attention; it does not flush those sessions.
The receipt is rechecked immediately before build/export. Unrelated files do not block a fully resolved
document.

A Visual operation that requires changing a root declaration and a chapter is
refused before either changes. Add the declaration in Source first. General
multi-file transactions remain future work.

The accepted-source journal observes Source-only edits as well as Visual edits.
Source/Split exposes the same comparison-first recovery offer. This bridge keeps
the existing recovery format and user choice; it does not enable silent session
restoration. The recovery journal retains one accepted source copy and its base
revision in memory, then coalesces
local storage writes on a 200 ms leading deadline. There is no synchronous
document hash on the input path or migration chain for retired overlay formats.
Recovery is offered when a document opens with stored work that differs from the
file. Only records in storage count; this window's unwritten checkpoint is the
live draft of the current session. The work is moved from the live draft slots to
a parked list, so the editor stays writable and later checkpoints cannot replace
it; the original is removed only after its parked copy is stored. One line in
the footer offers it. The file changes only after the user has opened the
comparison and chosen the recovered version there, whatever revision the work
was based on: the comparison is against the source the editor shows, which
includes writing that is not saved yet. The write is a revision-checked save
against the exact source the user compared, after any writing done meanwhile has
been published, so a file that moved in between is not overwritten. The applied
copy goes back to the live slot until its save is acknowledged. Nothing removes
a parked entry except applying or discarding it; an entry that already equals
the file compares as having no differences. Apply and Discard act only on the
record the line shows, read from storage at that moment, so another view or
window cannot be overridden. A document assembled from several files cannot be
replaced in one revision-checked save, so its recovered work is offered for
comparison and copying only. Work that cannot be parked, because storage is
full, is offered from its live slot instead, and the editor stays read-only
until the user uses or discards it, since writing would replace that slot;
this window's own unwritten checkpoints are also kept out of that slot meanwhile.
Work applied from its slot stays there as the live draft.
The source-draft cache holds only this window's unwritten checkpoints, and
confirming or discarding a draft judges the unwritten checkpoint and the stored
record separately and removes each one that matches. A recovery copy is stamped with the
revision of the source the editor actually holds, not the newest file revision
it has seen. Storage failures are reported without blocking workspace saves.
The session owns workspace saving; the existing LaTeX journal retains the explicit
Compare-first recovery policy. Consolidating stores remains a separate step.

Unapplied raw-block input is stored separately as exact text, including incomplete
LaTeX. Each editing interaction replaces only its own preceding record; another
view's input survives. Reopening offers View/Copy without treating that fragment as
a complete document. Cancel discards only the current interaction. Apply removes
its fragment only after accepted source has a durable journal copy. Storage
failure keeps the input in memory, reports the failure, and prevents further
editing; the input remains available to copy or discard.
Autosaving continues while the writing surface is focused. Conflicts use the
existing explicit retry/discard workflow. Rebuild waits for document preparation
and cannot run while a relevant save error, conflict, or unpublished field remains. Word export uses the same
preparation. PDF export also requests fresh server dependency evidence and
compares the receipt with the build revisions before saving a copy.

`LatexBuildService.status` verifies dependency evidence but never starts a
compiler. A stale status keeps the old artifact readable, marks its descriptor
stale and removes visual source authorization from that response. The client
rebuilds when a stale PDF is opened and on Ctrl/Cmd+S while PDF is visible.
Typing does not schedule a build; the shared scheduler and setting are pending. Open-PDF requests wait for file saves and build availability, and do not
retry after an attempt until the PDF is reopened. Explicit Rebuild remains available. Existing
root resolution, cancellation, bounded compile stabilization, immutable
artifacts and PDF navigation remain owned by the existing build/reader path.

Visual uses browser-rendered paper with CSS pagination; PDF and Split with PDF use the
actual PDF with navigation. Supported tables and selected scientific structures
have structured editors. Browser output remains approximate: a successful build
does not make the browser execute arbitrary macros or guarantee compiler-identical
typography and pagination. Macro/preamble changes produce rebuild guidance.
Incremental TeX, arbitrary macro rendering, and a general TeX-to-editable-content
adapter are not implemented.

### CSS page layout

Paragraph and subparagraph headings run into the following editable paragraph.
Pagination measures their shared leading space once when moving the pair to a
new page. Nested lists use the standard class's second-level spacing and indent,
with the existing supported list overrides retained. Contents reserve distinct
number widths for subsections and subsubsections; an unnumbered entry has no
empty number column. Abstract text follows the class's small-font baseline.

The pagination plugin publishes a derived position-to-page map alongside its
decorations. Contents entries and `\pageref` read that local map, never claiming
compiled TeX page evidence. The live reference index supplies current heading
titles, numbering and targets; explicit contents metadata retains its source
block target. Contents buttons and internal links share the existing navigation
and temporary highlight behavior. The source adapter separates `\newpage` and
`\clearpage` from preceding prose even without a blank line.

The adapter recognizes the two-argument `\hyperlink`/`\hypertarget` forms and
the optional-label `\hyperref[label]{text}` form from the
[hyperref manual](https://tug.ctan.org/macros/latex/contrib/hyperref/doc/hyperref-doc.html).
Their destination namespace and label namespace remain distinct. Link labels
use a bounded read-only prose projection, preserving source formatting and
displaying unsupported content exactly. Attribute serialization retains the
optional-label syntax; footer editing never converts it to `\href`.

Standard footnote markers are numbered by the shared live index. Pagination
measures their prose, reserves space with the containing line, and places
non-source footnote widgets at the page's text-area bottom. Notes and markers
select the same existing footer editor. Marker clicks navigate to the note;
note clicks return to the marker. Navigation uses the shared temporary highlight
and respects reduced motion without automatically focusing the footer. The bounded prose renderer shares the
source parser and constructs DOM text and mark elements without injecting HTML.
Custom counters suppress inferred numbers, and long or unsupported footnotes
remain subject to the compiler's authoritative layout. These widgets do not
enter source or generated page-break commands.

`latexVisualLayout.ts` owns the supported layout profile. It reads top-level
class/package options and explicit geometry and spacing commands, ignoring
comments and command bodies. Paper dimensions remain in inches and typography
in TeX points until conversion to CSS pixels. The standard-class measurements
follow LaTeX's [classes.dtx](https://github.com/latex3/latex2e/blob/main/base/classes.dtx);
custom class code, font metrics, package effects and macro expansion still need
the compiler. This is source interpretation, not compiler-extracted metadata.
First-level `enumitem` settings supply list spacing and indentation. Table
presentation reads standard font-size switches and literal paragraph-column
widths from preserved source, including empty outer `@{}` separators. Captions
remain at the surrounding text size and wrap independently of cell text.

`latexVisualPaginationExtension.ts` owns view pagination. It measures browser
text lines, keeps headings with following content and pairs lines at paragraph
boundaries, and supplies ProseMirror decorations for page spacing. A paragraph
can continue on another sheet without splitting its source block. Tall supported
tables receive presentation gaps between rows through node-view decorations;
their cell editors retain stable row identities. Ordinary tables and equations
stay together when they fit on a sheet. A single object or table row taller than
the printable area is still an overflow limitation; this does not reproduce
TeX's float algorithm or exact longtable break positions.
Description lists and contents lists can break between entries. Description
labels and bodies use the document baseline; `nextline` wraps the body only
when the label cannot fit beside it, following
[enumitem's description styles](https://github.com/jbezos/enumitem/blob/master/enumitem.tex).
The symbol palette uses `mathSymbolCatalog.json` for command membership and
Unicode/package metadata, checked against the math panels in LyX's
[`lib/ui/stdtoolbars.inc`](https://raw.githubusercontent.com/cburschka/lyx/master/lib/ui/stdtoolbars.inc)
and [`lib/symbols`](https://raw.githubusercontent.com/cburschka/lyx/master/lib/symbols)
on 2026-09-24 (827 entries in 20 groups). These are command and symbol facts;
Scient supplies its own layout, labels, selection-aware insertion templates, and
keyboard interactions. `mathSymbols.ts` also supplies source completions and
package requirements. `mathSymbolPresentation.ts` caches local glyph previews;
Unicode display macros retain their original LaTeX command on serialization.
The Common and Labels groups expose labeled over/underbraces,
annotations above/below an expression, and extensible arrows with both label
slots. Templates wrap the selected expression and supply empty editable slots;
Tab navigates those slots. Text in math supplies ordinary words for annotations.
Palette tooltips and details show commands without descriptive action names;
those names remain searchable. They show effective keyboard bindings (including user
overrides). MathLive's inline shortcuts are explicitly empty, and the shared math
controller does not replace bare words or punctuation pairs. Command completion
requires a backslash. User-declared macros and explicit keyboard bindings remain
available; symbol previews do not create document macros.
`mathCommandCompletion.ts` derives argument templates from the symbol catalog and
limits environment completions to the supported formula environments.
`mathLiveCommandCompletion.ts` reads the active MathLive command draft at the
library boundary, excluding ghost characters. It pairs braces without replacing
typed arguments and extends native acceptance with editable argument slots and
matching environment ends. Its local environment list retains field focus and
uses the existing popup ownership route. It never alters the Source editor or
adds macro declarations. Cursor movement, blur, disabled completion, and disposal
hide the list; scrolling positions it without scrolling the document selection.
Simple symbol-plus-script combinations do not get additional palette entries.
`mathMacroEditing.ts` unlocks document macros whose entire definition is a
single `\left...#1\right...` delimiter wrapper. It adapts MathLive's per-field
serialization to read the current fence body rather than its cached original
macro arguments, including inserted and undo-restored atoms. The macro call is
retained while the wrapper matches; structural wrapper edits serialize the
expanded occurrence. Other macro shapes remain atomic. No extra argument
metadata is injected into the rendered formula or document source.
`mathSymbolPalette.ts` owns the presentation families, duplicate filtering and
ranked command/name/Unicode search independently of catalog IDs. Supported root
macros appear in Macros. `latexMathPalette.css` keeps all tiles at 48px square;
Lucide category icons and minimal mathematical previews follow the shared chrome.
`mathSymbolIllustrations.ts` and `MathSymbolIllustration.tsx` supply diagrams for
spacing and other layout commands. `mathSymbolGlyphs.json` bundles TeX path
outlines for package glyphs absent from MathLive, generated from retained recipes
by `scripts/generate-math-symbol-glyphs.mjs`. `MathSymbolOutline.tsx` namespaces
SVG references per instance. Preview recipes affect presentation only.
Unsupported commands retain source fallback. Palette preferences contain symbol
IDs only and live in local storage. Package additions pass through the same source
transaction and projection guard as the math edit; effective bindings supply
shortcut hints, including user overrides and disabled shortcuts.

`latexLanguage.ts` reads literal root language/font declarations and maps supported
English/Hebrew and LTR/RTL wrappers to blocks and inline marks.
`LatexLanguageContext` shares root-derived labels with node views.
`latexDirection.css` isolates mixed-language passages and keeps math/source flow
left-to-right. `latexVisualDocument.ts` preserves an entire bilingual phrase as
one source wrapper across styled runs and math. Package insertion precedes
`bidi`, `xepersian` and declarations enabling Hebrew, retaining dependency order.
This source-derived support is independent of the removed configuration/direction
menu additions; unsupported setups remain source-owned.

The Math menu separates placement, equation layout, and insertion. Its seven
entries are Inline math, Display math, Aligned equations, Brackets, Matrix, Cases,
and Symbols. The first two reflect current placement. With active
math, the contextual footer exposes these same actions through the shared
`LatexMathMenuItems` component, including the matrix size picker. With active
math, the Math menu opens that field's existing footer symbol palette. Outside
math, the same palette opens at the footer corner and retains the document and
selection until insertion; a changed document cancels insertion. Matrix uses
`DocumentGridSizeMenu`, the same expanding size grid as Table, with its bracket
selector above the grid. The selector is compact and has no separate Brackets
heading. Matrix and Table grids have no Choose size entry. Grid choices run after
the writing menu closes. Opening or canceling a picker never creates a formula.
Matrix insertion reuses the shared matrix source builder. `latexMathLayout.ts` preserves existing expressions when
constructing aligned rows; numbering chooses an unnumbered outer environment,
an equation containing aligned/gathered, or per-row align/gather numbering.

`LatexBracketsMenu` is shared by both Math menus. Its Match toggle synchronizes
the right selector with the left and disables the right control while matched.
Turning Match off permits mixed and invisible sides. Auto, Normal and four
fixed sizes are local choices until the deferred Insert action runs after the
menu closes. `mathBracketsTemplate` supplies a `#0` selection wrapper using core
LaTeX delimiters; it does not introduce packages or macros. Outside active math,
the template becomes an empty inline pair without exposing its selection marker
in source. Popup ownership preserves the selected formula through nested selects.
`mathSelectionWrapReason` rejects wrappers across partial array cells while
allowing one cell's expression or a complete array.

Palette presentation groups the catalog into its existing task-oriented categories;
search, previews, recents, favorites, and package discovery keep using the same
catalog. MathLive handles selection-aware insertion. Row/column controls target
the actual MathLive caret's array, including a nested matrix. `mathArrayContext`
and `mathStructureCommandReason` supply availability both to the inspector and
to command execution, including Shift+Enter. Fixed columns, minimum dimensions,
size limits and imported row metadata retain their restrictions. Display insertion
checks the active editor's schema so inline-only containers do not offer a no-op.
New structured fields start at their first cell. The source adapter still owns
the final edit guard.
LaTeX insertion and settings dialogs use the shared DialogHeader and DialogPanel
spacing so fields, focus rings and action buttons stay inside the rounded edges.

Math, title, and table controls share a contextual slot in the document status footer,
which keeps a constant height. Activation is scoped to the Visual workspace.
`useLatexObjectContext.ts` assigns the nearest object ownership, including nested
editable bodies and keyboard caret movement; nested math takes precedence over
its enclosing statement or table. Separate canvases do not share activation.
The symbol palette portals to the footer so the inspector's scroll area cannot
clip it; it retains the same ownership chain. `LatexTitleView.tsx` keeps native text editing on the paper;
author visibility and date mode live in the footer. Hiding an author writes
`\author{}` and retains the hidden name in the document's local app preferences.
Showing it restores `\author`. No new app metadata is written into the LaTeX
source. Legacy hidden-author comments remain readable and are removed when the
author is edited. Restoring a hidden name therefore depends on the local app
preferences when no legacy comment is present. The palette uses LaTeX-specific CSS classes to
avoid collisions with the shared math-input popup. Its code popover is attached
to the footer controls, outside the scaled document. It edits the formula body only and publishes
supported changes through the existing source guard as the user types. Outer
wrappers stay under Placement and Numbering; rejected drafts are marked as
unsaved. Inner-environment completions omit display wrappers.

Labelled display math keeps `label`, `tag`, `notag`, and `nonumber` commands in
preserved source metadata outside MathLive. The adapter counts outer rows while
ignoring row separators inside nested matrices and cases. Formula edits patch
only their changed source range and retain the commands, whitespace, and row
separators. Numbered formulas keep their outer row count and equation type;
changes spanning an interior numbering command are refused. Single outer equation
labels have a narrowly scoped exception: the adapter patches only the label,
requires every other numbering command and the wrapper to remain identical,
and then applies the ordinary formula/round-trip guard. Per-row labels and
numbering remain source-owned. Comments, malformed
commands, and numbering inside a nested environment remain source-only.

Item controls stay outside measured flow. Inline math uses MathLive's
`inline-math` mode and does not reserve input-field padding around every formula.
Math selection keeps the pointer-down anchor and a path through nested cells.
One resolver handles pointer and keyboard selection: movement within a cell
selects a range, movement across cells selects their row/column rectangle,
and crossing the visible outer boundary of a nested array selects that array
as a whole before continuing in the outer scope. Gaps inside an array resolve
to the nearest cell. MathLive supplies symbol offsets and rendering. Selection
and scope overlays sit outside the editable document, are clipped to its viewport,
and never enter source or printed output.
Named math branches use the same selection resolver: dragging or extending a
selection out of a fraction slot, script, brace body/label, arrow label, or other
nested branch includes its entire owning structure. An underbrace's expression
and annotation therefore select together before the range continues into nearby
math. Within one branch, character selection stays precise; reversing a pointer
drag back into it restores that precision. Plain clicks still place a caret.
Base/script expressions have a shared outer scope even when MathLive stores the
script as a sibling. Selection endpoints on either the base or script participate
in that scope; leaving either side selects the complete expression. Owner ranges
and whole-structure outlines include trailing scripts, while selection within a
body or script slot stays local.
Delimiter hit targets resolve closing brackets before adjacent script sentinels.
Complete expressions use one connected selection rectangle; matrix rectangles
retain separate cell boxes, including empty cells. MathLive's native fragmented
selection fills are suppressed while Scient paints this overlay.
Ctrl/Cmd+A uses `latex.selectionScopeExpand`, selecting the innermost scope and
then each parent. Its ladder retains distinct owners with equal ranges, continues
through containing editors and tables, and survives menu snapshots. Caret moves,
clicks and input reset it. Escape restores editor focus after the popup releases
focus. Math/text mode changes caused by navigation do not mark the source dirty;
leaving LaTeX command mode still schedules completed input publication.
The focused selection fixtures qualify these paths in real Chromium, including
the complete Visual editor; `apps/web/latexSelection.vitest.config.ts` runs them
without app startup or real profile data.
The MathLive adapter clears selected cells through one deferred content edit,
retaining array dimensions. Deleting in an empty cell unwraps its nearest
structure and moves the remaining atoms into the parent in row/branch order.
Native beforeinput, input notifications and undo snapshots remain in that path.
When document Undo/Redo supplies a restored formula, the adapter silently resets
the MathLive model before parsing that source into the existing field. This
avoids retaining an empty array alongside the restored array. It also discards
stale cell selections and pointer geometry; source acknowledgements still leave
the live field intact.
Left at the start of a row's first cell and Right at the end of its last cell
move outside the owning array in their respective directions. Shift with either
arrow selects that array at the boundary; nested arrays use the innermost scope.
The MathLive dependency patch keeps command suggestion rows mounted while the
highlight changes, reuses their rendered previews, and scrolls only the menu
instead of the document. The menu appears synchronously without delayed callbacks
that can reopen an obsolete popup. Rows have a fixed height and stable scrollbar
spacing. Both development and production browser exports use the patched readable
bundles; the application bundler handles production minification.

Pagination metadata never enters document JSON, the recovery journal, undo, or
source serialization. Measurement caches unchanged paragraphs, responds to font
and object resizing, waits for composition to end, and preserves a visible text
anchor during reflow. `LatexTableToolbar.tsx` keeps row, column, and table actions
in footer menus, including caption and label fields. Activation spans the table
and its portaled controls, so moving focus between them retains the active cell.
Table cell selection uses a background highlight without adding controls or changing geometry.
Whole-table highlights include the caption; document ranges use node decorations
from `latexDocumentObjectSelection.ts` to paint the block rather than isolated
native text selections. Table node selection does not autofocus a cell.
`useLatexTableSelection` owns rectangular drag/Shift selection, clipboard events
and whole-table selection separately from each native field's text selection.
Dragging out of a cell into surrounding prose hands the range to ProseMirror,
so block deletion and mixed text/table copying follow the document selection.
Tables and math share the object-range coverage check, pointer boundary resolution
and window capture in `latexObjectSelection.ts`. Leaving either nested editor
includes the whole object even when text endpoints snap past its boundaries;
moving back inside returns to its local selection. The capture runs before native
input trackers and releases only the pointer that began the drag.
The document plugin also owns prose-origin drags after they cross a math or table
object. Endpoints inside a nested editor include that entire object, and the
document range includes every intervening object. Native DOM selection reads use
the same range while the drag is active; release resynchronizes the DOM after the
browser's mouse tracker finishes. Cell-local selections remain separate.

Fit content uses intrinsic column widths without a page-percentage minimum or
an arbitrary text-length cap. Standard intercolumn spacing belongs to the cells,
not their text fields. Imported paragraph-column widths still constrain and wrap
their text; stretch tables retain full-width layout. Empty targets reserve one
character of width, with guides painted inside it without changing geometry.
These selection and sizing changes await interaction and PDF comparison checks.

Table presentation reads caption order and column kinds from the retained source.
A caption following the tabular stays below it; missing captions reserve no empty
field. Header rules do not imply bold text: cell formatting follows preserved
wrappers, including after structural edits. Imported mixed l/X/r tabularx layouts
use intrinsic natural columns and give the flexible column the remaining width;
fixed paragraph columns retain their declared widths. Uniform generated X tables
keep equal columns. Caption and float spacing use the natural standard-class
dimensions, with booktabs rule spacing approximated in CSS. Custom caption styles
and TeX float placement still need the compiled PDF.

The table adapter also projects bounded literal multicolumn/multirow cells,
basic named xcolor row mixes, hline and cline rules in ordinary l/c/r tabulars.
Logical slots share an owner cell in source metadata. The view renders only
owners, using their spans, alignment, rules and shading; navigation skips covered
slots and selections expand to full merged cells. Cell edits patch only their
inner source ranges. The serializer rejects generic structural normalization for
these tables; the source-owned operations below handle supported color, rule,
merge/split and grid edits. Unsupported span reordering remains disabled while
content editing, selection, copying and deletion stay available. Their pagination stays atomic so
presentation gaps cannot split a rowspan. Unsupported spans, colors or cell
bodies retain exact-source fallback.
The shared live reference index registers captioned table labels after their
caption and derives standard article/book/report table numbers conservatively.
Nonfloating tabulars do not increment that counter. Clicks scroll and highlight
the table using the same navigation path as equations and statements.

Clearing a rectangle updates the rows in one history transaction and resets the
selected field drafts after acceptance, so delayed native input cannot restore
the cleared text. Selected cell copies use source-preserving table cell serialization;
whole-table copies use the ordinary block serializer, including caption metadata. Row and
column insertion avoids existing IDs; cell keys follow column IDs when reordered.
Blank cell space forwards focus to the cell editor without resizing the table;
clicks on text retain native caret placement. Empty cell insertion preserves a
separator after TeX rule commands, and cell/caption round trips normalize TeX
whitespace while retaining the user's exact text in the editing session.
The long-lived ProseMirror guard calls the current source adapter through a
ref so renderer hot updates do not retain obsolete validation logic.
The outline starts collapsed, and the header's page number follows the visible page.
The canvas has no ruler above the paper. Automated source regressions and native
interaction checks qualify editing separately from human visual acceptance.

Unit tests cover source-range integrity, whitespace, headings, nested lists,
empty paragraphs, math, escaping, protected syntax and rebuild notices. Build
service/store tests cover observational status and explicit compilation.
Running-candidate checks and remaining qualification gaps are recorded in the
PR handoff. Human review is required before merge.

## Source-owned authoring operations

The footer has one object inspector. `useLatexObjectContext` identifies the nearest
active object, and `latexContextEvents` follows select/menu portals back to it.
Property controls never enter measured paper flow. Large document-bound drafts
use the existing References panel; switching modes retains the draft.

`latexObjectAuthoring.ts` is the common boundary for property changes: obtain the
current object source, apply its adapter's owned-range transformation, reproject
with the document setup, and accept one history transaction only if the result
remains a supported object. `latexSourceSyntax.ts` supplies balanced arguments,
literal-aware command scanning and nonoverlapping patches. The table, layout,
listing, box and algorithm controls use this boundary rather than rebuilding an
object from its displayed text.

`latexTableAuthoring.ts` owns grid/source ranges separately from column specs,
spans, colors, rules, captions and longtable bands. Styling updates cell interiors;
merges retain all selected text and refuse overlapping existing spans. Structural
changes on unsupported grids are refused. Repeated headers are explicitly copied
from first-header rows; they are not yet one shared editable field. Arbitrary
decimal column dialects, paragraph/display-math cells and generated-grid structural
changes remain outside these operations.

The semantic round-trip comparison stays independent of retained source spelling.
The edit signature additionally includes retained raw source on rich objects,
scientific containers and inline commands, so changes to a color, citation note or
layout option are not mistaken for a no-op.

`latexLabelAuthoring.ts` plans bounded same-file label renames for the heading
footer. Known reference arguments are updated while comments and literal content
remain unchanged; included files and dynamic definitions stay outside its scope.

These root changes reuse the source-carrying `LatexTitleStep`, ordinary publication
checks and document history. A setup-only step must publish even when its body is
equal, and the setup refresh must not discard that local history. External source
adoption and parser replacement still invalidate obsolete history. The shared
file sessions remain the persistence owner; there is no new saver or recovery
store. Cross-file atomic rename/conversion remains a separate coordination task.

Color and math inventories depend on the preamble, avoiding repeated body
parsing for ordinary typing and cursor movement.

## Root context and source coverage

`LatexProjectVisualEditor` projects the resolved root and its included sources,
regardless of which file Source is showing. `latexProjectVisual.ts` expands literal
input/include/subfile/import/subimport directives and records virtual-to-physical
source spans. Subfile document wrappers are omitted, includeonly is honored, and
include page breaks have synthetic spans that cannot be written into child files.
Missing files, cycles, unsupported dynamic includes and bounded expansion limits
block Visual with an explanation while leaving PDF available.

The assembled preamble supplies layout and package inventory. The edit mapper
separates preamble and body changes, checks span ownership, and patches the owning
files without flattening includes. Cross-file selections are rejected. The changed
block's original offset disambiguates insertions at file boundaries. File watchers
refresh dependencies; optimistic buffers are checked before publication. Each file
uses the existing shared revision-checked save session, including files open in
another Source view. Sessions survive view switches and retain pending removed
dependencies until their saves finish. Build/export wait for saves or save errors.
These are coordinated file saves, not an atomic filesystem transaction.

Write uses the root's directory for figure paths. Required packages and declarations
are mapped back to their source files in the preamble; the default table is
package-free. Resolution retains the established root while a new saved revision
is being resolved, avoiding a loading reset on each save.
`latexPackages.ts` owns the declared package inventory, known dependency providers,
and command requirements. The source guard inspects each changed block's emitted
LaTeX as well as structured tool metadata and the math symbol catalog. This covers
native MathLive context-menu styles and custom insertions without depending on
which button initiated an edit. Color/highlight requests `xcolor`; menu-only color
names receive non-overwriting `providecolor` definitions. Declarations retain user
options and are added before relevant late-loading packages. This is a bounded
source inventory, not execution of arbitrary preamble macros or external styles.
Supported table structural operations retain each surviving cell's source and
formatting by row and column identity. Labels are identifiers, not escaped prose.
Page settings target the resolved root, expose individual margins and write only
the requested fields. Hidden author text stays in app
preferences rather than private comments in the preamble.

The active math editor is registered within its document's React context. Insert
and toolbar history target that editor until the caret leaves it. An inline-to-
display conversion splits a paragraph around the formula; aligned and gathered
bodies keep an inner math environment when their outer wrapper changes. Empty
slots are local caret targets with subtle focused indicators, omitted from source.
Math and object fields coalesce source publication for 180 ms while preserving
native input and selection, flush on blur, and retain unacknowledged field drafts.
Ordinary prose insertion, deletion, replacement and paragraph edits paint without
calling the LaTeX adapter. `visualTyping.ts` classifies the editor steps without
parsing or serializing source; the live immutable editor document is retained
separately from the last synchronized source projection. `editorBackgroundTask.ts`
coalesces conversion and toolbar state during typing: a 120 ms quiet window,
with a one-second scheduling bound during continuous input, followed by
`afterEditorPaint` (animation frame then a task, with a hidden-window fallback).
These delays apply to bookkeeping; native text and MathLive paint immediately.
Following ordinary input replaces the queued document without synchronously
flushing earlier text. Selection changes and explicit formatting remain immediate.
Recognition of structured math typed as prose also happens after its text paints.
Structural actions and explicit finish/reload flush outstanding typing and source
publication to preserve revision ordering. Composition stays local until it ends.
Package edits that would change more than one physical file are refused before
publication; add the required declaration in Source first.
Rejected text conversion or source conflicts retain the live text and a raw editor
recovery snapshot; they never reset the typing document to the prior source. That
snapshot reopens after reload only over the exact source it was typed on. Over a
newer file, or when the editor cannot load it, it is offered through the same
recovery line instead: as source when it converts, and as readable, copyable
text when it does not. That text is read from the snapshot on a best-effort
basis, so the parked entry also keeps the snapshot itself. Successful conversion hands recovery to the
validated source journal before clearing the raw snapshot. Plain prose bypasses
per-character source tokenization; round-trip signatures are cached for immutable
nodes. Recovery storage writes happen after painting or on explicit exit.
Pagination waits 220 ms after input and maps existing decorations while waiting;
measurements and resize-observer refreshes run after painting, not on every input.
It never replaces the editable DOM. Plain paragraph edits map reference positions
without rebuilding counters, captions or citations, and retain cached layout
measurements. Heading text edits update only their contents titles; heading
structure and other structural edits still rebuild reference presentation.
Reference previews redraw only when presentation changes; navigation resolves the
current target when clicked. Immutable heading indexes and one shared caret-root
lookup avoid document walks and repeated object activation on each keystroke.
Shared authoring context values stay stable across toolbar-only renders.
Preamble-only configuration is scanned without copying the document body, and
single-heading edits use the same local round-trip validation as prose blocks.
Layout profiles are cached by preamble.
Physical page lookup uses binary search after checking each immutable page map's
position order; unusual line order retains the sequential lookup. Printed page
labels are reused while the document, page map and title-page setting are unchanged.
Weak caches release discarded documents/maps. Heading decorations are reused until
the document or reference index changes, including preamble-only index refreshes.

Unescaped percent comments are hidden in Visual, including standalone comment lines
and comments inside supported prose. Their source remains intact during ordinary
edits; replacements and deletions retain comments from the affected source span.
Comment line endings do not add printed spaces. Escaped `\%` and percent signs in
literal code remain content. An empty document containing only comments still has
an editable paragraph, with new text inserted outside the comments.

The parser intentionally leaves unknown commands, unsupported citation arguments,
unsupported control symbols, custom macros and unsupported table cells as source-only
blocks. Simple templates do not establish arbitrary-paper coverage.

### Longtable sections and literal row templates

`latexLongTable.ts` separates longtable header/footer sections and creates a
bounded virtual source for literal row macros from the existing document macro
dictionary. Only required braced arguments and direct definitions containing
alignment separators and row terminators are expanded. It never executes TeX.
Non-body sections are masked without moving offsets, then the ordinary table
adapter supplies cell ranges, caption/label ranges, formatting and alignments.

The longtable metadata retains the physical source, virtual source, expansion
ranges, continuation bands and original structure. Cell edits map back to the
physical source. An edit within a generated row materializes only that macro
call; all other calls and the preamble definition remain unchanged. The existing
native text-field, transaction, undo, draft and source-acceptance paths own edits.
Structural row/column actions are disabled for these imported tables.

`LatexLongTableBand.tsx` paints read-only continuation rows using projected spans,
rules, sizes and the live table number. Pagination measures hidden header/footer
bands at the body's actual column widths, reserves their heights, and inserts
them around its existing row gaps. During measurement the rendered continuation
rows collapse vertically while retaining their contribution to column widths.
Page-gap decorations survive content-only atom replacements with the same
source identity and row/column or item identities. Structural changes discard
that map and require new measurements. Node views track position changes so
derived table numbers continue to resolve after edits above them.
Final footers use `endlastfoot`, falling back to `endfoot` when absent. Continuation
definitions remain in Source. Oversized rows, advanced column specifications,
recursive row macros and exact TeX page breaking remain limitations.

### Columns, minipages and page furniture

`latexPageLayouts.ts` bounds literal `multicols` counts, `minipage` widths,
literal fixed heights and inner/outer alignment, and common root-preamble
`fancyhdr` slots and running fields.
The source adapter projects editable layout bodies through the existing nested
`latexScientific` container schema, distinguished by layout attributes. They
do not acquire statement headings, counters or statement controls. Minipages
joined by `\hfill`, literal `\hspace`, whitespace or comment joins share a row;
their original separators and environment options
remain source-owned. Recursive body patches use the existing adapter and file
save path. This does not add another editor, session or persistence mechanism.
Widths and vertical alignment belong to Tiptap's outer node-view element, which
is the actual flex item. The inner editable wrapper fills that item; a percentage
width must not be applied again inside a content-sized renderer wrapper.
Each panel's `layoutGap` supplies its leading margin: auto for stretch glue,
a bounded CSS length for explicit glue, an interword space for whitespace and
zero for a comment join. A blank source line prevents grouping. Root-preamble
column separation/rule assignments enter the shared layout profile. Heading
styles target `data-latex-command` throughout the document, including nested
containers, while leaving generated preview headings independent.

Paragraph terminators directly after content remain in source gaps instead of
creating extra empty lines. Isolated empty paragraphs remain editable.
Explicit `\noindent`
uses a paragraph attribute and preserves its prefix during text edits. Standard
skip commands and paragraph-boundary `\columnbreak` use the existing opaque
preview node with a spacing kind. Inline `\columnbreak` is an existing inline
command atom, preserving paragraph continuity and its original source.
The forced `[4]` form uses the same distinction. A source newline alone never
promotes an inline command to a paragraph-boundary break.
`latexColumnBreaks.ts` measures the line containing each inline command and
places a presentation-only break at that line's end, following the
[multicol manual](https://tug.ctan.org/macros/latex/required/tools/multicol.pdf).
The pagination plugin owns these decorations without adding source or undo
steps. It hides previous column-break widgets during line measurement, then
measures the actual column layout for page placement. A leading indentation
spacer keeps the continuation in the next column from receiving a new paragraph
indent. CSS handles balanced columns and forced column starts. Pagination
measures each layout region as one indivisible object so side-by-side contents
are not mistaken for sequential full-width lines. Column footnotes use the
existing page-footnote path; minipage footnotes remain unsupported because they
need a separate counter and local placement.

Root-level `\vfill` contributes stretch to the existing pure pagination planner.
It divides remaining printable space among fills before the next explicit page
break, reserving room for following content and footnotes. Existing gap widgets
apply this space and disappear during natural-flow measurement; source is never
rewritten to implement the stretch.

The paper sheets render running fields behind the editable DOM. Common fancyhdr
left/center/right and odd/even assignments, cleared slots, numeric page fields
and standard article section/subsection marks are supported. Geometry and literal
length assignments supply header height, separation and footer baseline offsets.
The default fancyhdr slots share the full printable header/footer width and
align left, center or right within it, rather than occupying three separate
columns. Text wraps within that width; the header's last baseline stays above
its rule. Custom field widths and collision handling remain source-owned.
These fields are display-only and use Visual's local page map. Custom page styles,
mark redefinitions, multipage columns and exact TeX
balancing remain outside this approximation.

`fixtures/layouts.tex` exercises two/three columns, lists, math, tables, theorem
blocks, color boxes, nested panels, explicit gaps and fixed-height alignment.
`latexPageLayouts.test.ts` checks source-preserving edits and math insertion
inside those containers in addition to parsing their layout options.

### Literal text and listing coverage

The inline adapter treats `\verb` as one existing inline-command atom. Structure,
comment and package-inference scans skip its payload. Edits retain the original
delimiter when possible, or choose an unused delimiter; multiline input cannot
be serialized as inline literal text.

`latexLiteralBlock` owns the exact body and option ranges for `verbatim`,
`verbatim*` and `lstlisting`. Local options stay outside the editable code body.
Literal source does not enter the prose grammar. Body edits patch only that range,
preserving the opening/closing commands, options and surrounding whitespace.
Caption edits use the existing inline source mapper. A line that would close the
environment is refused rather than allowed to escape its wrapper.

Listing presentation combines top-level root-preamble `\lstset` declarations
with local options. Supported settings cover language, plain captions and labels,
basic/keyword/comment/string/number styles, common font sizes and named xcolor
mixes, left/right numbering, first/step numbers, blank-line numbering, tab size,
single/top/bottom frames, wrapping, string-space visibility and caption placement.
Unknown options or styles retain the exact source. Named styles, executable TeX
and arbitrary package definitions are not evaluated. Caption numbering currently
follows preceding captioned Visual listings rather than arbitrary custom counters.

`LatexLiteralCodeView` uses the existing `LatexTextField` draft/save/undo path.
The native textarea owns editing and selection; a noninteractive backdrop paints
code with the installed CodeMirror/Lezer language parsers and places line numbers
outside the frame. Language-load failure leaves plain editable code. No new
session, persistence path, Tiptap node type or external highlighter is introduced.
PDF typography and complex wrapping remain approximations requiring human review.

### Scientific statement coverage

Known theorem, lemma, proposition, corollary, claim, definition, example, remark,
remarks, and proof environments have editable block content. Ordinary prose,
supported formatting, references, inline formulas, display equations, and supported
nested blocks use the same editor adapters as the document body. Paragraph changes
patch the statement body, retaining its opening/closing commands, optional title,
labels, surrounding whitespace, and untouched equations. Standard literal text
accents render as characters while retaining their source spelling.

Projection carries the root macro/environment setup through nested blocks and
local replacement validation. The scientific math whitelist also validates
supported document macro bodies, so rendering and source editing agree about
`\R`, required-argument commands and declared operators. Macros remain calls
in source; the adapter does not expand them into edited document text.

`latexEnvironmentDeclarations.ts` recognizes top-level literal `\newtheorem`
declarations, including starred statements, shared counters and section/chapter
scope. Standard `\theoremstyle{plain|definition|remark}` declarations provide
heading/body styling. The live reference plugin derives statement counters and
label targets without storing presentation in source-editing attributes. Unknown
counter changes disable inferred numbering. Labels remain inline source nodes,
hidden on paper and editable through the statement footer.

Statement headings run into the first prose paragraph instead of introducing
an extra line. Standard theorem/proof spacing uses the document's base font size;
quote wrappers use the standard 2.5em inset. Optional theorem notes remain upright
and normal weight, and a proof's optional argument replaces its heading.
Default amsthm proofs show an open square at the right end of the final paragraph,
or on a following line after a final display/list. This CSS marker does not become
an editor node, copied content or LaTeX source. Pagination includes its height.
Custom proof definitions and preamble QED overrides disable this inferred marker.
The layout follows the [AMS package conventions](https://texdoc.org/serve/amsthm/0);
custom styles and exact TeX line/page breaking still belong to the compiler.

Zero-argument `\newenvironment` wrappers around `quote`, with an optional literal
or `\textbf` prefix, reuse the structured statement body adapter. Their declaration,
prefix and custom begin/end names stay in source. Optional arguments, dynamic
definitions, custom theorem styles and arbitrary wrapper code stay source-only.

| Content                                                      | Visual behavior                      | Source preservation                                |
| ------------------------------------------------------------ | ------------------------------------ | -------------------------------------------------- |
| Ordinary prose and supported formatting                      | Editable on paper                    | Bounded text edits preserve original tokens        |
| Inline/display math and references                           | Existing math/reference editors      | Formula edits retain delimiters and outer metadata |
| Numbered align rows                                          | Math editable, outer row count fixed | Row labels, tags, and number suppression retained  |
| Literal optional statement title                             | Editable in the contextual footer    | Only the title argument changes                    |
| Unknown body commands, dynamic titles, or unsupported syntax | Exact-source block with Edit LaTeX   | No lossy rendered preview or prose conversion      |

This coverage does not evaluate arbitrary class/package definitions or reproduce
custom counter formatting, custom theorem styles, or custom proof-ending symbols. Their compiled PDF
remains authoritative. Unsupported blocks can be edited in place as exact LaTeX;
applying a draft checks both the source generation and the original block.

Export freshness reuses the revision-scoped dependency hashes in the build evidence.
There is no second visual revision manifest or PDF-overlay interaction host. The
Write editor loads lazily; Source uses the shared file editor and does not load MathLive.
Native math fields mount in short shared batches after paint so a long manuscript
does not initialize every equation in one blocking task. Focus, insertion and
flush make a queued field ready immediately; removed views cancel their pending
mounts. Queued mounts recheck attachment and use the same connected host for the
native field and its listeners. Equation-number positioning attaches when its native field is ready.

## Adapter direction

A single document-level count loop can project through a bounded virtual source
map. The accepted form initializes a preamble-declared register, increments by
one and stops at a literal integer. Safe zero-argument paragraph macros expand
inside it; counter reads become literals in prose, headings and math. Limits
bound iterations (100), template size and total expanded source. Nested loops,
dynamic definitions and subsequent register uses retain the source fallback.

The projected document contains ordinary flat blocks, so contents links,
numbering, selections and explicit page breaks use the existing editor and
pagination paths. Physical source locations point back to the owning loop.
Edits are validated against the virtual projection; an unchanged expansion is
collapsed back to its original loop. Editing generated content materializes the
loop, retaining the preamble definitions and normal source/history pipeline.
Matching original text can restore the loop within the editing session. Once
materialized, subsequent edits use the ordinary incremental source map.

Standard `algorithm` floats containing `algorithmic` use the existing structured
block with native editable algorithm lines and inline comments. The bounded
algpseudocode grammar covers requirements, guarantees, statements/returns,
for/while/repeat/loop blocks and if/else branches. Structural validation derives
indentation and line numbering; generated keywords are outside editable text.
Caption and line edits patch their original ranges. Enter and the footer's Add
step create a State line; row count changes serialize only the algorithmic body.
The reference index maintains an independent algorithm counter and clickable
labels. Unsupported pseudocode commands retain the source fallback. The float
stays together in Visual; placement remains a TeX approximation.

Literal `textcolor`, `colorbox`, `fcolorbox` and `fbox` use an attributed inline mark;
serialization retains the color expression. Document-scoped CSS variables resolve
basic xcolor names and literal `definecolor` declarations (HTML, rgb, RGB, gray),
including chained percentage mixtures. Unknown colors retain source fallback.
The `tcolorbox` adapter uses the existing structured block node, with an editable
title and native prose/math/list children. It accepts literal title, colback,
colframe, coltitle and breakable options, plus bounded corner, shadow, dashed-frame
and west-border styles. The upper and lower regions use structured children;
edits retain their `\tcblower` separator. Basic local frame groups and framed
paragraph boxes retain their argument boundaries and length declarations.
`tcblisting` with the listings engine uses the existing literal code editor and
patches its code/title ranges without rewriting the frame options. Source-only
fields have fixed sizing and a one-line minimum, with scrollable content.
Breakable boxes participate in nested
pagination; the CSS frame and continuation are an approximation of TeX output.

A bounded literal newcount/advance/ifnum loop can project up to 100 repetitions.
It is not a TeX interpreter. Unchanged generated text retains its exact loop;
editing a generated paragraph materializes that loop into ordinary paragraphs.
The footer explains this conversion, and normal document undo restores it.
Unrecognized loop forms and box options remain exact source.

Editable table cells use a single-paragraph editor with the document's inline
formatting, references and MathLive views. Math and formatting commands follow
the active cell caret. Cells publish source-preserving edits to the owning
document and share its undo history; a cell does not keep a competing history.
Mixed prose/formula cells preserve their original delimiters and table rules
through editing, copying and row/column changes. Escaped dollar signs remain text.
Re-entering a cell clears rectangle selection and restores a normal caret.
Window focus restoration respects focused objects inside an editable document,
including table selections and MathLive fields, so chat autofocus cannot take
their next keystroke.
Display equations stay unavailable inside inline-only table cells.

Abstract bodies use the same structured paragraph and math editing as scientific
environments, including Enter and inline/display math insertion. Empty MathLive
slots use the shared faint gray guides while editing, including fraction and
root slots; guides do not appear in copied source or printed output.

Complete `tikzpicture` blocks, including pgfplots axes, render as read-only
artwork in figures or on their own. Recognition scans environment boundaries,
without interpreting drawing commands. Caption edits cannot patch the drawing.
The authenticated artwork endpoint calls `LatexTikzPreview`, which compiles the
picture with the root document's preamble and current panel linewidth. The
`preview` package crops the PDF; the existing PDF.js runtime paints it at paper
scale. Each run uses a scoped temporary directory, the shared toolchain and
managed package installer, no shell escape, a concurrency limit, cancellation
of its process tree, and bounded output and time. Project inputs are resolved
through the validated document directory. Preview compilation leaves project
files and ordinary document build status unchanged. Compiler failures display
a diagnostic while keeping source intact. Document-body macro definitions,
cross-picture references and externalization are not provided by this isolated
preview. There are no drawing-editing controls in Visual.

Standard report/book structure uses the existing rich-preview nodes for literal
document controls (`title`, `author`, `date`, `pagenumbering`, `appendix`) and
generated contents/figure/table lists. Controls retain their exact source and
occupy zero-height positions in the page map. Title edits replace the effective
declaration before `maketitle`, including declarations inside `document`.
The reference plugin derives chapter/appendix numbers, heading decorations,
captions and list targets together. Pagination applies implicit chapter/list
starts and title pages; printed page labels are derived separately from physical
sheet indices. Contents indentation and leaders follow standard class levels.
This remains a CSS approximation: TeX float placement, custom class counters and
two-sided blank recto pages require the compiled PDF.

Expand coverage through bounded command/environment adapters that own recognition,
source mapping, rendering, round-trip validation and package requirements. Use the
same adapter capabilities for insertion and editing so controls cannot promise an
unsupported edit. Compiled measurements may refine presentation, but never authorize
source mutations from PDF coordinates. Shared document-session saving is integrated
here, and the editors share their bars, menus, footer and find and replace
(`writing/`). There is no new editor framework, and the LaTeX recovery stores are
not consolidated.

Scientific blocks accept scoped legacy math font declarations (`rm`, `bf`, `it`,
`sf`, `tt`, `cal`). The shared MathLive boundary translates these into font groups,
including supported document macro definitions. Loading a field is silent and
retains the original source; editing a formula may serialize modern font commands.
Proof titles retain their original inline source and resolve `ref`/`eqref` through
the same reference index as body text. Algorithm floats accept a standard font-size
declaration before `algorithmic`; prose spacing commands round-trip as spacing.

For external BibTeX bibliographies, the build service captures the generated
`.bbl` from the private build directory after a successful compile. Presentation
is bounded to 1 MB and persisted with the PDF artifact/revision in build evidence;
status exposes it only for that successful, current revision. Older evidence
without it remains readable and needs a rebuild to populate it. A bounded client
parser extracts ordinary `thebibliography`/`bibitem` entries without executing
helper definitions. Citation numbers follow the compiled order. Generated output
is never a save target; Document ? References edits the original `.bib` files.
Bibliography/style commands split from adjacent prose without requiring blank
lines, and the style command remains invisible and source-preserved. Missing or
stale presentation requests a PDF rebuild. BibLaTeX output remains unsupported.

### Shared selection ownership

`latexSelectionSession.ts` coordinates document prose, nested inline editors,
MathLive fields, native text fields, and table rectangles. Menu focus retains a
snapshot of the active participant. Root popup ownership passes through React
context into portaled submenus; nested selects follow their trigger ownership.
`DockMenu` restores selection before deferred commands and restores editing focus
after root Escape. Selection commands use the existing configurable keyboard
catalog and route through the active participant, with parent expansion/shrink.

Overlay painting measures current screen coordinates on captured scroll and resize
events. Math range geometry clears MathLive's render-time atom bounds cache before
measuring, so scrolling without an edit cannot reuse old screen coordinates.
Retained menu snapshots also measure when painted. The overlay intersects the
document viewport with an active math viewport, keeping panned highlights inside
the visible formula area.

`LatexStructuredSelection` maps retained ProseMirror bookmarks through transactions
and exposes authored formatting ranges using `latexInlineEditingScopes` when the
source projection matches, including attributed color/frame wrappers. Otherwise
it derives current mark runs. Enter formatting operates on stored marks at a
collapsed caret, with authored outer-to-inner ordering and preference for the
following span at a shared boundary, unless re-entering the scope just left.
Leaving removes the active scope's mark;
menu snapshots retain stored marks as well as the bookmark. Entry stays local to
the prose participant instead of bubbling out of math or table selections. Math/table
snapshots guard model/node identity and native text snapshots guard their value.
Math formatting runs remain character-selectable; structural branch crossing
keeps owner normalization. Structural Tab traversal skips formatting, and vertical
math navigation retains an x-coordinate until horizontal movement, typing, or a
pointer action resets it.

`splitMathRow` handles Ctrl/Cmd+Enter before document-exit handling. Existing
array rows split by moving their atoms, preserving the current column and all
following columns, through one undo-aware `insertLineBreak` mutation. A single
flow or nested body becomes a two-row `gathered` through MathLive's insertion
API; its surrounding fraction/root/formatting stays intact. The caret starts
the second row and keeps its text/math mode. Nonempty selections and protected
imported row numbering are rejected without deleting selected content.

`mathCommandCompletion` uses the bounded formatting-command inventory in
`mathTextFormatting` to create braced placeholder arguments. Keyboard acceptance,
native suggestion clicks and completion on blur share the argument insertion
path. Blur accepts only the typed command and does not reclaim focus.
The math field's explicit insertion adapter normalizes bare formatting commands
and vacant single-argument templates to selection wrappers. Without selected
content, MathLive creates a placeholder; text commands enter text mode in that
slot, while math alphabet commands retain math mode. Existing argument content
and document macro overrides bypass this normalization.
Formatting input uses marked, screen-only `htmlData` owners to retain each
braced font argument in MathLive's atom tree. `installMathFormattingScopes`
serializes these owners as their original commands, including empty arguments
and scripts, and restores the adapter on atoms recreated by undo. No internal
wrapper metadata enters source or clipboard content. Its insertion-style hook
keeps the active argument's alphabet rather than MathLive's ordinary-math reset;
outside those scopes the native style behavior is retained. Empty-slot insertion
collapses the placeholder selection to a caret inside the argument. Scope
navigation recognizes these owners, including adjacent entry and empty removal.
`mathTextFormattingInput` restores placeholders in empty formatting arguments
on load; the existing `latex-without-placeholders` save/clipboard projection
retains the formatting braces without exporting the editing slots. Document
macros overriding these commands bypass this adaptation.

Scope corner marks and muted retained highlights are clipped, noninteractive DOM
overlays outside the source model. Empty matrix cells use their rendered hit boxes
for selection painting. The footer shows only the environment type, word count
and contextual controls; nested scope paths are not rendered. These
changes do not add source tokens or undo entries. Only the innermost slot is
marked; content selections suppress these marks. Text/prose and math selections
use Markdown's primary-color mix at 22%; rectangular table/math cell selections
use its 14% mix. The overlay inherits the document's computed selection variables
so placement outside the document cannot change the theme or menu-held color.
`mathEditingGuides` gives the
native caret a thin stroke in local text color. Its em-based size follows the
rendered math style; inside accent bodies a baseline-anchored paint transform
shortens it by 15% without changing layout. Selection and menu retention suppress
the editing caret. Page-preview snapshots strip guide state. These visual changes
have not been qualified with live interaction tests.
