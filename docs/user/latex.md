# LaTeX

Use the LaTeX workspace to write a paper, report, thesis, or other scientific
document while seeing the compiled PDF beside its source. Opening a `.tex` file
offers Source, Split, Visual, and PDF across the top. Split places Source on the
left and your last chosen PDF or Visual view on the right. PDF is the initial
right-side choice. Use the PDF/Visual selector beside Update PDF to
change it, and drag the divider to resize either side.

## Start a document

Choose **Documents** from **Open a surface** or the panel's **+** menu. Enter a
filename and press Enter (or **Create**). The `.tex` extension is added when needed,
and the filename becomes the default printed title. A blank article is the default;
**Use a template** optionally selects Assignment, Report, Research proposal, or
Thesis in the same form. Author and date can be added while writing. Known filename
collisions receive a numbered suffix; existing files are never overwritten.

Built-in starters are bundled `.tex` templates. A successful save reports the
created filename; creation failures keep your entries and display an error.

The Documents surface also searches the project's `.tex` files and remembers
documents opened through it on this device. **Use a project template** copies an
existing `.tex` file beside its original, keeping relative supporting-file paths
intact. For an institutional template with supporting files, open that folder as
a project first. The built-in thesis starter is a general article-based structure,
not an institutional thesis class. Project creation remains in the project sidebar.

Templates, writing, project image selection, and bibliography search work locally.
PDF generation requires an installed TeX toolchain and the packages used by your
document. Install those packages before working offline; no hosted compiler or AI
service is required for the writing workflow.

## Write visually, verify with TeX

Write is a source-derived writing canvas, not an editable PDF. You can start
writing before installing or running TeX. The canvas uses a document workspace
with a compact toolbar, a collapsible outline, and a contextual
status bar. The **Text** menu includes Text, heading levels, and Quote, using
plain labels and a checkmark for the current style. Heading levels are grouped
under **Headings**, with a centered **Numbered** button. A filled gray button
with a checkmark means numbering is on; an outlined button without a checkmark means it is off. It updates the current
heading immediately and keeps the menu open. The heading footer uses the same
label and pressed state. In ordinary
text, choose numbering and then a heading level in the same menu. Changing
heading level preserves the selected numbering setting; Text and Quote are
unaffected. Chapter-based classes also offer Chapter. The toolbar button always
says Text (or T when narrow). The toolbar supports bold, italic,
lists, undo and redo. **Insert** opens a searchable menu for figures, tables, citations, cross-references,
footnotes, links and statements. Equations and structures live in **Math**. Heading styles live in the style menu rather
than being duplicated in Insert. Type `/` on an empty
paragraph or press Ctrl/Cmd+/ to open it; use the arrow keys and Enter to choose.
The writing toolbar stays fixed at the top on one row. When the pane narrows,
labels disappear first (Text becomes **T**); less-used groups then move into
**More**. Insert holds elements and references; Lists holds list actions.
**Document > Page layout** and **Document > Document style** open two sections of
one settings dialog. **Outline** is a tab
in the footer's Pages sidebar. Selected-object options appear between **Fit
width** and **Search** in the footer; narrow panes use an object-named menu.
**Document > Title & authors** groups Edit title, Edit authors, Edit date and
Add title block. Editing jumps to the corresponding on-paper field. A missing or
custom title offers an explicit creation/source action instead of silently adding
a block. Add title block is disabled when a title already exists. Date modes in
the footer are Automatic (the compilation date), Custom and Hidden.
Title, author, and date remain editable on paper. **Document > Title & authors > Add title block**
explicitly restores the standard block. **Document > Use paragraph as title** moves a
plain paragraph there, with confirmation before replacing an existing title.

**Lists** offers Bulleted list, Numbered list, Description list, Indent item,
Outdent item, and Remove list formatting. A checkmark identifies the current
type. Choose a type on an empty paragraph to start writing, or select paragraphs
to turn them into items. With a caret inside a list, changing type affects that
list at its current nesting level; selecting particular items changes only those
items. Choosing the active type leaves it unchanged. Remove list formatting
keeps the content, including supported equations and description terms.

In bulleted and numbered lists, Enter creates an item; Enter on an empty item
leaves that level. Tab and Shift+Tab indent and outdent. Description lists have
editable term and body fields: Enter in a term moves to its body, Enter in the
body starts another item, and Enter in an empty item returns to ordinary text.
New description lists use your selected paragraphs as bodies, with empty terms
ready to fill in. Conversion to description currently supports plain paragraphs;
rich or nested content that its adapter cannot preserve is disabled. Custom
source-only lists remain editable in LaTeX source.

