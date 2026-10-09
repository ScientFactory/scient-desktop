# LaTeX

Use the LaTeX workspace to write a paper, report, thesis, or other scientific
document while seeing the compiled PDF beside its source. Opening a `.tex` file
offers Source, Split, Visual, and PDF across the top. Split places Source on the
left and your last chosen PDF or Visual view on the right. PDF is the initial
right-side choice. Use the PDF/Visual selector in the same header row to
change it, and drag the divider to resize either side.

## Start a document

Choose **Documents** in the side panel, or under **+**, then **LaTeX** (or
**Markdown**). A new `untitled.tex` opens straight in Visual, set up from your
default template, with the cursor in the title. Nothing else needs filling in:
type the title and keep writing. Once the title is saved and you move on, the
file takes its name from it once, for example `spectral-bounds.tex`; later
title changes leave the file name alone. Templates without a title, such as a
letter or a CV, ask for a document name instead. Existing files are never
overwritten, and a name that is taken gets a number.

Until you write in the body, the templates and the document language (English
or Hebrew) sit above the page: choosing another one switches the empty
document in place and keeps your title. The first few templates are on the
page; the rest are under **More**. The Thesis template is a folder of its own,
with chapters and a bibliography beside `main.tex`. Right-click a template to
make it the default, move it between the page and **More**, or hide it, and
drag to reorder. **More > New template…** saves a copy of the chosen template
as your own, which you can then edit, rename, or delete.

**Settings > Documents** keeps these choices in one place:

- **LaTeX**: the LaTeX installation on the server (with **Install TinyTeX**
  when none is found), **Templates** (the default and the full list to arrange,
  hide, show again, rename, or delete your own), the language for new
  documents, and the view LaTeX files open in.
- **Markdown**: whether Markdown files open Rich or as Source.
- **Word**: the Pandoc converter that Word export uses, and its install.

Template, language, and view choices stay on this device. The installs belong
to the server shown at the top of the page; with that server offline, they
read **Offline**. The view a file opens in is the one you last used, in
Settings or in the editor.

PDF generation requires an installed TeX toolchain and the packages used by your
document. Install those packages before working offline; no hosted compiler or AI
service is required for the writing workflow.

## Hebrew and mixed-language documents

Visual reads the existing English/Hebrew language and font declarations from
Babel or Polyglossia in the document root. Hebrew documents use right-to-left
flow; formulas and source fields retain left-to-right entry. Supported English,
Hebrew, LTR and RTL environments and inline language switches remain editable,
including `\textenglish`, `\texthebrew`, `\LR`, `\RL` and
`\foreignlanguage`. Existing language wrappers survive supported edits.
Document fonts and standard abstract, contents and caption labels follow the
root's language setup. Custom or unsupported setups remain accessible in Source;
the compiled PDF is authoritative. Language, compiler and font configuration
is edited in Source; no new language or direction menu is required.

## Write visually, verify with TeX

Write is a source-derived writing canvas, not an editable PDF. You can start
writing before installing or running TeX. The canvas uses a document workspace
with a compact toolbar, a collapsible outline, and a contextual
status bar. **Text > Paragraph style** lists Text, the heading levels and Quote, with
thin lines between them; the current style is highlighted. **Numbered
headings**, a small switch under the heading levels, turns numbering on or off
for the current heading, or for the next heading chosen from ordinary text,
without closing the menu. Changing heading level keeps that setting; Text and
Quote are unaffected. Ctrl/Cmd+Alt+0 is Text and Ctrl/Cmd+Alt+1, 2 and 3 are the first
three heading levels. Quote is not available inside a list item.
Chapter-based classes also offer Chapter. The toolbar holds, in order: undo and
redo; Text; Insert; Math; Lists; and Document. **Text > Formatting** offers bold,
italic and inline code (Ctrl/Cmd+E). **Insert > References > Link** (Ctrl/Cmd+K)
links text within one paragraph. **Insert** groups figures,
tables, text blocks, references and statements. Equations and structures live in **Math**. Heading styles live in Text > Paragraph style rather
than being duplicated in Insert. Type `/` on an empty
paragraph or press Ctrl/Cmd+/ to open it; use the arrow keys and Enter to choose.
The writing toolbar stays fixed at the top on one row. When the pane narrows,
**Math** keeps its word label, without an icon; less-used groups move into **More**. Insert holds elements and references; Lists holds list actions.
**Document > Document settings** opens one card with every document setting.
**Document** also holds Find and replace and Export. **Outline** is a tab
in the sidebar, which opens from the header row. Selected-object options appear
on the left of the footer as one named control, such as **Equation** or **Table**.
Open it for a compact options panel above the footer. It works the same way in
wide and narrow panes, with no modal backdrop.
**Document > Title & authors** offers Edit title, Edit authors and Edit date when
the document shows a title; editing jumps to the corresponding on-paper field.
When it shows none, the only item is **Add a title**: a title block is never
added silently. Title, author, and date remain editable on paper; the title block
has no contextual footer. Title actions stay under **Document > Title & authors**.

