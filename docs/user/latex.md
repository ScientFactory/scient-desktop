# LaTeX

Use the LaTeX workspace to write a paper, report, thesis, or other scientific
document while seeing the compiled PDF beside its source. Opening a `.tex` file
offers Write, LaTeX source, Source + PDF, and PDF preview in the view selector. Switch
between them, and drag the divider in split view to resize either side.

## Start a document

Choose **Documents** from **Open a surface** or the panel's **+** menu. In your
current project, choose Assignment, Report, Research proposal, Thesis, or Blank,
enter a title and optional author/course, and choose **Create and start writing**.
The filename is editable, including a folder inside the project. Existing files
are never overwritten by document creation.

Built-in starters are bundled `.tex` templates with title, author, and course
placeholders and instructional body text. **Preview LaTeX source** shows the exact
filled source before saving. A successful save reports the created filename;
creation failures keep your form entries and display an error.

The optional course/institution is a centered line below the author in the title
block. Author details support multiple lines in Write and preserve LaTeX line
breaks. This formatting applies to newly created templates; existing source is
preserved.

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
status bar. The toolbar supports paragraphs, three heading levels, bold, italic,
lists, undo and redo. **Insert...** opens a searchable menu for equations, tables,
statements, figures, question/solution pairs, and page breaks. Type `/` on an empty
paragraph or press Ctrl/Cmd+/ to open it; use the arrow keys and Enter to choose.
The toolbar stays on one slim row. **More writing tools** holds Table, Cite / Refer,
Document settings, Outline, and Review. In narrower panes, formatting controls also
move into this menu, keeping them available without wrapping the toolbar.
Zoom controls are in the top writing toolbar. Enter an exact percentage (25–400%)
and press Enter, or use minus/plus and the percentage presets. Escape cancels an
unfinished percentage edit. **Fit width** fills the available pane and follows
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
empty cells rather than example expressions.

