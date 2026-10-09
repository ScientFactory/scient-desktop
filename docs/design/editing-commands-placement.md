# Editing commands and placement

Owner decisions agreed from 2026-10-03 onward, with the later footer and navigation
rules consolidated below. Reference: [the owner's placement branch](https://github.com/ScientFactory/scient-desktop/blob/claude/editing-commands-placement-20261003/docs/design/editing-commands-placement.md).

The owner reviewed the current Visual editor on 2026-10-08 and reports that the
previous verification items, including Ctrl+A, work well except responsiveness
and math caret/selection positioning. Track those two in
[Remaining fixes](../internals/scient-latex-visual.md#remaining-fixes).
This guide records placement decisions and deferred product proposals.

## Shared bar

```
Undo  Redo | Text ▾ | Insert ▾ | Math ▾ | Lists ▾ | Document ▾
```

Each menu has the same name, place and order in both editors; each editor lists
only what its file format can save. The LaTeX bar stays visible and uses More
when the pane is narrow. Markdown retains its hide-formatting-tools handle.

## Command homes

| Command                                     | Home / decision                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Undo, Redo                                  | Bar                                                                          |
| Paragraph, Heading 1–6 / Section…           | **Text › Paragraph style**                                                   |
| Numbered headings                           | **Text › Paragraph style** (LaTeX only)                                      |
| Quote                                       | **Text › Paragraph style**                                                   |
| Bold                                        | **Text › Formatting**                                                        |
| Italic                                      | **Text › Formatting**                                                        |
| Strikethrough                               | **Text › Formatting** (Markdown only)                                        |
| Inline code                                 | **Text › Formatting**                                                        |
| Subscript, Superscript                      | Not now (decided)                                                            |
| Clear formatting                            | **Text › Formatting** (Markdown only)                                        |
| Font size                                   | **Text › Size** (LaTeX only, later)                                          |
| Text direction (Auto, LTR, RTL)             | **Text › Direction** (Markdown only)                                         |
| Bullet list, Numbered list, No list         | **Lists**                                                                    |
| Task list                                   | **Lists** (Markdown only)                                                    |
| Link                                        | **Insert › References**; Cmd+K stays                                         |
| Table (size picker)                         | **Insert**                                                                   |
| Image / Figure                              | **Insert**                                                                   |
| Code block                                  | **Insert**                                                                   |
| Footnote                                    | **Insert › References**                                                      |
| Citation, Cross-reference                   | **Insert › References** (LaTeX only)                                         |
| Wiki link                                   | **Insert › References** (Markdown only)                                      |
| Divider line / Page break                   | **Insert**                                                                   |
| Line break                                  | **Insert** (Markdown only)                                                   |
| Theorems & proofs                           | **Insert** (LaTeX only)                                                      |
| Abstract, Table of contents, Bibliography   | **Insert › Document blocks** (LaTeX only)                                    |
| Literal text                                | **Insert**, directly beneath Code block                                      |
| Long quotation, Part                        | **Text › Paragraph style**; retain block insertion behavior                  |
| Left-aligned / Right-aligned text           | **Text › Alignment**; retain block insertion behavior                        |
| Verse                                       | **Insert › Document blocks**                                                 |
| Question and solution, Subquestions         | Removed from creation menus; existing content stays supported                |
| Inline math, Display math                   | **Math**                                                                     |
| Aligned equations, Matrix, Cases            | **Math** (Markdown: whatever it can store)                                   |
| Symbols & structures                        | **Math**                                                                     |
| Title & authors                             | **Document** (LaTeX only)                                                    |
| Document settings                           | **Document** (LaTeX only)                                                    |
| Document outline                            | **Document** in Markdown; **Pages** sidebar in LaTeX                         |
| Find and replace                            | **Document** in both; shared Search control in the LaTeX footer              |
| Move block up/down, Duplicate, Delete block | **Document** (Markdown only), or a menu on the block itself                  |
| Export                                      | **Document** in both (LaTeX PDF and Source views keep it in the header More) |
| Keyboard shortcuts                          | **Document**                                                                 |
| Hide formatting tools                       | Keep in Markdown                                                             |
| Table rows, columns, alignment              | Footer                                                                       |
| Figure, equation, statement options         | Footer                                                                       |

## Decided (owner, 2026-10-03)

| #   | Question                                                 | Decision                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where does Link go?                                      | **Insert › References**, alongside Citation, Cross-reference and Footnote. No Link button in the bar; Cmd+K stays.                                                                                                           |
| 2   | How does the Insert button look?                         | **The word "Insert"**, not a plus icon.                                                                                                                                                                                      |
| 3   | Math in Markdown?                                        | **The same Math menu as LaTeX**, replacing the Ω button and the "Math equation" item in Insert.                                                                                                                              |
| 4   | Text direction?                                          | **Moves into the Text (Style) menu** (Markdown only), freeing a bar button.                                                                                                                                                  |
| 5   | Subscript and superscript?                               | **Not now.**                                                                                                                                                                                                                 |
| 6   | Markdown's "hide formatting tools" handle?               | **Keep it.**                                                                                                                                                                                                                 |
| 7   | How does the Math button look?                           | **The word "Math"** alone, no Σ icon, in both editors.                                                                                                                                                                       |
| 8   | Where do Find and replace and Export go in LaTeX Visual? | **The Document menu**, with Title & authors and Document settings. The header's More then lists only what the row has no room for, and is hidden while everything fits. The Export card is only as wide as "PDF" and "Word". |
| 9   | How is Document settings organised?                      | **One card, no tabs**: Type, Text size, Paper, Orientation, Margins (Narrow / Normal / Wide / Custom), Paragraphs. Every setting shows the document's current value; Apply writes only what changed.                         |
| 10  | Screen-blocking editing dialogs?                         | **None wanted.** Link becomes a compact popover; remaining conversion proposals are recorded below.                                                                                                                          |

The decided menu layout is implemented; the dialog policy still has the deferred migration proposals below.

Document settings has no read-only Packages and macros summary. Package and macro declarations remain available in Source.

## Shared Text menu (decided; implemented)

The shared order is **Text → Insert → Math → Lists → Document**, following
Undo/Redo. Markdown's final menu uses the Document icon and name. Formatting
rows have equal side padding; their checkmark reuses the leading icon slot
instead of reserving a separate left gutter.

The bar button reads **Text** in both editors. Hover opens these categories:

- **Paragraph style:** Paragraph, heading levels, Quote. LaTeX also has its
  Numbered headings switch alongside its heading choices, Part and Long quotation.
  Part and Long quotation retain their existing block insertion behavior.
- **Alignment (LaTeX):** Left-aligned text, Right-aligned text; existing block insertions.
- **Formatting:** Bold, Italic, Inline code in both; Strikethrough and Clear
  formatting in Markdown. Active formatting has a checkmark; shortcuts remain.
- **Direction:** Auto, Left-to-right, Right-to-left in Markdown. In a table this
  category reads Table direction.

Bold, Italic, Inline code and Markdown's Strikethrough are removed from the main
bar. Clear formatting is removed from Markdown's More menu. The selection
floating toolbar is unchanged. Size remains deferred; subscript/superscript
remain out of scope. `apps/web/src/scient/writing/TextMenu.tsx` owns the shared
categories; each editor supplies its supported commands.

## Insert organisation (decided; implemented)

Each item occupies its own vertical row. References and Document blocks open
secondary cards on hover, as do the other menu categories.

- **LaTeX:** Figure, Table, Code block, Literal text; References; Theorems & proofs;
  Document blocks; Page break. References contains Citation, Cross-reference,
  Link, then Footnote after a separator. Document blocks contains Abstract,
  Table of contents, Bibliography, Verse.
- **Markdown:** Image, Table, Code block; References; Divider line, Line break.
  References contains Link, Wiki link, then Footnote after a separator.
- More and Other blocks are removed from LaTeX Insert. Per the owner's October 7
  follow-up, Question and solution and Subquestions are removed from the menu
  and command search; existing document content remains editable. Verse remains
  under Document blocks.
- Long quotation and Part move to Text › Paragraph style. Left-aligned and
  Right-aligned text move to Text › Alignment. Their source and insertion
  semantics are unchanged.

## Contextual footer

Keep object controls in the fixed-height footer, between Fit width and Search.
Content edits on paper; selecting an object does not resize it or add controls
around it. Use named shared menus without an overall object inspector, duplicate
object names, explanatory paragraphs, or select/delete-object actions.

| Context                                                 | Controls and behavior                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heading / Part                                          | Compact **Label** only; Numbered stays in Text. Labels commit on Enter/blur, reject invalid/duplicate keys, and rename recognized uses in single-file documents.                                                                                                                                                                                                                |
| Title block                                             | No footer. Edit title, author and date on paper; actions stay in **Document → Title & authors**. Preserve custom title structures.                                                                                                                                                                                                                                              |
| Inline math                                             | **Edit LaTeX**; **Rows & columns** only inside a grid. Source opens above the footer; insertion and Symbols stay in Math.                                                                                                                                                                                                                                                       |
| Display math / equation                                 | **Edit LaTeX**, **Numbered**, compact **Label** when numbered, and conditional **Rows & columns**. Ordinary displays become equations when numbered; align/gather retain row scope. Preserve single outer labels and protect imported tags/per-row metadata. Wide math uses horizontal/Shift-wheel panning without a scrollbar control.                                         |
| Table                                                   | **Rows & columns**, **Cells**, **Appearance**, **Caption**, compact **Label** for captioned tables. Preserve selected cells. Appearance groups Rules, Width, Header row, Column, Borders and Layout; dimensions and longtable continuation use compact submenu forms. No Select table/row/column or Clear cells menu items. Numbering follows the caption.                      |
| Image figure                                            | **Replace**, **Appearance**, **Caption**, compact **Label** for captioned figures. Replace uses project images or PNG/JPEG import and retains settings. Appearance groups width, alignment, caption position and placement.                                                                                                                                                     |
| Statement / proof                                       | Statement type, **Title**, compact **Label**; proofs show **Title** only. Types and numbering use document definitions. Title edits at its printed location; clearing it removes the optional argument.                                                                                                                                                                         |
| Algorithm                                               | **Steps**, **Appearance**, **Caption**, compact **Label** for captioned floats. Insert creates steps; Wrap encloses existing steps. Keep structures paired; use **Delete step**. Empty opening/closing-line Backspace/Delete removes the wrapper and retains its contents. Appearance holds line numbers and placement. Standalone algpseudocode has Steps and Appearance only. |
| Code listing                                            | **Language**, **Appearance**, **Caption**, compact **Label** for captioned listings. Search readable language names and preserve imported values. Appearance groups frame, wrapping, font size, tab width, line numbering and caption position. No Syntax color or Delete code block buttons. Verbatim has no footer.                                                           |
| Box                                                     | **Appearance**, **Title**. Appearance groups background/frame colors, border thickness or none, Square/Rounded corners, padding presets and Allow page breaks. Exact radius/padding values live under Custom. No Caption, Numbered, Label or Delete box controls. Preserve unrelated imported options.                                                                          |
| Numbered / description list                             | **Numbering** with format, Start at and Continue previous; description lists use **Items** with Insert item/Delete item.                                                                                                                                                                                                                                                        |
| Citation / cross-reference                              | Citation **References**, **Form**, **Note**; cross-reference searchable **Target**. Preserve source-owned notes and selection.                                                                                                                                                                                                                                                  |
| Link / footnote                                         | Link **Text** edits plain content on paper; **Address** or **Target** edits metadata. Footnote **Edit text** beside the marker; formatted content retains Source editing.                                                                                                                                                                                                       |
| Columns / minipage / panel row                          | Column count; minipage **Appearance** for dimensions/alignment; panel-row **Layout** for ratios/spacing. Width edits retain imported gaps; spacing edits retain imported widths.                                                                                                                                                                                                |
| Multi-panel figure                                      | **Panel**, project-image **Replace**, existing figure/panel captions and labels. Clicking/focusing chooses the active panel.                                                                                                                                                                                                                                                    |
| TikZ / pgfplots                                         | Read-only drawing preview; no Drawing menu or editable drawing labels. Figure captions retain their controls.                                                                                                                                                                                                                                                                   |
| Source-only block                                       | No footer. Delete is in the block header and removes only that block through document undo. Apply LaTeX/Cancel stay inside the source editor. Protect stale source and unrelated drafts; ordinary selection cannot delete across these blocks.                                                                                                                                  |
| Bibliography / quote / custom referenceable environment | Bibliography records live in **Document → References**. Quotes have no footer; custom referenceable environments expose their existing **Label** fields only.                                                                                                                                                                                                                   |

Caption and title actions focus editing on paper. Clearing a float caption removes
its number/label; both can be added again. An extra delete in an empty caption or
title returns to the body. Printed-title clicks retain the clicked caret position;
Statement Title enters at the beginning. Listing/float labels share validation,
single-file reference renaming and navigation. Retain statement footer context
after title removal and app focus changes.

Nested menus retain selection ownership. Shared Numbered/Line numbers/page-break
switches keep their menu open. Compact custom forms reserve the widest unit option,
fit their contents, cap to available space, and wrap controls in narrow panes.
Math → Brackets puts Left/Right above Size/Match, then Insert.

## Dialog policy and deferred conversions

Editing controls should not block the document with a modal backdrop. Use compact
anchored popovers for short forms and nonmodal panels for larger workflows.
Link, Citation/Cross-reference and Document settings already use nonmodal controls.
Document settings uses one card without tabs: Type, Text size, Paper, Orientation,
Margins and Paragraphs. Show current values; Apply changes only requested fields.

The owner has verified the available workflows. These remaining UI conversion
proposals are separate from the two current Visual fixes:

| Entry point                    | Proposed conversion                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| Figure insertion               | Anchored figure popover or nonmodal panel.                                               |
| Bibliography insertion         | Compact popover or nonmodal panel.                                                       |
| Missing/custom title guidance  | Inline guidance or compact popover; ordinary title fields remain inline.                 |
| Keyboard shortcuts             | Nonmodal panel, with reference sheet and New/Edit math-action forms inside it.           |
| Word export                    | Nonmodal export/progress panel or status popover. Native file-save windows remain OS UI. |
| Alternate matrix overflow path | Reuse the compact matrix grid picker.                                                    |

Table uses its size picker; Symbols, normal Matrix, menus, Find, outline and
inline/footer controls already avoid these modal dialogs.

## Functionality to add (placement pending)

Deferred product proposals: these are requested capabilities, not current
verification failures or approved additions to the menus.
The existing placement decisions above still apply: size is deferred, Direction
currently belongs to Markdown, settings stays compact, and content is edited on
the paper with object options in the footer. Agree each capability's home before
implementing it; use compact nonmodal controls and the shared source/save/undo path.

| Need                               | Functionality to add                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text appearance                    | Apply foreground color, highlight, local text size and Roman/sans-serif/monospace family to a selection or subsequent typing. Preserve independent foreground/background formatting and imported styles. Distinguish local formatting from document-wide fonts and size; define applicable math/text-slot behavior.                                            |
| Language and direction controls    | Existing Hebrew/mixed-language document editing is retained. Add explicit controls to configure English/Hebrew document language and installed fonts with a compatible compiler; change or reset passage/paragraph direction. Keep math entry left-to-right, retain the existing Babel/Polyglossia approach, and preserve custom source-owned language setups. |
| Custom theorem insertion           | Insert theorem/statement environments already declared in the document, using their names and titles without inventing or replacing definitions.                                                                                                                                                                                                               |
| Document structure                 | Insert lists of figures/tables and start appendices. Reuse existing document structure and counters.                                                                                                                                                                                                                                                           |
| Scientific and page layouts        | Create algorithms, boxes, two/three-column blocks, side-by-side panels, column breaks, vertical space and fill-remaining-space. Insert empty editable content and required declarations while preserving surrounding text; object properties belong in the footer.                                                                                             |
| Reusable definitions               | Manage supported packages, operators, symbols, delimiter functions, plain text/quote templates, theorem definitions and named colors. Preserve literal declarations/options, guard dependencies and known uses, and leave custom/conditional/included definitions reachable in Source. Package declaration does not imply installation or editor support.      |
| Reference management               | Extend the existing bibliography manager with label search, usage counts, duplicate/unresolved-reference discovery and rename with recognized uses. Keep manual bibitems and linked bibliography files in their existing format. Distinguish single-file operations from coordinated multi-file changes.                                                       |
| Compiler, fonts and page furniture | Configure pdfLaTeX/XeLaTeX/LuaLaTeX, compatible installed main/sans/monospace fonts, and simple running headers/footers with page numbers or section/chapter titles. Preserve custom setups and apply only requested changes through document undo.                                                                                                            |

Existing table, citation and contextual-footer improvements remain available.
The deferred Text size decision still needs agreement on sizes and timing;
subscript/superscript controls remain out of scope.

### Author request: fonts and colors (2026-10-07)

Fonts and text colors are already included in the requested capabilities above.
Keep them explicit in the plan, with compact controls inside existing menus:

- **Text formatting:** add font-family, foreground-color and highlight controls
  for selected text and subsequent typing. Their proposed home is **Text**;
  document-wide fonts remain in **Document settings**. Local size remains deferred.
- **Table footer:** add colors under the existing **Appearance** menu, including
  cell background, text and printed border/rule colors. Preserve the selected
  cells while the menu is open and apply changes to that selection; provide a
  clear way to reset only the chosen color override.
- **Box footer:** keep background and border/frame colors under **Appearance**
  in the box's contextual footer, and complete title background/text colors where
  the box supports them. Box body text uses the shared text-formatting controls;
  the title and body continue to edit on paper.

Reuse document-defined colors and preserve imported font/color declarations and
unrelated styling. Use the shared source/save/undo path, compact nonmodal menus,
and no additional top-level buttons. These are requested additions and corrections;
they do not assert that the controls are implemented or interaction-qualified.

### Author request: configurable menu shortcuts (2026-10-07)

Extend the existing **Document → Keyboard shortcuts** settings to cover suitable
menu and contextual-footer commands, including commands with saved option values.
Detailed placement and implementation remain future work.

- Let users assign, change and remove a shortcut, and manually edit its command
  and saved parameters. Reuse the existing shortcuts settings instead of adding
  shortcut buttons throughout the editor.
- Support specific presets: for example, bind a user-chosen shortcut to apply
  foreground color `#245A81` directly, without reopening the color picker. Allow
  the color code and key combination to be edited independently. Distinguish
  text color, highlight, table-cell fill and box background as separate actions.
- Offer applicable menu actions such as font family, formatting and object
  appearance. Use the same command, validation, selection and undo behavior as
  choosing the corresponding menu option. A saved value must not change the
  document's formatting until the shortcut is invoked.
- Respect editing context: table actions require a table selection, box actions
  require an active box, and text actions target selected text or subsequent
  typing. Keep ordinary typing and shortcuts in unrelated inputs unaffected.
- Show effective shortcuts beside their menu actions where applicable. Detect
  conflicting or reserved bindings and let users resolve conflicts explicitly;
  retain existing defaults and provide a reset option for custom bindings.

## Selection and navigation rules

Symbols opens explicitly from **Math → Symbols** or **Alt+I, then S**.
The local implementation replaces the Ctrl+Space default and consumes palette
open requests once, so returning to an equation does not replay a dismissed
panel. Its Symbols header supports dragging within the editor and keyboard
movement, retaining its position for the mounted editor without changing the
retained document selection. Existing custom shortcuts remain user-owned.

Use smooth ordinary cursor movement, visible editing scope, and explicit parent
navigation. This changes selection behavior and status
feedback; it adds no buttons or explanatory content to the Scient menus.

- Keyboard focus and the selected range have separate owners. Opening a menu,
  entering a submenu, or using a nested select retains the editing surface and
  selection. Commands restore the range before acting; root-menu Escape returns
  focus to the original surface. Clicking another editing location releases it.
- The footer shows the environment type, word count and contextual controls, with
  no nesting path in any context. Gray corner marks show only the innermost editing
  slot's contents; occupied-slot marks disappear during selection. Empty math
  markers remain visible during cell selection, with the highlight inside each
  marker. Selecting the enclosing environment uses its whole-expression highlight.
  Prose, math and rectangular cell selections share one active blue fill (22%
  primary color). Only the active editing surface paints selection. Whole-table
  selection fills cells and the caption, without a second container highlight or
  a band across the page.
  Retained selection has a muted fill while menus own focus. Empty and active slots
  use the same faint gray corner markers with short strokes within the active
  structure. An empty slot keeps its marker size and position when entered,
  with the math caret centered inside it.
  Empty-marker centers come from the native insertion stop and painted caret
  baseline; clicking the marker resolves that same offset. The caret is not
  translated to match a separate cell-center estimate.
  Guides retain stable click targets and never enter source,
  clipboard content or printed output.
- Ordinary table cells use no slot markers; math inside a table keeps math markers.
  Every table edge is visible as either its printed rule or a faint dashed editing
  guide for the missing segment, with thin strokes and short dashes that stay
  consistent across zoom changes. Real borders are never overpainted by guides,
  including shared edges and merged cells. New tables use a full grid and focus
  the first cell instead of selecting the whole table.
- Basic and styled frame contents stay editable on paper, including nested tables,
  split box regions and framed listings. Unsupported box source remains editable
  in place; its source field can shrink to one line without discarding text.
- Ordinary Visual typing uses existing source-block capabilities and paints before
  coalesced source conversion. Structural commands retain source validation;
  protected structures keep disabled controls. Failed publication retains exact
  input for recovery. Save preparation flushes pending fields, including table
  cells. Save/conflict notices use a compact status strip outside the paper with
  shared Open Source and draft controls.
- Math formatting commands such as `\text`, `\textbf`, `\mathbf`, `\mathbb`
  and `\mathcal` complete with a
  braced empty argument and focus its editable slot. Keyboard acceptance and
  suggestion clicks share this behavior. Symbols insertion wraps selected
  content or opens an empty slot, with text/math mode matching the command.
  Formatting arguments retain an editable scope instead of becoming flat font
  runs. Insertion shows a caret inside the argument, typing retains its alphabet,
  and Enter formatting/Leave parent cross its boundary. Nested formatting remains
  separate Ctrl+A steps. Empty formatting slots are restored
  when loading source, and placeholder tokens stay out of saved LaTeX. Custom
  document macros retain their own definitions and completion behavior.
- Backslash completion shows insertion templates with required argument braces,
  including text/math formatting and document macro arity. Color arguments offer
  standard and document-defined colors and xcolor mix values. Completion also
  works in Visual prose/table text and Source; accepting a math command from
  prose creates inline math. It uses an anchored suggestion list with retained
  insertion position, without adding toolbar actions or menu explanations.
- Caret target (positioning still open): use local text color and size, with one thin stroke. Inside an accent
  body such as `\hat{...}`, the painted caret is 15% shorter with its baseline
  preserved. This does not resize the expression. Editing carets pause while a
  menu owns focus and remain hidden during content/cell selection.
- Selection target (math positioning still open): ordinary text selection can cross formatting wrappers. Crossing structural math
  branches includes their owner; crossing sibling grid cells selects a rectangle
  including empty cells. Crossing an outer cell includes its nested grid.
  Math uses one pointer-selection handler and one overlay painter. Complete cells
  and partial ranges share glyph/rule bounds; equation rows remain separate
  highlights with row spacing clear, regardless of trailing punctuation. Explicit
  cell selection retains the same cell range through later selection notifications.
  Shift+Arrow, dragging and Shift-click share the same resolver and original
  anchor/head, including after structural snapping. Either input method can
  continue or shrink the other's selection; menu use retains these endpoints.
- Selection highlights and slot guides follow document scrolling using current
  screen coordinates, including while menus retain the selection. Wide display
  math pans horizontally after entering it, through trackpad gestures or
  Shift+wheel and caret following, without a scroll bar or range control. Its
  highlights clip to the visible math viewport.
- A base and its superscript/subscript share one outer selection boundary.
  Crossing out of the base or script includes both, including when the pointer
  leaves `\left(x\right)^2` through its base without entering the exponent.
  Selection inside the body or exponent remains precise. Whole-structure scopes
  include the scripts. Selecting a complete base also includes any detached
  scripts; the highlight measures their ink even when the parent has no rendered
  wrapper covering them. What is highlighted matches the range used by edits.
  A complete underbrace uses one connected blue highlight
  across its body, brace and label; selecting only its label or formatted text
  keeps the highlight within that selection.
- Left/right movement follows the existing text engine, including Hebrew. Math
  array exits use the innermost array; repeated vertical moves retain horizontal
  intent. Tab/Shift+Tab visit structural math slots and empty cells without extra
  formatting stops.
- Ctrl+Enter (Cmd on macOS) splits the active math flow at the caret and places
  the caret at the start of the new row. A single-line flow becomes `gathered`;
  existing matrices/cases/aligned rows retain their columns, moving the current
  cell's suffix and later cells below. Nested bodies keep their surrounding
  structure. Empty rows remain editable. This follows the existing undo/save
  path, row-count limit and imported numbering protections, without menu changes.
- Expand/shrink selection use Alt+Shift+Up/Down. Leave parent before/after uses
  Ctrl+Alt+Left/Right (Cmd on macOS). These are configurable in the existing
  shortcut settings. Expansion can pass from a nested editor to its containing
  table/document; shrinking returns to the prior selection. Leaving a text style
  removes that typing style while retaining other active formatting.
- Enter formatting uses Ctrl+Alt+Down (Cmd on macOS). It keeps the caret at the
  same text position and activates the adjacent authored span, including colored
  text and inline frames. At a shared boundary it re-enters the span just left,
  otherwise preferring the following span. Repeated entry visits outer then
  inner formatting. Leave parent before/after
  selects the outside typing context. Menu snapshots retain this formatting
  choice together with the range. The command is configurable in the existing
  shortcut settings; it adds no menu controls or explanations.
- Ctrl+A (owner-verified): Ctrl+A (Cmd+A on macOS) selects the innermost editing scope, then each parent
  on repeated presses, with no fixed number of levels. For an underbrace label,
  this visits Bold → Label → Underbrace → Equation → enclosing content.
  Distinct scopes remain separate steps even when their ranges match. Clicking,
  moving the caret or typing starts a new sequence; menu use preserves it.
  Document selection highlights every included formula, including the one where
  expansion started, even when its math editor remains active.
  It also includes tables, figures and their captions, title fields, code listings
  and source-only blocks. The document range owns one content overlay across
  these surfaces; native browser paint and inactive nested selections do not add
  another layer. Images and TikZ canvases are included, while page gaps and editing
  controls stay clear. Dragging across a block includes its whole atom; figures
  and source blocks hand an outward drag to the document. An open source field
  participates in repeated Ctrl+A expansion too.
  Parent handoff resolves the child field in the parent's document model instead
  of expanding from a stale caret. Selecting a whole figure keeps document focus;
  it does not automatically enter the caption and cancel the selection.
- Supported prose wrappers use their authored source ranges when the projection
  matches the live paragraph. Pending edits use current marked text ranges.
  Formula/table snapshots reject replaced models instead of replaying old offsets;
  prose bookmarks map through document transactions.

Source preservation and recovery behavior lives in
[Source-derived writing canvas](../internals/scient-latex-visual.md#source-and-editing).
The remaining performance and caret/selection work is tracked in its
[Remaining fixes](../internals/scient-latex-visual.md#remaining-fixes) section.
