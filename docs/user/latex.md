# LaTeX

Use the LaTeX workspace to write a paper, report, thesis, or other scientific
document while seeing the compiled PDF beside its source. Opening a `.tex` file
offers Source, Split, Visual, and PDF across the top. Split places Source on the
left and your last chosen PDF or Visual view on the right. PDF is the initial
right-side choice. Use the PDF/Visual selector in the same header row to
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
status bar. The **Style** menu lists Text, the heading levels and Quote, with
thin lines between them; the current style is highlighted. **Numbered
headings**, a small switch under the heading levels, turns numbering on or off
for the current heading, or for the next heading chosen from ordinary text,
without closing the menu. Changing heading level keeps that setting; Text and
Quote are unaffected. Ctrl/Cmd+Alt+0 is Text and Ctrl/Cmd+Alt+1, 2 and 3 are the first
three heading levels. Quote is not available inside a list item.
Chapter-based classes also offer Chapter. The toolbar button shows
the icon of the current style. The toolbar holds, in order: undo and redo; bold,
italic, inline code (Ctrl/Cmd+E) and link (Ctrl/Cmd+K); Style; Lists; Insert;
Math; and Document. Link is unavailable when the selection spans more than one
paragraph. **Insert** opens a searchable menu for figures, tables, citations, cross-references,
footnotes, links and statements. Equations and structures live in **Math**. Heading styles live in the style menu rather
than being duplicated in Insert. Type `/` on an empty
paragraph or press Ctrl/Cmd+/ to open it; use the arrow keys and Enter to choose.
The writing toolbar stays fixed at the top on one row. When the pane narrows,
labels disappear first (Math keeps its sigma); less-used groups then move into
**More**. Insert holds elements and references; Lists holds list actions.
**Document > Page layout** and **Document > Document style** open two sections of
one settings dialog. **Outline** is a tab
in the sidebar, which opens from the header row. Selected-object options appear
on the left of the footer; narrow panes use an object-named menu.
**Document > Title & authors** offers Edit title, Edit authors and Edit date when
the document shows a title; editing jumps to the corresponding on-paper field.
When it shows none, the only item is **Add a title**: a title block is never
added silently. Date modes in
the footer are Automatic (the compilation date), Custom and Hidden.
Title, author, and date remain editable on paper.

**Lists** offers Bullet list, Numbered list, Description list, and No list. The
current type is highlighted, and each row shows its shortcut: Ctrl/Cmd+Shift+8
for a bullet list, Ctrl/Cmd+Shift+7 for a numbered list. Where a list cannot
start, such as on a selected figure, the menu says so. Choose a type on an empty paragraph to start writing, or select paragraphs
to turn them into items. With a caret inside a list, changing type affects that
list at its current nesting level; selecting particular items changes only those
items. Choosing the active type leaves it unchanged. No list
keeps the content, including supported equations and description terms.

In bulleted and numbered lists, Enter creates an item; Enter on an empty item
leaves that level. Tab and Shift+Tab indent and outdent. Description lists have
editable term and body fields: Enter in a term moves to its body, Enter in the
body starts another item, and Enter in an empty item returns to ordinary text.
New description lists use your selected paragraphs as bodies, with empty terms
ready to fill in. Conversion to description currently supports plain paragraphs;
rich or nested content that its adapter cannot preserve is disabled. Custom
source-only lists remain editable in LaTeX source.

PDF, Visual and Split use one header row. From the left it holds the sidebar
button, the page number and arrows, the zoom, the view switch, then a search
field; Rebuild and More are on the right. Click the search field and type: the
count and two arrows appear at its end, Enter moves to the next result, and
Escape clears it. Ctrl/Cmd+F puts the caret there. The view switch stays in the same place in
Source, where the room before it is empty. Minus and plus sit on either side of the zoom percentage and use
five-percent steps in the 25–500% range. Click the percentage to fit the page
to the pane width; the fit follows pane resizing automatically. In Visual, **More > Find and replace** opens the full bar under the writing
toolbar, with Replace and Replace all. Replace all works through the document one paragraph
at a time, so a very long document takes a few seconds, and each paragraph is
its own undo step. It stops if you type or undo while it is working. Text
inside figures, tables and other objects is not searched.

