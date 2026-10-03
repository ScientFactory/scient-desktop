# Source-derived writing canvas

Status: implementation candidate; human visual review pending.

## Review direction and implementation boundary

Yaacov's [architecture note](https://github.com/ScientFactory/scient-desktop/blob/claude/shared-editor-layer-design-20260926/docs/internals/scient-latex-visual-architecture-note.md)
and [editable-content proposal](https://github.com/ScientFactory/scient-desktop/blob/claude/shared-editor-layer-design-20260926/docs/internals/scient-latex-visual-editable-content.md)
explain the target shared architecture. This file describes the implementation
on this branch. It does not claim the shared session or patch-contract migration
has landed. Saving, recovery and the future timed-build scheduler remain shared
integration work owned by the maintainers.

The [contributor request](https://github.com/ScientFactory/scient-desktop/blob/claude/shared-editor-layer-design-20260926/docs/internals/scient-latex-visual-contributor-request.md)
separately asks for an operation-by-operation capability table with exact-source
test evidence. The control map below explains UI behavior; it is not evidence
that every operation preserves every supported LaTeX construct.

## Component ownership and edit flow

| Layer                         | Owner                                                                                                        | Responsibility                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Document view and compilation | `ScientLatexSurface.tsx`                                                                                     | Source/Split/Visual/PDF selection, save-before-build entry points, export availability and build diagnostics.                                                                                                                                                |
| Project assembly              | `LatexProjectVisualEditor.tsx`, `latexProjectVisual.ts`                                                      | Resolve the root and included files; route accepted edits to their physical file. Ambiguous boundaries can refuse edits.                                                                                                                                     |
| Source adapter                | `latexVisualDocument.ts`                                                                                     | Project supported source into editor nodes, retain source ranges, validate proposed changes and preserve opaque source.                                                                                                                                      |
| Interactive canvas            | `LatexVisualEditor.tsx` and object views                                                                     | ProseMirror/Tiptap transactions, MathLive fields, selection, menus and contextual editing.                                                                                                                                                                   |
| Title conversion              | `LatexTitleStep.ts`                                                                                          | Keep the source before/after a paragraph-to-title conversion in the existing undo history.                                                                                                                                                                   |
| Writing chrome                | `writing/dockChrome.tsx`                                                                                     | Shared button/menu styling and priority overflow. Visual opts into a permanent row and labels-before-overflow compression; other consumers retain their defaults.                                                                                            |
| Reading controls              | `writing/DocumentReaderControls.tsx`, `writing/readerBarHost.ts`                                             | Shared PDF/Visual sidebar, page, zoom and search controls. Format adapters supply navigation and search operations. With a `ReaderBarHost` they are drawn in the host's header row instead of a bar of their own.                                            |
| Contextual footer             | `writing/DocumentFooter.tsx`, `LatexContextTools.tsx`, heading/table/object toolbars                         | Shared one-line strip under the document. The selected object's options sit on the left in a stable portal destination that keeps fields mounted while switching between inline controls and a compact menu. Caret position and word count sit on the right. |
| Shared writing pieces         | `writing/commandNames.ts`, `writing/commandIcons.tsx`, `writing/InsertMenu.tsx`, `writing/ScientFindBar.tsx` | One name and icon per command that both editors offer, one Insert menu with a search field, and one find and replace bar. Each editor supplies its own items and carries out its own commands.                                                               |
| Persistence                   | Shared document sessions and LaTeX recovery journal                                                          | One saver per physical file across Source and Visual. Pending fields are settled before document save/build/export; recovery remains comparison-first.                                                                                                       |

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
the ID of its owning field: footer dismissal and table selection treat choices
inside that popup as interactions with the same selected object, including in
compact panes. Field drafts, disabled choices and source restrictions remain
owned by each feature.

## Control map

### Document header

| Control                               | Role and behavior                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source                                | Open the shared text editor for the physical LaTeX file.                                                                                                                                                                                                                                                                                            |
| Split                                 | Show Source beside PDF or Visual. The preview choice persists locally.                                                                                                                                                                                                                                                                              |
| Visual                                | Open the supported visual editing canvas.                                                                                                                                                                                                                                                                                                           |
| PDF                                   | Show the compiled artifact; opening an absent/stale PDF requests a build when prerequisites permit.                                                                                                                                                                                                                                                 |
| Error / warning counts                | Toggle the build messages card. A failed build also shows "Build failed · View details", which toggles the same card.                                                                                                                                                                                                                               |
| Sidebar                               | Toggle Pages/Outline navigation for Visual. PDF supplies its own sidebar content.                                                                                                                                                                                                                                                                   |
| Previous / page number / total / Next | Navigate the local Visual page map or compiled PDF page map. Page input uses shared validation. Previous/Next remain in More when hidden to make room.                                                                                                                                                                                              |
| Minus / percentage / Plus             | Shared PDF zoom stepping and range. The percentage displays a whole number; clicking it fits the page to the pane width.                                                                                                                                                                                                                            |
| Split preview: PDF / Visual           | Choose the right-hand view; sits before Rebuild, and moves into More when the row runs out of room.                                                                                                                                                                                                                                                 |
| Search                                | A quiet field after the view switch (`ReaderSearchField`): type to search, Enter and the arrows move, Escape clears. Visual searches supported prose; More > Find and replace opens the full bar with Replace. PDF uses its own search engine.                                                                                                      |
| Rebuild / Cancel                      | Save and request a manual PDF build; while cancellable, the same slot cancels it. The prior PDF stays available.                                                                                                                                                                                                                                    |
| More actions                          | Only what the row does not show right now: zoom steps, Fit width, the sidebar, search, page arrows, the split-preview choice and build messages appear while their own control is hidden by the narrowing order. Always: Find and replace (Visual), the format-specific PDF actions, and the PDF/Word Export submenu. There is no Actual size item. |

PDF, Visual and Split share this one row. `ScientLatexSurface.tsx` passes a
`ReaderBarHost` (`writing/readerBarHost.ts`) whose slot is
`.scient-latex-reader-slot` in the header. `DocumentReaderControls` portals into
that slot and reports back through `onHosted`; the host supplies the Split
switch before Search, Rebuild after it, and its own items at the end of the
reader's More menu. Source has no reader controls, so the surface draws its own
Rebuild and More there, and does the same until some controls are drawn in the
slot. Word export has no direct button; Export lives only in More.

The row never scrolls horizontally. As the pane narrows it gives up, in order,
the Rebuild label, the Split switch, the page arrows, the zoom steps, the
sidebar button, the zoom percentage and the page field. Their actions stay in
More.

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

| Control                            | Role and behavior                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Undo / Redo                        | Use the active math field's history while editing math; otherwise use document history.                                                                                                                                               |
| Bold / Italic / Inline code / Link | Apply/remove marks on the prose selection; Inline code is Ctrl/Cmd+E. Link (Ctrl/Cmd+K) opens the link dialog and is unavailable outside ordinary text or when the selection spans more than one paragraph (`linkUnavailableReason`). |
| Style                              | Change the current paragraph to Text, a supported heading level or Quote. The button shows the current style's icon; the menu marks the current style.                                                                                |
| Numbered                           | Inside Style: update the current heading without closing the menu, or choose numbering before applying a heading to ordinary text.                                                                                                    |
| Lists                              | Bullet list, Numbered list, Description list and No list. Check the current type and disable unsupported conversions. Tab and Shift+Tab indent and outdent; the menu has no indent items.                                             |
| Insert / +                         | Search and insert tables, figures, statements, references, footnotes, bibliography, abstract, contents and page breaks where supported. Root declarations and source context can restrict insertion.                                  |
| Math                               | Inline math, Display math, Aligned equations, Matrix, Cases, and Symbols & structures.                                                                                                                                                |
| Document                           | Edit title/authors/date, add a standard title block, use a plain paragraph as the document title, open page/document settings, or open Keyboard shortcuts (a plain text item without an icon).                                        |
| More                               | Retain lower-priority groups as the pane narrows. Contains only overflowed toolbar groups; no additional source or shortcut actions.                                                                                                  |

The row stays at the top and follows the Markdown bar's order. Command names
and icons that both editors offer come from `writing/commandNames.ts` and
`writing/commandIcons.tsx`. Text labels disappear before action groups
overflow: only Math has one, and it keeps its sigma. Style, Insert and Document
are icons at every width. Further narrowing moves complete groups into More; menus
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
| Equation                        | Placement, numbering, reference label, structure actions, Symbols & structures, and Edit LaTeX. Imported row metadata stays protected.                                                           |
| Table                           | Row and column insertion/deletion/movement, alignment, table style/width, header, caption, reference label and deletion, subject to source constraints.                                          |
| Figure                          | Alignment, width, placement, image path, reference label and deletion. Caption text is edited on the paper.                                                                                      |
| Statement                       | Supported theorem/proof/remark type, optional title and deletion. Supported body prose and math are edited inside the block.                                                                     |
| Reference / footnote            | Edit the supported command argument.                                                                                                                                                             |
| Bibliography / description list | Add/remove the selected structure's supported entries or items.                                                                                                                                  |
| Exact-source block              | Open its source, Apply a valid replacement or Cancel the local edit.                                                                                                                             |
| Draft indicator                 | Indicate pending field input that has not been accepted into source; it does not assert a successful save.                                                                                       |

The footer is the shared `writing/DocumentFooter.tsx`: one 28px line that is
always present, with the selected object's options on the left and the caret
position and word count on the right. Page, zoom and search controls are not in
it. On narrow panes the options
use a menu named for the object, such as Equation or Table. The footer stays the
same height and preserves the field components while resizing; selecting an
object never adds controls to the paper or changes the page layout. Only the
recovery line can make it taller. The word count comes from
`latexWordCount.ts`: it reads the source after `\begin{document}` and leaves out
comments, math, literal code, commands and reference keys. The selected count
comes from the editor's selection, and the total never reads below it.

`LatexVisualEditor.tsx` draws this footer when a `ReaderBarHost` is present,
which is always the case inside `ScientLatexSurface.tsx`. Without a host it
keeps the reader controls in its own footer, with the object options between
zoom and Search.

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

The writing toolbar owns a searchable Insert menu, with `/` on an empty
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

Insert is the shared `writing/InsertMenu.tsx`, with each editor's own arrangement
of its actions and no search field; the menu is as wide as its longest item. `LatexInsertMenu.tsx`
supplies the LaTeX actions and layout, and `LatexInsertMenuContent` is used in
both the regular and overflow menus.
Its top level is Figure, Table, Citation, Cross-reference, Footnote, Link,
Theorems & proofs and More. Search includes nested actions. Unsupported insertion
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
styles and delegates rendering to TeX. Abstract, contents and bibliography actions
navigate existing open-file blocks; a bibliography already configured in the root
is reported instead of duplicated. Cross-file discovery remains limited to the
explicitly linked bibliography files and root setup.

The Visual writing bar uses the shared `writing/dockChrome.tsx` button/menu
primitives, the same ones as the Markdown bar, with its own
LaTeX action groups, in the Markdown bar's order: history; bold, italic, inline
code and link; style; lists; Insert; math; and Document. It stays visible at the
top and never collapses or scrolls
horizontally. As the pane narrows, labels disappear first (Math keeps its sigma),
then lower-priority groups move into More if the symbols still do not fit.
The style button shows the current style's icon; selection does not otherwise
rename or replace the top-row controls. Settings and keyboard shortcut help live
under Document. The document header hosts the reader controls for Visual and
PDF. Its view tabs, reader controls, Rebuild and More
share one non-scrolling row; action labels yield to icons on narrow
panes. Cancel reuses the build button while a build is running. The style menu contains Text, headings,
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
keyboard interactions as PDF. Fit width is in More only while the percentage is hidden. Each
surface
supplies its own navigation/search adapter. Visual's sidebar contains Pages and
Outline; its pages follow the local editor page map and can differ from PDF.
PDF keeps `DocumentSearchBar`, which only finds. Visual shows the shared
`writing/ScientFindBar.tsx` under the writing row, through
`useLatexVisualSearch.ts`. It uses the shared document-text plugin for supported
prose; title
attributes, math fields and exact-source objects are not indexed by that plugin.
Replace and Replace all dispatch ordinary text edits, so the source adapter
writes them like typing.
Navigation does not edit LaTeX. PDF/Word Export is in the header's More menu.

Title, author and date remain editable on paper. Editing existing metadata
never inserts a title block. Document > Title & authors shows Edit title, authors
and date while a title block is displayed, and only **Add a title** while none
is; that explicitly creates or restores the standard block while preserving
existing metadata. There is no command that turns a paragraph into the title. Custom title pages and
unsupported title formatting remain source-owned. Standard article/report/book
classes can be selected in Document settings; incompatible switches and custom
classes stay protected.

Document has these entries: Title & authors, Document settings, Find and
replace, Export and Keyboard shortcuts. Document settings opens one card showing
the current values read by `latexVisualLayoutProfile`, with a draft of changes only, explicit Apply/Cancel, and a source snapshot checked again
before mutation. Unchanged fields remain source-controlled. Margin updates carry
only edited sides; adding geometry to a standard class retains the other projected
margins. Custom classes without an explicit geometry setup require Source for this
operation. Orientation updates class/geometry options and the Visual layout reader.
Title help and source actions finish their dialog close before transferring focus.

### Empty editing positions

Insertion helpers leave editable content empty instead of generating sample text.
`LatexTextField` marks emptiness from its local draft, so guides update immediately
while typing or composing. Description fields mark the same state. Small dashed
background markers appear only in empty controls within the focused environment;
hover, filled cells and ordinary empty paragraphs do not reveal guides. Tables
retain minimum cell targets independently of markers and printed rules.
Empty caption editors do not create source caption commands until edited.
Caption markers follow the centered text position within the caption field.

`mathEditingGuides` decorates MathLive 0.108's rendered array cell boxes inside
its shadow root. Its bounded DOM observer and focus/selection listeners schedule
updates when rendering or the active environment changes. The current array's
atom ID limits dashed markers to its own empty cells, including when arrays are
nested. Absolutely positioned pseudo-elements use the existing VBox strut to
align with the row baseline. No inline guide nodes are inserted. Minimum cell
targets apply through the structural selector from the first render, independent
of observer attributes, focus and emptiness, so decorating a replacement render
does not resize the formula. Markers disappear on blur without changing geometry.
The adapter never modifies math atoms, selection history, or serialization.
Empty-cell clicks resolve through the owning array's atom ID in the existing
MathLive adapter. Native placeholder slots appear only in the focused formula;
empty array cells suppress duplicate placeholder glyphs beneath their guides. Publication and copying continue to use
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
preparation because ownership cannot be established. The receipt is rechecked
immediately before build/export. Unrelated files do not block a fully resolved
document.

A Visual operation that requires changing a root declaration and a chapter is
refused before either changes. Add the declaration in Source first. General
multi-file transactions remain future work.

The accepted-source journal observes Source-only edits as well as Visual edits.
Source/Split exposes the same comparison-first recovery offer. Raw-block input
has an identity-checked journal before Apply, and reopens as text to view/copy;
Cancel removes only that interaction's record. Applying raw text retires it only
after the accepted-source checkpoint is durable. This bridge keeps the existing
recovery format and user choice; it does not enable silent session restoration.
The recovery journal
retains one accepted source copy and its base revision in memory, then coalesces
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
existing explicit retry/discard workflow. Rebuild waits for document preparation and cannot run while a relevant save
error, conflict, or unpublished field remains. Word export uses the same
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
TeX's float algorithm or longtable running headers.
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
Commands without an editor glyph are explicit source entries. Palette preferences
contain symbol IDs only and live in local storage. Package additions pass through
the same source transaction and projection guard as the math edit.

The Math menu separates placement, equation layout, and insertion. Its six
entries are Inline math, Display math, Aligned equations, Matrix, Cases,
and Symbols & structures. The first two reflect current placement. With active
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

Palette presentation groups the catalog into eight task-oriented categories;
search, previews, recents, favorites, and package discovery keep using the same
catalog. MathLive handles selection-aware insertion. Row/column controls target
the active cell; cases/aligned/gathered do not offer column changes. New structured
fields start at their first cell. The source adapter still owns the final edit guard.
LaTeX insertion and settings dialogs use the shared DialogHeader and DialogPanel
spacing so fields, focus rings and action buttons stay inside the rounded edges.

Math, title, and table controls share a contextual slot in the document status footer,
which keeps a constant height. A shared activation event closes the previous
object's controls. `LatexTitleView.tsx` keeps native text editing on the paper;
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
to the nearest cell. MathLive supplies symbol offsets and rendering;
the scope boxes are used only for hit testing and are never drawn on the paper.
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
separately from the last synchronized source projection. `afterEditorPaint`
(animation frame followed by a task, with a fallback for hidden windows) then
converts, validates and publishes the latest document. Following ordinary input
replaces the queued document without synchronously flushing earlier text. Toolbar
refreshes and recognition of structured math typed as prose also wait until paint.
Structural actions and explicit finish/reload flush outstanding typing and source
publication to preserve revision ordering. Composition stays local until it ends.
Cross-file package edits still require both file sessions to acknowledge the edit.
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
It never replaces the editable DOM. Layout profiles are cached by preamble.

Unescaped percent comments are hidden in Visual, including standalone comment lines
and comments inside supported prose. Their source remains intact during ordinary
edits; replacements and deletions retain comments from the affected source span.
Comment line endings do not add printed spaces. Escaped `\%` and percent signs in
literal code remain content. An empty document containing only comments still has
an editable paragraph, with new text inserted outside the comments.

The parser intentionally leaves unknown commands, optional citation arguments,
unsupported control symbols, custom macros and unsupported table cells as source-only
blocks. Simple templates do not establish arbitrary-paper coverage.

### Scientific statement coverage

Known theorem, lemma, proposition, corollary, claim, definition, example, remark,
remarks, and proof environments have editable block content. Ordinary prose,
supported formatting, references, inline formulas, display equations, and supported
nested blocks use the same editor adapters as the document body. Paragraph changes
patch the statement body, retaining its opening/closing commands, optional title,
labels, surrounding whitespace, and untouched equations. Standard literal text
accents render as characters while retaining their source spelling.

| Content                                                      | Visual behavior                      | Source preservation                                |
| ------------------------------------------------------------ | ------------------------------------ | -------------------------------------------------- |
| Ordinary prose and supported formatting                      | Editable on paper                    | Bounded text edits preserve original tokens        |
| Inline/display math and references                           | Existing math/reference editors      | Formula edits retain delimiters and outer metadata |
| Numbered align rows                                          | Math editable, outer row count fixed | Row labels, tags, and number suppression retained  |
| Literal optional statement title                             | Editable in the contextual footer    | Only the title argument changes                    |
| Unknown body commands, dynamic titles, or unsupported syntax | Exact-source block with Edit LaTeX   | No lossy rendered preview or prose conversion      |

This coverage does not evaluate arbitrary class/package definitions or reproduce
custom theorem counters, styles, or proof-ending symbols. Their compiled PDF
remains authoritative. Unsupported blocks can be edited in place as exact LaTeX;
applying a draft checks both the source generation and the original block.

Export freshness reuses the revision-scoped dependency hashes in the build evidence.
There is no second visual revision manifest or PDF-overlay interaction host. The
Write editor loads lazily; Source uses the shared file editor and does not load MathLive.

## Adapter direction

Expand coverage through bounded command/environment adapters that own recognition,
source mapping, rendering, round-trip validation and package requirements. Use the
same adapter capabilities for insertion and editing so controls cannot promise an
unsupported edit. Compiled measurements may refine presentation, but never authorize
source mutations from PDF coordinates. The shared Markdown/LaTeX foundation proposed
in PR #373 remains a proposal; these fixes do not adopt a new framework or persistence
architecture ahead of that decision.
