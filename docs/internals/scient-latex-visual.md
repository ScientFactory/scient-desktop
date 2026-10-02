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

| Layer                         | Owner                                                   | Responsibility                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document view and compilation | `ScientLatexSurface.tsx`                                | Source/Split/Visual/PDF selection, save-before-build entry points, export availability and build diagnostics.                                                     |
| Project assembly              | `LatexProjectVisualEditor.tsx`, `latexProjectVisual.ts` | Resolve the root and included files; route accepted edits to their physical file. Ambiguous boundaries can refuse edits.                                          |
| Source adapter                | `latexVisualDocument.ts`                                | Project supported source into editor nodes, retain source ranges, validate proposed changes and preserve opaque source.                                           |
| Interactive canvas            | `LatexVisualEditor.tsx` and object views                | ProseMirror/Tiptap transactions, MathLive fields, selection, menus and contextual editing.                                                                        |
| Title conversion              | `LatexTitleStep.ts`                                     | Keep the source before/after a paragraph-to-title conversion in the existing undo history.                                                                        |
| Writing chrome                | `markdownEditor/ui/dockChrome.tsx`                      | Shared button/menu styling and priority overflow. Visual opts into a permanent row and labels-before-overflow compression; other consumers retain their defaults. |
| Reading controls              | `writing/DocumentReaderControls.tsx`                    | Shared PDF/Visual page, zoom, fit and search controls. Format adapters supply navigation and search operations.                                                   |
| Contextual footer             | `LatexContextTools.tsx`, heading/table/object toolbars  | Stable portal destination between Fit width and Search; keeps fields mounted while switching between inline controls and a compact menu.                          |
| Persistence                   | Existing file save coordinator and Visual draft paths   | Publish accepted source with revision checks. Pending/refused input is not silently treated as saved source. Shared-session migration is outstanding.             |

A supported edit passes from the canvas transaction to the source adapter, then
to the project/file save path. Accepted source is projected back into the editor;
an unsupported edit retains its pending input or uses the exact-source editor.
Navigation, zoom and search do not rewrite LaTeX. A PDF build consumes saved
source and publishes a separate artifact; CSS page layout is never proof of
compiled output.

## Control map

### Document header

| Control                     | Role and behavior                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Source                      | Open the shared text editor for the physical LaTeX file.                                                                             |
| Split                       | Show Source beside PDF or Visual. The preview choice persists locally.                                                               |
| Visual                      | Open the supported visual editing canvas.                                                                                            |
| PDF                         | Show the compiled artifact; opening an absent/stale PDF requests a build when prerequisites permit.                                  |
| Split preview: PDF / Visual | Choose the right-hand view; available in More when the inline selector cannot fit.                                                   |
| Export to Word              | Open Word export through the existing export workflow; unavailable with unresolved source/draft state.                               |
| Rebuild / Cancel            | Save and request a manual PDF build; while cancellable, the same slot cancels it. The prior PDF stays available.                     |
| More actions                | PDF/Word Export submenu, split-preview choices and build messages when available. PDF export requires a current successful artifact. |

The direct Word action is retained to match the user's requested main-style
header. Review item 13 proposed only one Export submenu; the branch therefore
still differs from that recommendation. Header actions use icons in narrow
panes, remain one row and never require horizontal scrolling.

### Permanent writing row

| Control               | Role and behavior                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Undo / Redo           | Use the active math field's history while editing math; otherwise use document history.                                                                                                              |
| Text / T              | Change the current paragraph to Text, a supported heading level or Quote. The button name stays fixed; the menu marks the current style.                                                             |
| Use as document title | Move a plain paragraph into the standard title block; confirm before replacing a nonempty title. One Undo reverses the conversion.                                                                   |
| Bold / Italic         | Apply/remove marks on the prose selection. Additional formatting is available in More.                                                                                                               |
| Lists                 | Bullet, numbered, continued-numbering and description lists; indent/outdent supported items.                                                                                                         |
| Math                  | Insert supported inline/display equations and open the symbol tools.                                                                                                                                 |
| Insert / +            | Search and insert tables, figures, statements, references, footnotes, bibliography, abstract, contents and page breaks where supported. Root declarations and source context can restrict insertion. |
| Document              | Edit title/authors/date, explicitly add a standard title block, or open page/document settings.                                                                                                      |
| More                  | Retain lower-priority groups as the pane narrows; expose additional formatting, source-only block navigation and writing shortcut help.                                                              |

The row stays at the top. Text labels disappear before action groups overflow:
Text becomes **T**, Math keeps its sigma, Insert keeps its plus, and Document
keeps its file icon. Further narrowing moves complete groups into More; menus
keep their full labels and accessible names. Selection-specific fields belong
in the footer, not in an extra row or on the document paper.

### Reading and contextual footer

