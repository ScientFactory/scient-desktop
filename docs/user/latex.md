# LaTeX

Status: Draft
Owner: Yaacov
Created: 2026-08-14
Last updated: 2026-11-10
Purpose: Explain creating, editing, compiling and reviewing LaTeX documents in Scient Desktop.
Doc type: Operational procedure

Use Scient's LaTeX workspace to write, compile and review a paper, report or
thesis. **Visual** lets you edit supported document content on a page-like canvas;
**Source** edits the `.tex` file directly; **PDF** shows TeX's compiled output.
**Split** puts Source beside PDF or Visual. The saved LaTeX remains the document
source, and the compiled PDF determines final typesetting.

You can write in Source or Visual before installing TeX. To produce a PDF, install
a compatible toolchain and the packages your document uses. See
[Build and review](#build-and-review) and
[Install LaTeX tools](#install-latex-tools).

## Start a document

Open a new side-panel tab with **+**, then choose **LaTeX** from the format
button on the **Document** card, or use the side panel's **Documents** menu.
You can also choose the Files bar's **New document** button (file-plus icon)
then **LaTeX**, or **New document here → LaTeX** from a folder's context menu.
A single-file template starts as `untitled.tex`; a folder template such as Thesis
starts at `main.tex` inside its own folder. The document opens in Visual, using
your default template and placing the cursor in its title. Type the title and keep writing. For Markdown, see
[Writing Markdown](./markdown.md). Once the title is saved and you move on, the
file takes its name from it once, for example `spectral-bounds.tex`; later
title changes leave the file name alone. Templates without a title, such as a
letter or a CV, ask for a document name instead. Existing files are never
overwritten, and a name that is taken gets a number. The document is created in
the selected folder when you start from Files, or the active thread's workspace
root from the Document card. The Thesis template creates its own folder there.
Creation or automatic naming can stop if a save, permission or recovery decision
needs attention. Resolve the notice before trying again.

Until you write in the body, the templates and the document language (English
or Hebrew) sit above the page: choosing another one switches the empty
document in place and keeps your title. The first few templates are on the
page; the rest are under **More**. The Thesis template is a folder of its own,
with chapters and a bibliography beside `main.tex`. Right-click a template to
make it the default, move it between the page and **More**, or hide it, and
drag to reorder. **More > New template…** saves a copy of the chosen template
as your own, which you can then edit, rename, or delete.

Hover over a template name to preview its first page. Click the preview to open
a larger view with zoom and scrolling; Escape closes it. Opening a preview
does not select the template. Click the template's name to use it. Available
previews work offline, including personal templates with a captured first page.

For later filename changes, use the file header's **Rename** action. If a chapter
is included by another file, update the including path in Source after renaming;
Scient does not rewrite that include for you. Finish pending edits, recovery
decisions and builds before retrying a blocked rename. A document with existing
build output may reopen at its new name rather than keep every local editor state.

**Settings > Documents** keeps these choices in one place:

- **LaTeX**: a **LaTeX tools** readiness summary, an optional compiler-bundle
  install, and compiler versions, paths, and availability under **Technical details**.
  **Templates** includes the default and the full list to arrange, hide, show again,
  rename, or delete your own. Language, default compiler, and opening view are separate choices.
- **Markdown**: whether Markdown files open Rich or as Source.
- **Word**: the Pandoc converter that Word export uses, and its install.

Template, language, default-compiler and view choices stay on this device.
Tool installations belong to the server shown at the top of Settings; when that
server is offline, their status reads **Offline**. The opening view follows the
last choice made in Settings or the editor.

PDF generation requires an installed TeX toolchain and the packages used by your
document. Install those packages before working offline; no hosted compiler or AI
service is required for the writing workflow.

<a id="save-your-own-template"></a>

### Save and manage personal templates

Open the document's main `.tex` file, then choose **Document > Save as template…**
in Visual, or **More > Save as template…** in the other views. Enter a name and
choose **Save**. If that name already exists, the action becomes **Replace**.
The saved template clears its supported title field for the next document.
When this file is associated with a personal template, **Update “name”** replaces
that template with the file's current contents. Arrange, rename, edit or delete
personal templates in **Settings > Documents > LaTeX > Templates**.

Templates capture the selected source and some literal included `.tex` files.
Save from the main file: a chapter can show the assembled document in Visual yet
still save only that chapter as the template. Images and bibliography entries
are not bundled; copy those resources separately. New bibliography companions
may be empty and need their entries restored. A template picture is optional;
a missing picture does not prevent saving.

Template capture currently follows a limited set of literal includes. Multiple
includes on one line, unbraced inputs, the `import` family and nested files with
their own relative paths may be omitted or collected incorrectly. A successful
save does not establish that every dependency was captured. For those projects,
copy the project files instead. Keep the intended Visual pane as the only visible
LaTeX pane while taking a template picture; capture can otherwise use another
visible document. Wait for a save or update to finish before starting the next.

For an ordinary single-file template, create a new document from the saved copy
and check its source and resources before reusing it. Personal templates are
stored in this device's local application/browser storage; they are not shared
with other devices or packaged as portable project backups.

<a id="write-visually-verify-with-tex"></a>

## Choose a view and navigate

Opening a `.tex` file offers **Source**, **Split**, **Visual** and **PDF**.
Split places Source on the left and the last chosen PDF or Visual view on the
right; PDF is the initial choice. Use the PDF/Visual selector in the header to
change the right pane, and drag the divider to resize it. Choosing a view also
updates the device preference used when opening other LaTeX files. Newly created
LaTeX documents open in Visual.

PDF, Visual and Split share one header row: build status and search, the view
switch, sidebar/page/zoom controls, then Rebuild and More. Split also offers its
PDF/Visual selector. In narrow panes some controls move into More. Source keeps
the view switch in the same position.

The sidebar's **Outline** navigates document headings. Visual's page controls use
its current browser layout; PDF's controls use the compiled PDF. Clicking a
Contents entry navigates to its heading. Clicking a generated Contents heading
keeps your existing caret, and clicking a statement heading places the caret in
its editable body.

Visual tries to reopen at your reading position during the current session. The
initial screen loads first, and the rest of the document loads around it in steps. Editing and the writing toolbar become available after the complete
projection is loaded. Large or complex documents can take longer; loading speed
is not guaranteed by a particular page count. Formulas render in the background,
visible ones first; a formula that cannot render shows its LaTeX. Visual adjusts scrolling to
retain the reading line as formulas, images and edited content change size.
Complex layout and delayed restoration can still move the view.

Use the minus and plus controls for five-percentage-point zoom steps between
25% and 500%. Click the percentage to fit the page to the pane width; the fit
follows pane resizing. Zoom affects only the screen, not LaTeX paper dimensions.

In Visual, pinch a trackpad or hold Ctrl while scrolling to zoom around the
pointer. Ordinary two-finger scrolling moves through the document. Formula
previews and offscreen content may still need painting or measurement when
revisited. Formula previews are cached within a fixed memory budget, so some
may render again.

Where supported, the document's **More → Open in new window** action opens its
side-panel tab in another window. See [Multiple windows](./multiple-windows.md)
for window behavior; another window does not create an independent copy of the
project file.

## Write and format text

The writing toolbar contains Undo/Redo, **Text**, **Insert**, **Math**, **Lists**
and **Document**. It stays on one row; less-used groups move into **More** when
space is tight. **Math** keeps its word label. Type `/` on an empty paragraph or
press Ctrl/Cmd+/ to open Insert, then use the arrow keys and Enter to choose an
item.

Use **Text > Formatting** for bold, italic and inline code. The default
inline-code shortcut is Ctrl/Cmd+E. **Text > Paragraph style** contains Paragraph,
the heading levels, Quote and Long quotation, plus Part and Chapter where
supported. **Text > Alignment** contains Left-aligned text and Right-aligned text.
Quote is unavailable inside a list item.

**Numbered headings**, below the heading levels, changes numbering for the current
heading or the next heading selected from ordinary text. Changing heading level
retains that choice; Paragraph and Quote are unaffected. Ctrl/Cmd+Alt+0 selects
Paragraph, and Ctrl/Cmd+Alt+1, 2 or 3 selects the first three heading levels.

Use **Document > Keyboard shortcuts** to open **All writing shortcuts**. Search
or filter its Write, Math and Tables areas to see the effective bindings. The
same dialog owns shortcut editing, custom math actions and the printable
reference. See also [Keyboard shortcuts](./keybindings.md).

### Lists

**Lists** offers Bullet list, Numbered list and No list. Existing description
lists remain editable. The current type is highlighted, and each row shows its shortcut: Ctrl/Cmd+Shift+8
for a bullet list, Ctrl/Cmd+Shift+7 for a numbered list. Where a list cannot
start, such as on a selected figure, the menu says so. Choose a type on an empty
paragraph to start writing, or select paragraphs to turn them into items. With a caret inside a list, changing type affects that
list at its current nesting level; selecting particular items changes only those
items. Choosing the active type leaves it unchanged. No list
keeps the content, including supported equations and description terms.

In bulleted and numbered lists, Enter creates an item; Enter on an empty item
leaves that level. Tab and Shift+Tab indent and outdent. Description lists have
editable term and body fields: Enter in a term moves to its body, Enter in the
body starts another item, and Enter in an empty item returns to ordinary text.
There is no description-list creation item in the current Lists menu; add a new
description environment in Source. Custom source-only lists also remain editable
there.

Nested bulleted and numbered lists remain editable with ordinary enumitem labels
such as `label=\alph*)`, including bold or italic item text. Supported decimal,
alphabetic and Roman labels, `start` and `resume` options keep their source
spelling during content edits. Custom label macros retain exact-source fallback.
The list footer has a **Numbering** menu for the format, starting number and
continuing a previous list. Description lists have an **Items** menu for inserting
or deleting the current item. Common enumitem layout such as `style=nextline`
and literal `leftmargin` settings is reflected in the canvas.

### Title, authors, date and abstract

**Document > Title & authors** offers **Edit title**, **Edit authors** and
**Edit date** when a title block exists. Each item focuses its field on the page.
When no title is shown, **Add a title** is offered where the source supports it;
a title block is never added silently. There is no separate title footer.

Standard `\title`, `\author` and `\date` metadata appears at `\maketitle`.
Edit it directly on paper; fields grow with their text. Clear the author field
to remove its text. The date can be automatic, custom or hidden. Typing in an
automatic date makes it custom; an omitted declaration follows LaTeX's current-date
default, and `\date{}` hides it. Placeholders appear only while the block is active.
Standard report metadata declared inside `document` is also supported.

Abstracts support ordinary paragraphs and inline or display math. **Insert >
Document blocks > Abstract** visits an existing abstract in the open file before
creating another.

<a id="hebrew-and-mixed-language-documents"></a>

### Hebrew, language and paragraph direction

Visual reads the existing English/Hebrew language and font declarations from
Babel or Polyglossia in the document root. Hebrew documents use right-to-left
flow; formulas and source fields retain left-to-right entry. Supported English,
Hebrew, LTR and RTL environments and inline language switches remain editable,
including `\textenglish`, `\texthebrew`, `\LR`, `\RL` and
`\foreignlanguage`. Existing language wrappers survive supported edits.
In Visual, **Text > Direction** offers compact **LTR** and **RTL** controls for
the current paragraph or selected paragraphs. They save explicit `LTR`/`RTL`
environments, preserving inline formatting and math, and support Undo. Existing
language blocks retain their language and font when a paragraph's direction is
overridden. If the root has no bidi support, the first direction action adds
`bidi` and selects XeLaTeX, or adds `luabidi` when LuaLaTeX is already selected.
The document's language and fonts are retained. Controls are disabled in object
fields and unsupported paragraph containers; a separate root must be editable
when its setup needs updating.
Document fonts and standard abstract, contents and caption labels follow the
root's language setup. Custom or unsupported setups remain accessible in Source;
the compiled PDF is authoritative. **Document > Document settings > Language**
changes the main language between English and Hebrew in supported simple setups,
including after you have written in the body. Apply preserves the body and
explicit language passages, updates the root preamble, and can be undone with
the document's Undo command. Existing Hebrew fonts are retained; first enabling
Hebrew uses Times New Roman and selects a Unicode compiler when needed.
Babel and custom language setups show their current language but stay controlled
in Source. Compiler and font configuration can also be edited there. Changing a
document's language does not change the language default for new documents.
Use **Document > Compiler** in Visual, or **More > Compiler** in the other views,
for this document's compiler.

### Find and replace

Click the header search field or press Ctrl/Cmd+F. Type a query to show the
match count and navigation arrows; Enter advances and Escape clears the search.
Visual's **Document > Find and replace** opens the full bar under the writing
toolbar, with Replace and Replace all.

Visual search covers text in the main document editor. It does not search every
visible field: titles, captions, table cells and other nested object fields are
excluded. Use Source search when you need to locate commands or text in those
fields, and check included files separately.

Replace all works backward through one text block at a time, with each block as
its own undo step. It stops if you type, undo, begin composition, close the bar,
receive changed source or reach an edit that cannot be written back. A long
document can take time, and earlier replacements remain applied if the operation
stops. Review the result before continuing.

### The footer and object controls

The footer follows the current editing context. It shows object controls on the
left and your position and estimated word count on the right, for example
“Table · row 3, column 2”, “1,284 words” or “12 of 1,284 words”. Math, code,
comments, commands and reference keys are excluded from the count.

Click inside an object to edit its content on paper and use its footer controls.
Common controls include **Rows & columns**, **Appearance** and **Edit LaTeX**.
Other properties open in a compact panel above the footer. Clicking anywhere in
the footer, including its empty space and word count, retains the active object
and its open options. Click elsewhere, use Close or press Escape to close the
options; closing does not discard unfinished fields. Opening a submenu or symbol
picker retains the object.

Referenceable objects show a compact label field or **Add label**. Enter or blur
commits a valid unique key; invalid or duplicate keys remain drafts, and Escape
cancels unfinished input. A recognized unique label can be renamed with its
recognized references in a single-file document. Renaming across included files
requires coordinated Source edits. Clearing a heading label removes it; heading
numbering stays under **Text > Paragraph style**. Part headings also retain their
numbering and label controls. Quotes have no separate footer.

## Write mathematics

Click a rendered formula to activate its math editor, then wait for the editing
caret before typing, pasting or using an input method. Simple keypresses can be
buffered during preparation, but paste, drop and composition input are not
retained reliably before admission. A stalled editor keeps the readable formula
and offers **Retry**.

Once active, click a symbol to place the caret or drag to select an expression.
Inline and display math share the top Math menu and contextual footer. New
formulas start empty and focus the math cursor. Alt+= inserts inline math;
Ctrl/Cmd+Shift+M or Alt+Shift+= inserts display math. Outside command entry, plain
Enter or Escape returns to text. A paragraph is added after a display only when
needed. Tab and arrows navigate structural slots and return to text at a boundary.
Backspace or Delete in a completely empty equation removes it. Clicking outside
math dismisses its controls. MathLive's separate menu and virtual keyboard are
hidden.

### Insert or change a math structure

Use the **Math** menu to insert or change a structure:

| Option            | Behavior                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Inline math       | Insert math within a sentence, or move the active equation inline.                                          |
| Display math      | Insert math on its own line, or move the active inline formula onto its own line.                           |
| Aligned equations | Start two rows aligned at a relation; an existing formula becomes the first row.                            |
| Brackets          | Choose left/right brackets, matching and size, then Insert to wrap a math selection or start an empty pair. |
| Matrix            | Choose brackets using the compact selector above the table-style size grid, then click a size to insert.    |
| Cases             | Insert a two-row piecewise expression with expression and condition columns.                                |
| Symbols           | Search for symbols or insert fractions, roots, accents, and other structures.                               |

The current inline/display placement has a checkmark. Placement changes retain
existing math; converting inline math to display math retains the surrounding text
as paragraphs. Matrix and symbol pickers change nothing until an item is inserted.
Symbols opens above the footer at the same corner whether opened
from Math or the footer, with no centered dialog. Drag its **Symbols** header to
move it within the editor. Its position is retained while this editor stays open.
With the header focused, arrow keys move it and Home restores the footer position.
Inside math, insertion uses the current math selection/caret. Outside math,
matrices and cases start display math; brackets and symbols start inline math.
**Brackets** opens a compact submenu. **Match** starts on: choosing the left
bracket sets its complementary right bracket, whose dropdown is disabled.
Switch Match off to choose each side independently, including **None** for an
invisible side. **Size** offers Auto, Normal, `\big`, `\Big`, `\bigg`, and `\Bigg`.
Changing these choices does not edit the formula. **Insert** wraps the current
math selection or creates an empty pair at its cursor. Cross-cell selections
must be narrowed to one expression or expanded to the complete matrix.
Inside math, **Text > Formatting** offers bold, italic and monospace; these
apply to selected math or the next characters typed at the caret. Use the same
configured bold, italic and inline-code shortcuts (inline code becomes monospace).
Paragraph styles and alignment remain unavailable in a formula.
Math has no right-click menu; use Text, Math and the contextual footer.
Toolbar Undo/Redo uses the formula's editing history.

Ctrl+Enter (Cmd+Enter on macOS) splits math at the caret: the preceding content
stays on the current row and the following content moves to a new row below.
The caret starts that new row. A single-line formula becomes a two-row `gathered`
layout. In matrices, cases and aligned equations, column positions are retained;
cells to the right of the split also move to the new row. Inside a fraction,
root or other nested body, the split stays within that body. Start/end splits
leave an empty row ready for typing. Imported row labels/tags remain protected.

You can also type a complete `matrix`, `bmatrix`,
`pmatrix`, `vmatrix`, `Vmatrix`, `cases`, or `aligned` environment on an otherwise
empty visual paragraph; Scient converts it only after the matching `\end{...}`
is complete. Unsupported or malformed environments remain ordinary text or
protected source rather than being partially rewritten.

### Formula source, numbering and labels

Inline math shows **Edit LaTeX** directly in the compact footer. When the caret
is inside a matrix, cases or aligned cell, **Rows & columns** appears beside it.
The top **Math** menu provides placement, brackets, matrices, cases and Symbols.

Display math and equations share a compact footer with **Edit LaTeX** and a
**Numbered** toggle. **Label** appears only when numbering is on; its small field
commits on Enter or blur and rejects invalid or duplicate labels. Turning numbering
on converts an ordinary display into an equation; turning it off retains any
existing outer label for later reuse. Existing align/gather blocks keep their row
numbering scope. **Rows & columns** opens its small menu only when the caret is in
a matrix, cases or aligned cell. Fixed column counts, minimum sizes and imported
row metadata restrict its actions. The source editor opens above the footer.
Symbols, brackets and insertion actions stay in the top **Math** menu. Wide formulas
pan with horizontal trackpad gestures or Shift-wheel after clicking into them,
without a scroll bar. Moving the caret follows the part being edited. Selection
highlights stay attached to their contents during vertical and horizontal scrolling.

Supported numbered equations show their number at the right edge. A reference
such as `\eqref{eq:sum}` shows the matching number in parentheses; `\ref` omits
the parentheses. Click a resolved reference to jump to the equation and briefly
highlight it. Its target remains editable in the existing footer. Unnumbered
displays stay unnumbered, and explicit tags and suppressed row numbers are
respected. Standard article/book/report numbering and ordinary
`\numberwithin{equation}{section}` or `{chapter}` update locally as equations
change. Unresolved labels and unsupported custom numbering use a label fallback;
the compiled PDF remains authoritative. Table references also show the derived
caption number and navigate to their labelled table. The label must exist in the
document; an unlabelled nonfloating table does not create a reference target.

Choose **Edit LaTeX** to edit the formula body above the footer. Supported edits
update the equation and document as you type; there are no Apply or Cancel
buttons. Escape or Ctrl/Cmd+Enter returns to the formula. The body editor preserves
outer wrappers and metadata, including protected `\label`, `\tag`, `\notag` and
`\nonumber` commands in imported rows. Row count, placement and row metadata for
such imported structures remain Source operations. Edits crossing an interior
numbering command, nested numbering or commented equations can be refused.
Unknown commands remain literal source; the compiler determines whether they
are defined. A single outer reference label remains editable and survives
numbering changes; it does not prevent editing a nested matrix's rows or columns.

### Symbols and command completion

**Symbols** groups Common, Structures, Labels, Greek, Operators, Sets,
Relations, Arrows, Calculus, Accents, Brackets, Functions, Alphabets, Spacing and
More. Open it from **Math → Symbols** or press **Alt+I, then S**. Returning to
an equation leaves a dismissed Symbols panel closed. The Macros category appears
when the document declares supported math macros. Search accepts names, LaTeX
commands, Unicode and common descriptions.
Tiles are equal squares with minimal mathematical previews; layout-only commands
use small diagrams, and package symbols can use bundled TeX glyph outlines.
Hover or focus a tile to see its command and your effective keyboard shortcuts.
Arrow keys browse the grid; Enter inserts, and Escape returns to the formula.
Recent symbols and starred favorites are saved locally on this device.
A fraction, root, accent, or paired delimiter wraps the selected math; without a
selection, entry slots are blank.

For an annotated brace, select an expression and choose **Underbrace with label**
or **Overbrace with label** in Common or Labels. Fill the empty
slots using Tab to move between them. Choose **Text in math** inside a label to
type ordinary words, such as “terms.” This group also offers annotations above
or below an expression and arrows with labels on both sides. **Boxed expression**
is in Common. Templates insert empty slots, with no sample text to erase.
When extending a selection out of an inner math slot, its enclosing structure
is included first. For example, dragging from an underbrace label into the
surrounding equation selects the brace, expression, and label together. Dragging
within the label selects its text; an ordinary click places the caret.

Plain typing is not expanded into commands. Start a command with `\`.
Autocomplete in Source and Visual shows the insertion template, including
required braces: for example, `\frac{}{}`, `\mathcal{}` or
`\textcolor{color}{text}`. Argument names in previews are hints, not inserted
text. Up/Down chooses an entry; Tab, Enter or a click accepts it. Escape dismisses
the list. The caret starts in the first argument. Source completion includes
text, math, document commands and environments, plus supported macros defined
in that file's preamble. Tab moves through the empty arguments of an accepted
source template.

Completion also works in ordinary Visual paragraphs and editable table text.
Choosing a text format starts typing with that style; choosing a math command
creates inline math at that caret. Heading commands work on an otherwise empty
paragraph. Reference, link and footnote templates keep their arguments available
for typing; Tab moves to the next empty argument, and Tab, Enter or the final
closing brace finishes a supported inline command. Commands requiring a source
layout remain available in Source.

Inside a color argument, completion lists standard colors and literal colors
defined in the document preamble. Xcolor mixtures also offer percentages and
the next color, as in `red!50!blue`. Choosing a color for empty Visual colored
text starts writing in that color. All these lists follow the existing command
completion setting; they do not open Symbols.
Inside Visual math, argument braces are paired while typing a command. Accepting
an argument command such as `\text`, `\textbf`, `\textit`, `\mathbf`, `\mathbb` or `\mathcal` with
Tab or Enter supplies braces and enters an empty editable slot. Choosing a
suggestion does the same. Choosing these formatting commands in Symbols wraps
selected content, or creates an empty slot when nothing is selected. Typing in
`\text{}` uses text mode; `\mathbb{}` and `\mathcal{}` use math mode.
Formatting arguments keep their own editing scope: insertion places a caret
inside, typing retains the chosen font, and arrow movement can cross its
boundary. **Enter formatting** also enters an adjacent math formatting argument;
**Leave parent before/after** returns to the surrounding formula. Repeated Ctrl+A
includes each nested formatting argument before its containing structure.
Existing empty formatting arguments regain their
slots when reopened; placeholder markers never enter saved LaTeX. Type
`\begin{bmat` to choose `bmatrix`; Up/Down select and Tab or Enter accepts. The
matching end and editable cells are inserted together. Existing argument text is
preserved. These completions follow the Math command completion setting.

Type `\` followed by a command name directly in a formula to see local command
suggestions with symbol previews. Up/Down changes the suggestion; Enter or Tab
inserts it and moves into its editable slot when applicable. In-progress command
suggestions remain local until accepted, so ghost completions are not saved into
the document. Clicking a suggestion keeps you inside the formula.

The formula field keeps bare words and punctuation literal. In the formula-code editor, starting a known command
such as `\fra` or an inner environment such as `\begin{bmat` shows bounded
completions; Up/Down chooses an entry and Tab or Enter accepts it. Unknown commands remain literal
source; the TeX compiler determines whether their definitions are available.

### Packages and document macros

The symbol palette is bundled locally and needs no network. Inserting a supported
tool can add its known package requirements in a same-file source edit.
If editing a chapter would also require changing the root preamble, add the
requested declaration in the root's Source view first, then retry. This also
applies to math environments, table styles, equation references, custom shortcuts
and formula-code edits. Color/highlighting adds `xcolor`, cancellation adds
`cancel`, and AMS structures add their math packages.
Menu color names not provided by `xcolor` receive a definition when used.
The root's active `usepackage` and `RequirePackage` declarations are checked,
including comma-separated package lists and known package dependencies. Commented
declarations do not count. Existing declarations and their options are retained; the
packages must be available in the local TeX installation. Bundled TeX outlines
cover many package symbols that the browser math renderer cannot draw. Other unsupported commands retain a source fallback; the compiled
PDF renders them through their package. A preview never substitutes a different
symbol into document source.

Macro definitions belong in Source. Visual reads literal `\DeclareMathOperator`
declarations from the root preamble,
including the starred form, so `\DeclareMathOperator{\rank}{rank}` makes `\rank`
render as an upright operator without changing the command in source. Simple
`\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareRobustCommand`, and
undelimited `\def`/`\gdef` math definitions support required arguments. Macro
calls generally remain single units in the formula. One-argument delimiter
wrappers such as `\newcommand{\norm}[1]{\left\lVert #1\right\rVert}` allow
editing inside the delimiters directly; argument edits retain `\norm{...}` in
source. Changing the delimiters expands that occurrence into ordinary math.
Use Edit LaTeX for arguments of other macro shapes.
Preamble changes update the shared math setup without adding definitions to each
included file. Optional/default arguments, conditional or recursive definitions,
paired-delimiter declarations and commands requiring TeX execution remain
controlled in Source and PDF.

<a id="insert-document-elements"></a>

<a id="configure-objects"></a>

## Insert and edit document objects

The Insert menu keeps the same choices while you work. Math-only insertion belongs
in Math; finish editing a formula before inserting document elements.

| Menu entry                | Behavior                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Figure                    | Choose a project PNG, JPEG or PDF, or import a PNG/JPEG; set an optional caption and width. |
| Table                     | Choose a size from the grid.                                                                |
| Code block / Literal text | Insert a code or verbatim block.                                                            |
| References                | Citation, Cross-reference and Link, followed by Footnote.                                   |
| Theorems & proofs         | Theorem, Lemma, Proposition, Corollary, Claim; Definition, Example, Remark; Proof.          |
| Document blocks           | Abstract, Table of contents, Bibliography; Verse.                                           |
| Page break                | Start a new page.                                                                           |
| Other entries             | Long quotation, Left-aligned text, Right-aligned text and Part.                             |

Pickers retain the captured insertion point. Cancel inserts nothing. If the
document changes while a picker is open, choose the position again; an image
already imported at that point remains a project asset. New headings, cells,
captions and math structures start without example text to erase. Existing text
and explicitly chosen templates retain their content.

### Tables

Common `tabular`, `tabularx`, `tabulary` and `longtable` structures have visual
editors. Click a cell, including its blank space, to edit it. Clicking existing
text keeps normal caret placement and selection. Type directly in cells and use
Tab to move through the grid. At the last cell, Tab adds a row when
structural editing is available; otherwise it leaves the table. The
footer offers **Rows & columns**, **Cells**, **Appearance**, and **Caption**
directly. Rows & columns inserts, deletes and moves rows or columns;
Cells merges or splits cells, retaining supported cell content. Appearance uses standard menus for rules, widths,
headers, column settings, borders and layout. Dimensions and longtable continuation
use compact forms in submenus. Existing source colors are preserved; change color declarations in Source.
Caption adds a caption or focuses the existing caption on the paper. Floating
tables and longtables support caption and label edits independently of grid
restrictions, preserving merged cells, rules and continuation bands. Captioned
tables also show a compact **Label** field, committed on Enter or blur, with
invalid and duplicate keys rejected. Selection stays active while using the
menus. Imported structures retain their edit protections.
Clearing a caption removes its command, table number and reference label. You
can add a caption again, and label fields remain editable after committing.
The footer follows the active cell without changing the table's appearance or the
footer's height. The writing toolbar's **Insert > Table** picker inserts
the chosen size with full grid borders and puts the caret in the first cell.
Every cell edge shows either the table's real border or a faint dashed editing
guide where a border is missing. Guides stay thin with short dashes at every zoom
level. Real borders keep their appearance. Editing
guides are absent from the source and PDF.

Imported captions appear above or below the table in source order and show their
derived table number when supported. Enabling **Header row** makes the first row
bold in Visual as well as the saved LaTeX. An imported header rule alone does not make text bold;
explicit cell formatting is retained. In mixed-width tabularx tables, ordinary
columns fit their contents while flexible X columns take the remaining width and
wrap their text. Visual approximates table and caption spacing; custom package
styles and float placement remain authoritative in PDF.

Imported longtables can separate their initial header, repeated header, page
footer, and final footer using `\endfirsthead`, `\endhead`, `\endfoot`, and
`\endlastfoot`. Visual repeats the continuation header and footer when the data
rows cross its page boundaries. The caption, initial header, and data cells are
editable on the page; continuation definitions remain editable in Source.
For standard document counters, the caption includes `Table 1:` and continuation
text using `\thetable` shares that number. Cell edits retain the existing page
gaps while the updated layout settles.
Simple literal row templates declared in the preamble, such as
`\newcommand{\testrow}[1]{#1 & Synthetic record #1 & Pending\\}`, render as
ordinary cells. Untouched calls remain intact. Editing a generated cell writes
that one call as an explicit row, preserving the template definition and other
calls. Structural changes to these imported tables remain in Source. Exact
break positions and more complex template expansion require the compiled PDF.

Ordinary supported cell, caption and label edits target their corresponding
source ranges. Structural operations deliberately normalize only the supported table's
`tabular` region so that its dimensions, column specification, and rules remain
consistent; surrounding source outside the supported operation is retained. Imported `tabular` tables
with simple `l`, `c`, and `r` columns can also edit plain cell contents inside
literal `\multicolumn` and positive `\multirow{n}{*}` spans. Basic named row colors
such as `\rowcolor{blue!10}`, vertical rules, `\hline` and `\cline` are shown and
preserved. Supported span, rule and grid changes are available in the footer. Unsupported
combinations are disabled; edit table colors and custom structure in Source.
Tab skips covered cells. Selection expands to include complete merged cells.
Unsupported merged-cell splits remain protected; inspect PDF for final
multipage layout. New tables use a package-free grid style. Nonfloating tables stay nonfloating and unnumbered.
Column width and wrapping are separate from alignment. Supported literal grids
retain colors during row/column changes, but color controls are not exposed;
change those declarations in Source. Operations that cannot preserve spans or
custom column modifiers are disabled or report why they are unavailable.

Table placement controls move a caption above or below and convert a supported
ordinary table to a nonfloating multipage table. Longtables offer repeated header
rows and continuation text. Applying a repeated header copies the chosen first
header rows; apply it again after changing their text to refresh the continuation
header. Custom or macro-generated table structures retain their existing editing
limits.

Formatted prose and inline math can share a cell. Place the cell caret and choose
**Math > Inline math**; Text formatting and writing shortcuts also apply there.
Cell edits share document undo, and mixed prose/math cells support the same
rectangle clear and copy actions as ordinary cells. Paragraph or display-math
cells and unsupported nested commands remain Source operations. Actions incompatible with an imported
grid are disabled; edit its custom structure in Source.

<a id="selecting-table-and-math-cells"></a>

#### Select, copy and clear cells

Drag across table cells, Shift+click another cell, or use Shift+Arrow at a cell
boundary to select a rectangular area. Delete or Backspace clears all selected cells;
the table structure stays in place. Ctrl/Cmd+C copies the selected cells as a
LaTeX table fragment, and Ctrl/Cmd+X copies and clears them.

Clicking a table border focuses the active cell. Use the table's keyboard selection to
select the whole table. Ctrl/Cmd+A inside a cell
first selects its text; pressing it again selects the table. Copy then includes
the full table with its caption and settings. Delete, Backspace or Cut removes
a selected whole table. Escape returns to editing a cell.

Cell selections highlight complete cells. Whole-table selections highlight the
table block and its caption together. Dragging from a cell out into surrounding
text switches to document selection: Delete removes the table and any selected
text. Dragging across a table from surrounding text also selects it as a complete
block. Selecting the table does not move the caret into its first cell.

### Figures and panels

Figures use real `figure` and `\includegraphics` source and add `graphicx` when
needed. Imports are saved only after choosing Insert (PNG/JPEG, up to 20 MB).
An empty caption does not add a caption or reference label. PDF images can be
selected but do not have a raster preview in the picker. Deleting a figure does
not delete its image file. Standard image figures show **Replace**, **Appearance**,
**Caption**, and a compact **Label** field for captioned figures directly in the
footer. Replace chooses a project image or imports a PNG/JPEG while preserving
the caption and settings. Appearance groups width, alignment, caption position
and page placement. Caption adds or focuses its text on paper; clearing it
removes the caption command, figure number and label, and both can be added again.
Labels commit on Enter or blur and reject invalid or duplicate keys.
Backspace or Delete in an already-empty caption closes its editing area and
returns focus to the figure; the same behavior returns to a table from its caption.

Imported figures can also display editable framed text, literal rotations, and
side-by-side `subfigure` panels. A one-argument preamble command wrapping a
centered, fixed-height `parbox` in `\fbox` is recognized from its definition;
editing its text keeps the original command call. Panel and figure captions
are editable on paper. **Panel** selects which panel the compact footer controls;
clicking or focusing a panel also chooses it. **Replace** chooses a project image,
**Caption** / **Panel caption** focus existing printed captions, and compact
**Label** fields validate reference keys. Widths, rotation angles, framing and macro definitions
remain in Source. Unsupported artwork stays available as exact source.

For standard figure counters, captions show their number and subcaptions show
their panel letter. `\ref` navigates to labelled figures or panels; `\subref`
navigates to a panel and displays its letter. Custom counter or caption setup
can prevent Visual from deriving a reliable number; the PDF remains authoritative.

### TikZ and pgfplots previews

TikZ pictures and pgfplots can render as read-only drawings in Visual using the
document's LaTeX preamble, including packages, libraries and style definitions.
Preview is off by default: opening Visual or changing source does not execute it.
Choose **Run this drawing preview** only for source you trust. The drawing and
preamble run with host TeX/Lua's filesystem authority in the document's environment;
this is not a sandbox. Admission applies only to this preview's current source,
preamble and document/environment identity. Changing them requires another action;
resizing can rerender the same admitted text. **Run drawing preview again** retries
that admitted text.

Figure captions remain editable on paper, and Source stays editable without
running a preview. Drawing labels, coordinates and plot settings have no Visual
editing controls; change them in Source. Rendering needs a working LaTeX toolchain.
Preview never installs packages, and Tectonic previews use only already-cached
bundle files. If packages are missing, use **Rebuild PDF**
to resolve them before retrying. A drawing that fails to
compile shows a diagnostic instead of silently disappearing, and its original
source is preserved. Artwork previews are not published document PDFs and do not
establish whether the saved document's PDF is current.

### Theorems, proofs and custom environments

Block insertion preserves the surrounding text. Selecting ordinary prose before
choosing a theorem wraps that selection; with a caret inside an existing theorem,
a new theorem is inserted after it. Unsupported selections ask you to use ordinary
text or Source. Edit statement prose, math and references on paper, with title and
structural options in the footer. Missing standard statement declarations are
added using the existing source adapter; custom definitions remain in Source.

Theorem bodies use the same root macro setup, including commands such as `\R`
and `\norm{x}`. Literal `\newtheorem` declarations supply statement names,
shared counters and section/chapter numbering. The standard `plain`, `definition`
and `remark` theorem styles control prose and heading styling. Statement labels
stay out of printed prose. The compact statement footer shows its type, **Title**,
and **Label**. Type uses definitions already present in the document. Label
supports adding, changing and removing a key; recognized references are updated
when renaming a unique label in a single-file document. Resolved `\ref` links
show the statement number and navigate to it.
Statement and proof headings share the first line with their prose. Default
amsthm proofs show the end-of-proof square at the line's logical end (right in
LTR, left in RTL); it is display-only and
is never added to your source. Custom proof/QED definitions remain source-owned.
The optional proof title replaces “Proof”, while optional theorem titles appear
in parentheses. Spacing and quote indentation follow the standard layout.
**Title** activates editing at the beginning of that printed heading on the paper.
Clicking the printed title instead places the caret where you click. The footer
keeps the statement context when returning from another app or removing its title.
Clearing its
text removes the optional title; another Backspace or Delete in an empty title
returns the caret to the statement body. Proofs show only **Title** in their footer.
Simple zero-argument `\newenvironment` quote wrappers, such as a `note` containing
`\begin{quote}\textbf{Note.}` and ending with `\end{quote}`, render editable
content while preserving the custom environment name. More complex definitions
retain exact-source editing and compiler rendering in PDF.

Grouped legacy math-font commands such as `K_{\rm LQR}` remain usable in
supported statement bodies. References in proof headings can navigate to their
targets. Some rich objects whose content depends on root-only declarations can display
correctly yet refuse a contextual operation. Use Source when that operation
cannot preserve the object's setup.

### Code and literal text

Inline `\verb` text and `verbatim` blocks are editable directly on the page.
Their contents remain literal: commands, percent signs and braces are printed,
without creating headings, equations or comments. Code edits preserve the
surrounding LaTeX delimiters.

`lstlisting` code and plain captions are also editable on the page. Visual reads
supported root-preamble `\lstset` settings and local listing options for language,
font size, syntax colors, frames, wrapping and line numbers. Captions appear as
**Listing 1: …** above or below the code according to `captionpos`. Highlighting
uses the editor's existing language parsers; no external highlighter is launched.
Unsupported listing styles retain exact-source fallback. Visual approximates
the listing layout; the compiled PDF remains authoritative.

The code footer shows **Language**, **Appearance**, **Caption**, and a compact
**Label** for captioned listings. Language has search and retains the imported
language. Appearance groups frames, wrapping, font size, tab width, line numbering
and caption position. Its switches match heading numbering. Caption adds or
focuses editing on paper; clearing it removes the listing number and label, and
another Backspace/Delete in the empty caption returns to the code. Labels use
the shared duplicate checks and single-file reference renaming; references navigate
to the listing. Literal `verbatim` blocks remain editable without listing controls.

### Algorithms

Standard `algorithm` / `algpseudocode` blocks show their caption, line numbers,
indentation, keywords and comments. Edit prose, formulas, comments and captions
directly on paper. Press Enter in a step, or use **Steps → Insert** in the footer,
to add a step, return, input/output, condition or loop. Insert creates new content;
Wrap encloses existing steps. Steps also groups comments, branches, movement and
Delete step; opening and closing lines stay paired. Backspace or Delete on an empty
opening or closing line removes its wrapper while retaining the contents, including
conditions and comments. Appearance contains a Line numbers toggle and placement.
Turning line numbers on numbers every line. Caption focuses its text
on paper; clearing it removes the algorithm number and reference label, and
another delete in the empty field returns the caret to the body. Captioned floats
show a compact Label field with duplicate checking and single-file reference
renaming. Existing algorithm references navigate to the numbered float.
Standalone `algorithmic` blocks show Steps and Appearance with line-number settings,
without float placement, captions or labels. Unsupported pseudocode remains available in Source.

Algorithms can retain a size declaration such as `\small` before their steps.

### Colored text and boxes

Colored text and inline color boxes are editable on paper, including literal
custom colors and percentage mixtures. Supported `tcolorbox` blocks show their
colored title, frame and background with editable prose, math, lists and tables inside.
Plain `\fbox` phrases, local `\fboxsep`/`\fboxrule` groups and framed paragraph
boxes are also editable. Literal styles include square or rounded corners, shadows,
dashed frames, a left accent strip, and separate upper/lower regions. Framed
`tcblisting` blocks using `listings` show editable code with syntax colors and line
numbers. Visual approximates these decorations; the compiled PDF remains authoritative.
Visual approximates breaks inside supported breakable boxes. The compiler decides
the final breaks and continuation borders shown in PDF.

The box footer shows **Appearance** and **Title**. Appearance groups background,
border color and thickness, square/rounded corners, padding and **Allow page breaks**.
Corners and Padding use choice lists; **Custom** opens their exact dimension fields.
Title adds or focuses the title on paper. Clearing the title removes its source
option; another Backspace/Delete in the empty field returns to the box body.
Click an existing title to edit at that position. Imported title and color settings
stay intact when changing another property.

<a id="compact-layout-controls"></a>

### Columns and minipages

`multicols` regions render editable text in the requested columns, including
explicit `\columnbreak` commands; their footnotes appear beneath the region. Supported `minipage` widths
and top/center/bottom alignment are reflected on the page; adjacent minipages
joined by `\hfill`, literal `\hspace`, or ordinary spaces stay side by side.
Comment joins preserve zero spacing, and blank lines start a separate row.
Nested panels use the available local width. Literal fixed heights and their
independent inner alignment are supported. Edits retain these environments,
dimensions and separators. Root-preamble `\columnsep` and `\columnseprule`
settings control the column gaps and dividers. Headings inside panels and
columns share the document's numbering and heading styles.
An inline `\columnbreak` keeps the surrounding text in one paragraph and breaks
after its rendered line, without adding a new paragraph indentation.
To start the next paragraph at the top of the next column, end the preceding
paragraph before the command, using `\par\columnbreak` or a blank line before
`\columnbreak`. A single source newline does not end a LaTeX paragraph.
Visual preserves that distinction, including the equivalent forced form
`\columnbreak[4]`; it does not insert paragraph breaks to change PDF behavior.
Full-width prose resumes after a column region. `\noindent`, `\par` and the
three standard skip commands affect layout without printing their source.

Columns have a **Columns** count menu. Individual minipages expose **Appearance**
with Dimensions, Alignment and Content alignment; fixed height enables content
alignment. Side-by-side panel rows expose **Layout** with width ratios and spacing.
Spacing edits preserve panel widths; width edits preserve their original gaps.
Imported mixed width units stay editable per panel instead of guessing ratios.

### Repeated document content

Visual can display a simple document-level counter loop with up to 100 iterations,
including literal paragraph macros, generated headings and equations. Explicit
page breaks and contents links behave like ordinary document content.

Opening the file keeps its loop and macro definitions unchanged. Editing generated
content expands the loop into ordinary LaTeX so each occurrence can be edited
independently. More complex TeX programs remain available in Source.

For a supported document-level loop, the footer reports when an edit converts
it to ordinary LaTeX. Color-box loops use a separate conversion path: the notice
can be absent, and editing a generated occurrence can remove a counter declaration
that later source still uses. Keep those loops in Source when the counter or
loop is used elsewhere, or explicitly expand them there before editing. Check
the changed source and rebuild after converting generated content.

## Citations, references and footnotes

### Insert citations and manage bibliography entries

Citation search reads literal title, author, year and key fields from linked local
`.bib` files, plus inline `\bibitem` entries. It does not resolve BibTeX string
macros. Parenthetical and in-sentence forms are offered when natbib or biblatex is
configured. A known citation key or reference label can also be entered directly.
The compiler determines final citation text and reference numbers.

For a standard manual `thebibliography`, Visual displays a References heading
and bracketed entry labels, preserving supported emphasis and punctuation.
Ordinary `\cite` commands display linked labels, including multiple keys and a
plain optional note. Click a citation number to visit its entry. Citation keys
remain editable through the footer's **References** menu; search to add entries,
reorder them, or remove a key from a multi-entry citation. **Form** offers styles
supported by the document's packages; **Note** edits a plain prefix/page note.
Cross-references have a searchable **Target** menu. Package-specific citation styles
remain compiler-owned. Bibliographies have no separate footer.
Open **Document > References** to search, add, edit and remove entries in a side
panel. It reads the first 24 explicitly linked `.bib` files and existing `\bibitem` lists;
use Source for bibliography files beyond that panel limit. These files remain
part of the compiler's project when its bibliography setup includes them.
Choose a destination when the document uses more than one. The panel preserves the
document's bibliography packages, resources, style and printed-list commands.
BibTeX entries offer title, author, year and additional fields, plus Entry source
for expressions and custom fields. Manual entries offer their formatted LaTeX
text and optional custom label. Existing bibliography entry keys stay fixed to preserve citations;
new entries let you choose a unique key. Save applies the entry, while Cancel
discards its form draft. Close hides the panel and retains the draft during the
app session; reopen References to resume it. A save already in progress continues
while the panel is closed. Switching entries asks you to finish a dirty draft
first. Removal asks for confirmation because existing citations keep
their keys and become unresolved. The last manual entry can be removed without
changing the document's bibliography approach.

Clicking a citation exposes its known entry details and **Edit reference** (or
**Find reference**) in the contextual footer. **Manage references** in a citation's
References menu opens the same panel. The bibliography itself has no footer
controls; its paper view keeps formatted entries without code or
editing controls. **Insert > References > Citation** still inserts a citation at the captured
caret; **Insert > References > Cross-reference** chooses a labelled object and uses `\ref`
or `\eqref` by default. Bibliography management does not insert a citation.

Reference saves preserve unrelated entries, unknown fields and literal TeX
formatting. Unrelated document edits can be merged while the entry itself remains
unchanged; conflicting edits retain the form draft instead of overwriting it.
An entry draft stays bound to the bibliography where it was opened. If that
destination is removed from the document, restore it or cancel the retained draft;
saving cannot redirect the entry to another file. Duplicate copies of the entry's
citation key must be repaired in Source before saving that entry.
Linked `.bib` files use the same per-file session and revision checks whether edited in References or in their own Source tab. The entry form clears only after the owning file session reports the submitted
entry (with the same key and text, allowing different line endings) or confirms
its removal. This includes manual `\bibitem` edits. Failed, refused or superseded
saves keep the form draft and show the save notice; keep the document open and
resolve the save there.
Read-only or truncated files remain read-only. Entry form drafts survive moving
between file views during the app session. Linked `.bib` source and reference form
drafts have no recovery offer after an app restart.

**Insert > Document blocks > Bibliography** finds an existing bibliography, uses linked biblatex
resources, or asks you to choose a BibTeX file/style or manual entries. It preserves
an existing bibliography style. File paths are relative to the root document;
file/style availability and the final bibliography are resolved during compilation.
Abstract and Table of contents select an existing block in the open file instead
of adding another one.

For BibTeX documents, a successful PDF build supplies the printed bibliography
and citation numbers in Visual. Use Document > References to edit the original
`.bib` entries, then rebuild the PDF to refresh the bibliography. No generated
`.bbl` file needs to be copied into the project. Older builds need one rebuild
to supply this presentation data. Visual does not run BibTeX itself.

The Scient Library is a separate reference library; adding a source there does
not by itself create a manuscript citation or synchronize an existing `.bib` file.
Use the document's References panel or edit its bibliography source for this
workflow. See [Library](./sources.md).

### Links and document references

Links use `\href` and the document's hyperlink setup. Click an existing link to
edit its plain label on paper. **Text** activates the same editor, and **Address**
opens a compact field with Apply; incomplete addresses remain local drafts. Formatted labels keep their LaTeX and are edited in Source. Imported `\hyperref[label]{text}` and
`\hyperlink{name}{text}` navigate to a labelled section or other supported target,
including a literal `\hypertarget{name}{text}`. Section references display their
number, and `\pageref` displays the target's page in the last matching PDF
build, or the label in brackets without one. These commands retain their source syntax during supported edits. Links read as ordinary document text.

### Footnotes

Standard footnotes show a numbered superscript, and Visual places their notes
beneath a short rule at the foot of the containing page or column. Click the superscript to
navigate to its note; click the note to return to its marker. Either action
makes **Edit text** available in the footer. It opens an editor beside the marker
for supported prose, formatting, inline math and references without shifting the
paragraph. Enter or Escape finishes editing and returns to surrounding text.
Unsupported note bodies remain editable in Source. Prose formatting such
as emphasis is shown in the note. Custom counters and unsupported note bodies
remain approximate or show source fallback; PDF pagination remains authoritative.

Visual does not split an oversized note across pages like TeX. For long notes,
minipage-specific notes or custom counters, inspect the compiled PDF and edit the
source when the Visual layout cannot represent it.

## Document settings and page layout

Choose **Document > Document settings** for document type, text size, paper,
language, orientation, margins and paragraph style. Margins offer Narrow, Normal,
Wide or Custom values for each side. Layout groups also expose
columns, line/paragraph spacing, custom paper dimensions, binding and mirrored
margins, supported fonts and engine, heading/title defaults and simple running
headers and footers. Custom executable definitions stay in Source.

Each setting starts from the document's current setup. **Apply** writes only
changed settings; **Cancel** discards the draft. Blank custom margin fields retain
the current source. Existing package options are retained and packages are never
removed automatically. Custom classes retain their declarations. **Open in Source**
opens the root setup. If source changes while the settings are open, close and
reopen the card before applying. In an included file, settings update the root;
finish that save before building or exporting.

Visual uses browser layout and bundled math fonts. It reads supported class,
paper, base-font, geometry, paragraph indentation/spacing and line-spacing
settings, including common `\geometry{...}` overrides, landscape paper and
`setspace` commands. The sheets approximate paper size and margins. They do not
reproduce arbitrary class/package execution, TeX's line breaking or float placement.
Check an orientation change in PDF if the existing Visual pane does not reflect
it immediately.

The canvas presents standard `twocolumn` flow, full-width titles, separate
balanced `multicols` regions, explicit breaks, page footnotes and longtable
continuation bands. Simple running headers/footers can show supported page and
heading fields. Root-level `\vfill` stretches remaining Visual page space before
the next authored break. None of these page decorations changes saved source or
adds page markup to undo history.

`\newpage` and `\clearpage` both appear as Visual breaks, although TeX distinguishes
them, particularly around floats and columns. Changes between one and two columns,
large notes and content taller than a page may not fit the browser layout like
TeX. After deleting content, a heading can also stay on an extra Visual page until
repagination. Use PDF for final page/column breaks, balancing and continuation
borders.

Visual derives standard heading, equation, figure, table and statement numbers
from source. Article/book/report classes, ordinary section/chapter resets and
lettered appendix chapters have supported presentations. Custom counter code and
some class/package definitions cannot be reconciled fully. Treat these numbers
as writing aids; the compiled PDF remains authoritative.

`\tableofcontents`, lists of figures/tables and supported `\addcontentsline`
entries provide clickable navigation. Their titles update with edits, and their
page numbers follow Visual's own pages. A plain `\addcontentsline{toc}{section}{...}`
adds an unnumbered Contents entry without printing its command or creating a
heading. PDF-based `\pageref` needs matching build evidence and falls back to its
label without it.

<a id="edit-latex-source"></a>

## Edit Source and work with unsupported content

Source and the left side of Split use the same file editor as other source files
in Scient. Edit the `.tex` file directly there. Its contents are shared with
Visual; selecting another view does not create another document. In Split with
PDF selected, double-click a source line to locate it in the compiled PDF.

Supported edits try to retain the original commands, include boundaries and
unchanged source. Custom heading macros, formatting groups, paragraph boxes and
supported float contents can retain their wrappers. This is a bounded LaTeX
editor, not a complete interpreter or a guarantee of byte-for-byte preservation
for every operation. Editing a range containing comments can move the comments
within that range; deleting whitespace after an unknown control word can also
change its TeX meaning. Check Source after edits around custom commands, comments
or generated material.

Visual can keep unsupported nested content as source while leaving separable
surrounding text editable. Unsupported structures appear as protected source
blocks. A document selection cannot delete across a protected preview/source
block or an included-file boundary; use the owning Source file for that change.
Protection applies to those specific regions, not every possible unsupported
TeX program.

Click a source-only block to edit its source in place. **Apply LaTeX** and
**Cancel** appear inside it; Ctrl/Cmd+Enter applies and Escape cancels. Apply
checks whether the document changed underneath the draft. **Delete** in the
block header explicitly removes the block and any open draft, with document
undo. Resize its field down to one line when needed; longer text remains
scrollable. **Source** opens the owning file. These blocks have no object footer.

Edits that cannot be written back remain local and are marked unsaved. Resolve
that state before building, exporting or leaving the document. Block insertion
and deletion normalize edited separators toward a single blank source line;
this does not establish exact restoration of source trivia through every typing
and undo sequence.

## Save and recover writing

Source and Visual use the same per-file document session and save queue, including
a chapter also open in another tab. Source updates from object/math fields are
coalesced while typing and finished when leaving the field. Ctrl/Cmd+S requests
an immediate save and, according to the compilation preference, a PDF build.
Changing views does not create a separate saved document. Accepted source edits
autosave. A failed save retries automatically; choosing Save requests another
attempt without waiting for the retry delay. You can continue writing while an
ordinary save retries. Visible text is not proof that it has reached the file.

The shared save notice explains a lasting failure and offers **Save a copy**.
It copies the accepted source; preserve any refused or unfinished field text
separately. Use it while the original save problem is unresolved.
**File status** in the file toolbar points you to that notice for its options.
The file's version menu opens file history: saves keep copies of replaced content,
and a rename carries that history along. History is not every keystroke or an
independent backup; review a version before relying on it.

If the file changes outside Scient while you have unsaved edits, Scient's
ordinary save keeps your current accepted text and preserves the displaced
version in file history. A document with no unsaved edits adopts the new file.
**Use the other version** offers the displaced alternative. LaTeX does not use
Markdown's automatic block merge. This automatic choice is separate from
Overleaf sync, where conflicts stop for an explicit decision.

If the current file was deleted while the editor held unsaved text, the notice
can offer **Save it again** to recreate it. Check the intended folder before
choosing that action. A failed recreation leaves the text in the editor.

If a Visual edit cannot synchronize to LaTeX, its notice can offer **Open Source**,
**Keep draft** and **Discard draft**. Try correcting the edit or Undo while the
input remains available. Keep draft leaves the local writing in place; it does
not replace or save the file. Discard draft removes that unresolved Visual work,
returns to the accepted source snapshot and resets the affected Visual history.
Copy any text you need before discarding. These choices are separate from the
startup recovery actions below. Continuing to type during a disk-save failure
does not make unconverted or refused Visual input valid LaTeX. Pending fields,
recovery decisions and unavailable recovery storage can still prevent complete
source preparation for a build or export. Read-only and truncated files cannot
be edited or used to establish a complete current document.

Recovery is a second copy of some unfinished work, not a replacement for a
successful file save or a project backup. Journaled LaTeX source and Visual input
can be offered in the footer when reopening a document. **Compare** shows the
recovered copy beside the file; **Use recovered** replaces it only after that
comparison. **Discard** removes the recovered copy. In a narrow footer, use the
unsaved-work button to open the same comparison. When the recovered source can be
parked safely, you can keep writing while the offer remains. Other recovery
states pause editing until you use or discard it.

For a document assembled from several files, recovery offers comparison and Copy;
it cannot apply the recovered assembled document to all files automatically.
Source and Split provide recovery for the individual file being edited. Linked
`.bib` source and References form drafts have no ordinary recovery offer after an
app restart.

If a recovered copy cannot be stored safely, keep the document open and use Copy
before deciding what to use or discard. Closing can lose that unstored copy.
Unapplied source-block text is recovered separately, including incomplete LaTeX:
**View** and **Copy** retrieve it without replacing a whole document. Cancel
removes only unapplied text from that interaction. After Apply accepts a block
edit, its recovery copy is retained until the accepted source has a journal
checkpoint. If that checkpoint fails, the source field becomes read-only; Apply,
Cancel or Escape retries the checkpoint without applying the edit twice.

Quitting the desktop app does not wait for these document-saving checks. Finish
save and recovery notices, wait for pending field input to be accepted, and
preserve unresolved work before quitting. The newest text may not yet have a
committed recovery copy. File/view departure guards do not guarantee that every
app exit finishes saving.

## Work with a multi-file document

<a id="choose-the-root-document"></a>

### Choose the root

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
`main.tex` when you request Rebuild PDF. If no root can be found, open the main
document or add the comment; Scient leaves the fragment unbuilt rather than
compiling the wrong file.

<a id="editing-included-chapters"></a>

### Edit included chapters

Visual shows the assembled document from the same resolved root as PDF, even when
Source is showing a chapter. Literal `\input`, `\include`, `\subfile`, `\import`
and `\subimport` references are expanded in order, including nested files.
Literal top-level `\includeonly` is supported and `\include` retains its page breaks. Edits save
back to the file that owns the content; the original include commands stay intact.

Visual uses the selected root document for page settings and image paths. If a
supported insertion would need to change both a chapter and the root preamble,
Scient asks you to add the missing package or theorem declaration in Source first,
then retry; neither file is changed by the refused insertion. Each file has its own
revision check; save conflicts are reported, and build/export wait for pending
file saves. Switching views keeps those saves active. A selection spanning multiple
source files must be edited one file at a time.

Detected missing files, cycles and unsupported includes can block Visual with an
explanation. Arbitrary custom macros and packages loaded through external
class/style files are not expanded by the visual editor.

Visual's include scanner is independent from TeX execution. Some inactive
`\includeonly`, document-ending commands inside conditionals and commands inside
`filecontents` bodies can be misread: content may be omitted from Visual or a
literal file-writing example can be mistaken for a dependency. The saved source
is not necessarily truncated when the canvas is. For these projects, use Source
and inspect the compiled PDF; do not infer that content is absent from the file
because it is absent from Visual. The same scanner participates in save/build/export preparation, so a spurious
dependency can also prevent those actions. Inspect the literal content in Source;
simplifying that construct or compiling outside this workflow may be necessary.
Very deeply nested groups can also prevent Visual from opening even in a small file.

<a id="selection-and-editing-scope"></a>

<a id="empty-elements-and-editing-guides"></a>

## Select text, structures and document content

While editing a description list or other structured block, empty fields
show small, faint gray corner markers. Math slots show the same corner markers
within the nearest structure being edited, including nested cases and matrices.
An empty slot keeps the same marker size and position when you enter it; the math
caret appears in its center. Selected empty matrix cells retain their markers,
with the highlight inside each marker. Selecting the enclosing environment uses
the whole expression's highlight. Ordinary table cells show dashed guides for missing borders,
alongside any existing printed rules. Slot markers appear only for math inside a cell.
Markers disappear when editing leaves the environment; opening a menu retains
them, and hovering alone does not show them.
Only the innermost occupied slot is marked; ordinary empty paragraphs have no guide boxes. Click a blank
cell or use the existing keyboard navigation to enter content. Click targets and
document layout stay the same when guides appear or disappear.

These guides are editor decorations. They are not added to LaTeX, copied content,
or the compiled PDF, and do not alter printed table borders. Caption areas stay
available for editing without adding a caption command until you enter text.

Gray corner marks show only the innermost editing slot. Occupied-slot marks
disappear when content is selected; empty math markers remain visible during cell
selection. The caret follows the local text color and size; inside accent bodies
such as `\hat{...}` it is slightly shorter, without moving the expression.
Empty markers are centered on the caret's insertion point; clicking the marker
enters that exact slot without shifting the caret to a separate box position.
Text, math and selected cells use the same blue highlight. Only the active editing
surface paints selection; whole-table selection highlights its cells and caption
without a blue band across the page or a darker second layer over its cells.
Selection stays visible with a muted fill
while you use menus and submenus. Menu commands apply to the retained selection.
The editing caret pauses during menu use. Escape from the root menu returns to
the original editor.

In math, whole-cell and partial selections follow content bounds, including
brackets, scripts and annotations. Selecting equation rows highlights each row's expression and
leaves the spacing between rows clear; a trailing comma does not switch to a
different kind of highlight. Double-click selects a grid cell, and a third click
selects its enclosing grid. Shift-click extends the current selection.
Shift+Arrow uses the same math selection rules as dragging. You can continue a
drag with Shift+Arrow, or continue keyboard selection with Shift-click and drag,
without changing its original anchor. Reversing direction shrinks the same range;
menus retain it and its continuation point.

Arrow keys move through text. In math, Tab and Shift+Tab visit
structural slots, including empty matrix cells. Repeated Up/Down movements retain
the cursor's horizontal position. Drag within a slot to select characters, or
across matrix/table cells to select a rectangle, including empty cells.

| Action                                   | Default shortcut      |
| ---------------------------------------- | --------------------- |
| Select current scope, then each parent   | Ctrl+A repeatedly     |
| Expand selection to the enclosing scope  | Alt+Shift+Up          |
| Restore the previous smaller selection   | Alt+Shift+Down        |
| Enter formatting at the caret            | Ctrl+Alt+Down         |
| Leave the nearest parent before/after it | Ctrl+Alt+Left / Right |

Use Cmd instead of Ctrl on macOS. The bindings are configurable in Keyboard shortcuts. Leaving a formatting scope changes subsequent typing without changing
existing characters; surrounding styles stay active. At either end of colored
or formatted text, Ctrl+Alt+Down enters that span without moving the caret, so
typing extends it. Ctrl+Alt+Left/Right leaves before/after the active scope, so
typing uses the surrounding style. At a boundary shared by two spans, entering
returns to the span just left; otherwise it prefers the following span. Repeated
entry visits nested formatting from outer to inner. Menu use retains the chosen
typing style as well as the selection.

Repeated Ctrl+A starts with the innermost scope and climbs through every parent.
For `\underbrace{1+\cdots+1}_{n\ \textbf{times}}`, this selects bold text,
the label, the whole underbrace, then the equation and enclosing content. Opening
menus preserves both the selection and this sequence. Clicking, moving the caret
or typing starts again from the current scope.

At the outermost scope, Ctrl+A selects the entire document, including formulas,
tables, figures and captions, title fields, code and source-only blocks. Repeating
Ctrl+A keeps that selection. Selection across different blocks uses the same
highlight in editing and reading previews; page gaps remain clear. Dragging into
a block includes it, and dragging from a figure or source block into surrounding
text continues as a document selection. Open source fields also expand through
their block to the document. Menus retain the complete range.

Selecting across the closing bracket and exponent of `\left(x\right)^2` includes
the complete `(x)^2`. Extending selection out of its base into surrounding math
also includes the exponent; bases and their superscripts/subscripts share one
outer selection boundary. Selection inside the body or exponent stays precise.
Selecting a complete norm such as `\left\lVert y\right\rVert^2` highlights and
edits the exponent too. Selecting only `y` inside the norm leaves its exponent
outside the selection.
A complete underbrace
has one connected blue selection across its body, brace and label. Selecting only
the label or its bold text highlights just that part.

In math, Delete or Backspace clears every cell in a rectangular selection without
removing rows or columns. In an empty cell, deleting removes the nearest math
wrapper and keeps its other contents; matrix contents continue in row order.

### Ask in chat about selected content

Select supported text, math or table-cell content in Visual, then choose **Ask in
chat**. Scient adds a quotation chip to the message you are composing; review it,
add your question and send when ready. Use a shorter passage if a large selection
cannot be quoted. This action does not send a message or
save the document by itself. It is separate from a bibliography citation,
a source in the Library and a persistent document annotation.

A Visual quote records the owning source file and document root, with context
from the current accepted source. Accepted work that is not yet saved can be
quoted as a draft. Finish pending field input first: an unpublished field,
composition, stale projection or selection spanning different source files
cannot supply the same verified capture. Quote each file separately, and select
again if the source or selection changes. A nested math or cell quote retains
its selected content while anchoring to the containing source block.

In the same workspace, clicking a Visual quote chip reopens Split and tries to
verify the passage before highlighting it. If it cannot verify the anchor, it falls back to the
recorded source line with a notice. A Source quote captures the selected LaTeX
syntax and reopens Source, retaining the root context for an included file. If the thread has moved to a
different workspace, Scient instead opens the captured original file read-only
with a notice; it does not select a similarly named file in the new workspace.
Selecting text in the compiled PDF uses the PDF quotation workflow and its page
anchor; see [Ask in chat about a PDF passage](./pdf-reader.md#ask-in-chat-about-a-passage).
A PDF quote refers to that PDF's content, even when newer source needs rebuilding.

### Spelling suggestions

Editable Visual prose can use the host's spelling suggestions. On desktop,
right-click a marked word for available corrections. Suggestions depend on the
platform, installed dictionaries and field; technical source fields and formulas
do not have the same spelling behavior. These suggestions do not check grammar,
mathematical meaning or scientific accuracy. Browser spelling also depends on
the browser. See [Content direction](./content-direction.md) for mixed-language
writing and [Keyboard shortcuts](./keybindings.md) for focused-field shortcuts.

## Overleaf

A LaTeX document in a folder linked to Overleaf shows an **Overleaf** chip beside
its save status. **Sync now** brings collaborators' changes in and sends yours.
Sync first asks the open editors in the linked folder to commit supported input
and save. Active composition, unconverted input or a failed save can stop that
preparation. Overleaf conflicts require a decision; ordinary local-save conflict
handling does not authorize sync to overwrite a collaborator's changes.

While this file has Overleaf conflict marks, the build status explains how many
conflicts need settling. See [Overleaf](./overleaf.md) for linking, syncing and
conflict resolution.

## Build and review

Choose **Rebuild PDF** to build after the current source has been saved. When a
build can be cancelled, that header action becomes **Cancel**. It requests
cancellation; it does not delete the last successful PDF or promise an immediate
stop.
**Settings → Documents → LaTeX → PDF compilation** offers **Auto-compile**, **On save**,
and **Manual**. Auto-compile waits two seconds after source changes settle, including
edits in included files, and waits for a running build to finish before requesting
the latest source. On save is the default: Ctrl/Cmd+S saves and rebuilds from any
view, and opening a stale PDF requests a build. Manual saves without compiling
until you choose Rebuild. These preferences are remembered on this device.
Before building, Scient asks
open document fields to finish and waits for the root and included files to save,
even if you have only used Source. Unresolved field input, save errors or conflicts
must be resolved first. Preparation refuses while linked bibliography changes
are unsaved; save them in References or their Source tab before continuing.
Preparation does not save those bibliography files. The last successful PDF stays
readable while building.
A failed unchanged revision is not retried automatically; change the source or
choose Rebuild. Compile errors leave the last successful PDF readable.

Open build errors and warnings from their counts in the header, or from
**Build failed · View details**; each one shows
the file and line it came from when the compiler reported one. Click a message
that names a project file to open that file at the reported line.

You can also ask an agent to create or edit a project LaTeX document and build
it as a PDF. When the connected provider supports Scient's document tools, the
agent can use the server's LaTeX toolchain, save the requested PDF inside
the project, and open the compiled document in Split view. Save pending editor
work first: an agent build reads saved files and cannot finish input in your editor.
A successful build proves that the PDF compiled; ask the agent to inspect the
rendered pages when
visual quality matters.

Visual and PDF preview keep build messages closed until you select the warning
or error badge in the header. This includes the shell-escape-disabled notice.
The messages open as a card over the document and do not move it. Select the
badge again, press Escape, or click anywhere else to close the card.

Build status and freshness checks use recorded dependency evidence. They have
limits: an outside rewrite that retains both size and modification time can
escape a warm check, and a truncated dependency record cannot establish that
all child files are unchanged. If another program changes project files or
freshness is uncertain, request **Rebuild PDF** explicitly before reviewing or
sharing the output. A successful build establishes compilation of the files that
were read, not visual identity between PDF and Visual.

### Save a PDF copy

Choose **Document > Export > PDF** in Visual or **More > Export > PDF** in the
other views. The file-header download action offers the same export. Export first
finishes pending document input and saves, then rechecks the build; update the PDF
if the action is unavailable or asks for a rebuild. Export does not turn an old
PDF into a current one.

Check that the intended destination contains the copied PDF before sharing it.
Some copy failures returned by the destination layer do not currently produce a
LaTeX export error, so a closed export action alone is not proof of delivery.

## Export to Word

Save the source, choose the document root in the LaTeX toolbar if Scient has not
found one, then select **Document > Export > Word** in Visual, or
**More > Export > Word** in the other views.
Word export waits for the same document saves and field completion as Rebuild
PDF. Scient converts the selected LaTeX
document to a `.docx` file; the first export offers to install Pandoc if it is
not yet available. The export follows literal `\input`, `\include`, `\subfile`
and `\subfileinclude` references from the root. Word resolves these paths from
the root file's folder, and they may point anywhere inside the same project: for example,
`paper/main.tex` can include `../shared/methods.tex`. Projects relying on
subfile-relative paths may need adjustment for this conversion. Local bibliography files
and common image formats are included the same way; supported figure width and
height settings are carried into the conversion.

Files outside the project folder, including links that lead outside it, are
excluded from this conversion. Omitted includes and figures use visible
placeholders marked “outside the project folder”; omitted bibliographies produce
conversion notes. If Scient detects that source changed during preparation,
export stops and asks you to try again. These checks do not establish one atomic
snapshot against every possible outside edit; avoid concurrent edits during
export. On Windows, Word export is currently limited to a
single-file document open in the editor, without includes, figures or
bibliographies; Scient explains when a document needs more. Missing or computed includes and figures also become visible
placeholders. PDF and EPS figures are not rasterized for Word. Equation
numbering, references, layout commands, and some custom macros may change
during conversion; review the saved Word document before sharing it.

Export has resource limits. The LaTeX source budget is 20 MB, with at most 256
source files and 16 levels of include nesting. Bibliography capture is limited
to 16 files and 4 MB in total; figures over 25 MB are omitted. An omitted include
or image is replaced where supported by a visible placeholder, while bibliography
omissions appear in conversion notes. Review those notes as well as the Word
content. Word conversion has a different include reader from Visual; a project
that opens visually is not proof that every construct converts.

<a id="move-between-source-and-pdf"></a>

## Move between Source, Visual and PDF

While Split is showing the PDF, double-click a word in Source to reveal its
compiled PDF position. Double-click a word in the PDF to reveal the corresponding
source line. Both gestures keep normal word selection; Source-only and PDF-only
views do not switch layout automatically. Visual double-clicks in Split also keep
normal selection while revealing source; a standalone Visual view stays open.
Scient briefly marks the destination.
In Split, each pane keeps its own cursor and selection. Visual selects the mapped
source characters for prose or an equation cell; PDF selects a matching word on its
mapped source line when that word can be verified, otherwise the line. The source highlight stays until you interact with Source. Clicking back into
Visual or PDF keeps your source selection. Source interaction also cancels a pending jump so a
late result cannot replace your new cursor.
PDF/source navigation needs a successful current build with a navigation index
and the exact source revision compiled into that PDF. Saving changed source does not make the old PDF's
coordinates current: rebuild before navigating. An included file that has changed
or is waiting for save or recovery is not revealed at an obsolete line. If no
mapping is available, the PDF remains usable and the status explains why the
jump could not be completed.
PDF navigation uses the compiler's navigation index: some complex or RTL lines
contain only a line-level location, so those lines can land near the typeset
line instead of on the exact word. Visual/source navigation uses the displayed
document's source mapping and does not require a PDF build.

The PDF keeps your place across rebuilds: your page, zoom, scroll position, and
search query stay put while a new version comes in. The LaTeX header shows
**Rebuild required** when the source is newer than the compiled PDF, and
**Previous PDF** while a rebuild is running. If the replacement cannot be
authorized or loaded, the previous PDF stays readable and **Try again** retries
the update without discarding your place.

## Choose a LaTeX engine

**Document > Compiler** in Visual, or **More > Compiler** in the other views,
offers **Automatic**, **Tectonic**, **pdfLaTeX**, **XeLaTeX** (recommended for Hebrew), and **LuaLaTeX**.
Choosing an engine first saves pending document edits, updates
the root's portable compiler directive, saves it, and rebuilds:

```latex
% !TEX program = lualatex
```

Use `tectonic` to require the Tectonic driver, or `xelatex` or `pdflatex` to select
those engines instead. Tectonic declarations use its embedded XeTeX engine;
they never fall back to latexmk when Tectonic is missing. Selecting Tectonic
does not install it or change the default driver for other documents. TeXShop's
`TS-program` spelling is also recognized. A root directive takes precedence
over directives in included preambles. The selected engine must be supported
by the TeX toolchain used by Scient.
Only complete supported engine names select a compiler; other declarations remain
visible as source declarations. Compiler changes preserve the source's line endings.

**Automatic** removes root compiler directives rather than storing a device-only
override. Included files display the root's choice and offer **Open root**;
they never receive their own compiler directive through this control. Resolve
recovery or save conflicts, and finish an active rename, before changing the compiler.

**Not checked** beside a compiler option means its availability is not known;
it does not mean a compiler is missing. A latexmk availability report alone does
not establish whether Tectonic is also installed; a Tectonic build checks it separately.

**Settings > Documents > LaTeX > Default compiler for new documents** only affects
new documents. A template's compiler declaration takes precedence over the
device preference. New Hebrew documents use XeLaTeX unless LuaLaTeX is selected;
a pdfLaTeX preference cannot put a new Hebrew document onto an incompatible engine.
Existing documents are not rewritten.

Compiler availability comes from the selected server and its verified system or
Scient-managed installations, not the browser's operating system. Missing
compilers are unavailable in the document menu; failed availability checks read
**Not checked**, disconnected servers read **Offline**, and source saves remain
separate from compiler availability.

With latexmk, Automatic uses pdfLaTeX unless unguarded `fontspec` or
`unicode-math` requires XeLaTeX. An explicit pdfLaTeX directive with those
packages instead produces compatibility guidance. Tectonic remains a separate
XeTeX-compatible fallback: it can build XeLaTeX-style Hebrew documents without a
standalone XeLaTeX installation. Tectonic itself cannot satisfy explicit LuaLaTeX
or pdfLaTeX requests; an already-installed TinyTeX addition can provide those
compilers without replacing Tectonic as the default. The availability display
distinguishes compatibility from an installed compiler binary.
Package declarations can span multiple lines; commented-out loads do not select
an engine.

Engine-aware documents that load packages only in the appropriate conditional
branch are allowed to build normally.

<a id="install-a-latex-distribution"></a>

## Install LaTeX tools

**Settings > Documents > LaTeX** offers an optional TinyTeX installation,
including when Tectonic already builds PDFs. One bundle provides pdfLaTeX,
XeLaTeX, and LuaLaTeX; these are not three separate downloads. Settings shows
the base archive size for the selected server. TinyTeX lives with Scient,
needs no administrator access, and does not modify a system TeX installation.
Compiler versions, executable paths, and detailed availability are under
**Technical details**.
The LaTeX panel separates **Tools** (installation and technical details) from
**Document preferences** (templates, new-document language and compiler, and
the opening view), each using standard settings cards.

Opening Settings or choosing **Default compiler for new documents** never
downloads tools. **Automatic** chooses a compiler for the document; it is not
permission to install software.
Installing additional compilers does not replace a working default: Scient keeps
system latexmk, or Tectonic when latexmk is absent. It uses an installed TinyTeX
addition only when the document needs a compiler the default cannot provide.
When no system driver is available, TinyTeX supplies the default.

When an open document declares a compiler its current toolchain cannot run,
Scient names that compiler and offers **Install LaTeX tools**. Nothing downloads
until you choose Install. After installation and a successful compiler check,
Scient saves and rebuilds that document if it is still unchanged and needs no
recovery decision. Its compiler directive stays intact: Scient does not silently
substitute another engine. If you edit it during installation, review your work
and choose **Rebuild PDF** yourself. Installing from Settings does not authorize
a document build.

Setup also downloads recommended LaTeX packages. Other missing packages can
install on first use with Scient-managed TinyTeX; a system installation instead
reports the package to install. Setup and the first build may therefore take a
few minutes. Scient names the packages while it waits. Package installation
needs a network connection; if offline or a package cannot be found, the build
stops with an explanation.

The managed bundle is available on Windows (x64), macOS (Intel and Apple
Silicon), and Linux (x64). On other architectures, install TeX Live, MiKTeX,
or Tectonic yourself. A working system latexmk installation keeps precedence
unless the explicitly installed TinyTeX bundle adds a missing compiler without
losing any available system compiler. Tectonic remains a fallback rather than a
standalone installation of all three compilers. If you install tools yourself,
choose **Rebuild PDF** to refresh discovery without reopening the file or
restarting Scient.

If you have more than one distribution, Scient uses the first `latexmk` that
runs: it tries the next one on PATH, and on Windows the folders MiKTeX and TeX
Live install into, before reporting that LaTeX is missing. MiKTeX's `latexmk`,
for example, needs Perl, so without Perl Scient builds with TeX Live's instead.
When it finds a `latexmk` that will not run, the message names it and quotes
what it said. If the TinyTeX installation fails, the card says which step
failed and shows the installer's own message under **Details**.

On Windows, accented or Hebrew characters in the state-folder path can prevent
TeX Live from finding its runtime files. Scient attempts to put TinyTeX and build
files in a private folder under `%ProgramData%` (usually `C:\ProgramData`), with
access for your account, SYSTEM and administrators. If that setup fails, it retains
the original state-folder path. Uninstalling Scient leaves the relocated folder;
you can delete it, named
`scient-latex-` followed by 16 letters and digits, yourself.

Scient directs normal build output, logs and auxiliary files to its private
build folder. This is not a filesystem sandbox for TeX code in the document.

Some older LaTeX distributions emit an explicitly ignored “Infinite glue
shrinkage found in box being split” message for longtables. Scient shows this
known upstream issue as one warning per source location, without the engine's
page and font output. Updating the LaTeX distribution's `longtable` package
addresses the underlying issue. Table-width warnings from intermediate passes
are omitted only when `latexmk` completes a later pass and reports settled
output; warnings that remain in the final pass are still shown.

For standalone PDF search, navigation and reading tools, see
[Reading PDFs](./pdf-reader.md). For implementation support boundaries and
maintainer details, see [LaTeX Visual internals](../internals/scient-latex-visual.md).