**Lists** offers Bullet list, Numbered list and No list. Description lists already in a document still show and can be edited. The
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

Nested bulleted and numbered lists remain editable with ordinary enumitem labels
such as `label=\alph*)`, including bold or italic item text. Supported decimal,
alphabetic and Roman labels, `start` and `resume` options keep their source
spelling during content edits. Custom label macros retain exact-source fallback.
The list footer has a **Numbering** menu for the format, starting number and
continuing a previous list. Description lists have an **Items** menu for inserting
or deleting the current item.

PDF, Visual and Split use one header row. From the left it holds build status,
search and the view switch; sidebar, page and zoom controls follow, with the
PDF/Visual choice after the page controls in Split. Rebuild and More are on the right. Click the search field and type: the
count and two arrows appear at its end, Enter moves to the next result, and
Escape clears it. Ctrl/Cmd+F puts the caret there. The view switch stays in the same place in
Source, where the room before it is empty. Minus and plus sit on either side of the zoom percentage and use
five-percent steps in the 25–500% range. Click the percentage to fit the page
to the pane width; the fit follows pane resizing automatically. In Visual, **Document > Find and replace** opens the full bar under the writing
toolbar, with Replace and Replace all. Replace all works through the document one paragraph
at a time, so a very long document takes a few seconds, and each paragraph is
its own undo step. It stops if you type or undo while it is working. Text
inside figures, tables and other objects is not searched.

A thin footer stays under the document. On the left, one control opens the
current object's options. Extra structural choices are grouped inside that panel.
Click outside or press Escape to close it; closing keeps unfinished fields intact.
Headings show a compact **Label** field directly in the footer instead of an
options panel. Enter a unique reference key and press Enter or leave the field
to apply it. Invalid or duplicate keys stay as drafts. Renaming a key in a
single-file document updates its recognized cross-references in one undoable
change; included files require a coordinated rename. Clearing the field removes
the heading's label. Heading numbering stays in **Text > Paragraph style**.
On the right it shows where the caret is, for example "Section" or "Table · row 3, column 2",
and the word count:
"1,284 words", or "12 of 1,284 words" while text is selected. The count is an
estimate from the source; math, code, comments, commands and reference keys are
left out.

Zoom changes only the on-screen view, not the LaTeX
page dimensions or PDF layout. Pinch with two fingers on a trackpad, or hold Ctrl
while scrolling, to zoom smoothly around the pointer without fixed percentage
steps. Ordinary two-finger scrolling continues to move through the document.
Clicking a generated heading such as Contents keeps the current caret without
selecting the whole block. Contents entries still navigate to their targets.
Clicking a statement heading such as Definition or Proof places the caret in
its editable body. Object fields keep their own caret, with options in the footer.

For a citation, the footer shows its entries and offers search to add another
entry or remove one from a multiple citation. **Edit reference** opens the
existing References panel. Cross-reference options let you choose a labeled
target. Reference-label fields retain invalid input with an explanation until
it is corrected. Statement type choices use declarations already in the document.