| Control                               | Role and behavior                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar                               | Toggle Pages/Outline navigation for Visual. PDF supplies its own sidebar content.                                                                       |
| Previous / page number / total / Next | Navigate the local Visual page map or compiled PDF page map. Page input uses shared validation. Previous/Next remain in More when hidden to make room.  |
| Minus / percentage / Plus             | Shared PDF zoom stepping and range. The percentage displays a whole number; clicking it resets to actual size.                                          |
| Fit width                             | Scale the document to the available pane width.                                                                                                         |
| Search                                | Open shared find controls. Visual searches supported prose; math, title attributes and raw-source blocks are not indexed by this adapter.               |
| Search previous / next / close        | Navigate matches or close find; Enter/Shift+Enter and Escape use the same shared interactions.                                                          |
| More document actions                 | Alternate access to zoom, fit, sidebar, search and page navigation. PDF adds its format-specific actions.                                               |
| Heading / Part                        | Numbered switch and reference label for the selected heading.                                                                                           |
| Title                                 | Author visibility and automatic/custom/hidden date. Title, author and date text are edited on the paper.                                                |
| Equation                              | Equation type, symbol palette and Code editor. Protected numbering commands can prevent type/row-structure changes.                                     |
| Table                                 | Row and column insertion/deletion/movement, alignment, table style/width, header, caption, reference label and deletion, subject to source constraints. |
| Figure                                | Alignment, width, placement, image path, reference label and deletion. Caption text is edited on the paper.                                             |
| Statement                             | Supported theorem/proof/remark type, optional title and deletion. Supported body prose and math are edited inside the block.                            |
| Reference / footnote                  | Edit the supported command argument.                                                                                                                    |
| Bibliography / description list       | Add/remove the selected structure's supported entries or items.                                                                                         |
| Exact-source block                    | Open its source, Apply a valid replacement or Cancel the local edit.                                                                                    |
| Draft indicator                       | Indicate pending field input that has not been accepted into source; it does not assert a successful save.                                              |

Context controls sit directly between Fit width and Search. On narrow panes they
use a menu named for the object, such as Equation or Table. The footer stays the
same height and preserves the field components while resizing; selecting an
object never adds controls to the paper or changes the page layout.

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
editor transactions. Figure selection lists project images. Pasting or dropping
one PNG or JPEG image in Write saves it to an `assets` folder beside the root
document and inserts an editable figure at the original selection; the upload
limit is 20 MB. Citation selection
reads explicitly linked project bibliography files through the existing reader.
Literal BibTeX fields are indexed for selection, not executed or resolved. Object
references are scoped to the open file. PDF export delegates to
the existing PDF save-copy hook and requires current revision/dependency evidence.
These writing features introduce no hosted service, new compiler, or second save
path. Project creation remains owned by the project sidebar.

The Visual writing bar uses Markdown's button/menu primitives with its own
LaTeX action groups: history, paragraph style, emphasis, lists, math, Insert,
and Document. It stays visible at the top and never collapses or scrolls
horizontally. As the pane narrows, labels disappear first (Text becomes T),
then lower-priority groups move into More if the symbols still do not fit.
Selection does not rename or replace the top-row controls. Settings live
under Document; keyboard shortcut help lives in More. The document header has
no additional Visual-only controls. Its grouped view tabs and Export/Rebuild
actions share one non-scrolling row; action labels yield to icons on narrow
panes. Cancel reuses the build button while a build is running. The style menu contains Text, headings,
Quote, and a separate Use as document title action. Heading numbering and other
object controls sit directly between Fit width and Search in the fixed-height
footer without changing page layout. Narrow panes use menus named for the
selected object; previous/next page actions remain available in More.

PDF and Visual both render `DocumentReaderControls` and `DocumentSearchBar`.
The bottom Visual controls use the same page input validation, five-percent
zoom steps, 25–500% manual range, percentage-button reset to actual size, fit
width, search result controls, and keyboard interactions as PDF. Each surface
supplies its own navigation/search adapter. Visual's sidebar contains Pages and
Outline; its pages follow the local editor page map and can differ from PDF.
Visual search uses the shared document-text plugin for supported prose; title
attributes, math fields and exact-source objects are not indexed by that plugin.
Navigation does not edit LaTeX. The document header retains its PDF/Word Export menu.

Title, author and date remain editable on paper. Editing existing metadata
never inserts a title block. Document > Add title block explicitly creates or
restores the standard block while preserving existing metadata. Text > Use as
document title moves a standalone plain-text paragraph into that block, asks
before replacing a nonempty title, and preserves both the previous source and
the new source in one reversible editor history step. External source adoption
clears obsolete history as for other Visual edits. Custom title pages and
unsupported title formatting remain source-owned. Standard article/report/book
classes can be selected in Document settings; incompatible switches and custom
classes stay protected.

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

Source and Visual use one `useFileSaveCoordinator` and its existing compare-and-set
writes, with the existing 500 ms debounce for both views. The recovery journal
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
Moving this remaining journal onto the shared document session is a
separate integration step in the proposed editing foundation.
Autosaving continues while the writing surface is focused. Conflicts use the
existing explicit retry/discard workflow. Rebuild is disabled until saves
finish, and cannot run while a known save error or conflict is unresolved.

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
wrappers stay under the equation-type selector; rejected drafts are marked as
unsaved. Inner-environment completions omit display wrappers.

Labelled display math keeps `label`, `tag`, `notag`, and `nonumber` commands in
preserved source metadata outside MathLive. The adapter counts outer rows while
ignoring row separators inside nested matrices and cases. Formula edits patch
only their changed source range and retain the commands, whitespace, and row
separators. Numbered formulas keep their outer row count and equation type;
changes spanning an interior numbering command are refused. Comments, malformed
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
Table selection adds no controls or visual decoration to the paper. Row and
column insertion avoids existing IDs; cell keys follow column IDs when reordered.
Blank cell space forwards focus to the cell editor without resizing the table;
clicks on text retain native caret placement. Empty cell insertion preserves a
separator after TeX rule commands, and cell/caption round trips normalize TeX
whitespace while retaining the user's exact text in the editing session.
The long-lived ProseMirror guard calls the current source adapter through a
ref so renderer hot updates do not retain obsolete validation logic.
The outline starts collapsed, and the status bar follows the visible page.
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

The parser intentionally leaves unknown commands, optional citation arguments,
unsupported control symbols, comments inside prose, custom macros and unsupported
table cells as source-only blocks. Simple templates do not establish arbitrary-paper coverage.

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