A thin footer stays under the document. On the left it shows the options of the
selected object, such as a table, figure, equation or statement. On the right it
shows where the caret is, for example "Section" or "Table · row 3, column 2",
and the word count:
"1,284 words", or "12 of 1,284 words" while text is selected. The count is an
estimate from the source; math, code, comments, commands and reference keys are
left out.

Zoom changes only the on-screen view, not the LaTeX
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

| Option               | Behavior                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Inline math          | Insert math within a sentence, or move the active equation inline.                                       |
| Display math         | Insert math on its own line, or move the active inline formula onto its own line.                        |
| Aligned equations    | Start two rows aligned at a relation; an existing formula becomes the first row.                         |
| Matrix               | Choose brackets using the compact selector above the table-style size grid, then click a size to insert. |
| Cases                | Insert a two-row piecewise expression with expression and condition columns.                             |
| Symbols & structures | Search for symbols or insert fractions, roots, accents, and other structures.                            |

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
paragraph style. Both sections share one draft, with **Apply** and **Cancel**.
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
the compiler still determines final PDF pagination. Clicking the zoom percentage
fits the page to the available workspace, and the page number in the header row
shows the visible page. Choose **Outline** to open document navigation.
Table tools appear in the existing footer; selecting a table does not add
controls, labels, or empty caption fields to the paper.
The canvas also reads common `\geometry{...}` overrides, landscape paper, and
explicit `setspace` spacing commands. Complex class/package layout and objects
taller than a page still need review in the compiled PDF.

Write and PDF preview keep build messages closed until you select the warning
or error badge in the header. This includes the shell-escape-disabled notice.
The messages open as a card over the document and do not move it. Select the
badge again, press Escape, or click anywhere else to close the card.

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
unnumbered. `\tableofcontents` is represented as generated content and remains
authoritative in the compiled PDF. `\newpage` and `\clearpage` appear as compact
page-break markers instead of raw-source cards.

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

Ordinary cell, caption, and label typing changes only the corresponding source
ranges. Structural operations deliberately normalize only the supported table's
`tabular` region so that its dimensions, column specification, and rules remain
consistent; the surrounding document remains untouched. A table containing
structural cell content, such as nested commands, math, or `\multicolumn`, stays
protected; selecting it shows **Protected table — edit in Source** in the footer.
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
| Figure            | Choose a project PNG, JPEG or PDF, or import a PNG/JPEG. Preview raster images, set an optional caption and width, then insert. |
| Table             | Choose a size from the grid to insert a table.                                                                                  |
| Citation          | Select one or more bibliography sources and choose a citation form supported by the document.                                   |
| Cross-reference   | Find a labelled object in this file and insert its reference or page number.                                                    |
| Footnote          | Insert a note at the cursor, or move selected inline content into a note.                                                       |
| Link              | Give selected text a web/email address, or enter new link text.                                                                 |
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

Citation search reads literal title, author, year and key fields from linked local
`.bib` files, plus inline `\bibitem` entries. It does not resolve BibTeX string
macros. Parenthetical and in-sentence forms are offered when natbib or biblatex is
configured. A known citation key or reference label can also be entered directly.
The compiler determines final citation text and reference numbers.

**More > Bibliography** finds an existing bibliography, uses linked biblatex
resources, or asks you to choose a BibTeX file/style or manual entries. It preserves
an existing bibliography style. File paths are relative to the root document;
file/style availability and the final bibliography are resolved during compilation.
Abstract and Table of contents select an existing block in the open file instead
of adding another one.

Links use `\href` and the document's hyperlink setup. Click an existing link to
edit its address and plain label in the footer; formatted labels keep their exact
LaTeX and are edited in Source. Footnotes containing formatting retain their LaTeX;
plain note text can be edited directly in the footer.

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
**More → Export → PDF** saves a
copy only when the latest PDF matches the saved buffer and build dependencies.
Update the PDF first if export is unavailable.

An agent can still explicitly request a build through the existing tools. Errors and
warnings from the build can be opened from the error and warning counts in the
header row, or from **Build failed · View details**; each one shows
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
found one, then open **More** in the header row and select **Export ▸ Word**.
Scient converts the selected LaTeX
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