Math normally stays rendered in the document. Click a symbol to place the caret
directly there; drag to select part of a formula. **Equation** opens the display
formula's options in the footer; inline math shows its controls directly. Centered equations have
a single editing surface, without an outer selection box. New
equations start empty and focus the math cursor immediately. Alt+= inserts inline
math; Ctrl/Cmd+Shift+M (or Alt+Shift+=) inserts a display equation. Outside command
entry, plain Enter or Escape returns to text; a paragraph is added after a display equation only when
needed. Tab and arrow keys navigate inside math and return to text at its boundary.
Backspace or Delete in a completely empty equation removes it. Clicking outside
math dismisses its controls. Matrices, cases, and aligned calculations start with
empty cells rather than example expressions. Empty math slots appear as subtle
dots while the formula is focused and disappear when it is inactive. They are
caret targets and are never written into the compiled source.

Ctrl+Enter (Cmd+Enter on macOS) splits math at the caret: the preceding content
stays on the current row and the following content moves to a new row below.
The caret starts that new row. A single-line formula becomes a two-row `gathered`
layout. In matrices, cases and aligned equations, column positions are retained;
cells to the right of the split also move to the new row. Inside a fraction,
root or other nested body, the split stays within that body. Start/end splits
leave an empty row ready for typing. Imported row labels/tags remain protected.

The **Math** menu offers seven choices:

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

