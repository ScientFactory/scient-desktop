# Every editing command, and where it should live

Agreed between the owner and the LaTeX Visual author, 2026-10-03 (first
discussed in #450). Read from the Markdown bar and the LaTeX Visual writing row,
with their menus. "—" means the editor does not
have it. The last column records the proposed homes and the owner's decisions. The decided
layout, including the shared Text menu with hover cards, is implemented in this
branch.

## Proposed bar, in both editors

```
Undo  Redo | Text ▾ | Insert ▾ | Math ▾ | Lists ▾ | Document ▾
```

Each menu has the same name, place and order in both editors; each editor lists
only what its file format can save.

## The list

| Command                                     | Markdown today        | LaTeX today                          | Proposed home                                                                          |
| ------------------------------------------- | --------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| Undo, Redo                                  | Bar                   | Bar                                  | Bar                                                                                    |
| Paragraph, Heading 1–6 / Section…           | Style menu            | Style menu                           | **Text › Paragraph style** — decided, in pilot                                         |
| Numbered headings                           | —                     | Style menu                           | **Text › Paragraph style** (LaTeX only) — decided, in pilot                            |
| Quote                                       | Style menu            | Style menu                           | **Text › Paragraph style** — decided, in pilot                                         |
| Bold                                        | Bar                   | Bar                                  | **Text › Formatting** — decided, in pilot                                              |
| Italic                                      | Bar                   | Bar                                  | **Text › Formatting** — decided, in pilot                                              |
| Strikethrough                               | Bar                   | —                                    | **Text › Formatting** (Markdown only) — decided, in pilot                              |
| Inline code                                 | Bar                   | Bar                                  | **Text › Formatting** — decided, in pilot                                              |
| Subscript, Superscript                      | —                     | —                                    | Not now (decided)                                                                      |
| Clear formatting                            | More                  | —                                    | **Text › Formatting** — decided, in pilot                                              |
| Font size                                   | —                     | —                                    | **Text › Size** (LaTeX only, later)                                                    |
| Text direction (Auto, LTR, RTL)             | Bar                   | —                                    | **Text › Direction** (Markdown only) — decided                                         |
| Bullet list, Numbered list, No list         | Lists menu            | Lists menu                           | **Lists**                                                                              |
| Task list                                   | Lists menu            | —                                    | **Lists** (Markdown only)                                                              |
| Link                                        | Bar                   | Bar, and again in Insert             | **Insert › References** — decided; Cmd+K stays                                         |
| Table (size picker)                         | Insert                | Insert                               | **Insert**                                                                             |
| Image / Figure                              | Insert (Image)        | Insert (Figure)                      | **Insert**                                                                             |
| Code block                                  | Insert                | Insert › More                        | **Insert**                                                                             |
| Footnote                                    | Insert                | Insert                               | **Insert › References**                                                                |
| Citation, Cross-reference                   | —                     | Insert                               | **Insert › References** (LaTeX only)                                                   |
| Wiki link                                   | Insert                | —                                    | **Insert › References** (Markdown only)                                                |
| Divider line / Page break                   | Insert                | Insert › More                        | **Insert**                                                                             |
| Line break                                  | Insert                | —                                    | **Insert** (Markdown only)                                                             |
| Theorems & proofs                           | —                     | Insert › submenu                     | **Insert** (LaTeX only)                                                                |
| Abstract, Table of contents, Bibliography   | —                     | Insert › More                        | **Insert › Document blocks** (LaTeX only)                                              |
| Literal text                                | —                     | Insert › More › Other blocks         | **Insert**, directly beneath Code block                                                |
| Long quotation, Part                        | —                     | Insert › More › Other blocks         | **Text › Paragraph style**; retain block insertion behavior                            |
| Left-aligned / Right-aligned text           | —                     | Insert › More › Other blocks         | **Text › Alignment**; retain block insertion behavior                                  |
| Question and solution, Subquestions, Verse  | —                     | Insert › More › Other blocks         | Removed from creation menus; existing content stays supported                          |
| Inline math, Display math                   | Insert (display only) | Math menu                            | **Math** — decided                                                                     |
| Aligned equations, Matrix, Cases            | —                     | Math menu                            | **Math** (Markdown: whatever it can store)                                             |
| Symbols & structures                        | Ω button in the bar   | Math menu                            | **Math** — decided                                                                     |
| Title & authors                             | —                     | Document menu                        | **Document** (LaTeX only)                                                              |
| Document settings                           | —                     | Document menu                        | **Document** (LaTeX only)                                                              |
| Document outline                            | More                  | Sidebar button in the header         | **Document** in Markdown; the sidebar in LaTeX                                         |
| Find and replace                            | More                  | Header search field, and header More | **Document** in both — decided (the header search field stays in LaTeX)                |
| Move block up/down, Duplicate, Delete block | More                  | —                                    | **Document** (Markdown only), or a menu on the block itself                            |
| Export                                      | More                  | Header More                          | **Document** in both — decided (LaTeX PDF and Source views keep it in the header More) |
| Keyboard shortcuts                          | More                  | Document menu                        | **Document**                                                                           |
| Hide formatting tools                       | Bar (left handle)     | —                                    | Keep in Markdown — decided                                                             |
| Table rows, columns, alignment              | Footer                | Footer                               | Footer (unchanged)                                                                     |
| Figure, equation, statement options         | —                     | Footer                               | Footer (unchanged)                                                                     |

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
| 7   | Screen-blocking editing dialogs?                         | **None wanted.** Link becomes a compact popover; remaining modal controls are inventoried below for conversion.                                                                                                              |

The decisions above are implemented in this branch.

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

## Still open

3. **Font size** in Text › Size (LaTeX only): which sizes, and when.

## Screen-blocking dialogs (owner review, 2026-10-03)

**Decision:** editing controls must not block the document with a modal backdrop.
Use compact anchored popovers for short forms; larger settings and reference
workflows need a nonmodal panel. Link uses a nonmodal popover; Document settings uses a hover submenu in the local
pilot. This inventory is based on current pilot source inspection,
not a visual or native interaction sweep; size varies by window.

| Action / entry point                                         | Markdown                                                  | LaTeX Visual                                                                                                    | Status / proposed replacement                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Insert › References › Link; link keyboard shortcut           | Compact nonmodal popover                                  | Changed from modal to compact nonmodal popover beside Insert (256px, capped to viewport)                        | **Implemented.** Text and address fields retained; no screen backdrop.                                                                                                                                                                                          |
| Insert › Figure                                              | Local image controls; no corresponding editor modal found | Modal figure form                                                                                               | Pending: anchored figure popover or nonmodal panel.                                                                                                                                                                                                             |
| Insert › References › Citation                               | Unavailable                                               | Modal reference picker                                                                                          | Pending: nonmodal source picker panel.                                                                                                                                                                                                                          |
| Insert › References › Cross-reference                        | Unavailable                                               | Same modal reference picker                                                                                     | Pending: anchored picker or nonmodal panel.                                                                                                                                                                                                                     |
| Insert › Document blocks › Bibliography                      | Unavailable                                               | Modal bibliography form                                                                                         | Pending: compact popover or nonmodal panel.                                                                                                                                                                                                                     |
| Document › Document settings                                 | Unavailable                                               | Hover submenu beside the Document settings item (384px, capped to viewport); smaller controls in the same style | **Implemented.** No repeated title or whole-document description. Paper size and Orientation side by side; Top, Right, Left, Bottom in one row under Margin. Narrow margin fields beneath a distinct semibold Margin heading; margin help removed. No backdrop. |
| Title & authors: missing title or custom formatting fallback | Unavailable                                               | Modal Document title guidance                                                                                   | Pending: inline guidance or compact popover. Ordinary title fields are inline, not modal.                                                                                                                                                                       |
| Keyboard shortcuts (Markdown More / LaTeX Document)          | Large modal shortcut settings                             | Same large modal shortcut settings                                                                              | Pending: nonmodal shortcuts panel.                                                                                                                                                                                                                              |
| Keyboard shortcuts › My shortcut reference                   | Nested modal reference sheet                              | Same nested modal reference sheet                                                                               | Pending: view within shortcuts panel.                                                                                                                                                                                                                           |
| Keyboard shortcuts › New/Edit math action                    | Nested modal action form                                  | Same nested modal action form                                                                                   | Pending: compact form within shortcuts panel.                                                                                                                                                                                                                   |
| Export › Word                                                | Modal export/progress/install UI                          | Same modal export/progress/install UI                                                                           | Pending: nonmodal export panel or status popover. Native file-save windows are separate OS UI.                                                                                                                                                                  |
| Matrix action through LaTeX's overflow command path          | Math palette is nonmodal                                  | Modal matrix form still wired to the overflow action; normal Math menu uses the compact grid picker             | Pending: reuse compact grid picker for overflow too.                                                                                                                                                                                                            |

The unused standalone Table insertion dialog has been removed; Table uses the
compact size picker. Math symbols, normal Matrix picker, menus,
Find, outline and inline object/footer controls do not use these modal dialogs.

Source owners: `apps/web/src/scient/latex/LatexLinkDialog.tsx`,
`LatexFigureInsertDialog.tsx`, `LatexReferenceDialog.tsx`,
`LatexBibliographyDialog.tsx`, `LatexDocumentSettings.tsx`,
`LatexVisualEditor.tsx`, `LatexMatrixDialog.tsx`;
`apps/web/src/scient/keyboard/WritingShortcutsDialog.tsx`,
`ShortcutReference.tsx`, `CustomMathActionDialog.tsx`;
`apps/web/src/scient/wordExport/WordFileExportDialog.tsx`.

## Local alignment review (2026-10-06)

Reference: [the owner's placement branch](https://github.com/ScientFactory/scient-desktop/blob/claude/editing-commands-placement-20261003/docs/design/editing-commands-placement.md).
The notes below describe the source in the local `codex/source-derived-writing-canvas`
working tree, including uncommitted changes. They update implementation status;
they do not establish new owner decisions or runtime qualification.

- The shared bar keeps **Text → Insert → Math → Lists → Document**, following
  Undo/Redo. Object options use named controls opening panels above the footer.
- Heading exception (owner approved October 6): show only **Label** directly in
  the footer, without a Heading popup or duplicate Numbered toggle. Numbering
  remains in Text. Labels commit on Enter/blur, and single-file renames update
  recognized references through the existing source-preserving rename operation.
- Title block (owner approved October 6): remove its contextual footer. Title,
  author and date remain editable on paper; title actions stay in **Document →
  Title & authors**. Existing custom title protections remain in place.
- Inline math exception (owner approved October 6): show **Edit LaTeX** directly
  in the compact footer and **Rows & columns** only inside a math grid. The
  Inline math inspector and duplicate Math/Symbols controls are removed; the
  top Math menu retains those actions. Formula source opens above the footer.
  Native interaction qualification for these controls remains pending.
- Display math/equation footer (owner approved October 6): show **Edit LaTeX**,
  **Numbered**, and a compact **Label** field only when numbered, directly in the
  footer. Numbered uses the compact on/off switch style of section numbering.
  **Rows & columns** uses the same conditional menu as inline math.
  Remove the overall Equation inspector, duplicated Math/Symbols controls, and
  the numbering-scope dropdown. Ordinary displays become equations when numbered;
  existing align/gather blocks retain their row scope. Single outer labels survive
  numbering changes; tags and per-row metadata remain protected. The source editor
  opens above the footer. This supersedes the earlier Scroll footer control:
  horizontal/Shift-wheel panning remains available while editing wide formulas.
  Native interaction qualification remains pending.
- Table footer (owner approved October 6): show **Rows & columns**, **Cells**,
  **Appearance**, **Caption**, and a compact **Label** for captioned tables directly.
  Remove the overall Table inspector. Structural menus retain the selected cells;
  Per the owner's follow-up, remove Select table, Select row, Select column and Clear cells from the menus
  and defer table color controls at that review. The October 7 author request
  below adds table colors to the planned footer work. Appearance uses the shared menu and switch
  styles, with Rules, Width, Header row, Column, Borders and Layout; only column
  dimensions and longtable continuation need compact forms in submenus.
  Caption focuses content on the paper;
  labels commit on Enter/blur and reject invalid or duplicate keys. Table numbering
  follows the caption, without a separate Numbered toggle. Native interaction
  qualification remains pending.
- Figure footer (owner approved October 7): standard image figures show
  **Replace**, **Appearance**, **Caption**, and a compact **Label** for captioned
  figures directly in the fixed-height footer. Replace chooses a project image
  or imports a PNG/JPEG, preserving the figure's settings. Appearance groups
  width, alignment, caption position and float placement in shared menus.
  Caption edits its text on paper; clearing it removes the figure number and
  label, and both can be added again. Labels commit on Enter/blur and reject
  invalid or duplicate keys. Imported figure panels retain their existing
  dedicated controls. Native interaction qualification remains pending.
- Statement footer (owner approved October 7): show the statement type selector,
  **Title**, and a compact **Label** directly, with no overall Statement popup.
  Type uses existing document definitions. Title only activates editing at its
  printed location on paper; clearing it removes the optional argument, and an
  extra delete in the empty field returns the caret to the statement body.
  The footer retains its context after title removal and app focus changes.
  Clicking the printed title places the caret at the click; the footer's Title
  action enters at its beginning.
  Labels can be added, edited or removed, validate keys and duplicates, and share
  heading label renaming for recognized references in single-file documents.
  Proofs show only **Title**. Numbering follows the document definitions.
  Native interaction qualification remains pending.
- Algorithm footer (owner approved October 7): show **Steps**, **Appearance**,
  **Caption**, and a compact **Label** for captioned floats directly, with no
  overall Algorithm popup. Steps groups insertion, wrapping, comments, branches,
  movement and deletion; complete structures stay paired, and menus preserve
  the editing selection. Insert creates new content; Wrap encloses existing steps.
  Remove wrapper is absent from the footer; Backspace/Delete on an empty opening
  or closing line removes its structure while preserving the enclosed content.
  The deletion command is **Delete step**. Appearance contains a **Line numbers**
  toggle using the same shared switch as Numbered headings, keeping the menu open,
  and float placement. Caption activates editing on paper; clearing it removes its number
  and label, and an extra delete in an empty caption returns to the body.
  Label shares duplicate validation and single-file reference renaming.
  Standalone algpseudocode shows only Steps and Appearance with line numbers.
  Native interaction qualification remains pending.
- Code footer (owner approved October 7): show **Language**, **Appearance**,
  **Caption**, and a compact **Label** for captioned listings directly, without
  an overall Code popup. Language uses compact shared menu rows, with a search
  field that fits the popup and readable language names; imported choices retain
  their source values.
  Appearance groups frame, wrapping, font size, tab width, line numbering and
  caption position using the shared menu controls and heading-style switches.
  Caption edits on paper, removes its number/label when cleared, and returns to
  code on an extra empty delete. Listing labels share duplicate checking,
  single-file renaming and reference navigation. Syntax color and Delete code block
  buttons are absent. Literal verbatim blocks keep direct editing without a footer.
  Native interaction qualification remains pending.
- Box footer (owner approved October 7): show **Appearance** and **Title** directly,
  without an overall Box popup. Appearance groups background, border color and
  thickness (including no border), corners, padding and Allow page breaks using
  shared menus and the heading-style switch. Corners offers Square/Rounded;
  Padding offers None/Compact/Normal/Spacious. Exact radius and padding fields
  sit under Custom, keeping the main submenus as simple choice lists. Custom
  dimension panels fit their contents, reserve the widest unit option, and cap
  their width to the available space; controls wrap in narrow panels.
  Title activates editing on paper;
  clearing it removes the title option, and an extra empty delete returns to the
  box body. Printed-title clicks retain their clicked caret position. Ordinary
  boxes have no Caption, Numbered, Label or Delete box controls. Imported options
  remain intact when an unrelated property changes.
  Native interaction qualification remains pending.
- Source-only blocks (owner approved October 7) have no contextual footer.
  Delete lives in the block header; explicit removal deletes only that block's
  source and participates in document undo. Apply LaTeX and Cancel stay inside
  the block while its source editor is open. Stale source and unrelated pending
  drafts remain protected; ordinary selection cannot delete across these blocks.
- Remaining footer cleanup (owner requested October 7): ordered lists expose a
  compact **Numbering** menu with format, Start at and Continue previous. Description
  lists expose **Items** with Insert item/Delete item. Citations use **References**,
  **Form** and **Note**, with searchable entries and source-preserving note edits.
  Cross-references use a searchable **Target** menu. Links expose **Text** to edit
  plain content on paper, plus **Address** or **Target** for metadata. Footnotes expose
  **Edit text** beside their marker; formatted content retains Source editing.
  Part headings use the existing Numbered toggle and compact validated **Label**.
  Columns use a count menu; minipages use **Appearance** for dimensions/alignment;
  panel rows use **Layout** for ratios and spacing. Width changes retain imported
  gaps, and spacing changes retain imported widths. Multi-panel figures expose
  **Panel**, project-image **Replace**, and existing figure/panel captions and labels;
  click/focus chooses the active panel. Per the October 7 user request, TikZ and
  pgfplots render read-only with no **Drawing** menu or editable drawing labels;
  their figure captions keep existing controls. Bibliographies have no
  footer: records live in Document > References. Quotes have no object footer;
  custom referenceable environments expose only their existing **Label** fields.
  No duplicate object names, explanatory paragraphs, select-object or delete-object
  buttons appear in these footers. Nested menus share selection ownership; custom
  forms fit their contents and are capped to the available width.
  Native interaction qualification remains pending.
- **Math → Brackets** places Left/Right above Size/Match, with Insert below.
  Per the owner's October 6 decision, controls fit their widest option, the
  panel fits its contents within available space, and narrow layouts wrap rows.
  This local implementation retains shared controls and selection ownership;
  live interaction qualification remains pending.
- The Citation/Cross-reference picker now uses a nonmodal dialog without a
  backdrop in the uncommitted implementation. This supersedes those two pending
  rows in the October 3 modal inventory; focus and dismissal still need live review.
- Figure insertion, bibliography insertion, shortcut settings and Word export
  still use modal dialogs. Their conversion remains open, including the nested
  shortcut forms and the alternate matrix-dialog path.
- The extra Text, Insert and Document menu options are removed; **Math →
  Brackets** remains. The rollback is limited to those menu additions. Existing
  Hebrew document editing and the customized **Symbols** picker are retained:
  document-derived RTL/LTR and fonts, symbol families and search, square glyph
  tiles, minimal previews, bundled TeX outlines, favorites and effective shortcuts.
  Language configuration and new direction controls remain proposals below;
  reading and editing an existing Hebrew setup do not require those menu controls.

This review inspected Git history, diffs and current source. It did not run tests,
launch an app, or publish changes to the reference branch.

## Functionality to add (placement pending)

These are requested LaTeX capabilities, not approved additions to the menus.
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

Existing table, citation and other contextual-footer improvements are separate
from this menu rollback and remain in the local implementation.

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
This is requested functionality; detailed placement and implementation remain pending.

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

## Nested selection and navigation (2026-10-07)

Symbols opens explicitly from **Math → Symbols** or **Alt+I, then S**.
The local implementation replaces the Ctrl+Space default and consumes palette
open requests once, so returning to an equation does not replay a dismissed
panel. Existing custom shortcuts remain user-owned. Interaction qualification
is pending.

Local decision: use smooth ordinary cursor movement, visible editing scope, and
explicit parent navigation (choice B). This changes selection behavior and status
feedback; it adds no buttons or explanatory content to the Scient menus.

- Keyboard focus and the selected range have separate owners. Opening a menu,
  entering a submenu, or using a nested select retains the editing surface and
  selection. Commands restore the range before acting; root-menu Escape returns
  focus to the original surface. Clicking another editing location releases it.
- The footer shows the environment type, word count and contextual controls, with
  no nesting path in any context. Gray corner marks show only the innermost editing
  slot's contents and disappear during selection. Prose and math share Markdown's
  text-selection fill; rectangular cell selection shares its cell highlight.
  Retained selection has a muted fill while menus own focus. Empty and active slots
  use the same faint gray corner markers with short strokes within the active
  structure. An empty slot keeps its marker size and position when entered,
  alongside the caret.
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
- Math formatting commands such as `\text`, `\textbf`, `\mathbf`, `\mathbb`
  and `\mathcal` complete with a
  braced empty argument and focus its editable slot. Keyboard acceptance and
  suggestion clicks share this behavior. Symbols insertion wraps selected
  content or opens an empty slot, with text/math mode matching the command.
  Formatting arguments retain an editable scope instead of becoming flat font
  runs. Insertion shows a caret inside the argument, typing retains its alphabet,
  and Enter formatting/Leave parent cross its boundary. Nested formatting remains
  separate Ctrl+A steps. Native interaction qualification for this correction is pending.
  Empty formatting slots are restored
  when loading source, and placeholder tokens stay out of saved LaTeX. Custom
  document macros retain their own definitions and completion behavior.
- Carets use local text color and size, with one thin stroke. Inside an accent
  body such as `\hat{...}`, the painted caret is 15% shorter with its baseline
  preserved. This does not resize the expression. Editing carets pause while a
  menu owns focus and remain hidden during content/cell selection.
- Ordinary text selection can cross formatting wrappers. Crossing structural math
  branches includes their owner; crossing sibling grid cells selects a rectangle
  including empty cells. Crossing an outer cell includes its nested grid.
- Selection highlights and slot guides follow document scrolling using current
  screen coordinates, including while menus retain the selection. Wide display
  math pans horizontally after entering it, through trackpad gestures or
  Shift+wheel and caret following, without a scroll bar or range control. Its
  highlights clip to the visible math viewport.
- A base and its superscript/subscript share one outer selection boundary.
  Crossing out of the base or script includes both, including when the pointer
  leaves `\left(x\right)^2` through its base without entering the exponent.
  Selection inside the body or exponent remains precise. Whole-structure scopes
  include the scripts. A complete underbrace uses one connected blue highlight
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
- Ctrl+A (Cmd+A on macOS) selects the innermost editing scope, then each parent
  on repeated presses, with no fixed number of levels. For an underbrace label,
  this visits Bold → Label → Underbrace → Equation → enclosing content.
  Distinct scopes remain separate steps even when their ranges match. Clicking,
  moving the caret or typing starts a new sequence; menu use preserves it.
  Document selection highlights every included formula, including the one where
  expansion started, even when its math editor remains active.
- Supported prose wrappers use their authored source ranges when the projection
  matches the live paragraph. Pending edits use current marked text ranges.
  Formula/table snapshots reject replaced models instead of replaying old offsets;
  prose bookmarks map through document transactions.

The three math-selection rules have real Chromium regression fixtures using
MathLive and the complete Visual editor: bracket/script boundaries, connected
highlighting, and repeated Ctrl+A, including menu retention and a 13-step
sequence. Selection and movement between math/text slots leave source unchanged.
Existing Hebrew support, Symbols customization, and the owner's command-placement
decisions are retained.

Qualification before the document-highlight correction, footer simplification
and shared base/script boundary and caret/guide corrections:
16 Chromium checks and 82 focused unit checks pass; the web type check passes.
Interaction checks have not been rerun for those changes or the unified slot-marker
and table-guide refinements. Formatting and targeted lint pass (existing warnings
remain in the table/editor files); the latest web type check passes.
Browser fixtures run from `apps/web` with
`node node_modules/vitest/vitest.mjs run --config latexSelection.vitest.config.ts`.