Nested bulleted and numbered lists remain editable with ordinary enumitem labels
such as `label=\alph*)`, including bold or italic item text. Supported decimal,
alphabetic and Roman labels, `start` and `resume` options keep their source
spelling during content edits. Custom label macros retain exact-source fallback.

The footer shares PDF's page navigation, zoom and search controls. Minus/plus
use five-percent steps in the 25–500% range; click the percentage to reset to
actual size. **Fit width** fills the available pane and follows
pane resizing automatically. Zoom changes only the on-screen view, not the LaTeX
page dimensions or PDF layout. Pinch with two fingers on a trackpad, or hold Ctrl
while scrolling, to zoom smoothly around the pointer without fixed percentage
steps. Ordinary two-finger scrolling continues to move through the document.
Math normally stays rendered in the document. Click a symbol to place the caret
directly there; drag to select part of a formula. The contextual bar opens at the
bottom of the document workspace. Centered equations have a single editing
surface, without an outer selection box. New
equations start empty and focus the math cursor immediately. Alt+= inserts inline
math; Ctrl/Cmd+Shift+M (or Alt+Shift+=) inserts a display equation. Outside command
entry, Enter or Escape returns to text; a paragraph is added after a display equation only when
needed. Tab and arrow keys navigate inside math and return to text at its boundary.
Backspace or Delete in a completely empty equation removes it. Clicking outside
math dismisses its controls. Matrices, cases, and aligned calculations start with
empty cells rather than example expressions. Empty math slots appear as subtle
dots while the formula is focused and disappear when it is inactive. They are
caret targets and are never written into the compiled source.

The **Math** menu offers six choices:

| Option                | Behavior                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Inline math           | Insert math within a sentence, or move the active equation inline.                                       |
| Display math          | Insert math on its own line, or move the active inline formula onto its own line.                        |
| Aligned equations     | Start two rows aligned at a relation; an existing formula becomes the first row.                         |
| Matrix                | Choose brackets using the compact selector above the table-style size grid, then click a size to insert. |
| Cases                 | Insert a two-row piecewise expression with expression and condition columns.                             |
| Symbols & structures… | Search for symbols or insert fractions, roots, accents, and other structures.                            |

The current inline/display placement has a checkmark. Placement changes retain
existing math; converting inline math to display math retains the surrounding text
as paragraphs. Matrix and symbol pickers change nothing until an item is inserted.
Symbols & structures opens above the footer at the same corner whether opened
from Math or the footer, with no centered dialog.
Inside math, insertion uses the current math selection/caret. Outside math,
matrices and cases start display math; symbols start inline math.
Text formatting controls are disabled while math has focus, and toolbar Undo/Redo
uses the formula's editing history.