Type `\` followed by a command name directly in a formula to see local command
suggestions with symbol previews. Up/Down changes the suggestion; Enter or Tab
inserts it and moves into its editable slot when applicable. In-progress command
suggestions remain local until accepted, so ghost completions are not saved into
the document. Clicking a suggestion keeps you inside the formula.

Inline math shows **Edit LaTeX** directly in the compact footer. When the caret
is inside a matrix, cases or aligned cell, **Rows & columns** appears beside it.
The top **Math** menu provides placement, brackets, matrices, cases and Symbols.
There is no separate Inline math options popup or duplicate symbol button.

Display math and equations share a compact footer with **Edit LaTeX** and a
**Numbered** toggle. **Label** appears only when numbering is on; its small field
commits on Enter or blur and rejects invalid or duplicate labels. Turning numbering
on converts an ordinary display into an equation; turning it off retains any
existing outer label for later reuse. Existing align/gather blocks keep their row
numbering scope. **Rows & columns** opens its small menu only when the caret is in
a matrix, cases or aligned cell. Fixed column counts, minimum sizes and imported
row metadata restrict its actions. The source editor opens above the footer.
Symbols, brackets and insertion actions stay in the top **Math** menu; there is
no overall Equation options popup or duplicate Math/Symbols control. Wide formulas
pan with horizontal trackpad gestures or Shift-wheel after clicking into them,
without a scroll bar. Moving the caret follows the part being edited. Selection
highlights stay attached to their contents during vertical and horizontal scrolling.

Imported tags, suppressed numbers and per-row labels remain protected. Their
placement, numbering, and outer row structure are changed in Source. A single
outer reference label can be edited directly and survives numbering changes;
it does not prevent editing a nested matrix's rows or columns.
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
packages must be available in the local TeX installation. Bundled TeX outlines cover many package symbols that the browser math renderer
cannot draw. Other unsupported commands retain a source fallback; the compiled
PDF renders them through their package. A preview never substitutes a different
symbol into document source.

Choose **Edit LaTeX** to edit just the formula body in a compact box above the
footer. Supported edits update the equation and document as you type; there are
no Apply or Cancel buttons. Escape or Ctrl/Cmd+Enter returns to the formula.
The Math menu's placement choices and Numbering manage the outer delimiters and environment. Equations
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
calls generally remain single units in the formula. One-argument delimiter
wrappers such as `\newcommand{\norm}[1]{\left\lVert #1\right\rVert}` allow
editing inside the delimiters directly; argument edits retain `\norm{...}` in
source. Changing the delimiters expands that occurrence into ordinary math.
Use Edit LaTeX for arguments of other macro shapes.
Preamble changes update the shared math setup without adding definitions to each
included file. Optional/default arguments, conditional or recursive definitions,
paired-delimiter declarations and commands requiring TeX execution remain
controlled in Source and PDF.

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
amsthm proofs show the end-of-proof square on the right; it is display-only and
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
Edits that cannot round-trip remain local and are marked as unsaved. MathLive's
separate virtual keyboard and menu are hidden.

The formula field keeps bare words and punctuation literal. In the formula-code editor, starting a known command
such as `\fra` or an inner environment such as `\begin{bmat` shows bounded
completions; Up/Down chooses an entry and Tab or Enter accepts it. Unknown commands remain literal
source; the TeX compiler determines whether their definitions are available.

The Math menu creates display equations, bracket or parenthesis matrices,
cases, and aligned equations. You can also type a complete `matrix`, `bmatrix`,
`pmatrix`, `vmatrix`, `Vmatrix`, `cases`, or `aligned` environment on an otherwise
empty visual paragraph; Scient converts it only after the matching `\end{...}`
is complete. Unsupported or malformed environments remain ordinary text or
protected source rather than being partially rewritten.
Source remains the authoritative `.tex` file. Source and Visual share one document
session and revision-checked save queue per file, including a chapter opened in its
own tab; switching views does not create a second document. If the file changes
elsewhere while you have unsaved edits, Scient keeps both versions for you to resolve.

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
Use **Document > Document settings** for the document type, text size, paper,
orientation, margins (Narrow, Normal, Wide, or Custom for each side) and
paragraph style. Each setting shows what the document uses now; **Apply** writes
only the settings you changed, and **Cancel** discards the draft. Blank custom
margin fields preserve the current source. Package and macro declarations are
available in Source. Existing package options remain intact, and
Visual adds only known missing requirements for inserted tools. Packages are
never removed automatically. Custom classes retain their class and text style
in Source. **Open in Source** opens the root setup. If the document changes while
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
fits the page to the available workspace using the same zoom percentage as PDF
for the same paper size, pane width and navigation state. The page number in the
header row shows the visible page. Choose **Outline** to open document navigation.
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

`multicols` regions render editable text in the requested columns, including
explicit `\columnbreak` commands and page footnotes. Supported `minipage` widths
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
Full-width prose resumes after a column region. `\noindent`, `\par`, the three
standard skip commands and root-level `\vfill` affect layout without printing
their source. Vertical fill pushes the following content toward the bottom of
the current printable page when space is available.

Visual also reads common root-preamble `fancyhdr` left/center/right fields,
running section marks and `\thepage`, with header/footer offsets from geometry
or literal length assignments. These running fields are display-only; edit their
definitions in Source. Columns are currently kept together by Visual's local
page planner. Default running fields align against the full header/footer width,
and long text wraps within the page margins. Long regions, minipage-specific
footnotes, custom page styles and TeX's page/column balancing still require the
compiled PDF.

Description lists and common `tabular`, `tabularx`, `tabulary`, and `longtable`
structures have visual editors. When inactive they read like document content;
selection and keyboard focus reveal their structural controls. In a description
list, edit labels and bodies directly or add and remove items. Common enumitem
layout such as `style=nextline` and an explicit `leftmargin` is reflected in the
canvas. In a supported table, click anywhere inside a cell, including its blank
space, to start editing. Clicking existing text keeps native caret placement and
selection. Type directly in cells
and use Tab to move through the grid; Tab from the last cell adds a row. The
footer offers **Rows & columns**, **Cells**, **Appearance**, and **Caption**
directly. Rows & columns inserts, deletes and moves rows or columns;
Cells merges or splits cells. Appearance uses standard menus for rules, widths,
headers, column settings, borders and layout. Dimensions and longtable continuation
use compact forms in submenus. Table color controls are deferred; existing source
colors are preserved.
Caption adds a caption or focuses the existing caption on the paper. Floating
tables and longtables support caption and label edits independently of grid
restrictions, preserving merged cells, rules and continuation bands. Captioned
tables also show a compact **Label** field, committed on Enter or blur, with
invalid and duplicate keys rejected. Selection stays active while using the
menus. Imported structures retain their edit protections.
Clearing a caption removes its command, table number and reference label. You
can add a caption again, and label fields remain editable after committing.
The footer follows the active cell without changing the table's appearance or the
footer's height. The writing toolbar's Table picker inserts
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
Cells support formatted prose mixed with inline formulas. Use Math → Inline math
at the cell caret; formulas use the math editor and retain their delimiters.
Text → Formatting and configured writing shortcuts work inside cells, and cell
edits share document undo. Tab moves between cells; mixed prose/math cells
participate in the same rectangle clear and copy operations as text cells.
Other structural cell content, such as unsupported nested commands,
stays protected; incompatible footer actions are disabled.
Other unsupported structures, including
custom macros, appear as protected source blocks.
The visual editor does not silently normalize or discard them. A visual edit
cannot delete across a protected preview or source block, or across an included
file boundary. Source-only blocks have no contextual footer. Click their source
to edit it in place; **Apply LaTeX** and **Cancel** appear inside the block while
editing. Ctrl/Cmd+Enter applies and Escape cancels. Apply checks that the document
has not changed underneath the draft. **Delete** in the block header explicitly
removes that block, including its open draft, and supports document undo.
Drag the source field's resize handle to show as little as one line;
longer content remains scrollable while editing. **Source** opens the file that owns the block.

### Repeated document content

Visual can display a simple document-level counter loop with up to 100 iterations,
including literal paragraph macros, generated headings and equations. Explicit
page breaks and contents links behave like ordinary document content.

Opening the file keeps its loop and macro definitions unchanged. Editing generated
content expands the loop into ordinary LaTeX so each occurrence can be edited
independently. More complex TeX programs remain available in Source.

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
without float placement, captions or labels. Unknown pseudocode commands stay
available in Source.

### Colored text and boxes

Colored text and inline color boxes are editable on paper, including literal
custom colors and percentage mixtures. Supported `tcolorbox` blocks show their
colored title, frame and background with editable prose, math, lists and tables inside.
Plain `\fbox` phrases, local `\fboxsep`/`\fboxrule` groups and framed paragraph
boxes are also editable. Literal styles include square or rounded corners, shadows,
dashed frames, a left accent strip, and separate upper/lower regions. Framed
`tcblisting` blocks using `listings` show editable code with syntax colors and line
numbers. Visual approximates these decorations; the compiled PDF remains authoritative.
Breakable boxes can continue onto later Visual pages; exact splitting remains
the compiler's responsibility.

The box footer shows **Appearance** and **Title**. Appearance groups background,
border color and thickness, square/rounded corners, padding and **Allow page breaks**.
Corners and Padding use choice lists; **Custom** opens their exact dimension fields.
Title adds or focuses the title on paper. Clearing the title removes its source
option; another Backspace/Delete in the empty field returns to the box body.
Click an existing title to edit at that position. Imported title and color settings
stay intact when changing another property.

Simple counter loops used to generate repeated paragraphs are displayed without
showing their code. Editing a generated paragraph expands that loop into ordinary
paragraphs in Source, allowing each one to change independently. Until that edit,
the loop is preserved. Undo restores the previous document.

### Selecting table and math cells

Drag across table cells, Shift+click another cell, or use Shift+Arrow at a cell
boundary to select a rectangular area. The table's Rows and Columns groups also offer
Select row and Select column. Delete or Backspace clears all selected cells;
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

In math, Delete or Backspace clears every cell in a rectangular selection without
removing rows or columns. In an empty cell, deleting removes the nearest math
wrapper and keeps its other contents; matrix contents continue in row order.

### Empty elements and editing guides

Newly inserted elements start without sample text: table cells, table captions,
figure captions, title text and inserted headings are blank. Existing document
text and explicitly chosen templates retain their content.

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

### Insert document elements

The Insert menu keeps the same choices while you work. Math-only insertion belongs
in Math; finish editing a formula before inserting document elements.

| Menu entry                | Behavior                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Figure                    | Choose a project PNG, JPEG or PDF, or import a PNG/JPEG; set an optional caption and width.                             |
| Table                     | Choose a size from the grid.                                                                                            |
| Code block / Literal text | Insert a code or verbatim block.                                                                                        |
| References                | Citation, Cross-reference and Link, followed by Footnote.                                                               |
| Theorems & proofs         | Theorem, Lemma, Proposition, Corollary, Claim; Definition, Example, Remark; Proof; Question and solution, Subquestions. |
| Document blocks           | Abstract, Table of contents, Bibliography; Verse.                                                                       |
| Page break                | Start a new page.                                                                                                       |
| Final group               | Long quotation, Left-aligned text, Right-aligned text and Part; any additional actions not assigned above remain here.  |

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
not delete its image file. Standard image figures show **Replace**, **Appearance**,
**Caption**, and a compact **Label** field for captioned figures directly in the
footer. Replace chooses a project image or imports a PNG/JPEG while preserving
the caption and settings. Appearance groups width, alignment, caption position
and page placement. Caption adds or focuses its text on paper; clearing it
removes the caption command, figure number and label, and both can be added again.
Labels commit on Enter or blur and reject invalid or duplicate keys.
Backspace or Delete in an already-empty caption closes its editing area and
returns focus to the figure; the same behavior returns to a table from its caption.
In empty inline or display math, another deletion removes the math object and
places the caret in surrounding text. Empty nested cells first remove their
nearest wrapper while preserving any remaining contents.

Imported figures can also display editable framed text, literal rotations, and
side-by-side `subfigure` panels. A one-argument preamble command wrapping a
centered, fixed-height `parbox` in `\fbox` is recognized from its definition;
editing its text keeps the original command call. Panel and figure captions
are editable on paper. **Panel** selects which panel the compact footer controls;
clicking or focusing a panel also chooses it. **Replace** chooses a project image,
**Caption** / **Panel caption** focus existing printed captions, and compact
**Label** fields validate reference keys. Widths, rotation angles, framing and macro definitions
remain in Source. Unsupported artwork stays available as exact source.

TikZ pictures and pgfplots render as read-only drawings in Visual using the
document's LaTeX preamble, including packages, libraries and style definitions.
Figure captions remain editable on paper. Drawing labels, coordinates and plot
settings have no Visual editing controls; change them in Source. Rendering needs
a working LaTeX toolchain. A drawing that fails to compile shows a diagnostic
instead of silently disappearing, and its original source is preserved.

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
remain editable through the footer's **References** menu; search to add entries,
reorder them, or remove a key from a multi-entry citation. **Form** offers styles
supported by the document's packages; **Note** edits a plain prefix/page note.
Cross-references have a searchable **Target** menu. Package-specific citation styles
remain compiler-owned. Bibliographies have no separate footer.
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
Linked `.bib` files use the same document session and revision checks whether
edited in References or in their own Source tab. The entry form clears and reports
success only after the owning sessions' published source contains the submitted
entry with the same key and text (allowing different line endings), or confirms
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

Links use `\href` and the document's hyperlink setup. Click an existing link to
edit its plain label on paper. **Text** activates the same editor, and **Address**
opens a compact field with Apply; incomplete addresses remain local drafts.
Formatted labels keep their exact
LaTeX and are edited in Source. Imported `\hyperref[label]{text}` and
`\hyperlink{name}{text}` navigate to a labelled section or other supported target,
including a literal `\hypertarget{name}{text}`. Section references display their
number, and `\pageref` displays the target's local Visual page number. These
commands keep their original source syntax. Links read as ordinary document text.

Standard footnotes show a numbered superscript and their text beneath a short
rule at the bottom of the corresponding Visual page. Click the superscript to
navigate to its note; click the note to return to its marker. Either action
makes **Edit text** available in the footer. It opens a plain-text editor beside
the marker without shifting the paragraph. Enter or Escape finishes editing and
returns to surrounding text. Footnotes containing formatting retain their
LaTeX and stay editable in Source. Prose formatting such
as emphasis is shown in the note. Custom counters and unsupported note bodies
remain approximate or show exact source; PDF pagination remains authoritative.

Dialogs retain the original insertion point. Cancelling inserts nothing; if the
document changes while a picker is open, insertion asks you to choose the position
again. An image already imported when this happens remains a project asset.

Preamble, macro and global-layout edits show a rebuild notice. After a crash or
interrupted save, journaled LaTeX source and Visual input are offered in the footer
when you reopen the document, and you can keep writing meanwhile. This recovery
does not cover linked `.bib` files or reference entry forms. **Compare** shows them next to
the file, and the file is replaced only if you choose **Use recovered** there.
**Discard** removes the recovered copy. In a narrow footer, the unsaved-work button
opens the comparison, where you can also discard the copy. In a document made of
several files, the recovered changes can be compared and copied, but are not applied
for you. Source and Split offer the same comparison for the file you are editing.
If the recovered copy cannot be stored safely, editing pauses and the notice tells
you to keep the document open until you use or discard it. You can copy it first.

Unapplied **Edit LaTeX** text is recovered separately, including incomplete LaTeX.
**View** and **Copy** let you retrieve it without replacing a whole document.
Cancel discards only that editing interaction; Apply clears its recovery copy only
after the accepted source has been stored in the recovery journal.

## Configure objects

Click inside an object, then open its named control in the footer. Text, captions,
titles and cell contents stay editable on the paper. The inspector groups less
frequent properties under disclosures and remains outside the document layout.
Escape closes it; opening a select or symbol picker keeps the active object.

For a table, **Color** applies named colors or mixtures to selected cells, rows,
columns or the whole table. Background and text colors are independent. Rule color
and alternating row backgrounds live in the same section. **Cell spans & rules**
merges a rectangle while retaining its text, splits an existing span, and changes
rules above or below the selection. Column width and wrapping are separate from
alignment. Supported literal grids retain colors when rows or columns are added,
removed or moved. An operation that cannot preserve existing spans or custom
column modifiers explains why it is unavailable.

Table placement controls move a caption above or below and convert a supported
ordinary table to a nonfloating multipage table. Longtables offer repeated header
rows and continuation text. Applying a repeated header copies the chosen first
header rows; apply it again after changing their text to refresh the continuation
header. Custom or macro-generated table structures retain their existing editing
limits. Inline math and formatting remain available inside cells; paragraph or
display-math cells still need Source.

Boxes expose colors, padding, border, corners and page breaking. Columns expose
their count; side-by-side panels expose ratios, spacing and individual dimensions.
Algorithm controls add, wrap, move or remove steps, and can remove a wrapper while
keeping its body. Code controls change language, frame, line numbering, caption
position and highlighting colors while preserving the literal code. Existing objects
keep their supported editing controls.

Citation controls in the footer edit entry order, notes and supported citation
forms, or open a record in **Document > References**. Bibliography records stay
in their existing `.bib` or manual `\bibitem` source. Coordinated key/label
renaming across multiple files remains a Source workflow.

## Edit LaTeX source

Source and the left side of Split use the same file editor as other source files
in Scient. Edit the `.tex` file directly there. Its contents are shared with
Visual; selecting another view does not create another document. In Split with
PDF selected, double-click a source line to locate it in the compiled PDF.

## Build and review

Choose **Rebuild PDF** to build after the current source has been saved.
Opening a stale PDF requests a build. While PDF is visible, Scient also rebuilds
on Ctrl/Cmd+S. Typing alone does not request a build. Before building, Scient asks
open document fields to finish and waits for the root and included files to save,
even if you have only used Source. Unresolved field input, save errors or conflicts
must be resolved first. Preparation refuses while linked bibliography changes
are unsaved; save them in References or their Source tab before continuing.
Preparation does not save those bibliography files. The last successful PDF stays
readable while building.
A failed revision requires an explicit rebuild instead of repeated automatic attempts.
**Document → Export → PDF** in Visual, or **More → Export → PDF** in the
other views, uses the same save preparation and saves a copy only when the
latest PDF matches the saved source and freshly checked build dependencies.
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
found one, then select **Document > Export > Word** in Visual, or
**More > Export > Word** in the other views.
Word export waits for the same document saves and field completion as Rebuild
PDF. Scient converts the selected LaTeX
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

Scient uses `latexmk` when available and defaults to pdfLaTeX. A compiler
directive in the root document selects an installed engine:

```latex
% !TEX program = lualatex
```

Use `xelatex` or `pdflatex` to select those engines instead. TeXShop's
`TS-program` spelling is also recognized. A root directive takes precedence
over directives in included preambles. The selected compiler must be available
in the TeX distribution used by Scient.

Without a directive, an unconditional `fontspec` or `unicode-math` load produces
guidance to select LuaLaTeX or XeLaTeX. Tectonic remains the fallback toolchain;
it uses a XeTeX-based engine and cannot satisfy an explicit LuaLaTeX or pdfLaTeX
request. Such requests explain which toolchain is needed before compilation.

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

Some older LaTeX distributions emit an explicitly ignored “Infinite glue
shrinkage found in box being split” message for longtables. Scient shows this
known upstream issue as one warning per source location, without the engine's
page and font output. Updating the LaTeX distribution's `longtable` package
addresses the underlying issue. Table-width warnings from intermediate passes
are omitted only when `latexmk` completes a later pass and reports settled
output; warnings that remain in the final pass are still shown.

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

Write uses the selected root document for page settings and image paths. If a
supported insertion would need to change both a chapter and the root preamble,
Scient asks you to add the missing package or theorem declaration in Source first,
then retry; neither file is changed by the refused insertion. Each file has its own
revision check; save conflicts are reported, and build/export wait for pending
file saves. Switching views keeps those saves active. A selection spanning multiple
source files must be edited one file at a time.

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

Standard report documents show editable title metadata even when it is declared
inside `document`, separate title/chapter pages, Roman front-matter page numbers,
and lettered appendix chapters. Contents and lists of figures/tables have aligned
numbers, indented entries and clickable targets. Captions and references share
chapter numbering (for example, Figure 1.1 and Table 2.1). Page numbers reflect the
Visual layout; exact float placement and compiled page breaks remain PDF features.

Theorem and proof bodies remain editable when their formulas use grouped legacy
font commands such as `K_{\rm LQR}`. References in proof headings are clickable,
and algorithms may retain a size declaration such as `\small` before their steps.

Abstracts support ordinary paragraphs and inline or display math. Table cells
support formatted text mixed with inline math: place the caret in a cell and use
Math → Inline math. Table cells share document undo. Deleting a rectangle clears
its cells; re-entering a cell returns to caret editing. Display math requires a
paragraph outside the table.

For BibTeX documents, a successful PDF build supplies the printed bibliography
and citation numbers in Visual. Use Document ? References to edit the original
`.bib` entries, then rebuild the PDF to refresh the bibliography. No generated
`.bbl` file needs to be copied into the project. Older builds need one rebuild
to supply this presentation data. Visual does not run BibTeX itself.

### Selection and editing scope

The footer shows the environment type, word count and contextual controls,
without a path through nested structures or formatting.
Gray corner marks show only the innermost editing slot. Occupied-slot marks
disappear when content is selected; empty math markers remain visible during cell
selection. The caret matches the local text color and size; inside accent bodies
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

Math uses one drag-selection handler and one highlight painter. Whole-cell and
partial selections follow the same content bounds, including brackets, scripts
and annotations. Selecting equation rows highlights each row's expression and
leaves the spacing between rows clear; a trailing comma does not switch to a
different kind of highlight. Double-click selects a grid cell, and a third click
selects its enclosing grid. Shift-click extends the current selection.
Shift+Arrow uses the same math selection rules as dragging. You can continue a
drag with Shift+Arrow, or continue keyboard selection with Shift-click and drag,
without changing its original anchor. Reversing direction shrinks the same range;
menus retain it and its continuation point.

Ordinary arrows move smoothly through text. In math, Tab and Shift+Tab visit
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

Use Cmd instead of Ctrl on macOS. The bindings are configurable in Keyboard
shortcuts. Leaving a formatting scope changes subsequent typing without changing
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

### Compact layout controls

Columns have a **Columns** count menu. Individual minipages expose **Appearance**
with Dimensions, Alignment and Content alignment; fixed height enables content
alignment. Side-by-side panel rows expose **Layout** with width ratios and spacing.
Spacing edits preserve panel widths; width edits preserve their original gaps.
Imported mixed width units stay editable per panel instead of guessing ratios.
Part headings retain Numbered and a compact Label field. Quotes have no separate
footer; other supported referenceable environments expose their existing labels.