Type `\` followed by a command name directly in a formula to see local command
suggestions with symbol previews. Up/Down changes the suggestion; Enter or Tab
inserts it and moves into its editable slot when applicable. In-progress command
suggestions remain local until accepted, so ghost completions are not saved into
the document. Clicking a suggestion keeps you inside the formula.

Math controls appear within the editor's existing bottom status bar: equation
type, **Symbols**, and **LaTeX**. The footer keeps the same height when entering
or leaving math. Structures and symbol categories live inside **Symbols**, which opens
a compact visual palette with categories corresponding to LyX's math panels:
Greek letters, arrows, relations, negated relations, operators, accents, delimiters,
fonts, functions, spacing, and specialist symbols. Search by name, symbol, or LaTeX
command across all categories. Hover or focus a tile to see its name and command.
Arrow keys browse the grid; Enter inserts, and Escape returns to the formula.
Recent symbols and starred favorites are saved locally on this device. Selecting
a fraction, root, accent, or paired delimiter wraps the current math selection;
without a selection, its entry slots are blank. **Structures** also offers blank
matrices/cases and row/column editing at the current matrix cursor.

The palette is bundled locally and needs no network. Known package requirements
are added to a full document's preamble when a new command is introduced; the
packages must be available in the local TeX installation. Commands without a
browser glyph remain labeled LaTeX entries and render through their package in
the compiled PDF. The editor never replaces them with a different source symbol.

The bar changes between inline,
centered, numbered, unnumbered, aligned, and gathered forms and inserts
fractions, roots, scripts, operators, relations, Greek letters, matrices,
cases, and aligned structures at the mathematical cursor. Choose **LaTeX** in
that bar to edit just the formula's code in a compact box above the bar. Supported
edits update the equation and document as you type; there are no Apply or Cancel
buttons. Escape or Ctrl/Cmd+Enter returns to the formula. The outer delimiters and
equation environment are managed by the equation-type selector. Labels, numbering
commands, and macro definitions belong in the document source. Edits that cannot
round-trip remain local and are marked as unsaved. MathLive's separate virtual
keyboard and menu are hidden.

The formula field expands common typed shortcuts such as `sqrt`, `alpha`,
`sum`, `->`, and `<=`. In the formula-code editor, starting a known command
such as `\fra` or an inner environment such as `\begin{bmat` shows bounded
completions; Tab accepts the first suggestion. Unknown commands remain literal
source; the TeX compiler determines whether their definitions are available.

The Insert menu creates display equations, bracket or parenthesis matrices,
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
arbitrary macro expansion require TeX. Choose Update PDF, then PDF preview or Source + PDF to
inspect exact output. A successful build never means the browser canvas is
pixel-identical to that PDF. Compile errors preserve the last successful PDF.
The canvas reads safe document-class, paper, base-font, `geometry`, paragraph
indentation, paragraph spacing and line-spacing settings from the preamble.
Use **Document settings** to change paper size, base font size, margins and paragraph style;
these controls update explicit LaTeX preamble settings rather than maintaining
private visual-only state.

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
to their text; only the focused field has a subtle underline. Selecting any part
of the title block puts its options in the existing bottom status bar. **Author**
shows or hides the author; hiding retains the name in a TeX comment so it can be
restored after reopening the document. To delete the name, clear the author text.
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
custom macros and equation labels or tags, appear as protected source blocks.
The visual editor does not silently normalize or discard them. A visual edit
cannot delete across a protected preview or source block. Open an included file
to edit its contents; the established root still controls the PDF build.

The **Insert...** menu inserts theorem, claim, lemma, proposition, corollary,
definition, example, remark and proof environments. Their type, optional title,
body and reference label are editable together in a semantic card. When a newly
inserted statement has no preamble declaration, Scient adds a standard
`\newtheorem` or `\newenvironment` declaration so the source remains compilable.

The **Figure** action lets you select a project PNG, JPEG, or PDF image, caption,
and width. It inserts a real `figure` and `\includegraphics` structure,
adds `graphicx` when needed, and resolves its project-relative image through the
workspace asset service. Edit its path, width, placement, alignment, caption and
label from the card, or delete the whole figure. Direct external-file import and
asset deletion are separate workspace operations and are not implied by deleting
the LaTeX figure.

**Cite / Refer...** searches labelled objects in the current file by their heading,
caption, or key. Its Citations tab searches literal title, author, year, and key
fields from linked local `.bib` files, plus inline `\bibitem` entries. You can also
enter a known key. Bibliography configuration stays in LaTeX; the picker does not
create a bibliography or resolve BibTeX string macros. The compiler determines
final citation text and reference numbers. Preamble,
macro and global-layout edits show a rebuild
notice. After a crash or interrupted save, a recovered draft is offered as
copyable source, never automatically written over a newer file.

## Math insertion

The source editor's **Ω** toolbar provides shared math symbols, fractions, roots,
and matrices. Its shortcuts and completion behavior are configured in
**Settings → Shortcuts → Math**, alongside Markdown math.
See [math authoring](./math-in-chat.md#authoring-math) for defaults and source-safety
limitations. These controls change LaTeX source; PDF read mode does not insert math.

## Build and review

Builds are explicit: choose **Update PDF** after pending source saves finish. Opening,
typing, autosaving, status polling and toolchain installation do not compile.
**Review** lists repeated labels, references missing from the current file, and
common unfinished placeholders. References may belong to included files; this
review does not replace compiling the complete document. **Export PDF** saves a
copy only when the latest PDF matches the saved buffer and build dependencies.
Update the PDF first if export is unavailable.

An agent can still explicitly request a build through the existing tools. Errors and
warnings from the build appear in a list above the document; each one shows
the file and line it came from when the compiler reported one. Click a message
that names a project file to open that file at the reported line.

You can also ask an agent to create or edit a project LaTeX document and build
it as a PDF. When the connected provider supports Scient's document tools, the
agent uses the same qualified LaTeX toolchain, saves the requested PDF inside
the project, and opens the compiled document in Split view. A successful build
proves that the PDF compiled; ask the agent to inspect the rendered pages when
visual quality matters.

## Move between source and PDF

In Split, double-click a line of source to jump to the matching place in the
current successful PDF. Double-clicking a word in the PDF keeps the normal word
selection and reveals the corresponding source line in the source pane. These
gestures never open Split automatically; select Split first when you want both
sides to follow one another. Scient briefly marks the destination so it is easy
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