Type `\` followed by a command name directly in a formula to see local command
suggestions with symbol previews. Up/Down changes the suggestion; Enter or Tab
inserts it and moves into its editable slot when applicable. In-progress command
suggestions remain local until accepted, so ghost completions are not saved into
the document. Clicking a suggestion keeps you inside the formula.

The existing bottom bar holds **Placement**, **Numbered**, **Reference label**,
**Symbols & structures**, and **Edit LaTeX**. Aligned equations use a **Numbering**
menu with **None**, **Whole block**, and **Each row**. **Rows & columns** edits the
structure at the math cursor; cases and aligned equations keep their two-column
structure. The footer keeps its height when entering or leaving math.

Imported equation labels, tags, and suppressed numbers remain protected. Their
placement, numbering, and outer row structure are changed in Source. A single
outer reference label can be edited directly; per-row labels remain in Source.
**Edit LaTeX** edits the formula body, leaving its outer wrapper and metadata intact.

Supported numbered equations show their number at the right edge. A reference
such as `\eqref{eq:sum}` shows the matching number in parentheses; `\ref` omits
the parentheses. Click a resolved reference to jump to the equation and briefly
highlight it. Its target remains editable in the existing footer. Unnumbered
displays stay unnumbered, and explicit tags and suppressed row numbers are
respected. Standard article/book/report numbering and ordinary
`\numberwithin{equation}{section}` or `{chapter}` update locally as equations
change. Unresolved labels and unsupported custom numbering keep a label fallback;
the compiled PDF remains authoritative. Table references also show the derived
caption number and navigate to their labelled table. The label must exist in the
document; an unlabelled nonfloating table does not create a reference target.

**Symbols & structures** groups Common, Greek letters, Operators & relations,
Arrows, Sums/integrals/limits, Brackets & accents, Functions & math alphabets, and
More symbols. Search spans all categories. Hover or focus a tile to see its name
and command. Arrow keys browse the grid; Enter inserts, and Escape returns to the
formula. Recent symbols and starred favorites are saved locally on this device.
A fraction, root, accent, or paired delimiter wraps the selected math; without a
selection, entry slots are blank.

The palette is bundled locally and needs no network. Known package requirements
are added to the document root's preamble, including when editing an included
file. Math environments, table styles and equation references contribute their
requirements too. The same handling applies to commands produced by the math
right-click menu, custom shortcuts and formula code edits: color and highlighting
add `xcolor`, cancellation adds `cancel`, and AMS structures add their math packages.
Menu color names not provided by `xcolor` receive a definition when used.
The root's active `usepackage` and `RequirePackage` declarations are checked,
including comma-separated package lists and known package dependencies. Commented
declarations do not count. Existing declarations and their options are retained; the
packages must be available in the local TeX installation. Commands without a
browser glyph remain labeled LaTeX entries and render through their package in
the compiled PDF. The editor never replaces them with a different source symbol.

Choose **Edit LaTeX** to edit just the formula body in a compact box above the
footer. Supported edits update the equation and document as you type; there are
no Apply or Cancel buttons. Escape or Ctrl/Cmd+Enter returns to the formula.
Placement and Numbering manage the outer delimiters and environment. Equations
with `\label`, `\tag`, `\notag`, or `\nonumber` allow edits to the math in their
existing rows. The commands remain outside the formula field and retain their
source. The Reference label field edits a single outer label; per-row labels,
numbering, row count, and placement remain protected and are changed in Source.
Edits crossing an interior numbering command, nested numbering, and commented
equations remain protected. Macro definitions belong in the document source.
Visual reads literal `\DeclareMathOperator` declarations from the root preamble,
including the starred form, so `\DeclareMathOperator{\rank}{rank}` makes `\rank`
render as an upright operator without changing the command in source. Simple
`\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareRobustCommand`, and
undelimited `\def`/`\gdef` math definitions support required arguments. Macro
calls remain single units in the formula; use Edit LaTeX to change their arguments.
Preamble changes update the shared math setup without adding definitions to each
included file. Optional/default arguments, conditional or recursive definitions,
paired-delimiter declarations and commands requiring TeX execution remain
controlled in Source and PDF.

Theorem bodies use the same root macro setup, including commands such as `\R`
and `\norm{x}`. Literal `\newtheorem` declarations supply statement names,
shared counters and section/chapter numbering. The standard `plain`, `definition`
and `remark` theorem styles control prose and heading styling. Statement labels
stay out of printed prose and can be edited in the statement's footer options;
resolved `\ref` links show the statement number and navigate to it.
Statement and proof headings share the first line with their prose. Default
amsthm proofs show the end-of-proof square on the right; it is display-only and
is never added to your source. Custom proof/QED definitions remain source-owned.
The optional proof title replaces “Proof”, while optional theorem titles appear
in parentheses. Spacing and quote indentation follow the standard layout.
Simple zero-argument `\newenvironment` quote wrappers, such as a `note` containing
`\begin{quote}\textbf{Note.}` and ending with `\end{quote}`, render editable
content while preserving the custom environment name. More complex definitions
retain exact-source editing and compiler rendering in PDF.
Edits that cannot round-trip remain local and are marked as unsaved. MathLive's
separate virtual keyboard and menu are hidden.

The formula field expands common typed shortcuts such as `sqrt`, `alpha`,
`sum`, `->`, and `<=`. In the formula-code editor, starting a known command
such as `\fra` or an inner environment such as `\begin{bmat` shows bounded
completions; Tab accepts the first suggestion. Unknown commands remain literal
source; the TeX compiler determines whether their definitions are available.

The Math menu creates display equations, bracket or parenthesis matrices,
cases, and aligned equations. You can also type a complete `matrix`, `bmatrix`,
`pmatrix`, `vmatrix`, `Vmatrix`, `cases`, or `aligned` environment on an otherwise
empty visual paragraph; Scient converts it only after the matching `\end{...}`
is complete. Unsupported or malformed environments remain ordinary text or
protected source rather than being partially rewritten.
Source remains the authoritative `.tex` file. Source and Visual share the same
revision-checked save queue; switching views does not create a second document.

Inserting or deleting visual blocks maintains a single blank source line between
adjacent blocks instead of accumulating the separators left behind by deleted
content. This tidies the edited boundaries; intentional empty paragraphs and
source elsewhere in the document are preserved.

**File status** in the file toolbar shows save and external-change warnings.
Open it for details and the existing retry, reload, and conflict-resolution
actions. Warnings do not insert a banner above the writing page or move it.

Writing view uses browser layout with locally bundled math fonts. It is always
approximate: page breaks, floats, numbering, references, package output and
arbitrary macro expansion require TeX. Choose Rebuild PDF, then PDF or Split with PDF to
inspect exact output. A successful build never means the browser canvas is
pixel-identical to that PDF. Compile errors preserve the last successful PDF.
The canvas reads safe document-class, paper, base-font, `geometry`, paragraph
indentation, paragraph spacing and line-spacing settings from the preamble.
Use **Document > Page layout** for paper size, orientation and individual margins.
Use **Document > Document style** for standard document type, base font size and
paragraph style. Its **Packages and macros** summary shows explicit package
declarations (including options), declared macros, and definitions requiring
Source/PDF. Existing package options remain intact, and Visual adds only known
missing requirements for inserted tools. Packages are never removed automatically.
Both sections share one draft, with **Apply** and **Cancel**.
Fields marked **Keep document setting** preserve the current source; blank margin
fields do the same. Custom classes retain their class and text style in Source.
**Edit settings in Source** opens the root setup. If the document changes while
settings are open, close and reopen the dialog before applying. In an included file, these settings update the root;
these controls update explicit LaTeX preamble settings rather than maintaining
private visual-only state. Saving required root changes must finish before PDF
build or export becomes available. A failed root save remains visible for resolution.

Math and object fields retain the exact text and caret locally. Source updates
are coalesced during typing and flushed when leaving the field; page measurement
waits briefly for typing to pause. These changes request a PDF build only when
PDF is opened, or on Ctrl/Cmd+S while it is visible.
**Document > Keyboard shortcuts** opens **All writing shortcuts**, a searchable list covering
Write, Math and Tables. Filter by area when needed; shortcut editing, custom math
actions and the printable reference remain in the same dialog.

The writing surface uses a vertical stack of pages. Paragraphs can continue
across sheets, headings stay with following text when space allows, and tall
supported tables continue at row boundaries. Description lists and the contents
list can also continue between entries. These are live editor page breaks;
the compiler still determines final PDF pagination. **Fit width** adjusts to the
available workspace, and the status bar
shows the visible page. Choose **Outline** to open document navigation.
Table tools appear in the existing footer; selecting a table does not add
controls, labels, or empty caption fields to the paper.
The canvas also reads common `\geometry{...}` overrides, landscape paper, and
explicit `setspace` spacing commands. Complex class/package layout and objects
taller than a page still need review in the compiled PDF.

Write and PDF preview keep build messages closed until you select the warning
or error badge in the header. This includes the shell-escape-disabled notice.

Standard `\title`, `\author`, and `\date` metadata appears as the document's
title block at `\maketitle` and can be edited directly on the page. Fields size
to their text. Selecting any part
of the title block puts its options in the existing bottom status bar. **Author**
shows or hides the author; hiding writes `\author{}` and retains the name in
local app preferences so it can be restored on this device. To delete the name,
clear the author text.
**Date** offers Automatic, Custom, or Hidden. Custom focuses the date on the page;
typing into an automatic date also makes it custom. An omitted date follows
LaTeX's default and displays the current date, while `\date{}` hides it.
Placeholders appear only while the title block is active.
Plain abstract text is also shown and edited as an abstract
rather than as a source card. Numbered sections, subsections, and subsubsections
display their expected hierarchy in the canvas; starred headings remain
unnumbered. `\tableofcontents` shows clickable entries with page numbers in Visual.
Click a title to navigate to its heading. Titles follow heading edits, and page
numbers follow Visual's local page map; the compiled PDF remains authoritative.
An explicit
`\addcontentsline{toc}{section}{Unnumbered section}` contributes an unnumbered
entry to Visual's Contents without printing the command or creating a heading.
The following paragraph remains editable, and the command stays in source.
`\newpage` and `\clearpage` start a new Visual page, including when the command
immediately follows prose without a blank line. They appear as compact page-break
markers instead of raw-source cards.

Description lists and common `tabular`, `tabularx`, `tabulary`, and `longtable`
structures have visual editors. When inactive they read like document content;
selection and keyboard focus reveal their structural controls. In a description
list, edit labels and bodies directly or add and remove items. Common enumitem
layout such as `style=nextline` and an explicit `leftmargin` is reflected in the
canvas. In a supported table, click anywhere inside a cell, including its blank
space, to start editing. Clicking existing text keeps native caret placement and
selection. Type directly in cells
and use Tab to move through the grid; Tab from the last cell adds a row. The
footer offers **Row**, **Column**, and **Table** menus. These add, remove, and
reorder rows or columns, align the selected column, toggle a header, and change
between simple, booktabs, and full-grid styles or content/page width. Use the
Table menu to add or edit captions and reference labels when the table has a
float wrapper. Existing caption text also remains editable on the page. The
footer follows the active cell without changing the table's appearance or the
footer's height. The writing toolbar's Table picker inserts
a chosen grid size and style.

Imported captions appear above or below the table in source order and show their
derived table number when supported. A header rule does not make text bold;
explicit cell formatting is retained. In mixed-width tabularx tables, ordinary
columns fit their contents while flexible X columns take the remaining width and
wrap their text. Visual approximates table and caption spacing; custom package
styles and float placement remain authoritative in PDF.

Ordinary cell, caption, and label typing changes only the corresponding source
ranges. Structural operations deliberately normalize only the supported table's
`tabular` region so that its dimensions, column specification, and rules remain
consistent; the surrounding document remains untouched. Imported `tabular` tables
with simple `l`, `c`, and `r` columns can also edit plain cell contents inside
literal `\multicolumn` and positive `\multirow{n}{*}` spans. Basic named row colors
such as `\rowcolor{blue!10}`, vertical rules, `\hline` and `\cline` are shown and
preserved. These tables retain their structure: change spans, row/column counts,
colors and rules in Source. Tab skips covered cells and leaves the table after
the last visible cell. Selection expands to include complete merged cells.
They stay together in the writing canvas rather than splitting a merged cell
across pages. Nonfloating tables stay nonfloating and unnumbered.
Other structural cell content, such as unsupported nested commands or math,
stays protected; selecting it shows **Protected table — edit in Source** in the footer.
Other unsupported structures, including
custom macros, appear as protected source blocks.
The visual editor does not silently normalize or discard them. A visual edit
cannot delete across a protected preview or source block, or across an included
file boundary. Click a source-only block or use **Edit LaTeX** to edit its exact
source in place; **Apply LaTeX** checks that the document has not changed underneath
the draft. **Source** opens the file that owns the block.

### Selecting table and math cells

Drag across table cells, Shift+click another cell, or use Shift+Arrow at a cell
boundary to select a rectangular area. Row and Column footer menus also offer
Select row and Select column. Delete or Backspace clears all selected cells;
the table structure stays in place. Ctrl/Cmd+C copies the selected cells as a
LaTeX table fragment, and Ctrl/Cmd+X copies and clears them.

Use Table > Select table to select the whole table. Ctrl/Cmd+A inside a cell
first selects its text; pressing it again selects the table. Copy then includes
the full table with its caption and settings. Delete, Backspace or Cut removes
a selected whole table. Escape returns to editing a cell.

Cell selections highlight complete cells. Whole-table selections highlight the
table block and its caption together. Dragging from a cell out into surrounding
text switches to document selection: Delete removes the table and any selected
text. Dragging across a table from surrounding text also selects it as a complete
block. Selecting the table does not move the caret into its first cell.

In math, Delete or Backspace clears every cell in a rectangular selection without
removing rows or columns. In an empty cell, deleting removes the nearest math
wrapper and keeps its other contents; matrix contents continue in row order.

### Empty elements and editing guides

Newly inserted elements start without sample text: table cells, table captions,
figure captions, title text and inserted headings are blank. Existing document
text and explicitly chosen templates retain their content.

While editing a table, description list or other structured block, empty fields
show small, faint dashed guides. Math arrays show guides only in the array being
edited, including nested cases and matrices. The markers are spaced apart and
disappear when focus leaves the environment; hovering alone does not show them.
Filled cells and ordinary empty paragraphs have no guide boxes. Click a blank
cell or use the existing keyboard navigation to enter content. Click targets and
document layout stay the same when guides appear or disappear.

These guides are editor decorations. They are not added to LaTeX, copied content,
or the compiled PDF, and do not alter printed table borders. Caption areas stay
available for editing without adding a caption command until you enter text.

### Insert document elements

The Insert menu keeps the same choices while you work. Math-only insertion belongs
in Math; finish editing a formula before inserting document elements.
Search finds entries inside the submenus too.

| Option            | Behavior                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Figure…           | Choose a project PNG, JPEG or PDF, or import a PNG/JPEG. Preview raster images, set an optional caption and width, then insert. |
| Table             | Choose a size from the grid to insert a table.                                                                                  |
| Citation…         | Select one or more bibliography sources and choose a citation form supported by the document.                                   |
| Cross-reference…  | Find a labelled object in this file and insert its reference or page number.                                                    |
| Footnote          | Insert a note at the cursor, or move selected inline content into a note.                                                       |
| Link…             | Give selected text a web/email address, or enter new link text.                                                                 |
| Theorems & proofs | Insert Theorem, Lemma, Proposition, Corollary, Claim, Definition, Example, Remark or Proof.                                     |
| More              | Code block, Page break, Abstract, Table of contents, Bibliography and other specialized blocks.                                 |

Block insertion preserves the surrounding text. Selecting ordinary prose before
choosing a theorem wraps that selection; with a caret inside an existing theorem,
a new theorem is inserted after it. Unsupported selections ask you to use ordinary
text or Source. Edit statement prose, math and references on paper, with title and
structural options in the footer. Missing standard statement declarations are
added using the existing source adapter; custom definitions remain in Source.

Figures use real `figure` and `\includegraphics` source and add `graphicx` when
needed. Imports are saved only after choosing Insert (PNG/JPEG, up to 20 MB).
An empty caption does not add a caption or reference label. PDF images can be
selected but do not have a raster preview in the picker. Deleting a figure does
not delete its image file. Use the footer for image path, width, placement,
alignment and reference label; edit captions on paper.

Imported figures can also display editable framed text, literal rotations, and
side-by-side `subfigure` panels. A one-argument preamble command wrapping a
centered, fixed-height `parbox` in `\fbox` is recognized from its definition;
editing its text keeps the original command call. Panel and figure captions
are editable on paper. Widths, rotation angles, framing and macro definitions
remain in Source. Unsupported artwork stays available as exact source.

For standard figure counters, captions show their number and subcaptions show
their panel letter. `\ref` navigates to labelled figures or panels; `\subref`
navigates to a panel and displays its letter. Custom counter or caption setup
can prevent Visual from deriving a reliable number; the PDF remains authoritative.

Citation search reads literal title, author, year and key fields from linked local
`.bib` files, plus inline `\bibitem` entries. It does not resolve BibTeX string
macros. Parenthetical and in-sentence forms are offered when natbib or biblatex is
configured. A known citation key or reference label can also be entered directly.
The compiler determines final citation text and reference numbers.

For a standard manual `thebibliography`, Visual displays a References heading
and bracketed entry labels, preserving supported emphasis and punctuation.
Ordinary `\cite` commands display linked labels, including multiple keys and a
plain optional note. Click a citation number to visit its entry. Citation keys
remain editable in the footer. Package-specific citation styles remain compiler-owned.
Open **Document > References** to search, add, edit and remove entries in a side
panel. It reads explicitly linked `.bib` files and existing `\bibitem` lists;
choose a destination when the document uses more than one. It preserves the
document's bibliography packages, resources, style and printed-list commands.
BibTeX entries offer title, author, year and additional fields, plus Entry source
for expressions and custom fields. Manual entries offer their formatted LaTeX
text and optional custom label. Existing keys stay fixed to preserve citations;
new entries let you choose a unique key. Save applies the entry, while Cancel
discards its form draft. Closing or switching entries asks you to finish a dirty
draft first. Removal asks for confirmation because existing citations keep
their keys and become unresolved. The last manual entry can be removed without
changing the document's bibliography approach.

Clicking a citation exposes its known entry details and **Edit reference** (or
**Find reference**) in the contextual footer. Selecting the bibliography offers
**Manage references** there. The paper keeps formatted entries without code or
editing controls. **Insert > Citation** still inserts a citation at the captured
caret; **Insert > Cross-reference** chooses a labelled object and uses `\ref`
or `\eqref` by default. Bibliography management does not insert a citation.

Reference saves preserve unrelated entries, unknown fields and literal TeX
formatting. Unrelated document edits can be merged while the entry itself remains
unchanged; conflicting edits retain the form draft instead of overwriting it.
Linked file writes use Scient's normal file sessions and revision checks.
Read-only or truncated files remain read-only. Entry form drafts survive moving
between file views during the app session.

**More > Bibliography** finds an existing bibliography, uses linked biblatex
resources, or asks you to choose a BibTeX file/style or manual entries. It preserves
an existing bibliography style. File paths are relative to the root document;
file/style availability and the final bibliography are resolved during compilation.
Abstract and Table of contents select an existing block in the open file instead
of adding another one.

Links use `\href` and the document's hyperlink setup. Click an existing link to
edit its address and plain label in the footer; formatted labels keep their exact
LaTeX and are edited in Source. Imported `\hyperref[label]{text}` and
`\hyperlink{name}{text}` navigate to a labelled section or other supported target,
including a literal `\hypertarget{name}{text}`. Section references display their
number, and `\pageref` displays the target's local Visual page number. These
commands keep their original source syntax. Links read as ordinary document text.

Standard footnotes show a numbered superscript and their text beneath a short
rule at the bottom of the corresponding Visual page. Click the superscript to
navigate to its note; click the note to return to its marker. Either action
selects the same footer editor without moving focus into it. Footnotes containing formatting retain their
LaTeX; plain note text can be edited directly in the footer. Prose formatting such
as emphasis is shown in the note. Custom counters and unsupported note bodies
remain approximate or show exact source; PDF pagination remains authoritative.

Dialogs retain the original insertion point. Cancelling inserts nothing; if the
document changes while a picker is open, insertion asks you to choose the position
again. An image already imported when this happens remains a project asset.

Preamble, macro and global-layout edits show a rebuild notice. After a crash or
interrupted save, your unsaved changes are offered in the footer when you reopen
the document, and you can keep writing meanwhile. **Compare** shows them next to
the file, and the file is replaced only if you choose **Use recovered** there.
**Discard** removes the recovered copy. In a document made of several files, the
recovered changes can be compared and copied, but are not applied for you.

## Edit LaTeX source

Source and the left side of Split use the same file editor as other source files
in Scient. Edit the `.tex` file directly there. Its contents are shared with
Visual; selecting another view does not create another document. In Split with
PDF selected, double-click a source line to locate it in the compiled PDF.

## Build and review

Choose **Rebuild PDF** to build after the current source has been saved.
Opening a stale PDF requests a build. While PDF is visible, Scient also rebuilds
on Ctrl/Cmd+S. Typing alone does not request a build. Builds wait for saves,
and keep the last successful PDF readable while building.
A failed revision requires an explicit rebuild instead of repeated automatic attempts.
**Export → PDF** saves a
copy only when the latest PDF matches the saved buffer and build dependencies.
Update the PDF first if export is unavailable.

An agent can still explicitly request a build through the existing tools. Errors and
warnings from the build can be opened from the status chips above the document; each one shows
the file and line it came from when the compiler reported one. Click a message
that names a project file to open that file at the reported line.

You can also ask an agent to create or edit a project LaTeX document and build
it as a PDF. When the connected provider supports Scient's document tools, the
agent uses the same qualified LaTeX toolchain, saves the requested PDF inside
the project, and opens the compiled document in Split view. A successful build
proves that the PDF compiled; ask the agent to inspect the rendered pages when
visual quality matters.

## Export to Word

Save the source, choose the document root in the LaTeX toolbar if Scient has not
found one, then select **Export ▸ Word**. Scient converts the selected LaTeX
document to a `.docx` file; the first export offers to install Pandoc if it is
not yet available. The export uses the root file and its literal `\input`,
`\include`, and `\subfile` references. As in LaTeX, these resolve from the root
file's folder, and they may point anywhere inside the same project: for example,
`paper/main.tex` can include `../shared/methods.tex`. Local bibliography files
and common image formats are included the same way, and a figure keeps the
width or height the source gave it.

Files outside the project folder, including links that lead outside it, are
never read: they become placeholders marked "outside the project folder", with a
conversion note. If a project file changes while Scient reads it, the export
stops and asks you to try again. On Windows, Word export works for now only for a
single-file document open in the editor, without includes, figures, or
bibliographies; Scient explains when a document needs more. Missing or computed includes and figures also become visible
placeholders. PDF and EPS figures are not rasterized for Word. Equation
numbering, references, layout commands, and some custom macros may change
during conversion; review the saved Word document before sharing it.

## Move between source and PDF

Choose **Find selection in PDF** in Source, or press Ctrl/Cmd+Shift+J, to reveal the
current source position in the successful PDF. This opens Split when needed.
Double-clicking source keeps normal word selection. Double-clicking a word in the
PDF in Split keeps normal word selection and reveals the corresponding source line.
Scient briefly marks the destination so it is easy
to see. This needs a successful current build with a navigation index. If no
mapping is available, the PDF remains usable and the status explains why the
jump could not be completed.
The exactness comes from the compiler's navigation index: some complex or RTL
lines contain only a line-level location, so those lines can land near the
typeset line instead of on the exact word.

The PDF keeps your place across rebuilds: your page, zoom, and scroll position
stay put while a new version comes in, instead of snapping back to the top. If
the PDF you're looking at is older than the source it was built from, a stale
badge tells you so.

## Choose a LaTeX engine

Scient compiles with pdfLaTeX, driven through `latexmk` — or through Tectonic
instead, if that's what it finds. On the `latexmk` path, XeLaTeX and LuaLaTeX
aren't run: if a document asks for one, through a `% !TEX program = xelatex`
(or `lualatex`) comment or by loading a package pdfLaTeX can't process, such as
`fontspec` or `unicode-math`, Scient detects that before the build starts and
the error explains what the document needs instead of failing partway through a
compile that was never going to work. Tectonic's engine is XeTeX-based, so with
Tectonic installed those same documents build normally and nothing is refused.

Engine-aware documents that load packages only in the appropriate conditional
branch are allowed to build normally.

## Install a LaTeX distribution

If Scient can't find a LaTeX installation on your computer, it offers to
install TinyTeX for you — a small distribution, about 70 MB, that lives with
Scient and needs no administrator access. That install includes the packages
most documents need, and anything still missing installs automatically the
first time a document uses it; with your own TeX distribution, the error names
the package to install. The first build of a document can therefore take a few
minutes while those packages arrive — Scient says so, and names them, while it
waits. Later builds of the same document are as fast as any other compile.
Installing a package needs a network connection: when
you're offline, or when no package by that name can be found, the build stops
and the error says which one it was. This one-click install is available on
Windows (x64), macOS (Intel and Apple Silicon), and Linux (x64). On other
architectures, install TeX Live, MiKTeX, or Tectonic yourself, and Scient will
use it — an existing installation always keeps precedence over Scient's own,
on every platform. If you install one while a document is already open, select
Update PDF: asking for a build by hand also makes Scient look for an engine
again, so the one you just installed is picked up without reopening the file
or restarting.

Compiling never leaves clutter in your files: build output, logs, and other
compiler byproducts stay out of your project entirely.

## Choose the root document

When you open or edit a `.tex` file that belongs to a larger document, Scient
looks for the document that includes it and builds that document, not the
fragment on its own. A single, unambiguous static dependency is enough; common
`\input`, `\include`, `\subfile`, `\import`, and `\subimport` references are followed.

If the source belongs to more than one document, or Scient cannot safely infer
the root (for example, because an input is computed by a TeX macro or uses an
unsupported inclusion command), choose the document in the LaTeX toolbar.
Scient will not guess between possible roots.
You can also state the root explicitly near the top of the included file:

```
% !TEX root = ../main.tex
```

The path is relative to the file containing the comment. Scient compiles
`main.tex` when you request Update PDF. If no root can be found, open the main
document or add the comment; Scient leaves the fragment unbuilt rather than
compiling the wrong file.

### Editing included chapters

Visual shows the assembled document from the same resolved root as PDF, even when
Source is showing a chapter. Literal `\input`, `\include`, `\subfile`, `\import`
and `\subimport` references are expanded in order, including nested files.
`\includeonly` is respected and `\include` retains its page breaks. Edits save
back to the file that owns the content; the original include commands stay intact.

Write uses the selected root document for page settings and image paths. When a
supported insertion needs a missing package or theorem declaration, Scient saves
it in the root preamble along with the chapter edit. Each file has its own revision
check; save conflicts are reported, and PDF builds wait for pending file saves.
Switching views keeps those saves active. A selection spanning multiple source
files must be edited one file at a time.

Missing files, cycles and unresolved dynamic or conditional includes show an
explanation instead of an incomplete Visual document. Use PDF for includes that
require TeX execution. Opening the PDF and explicit save actions can request builds;
Visual alone does not compile each edit.
New tables start with a package-free style. Arbitrary custom macros and packages
loaded through external class/style files are not expanded by the visual editor.

Ordinary prose edits preserve unchanged `~`, dash spelling, emphasis commands and
source line breaks. Unknown macros and unsupported syntax remain available through
Source; Write is a bounded editor, not a complete TeX interpreter. Using
recovered changes follows normal save and conflict handling.
