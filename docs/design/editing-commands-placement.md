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
  Link, then Footnote after a separator. Theorems & proofs also contains Question
  and solution and Subquestions. Document blocks contains Abstract,
  Table of contents, Bibliography, Verse.
- **Markdown:** Image, Table, Code block; References; Divider line, Line break.
  References contains Link, Wiki link, then Footnote after a separator.
- More and Other blocks are removed from LaTeX Insert. Question and solution,
  Subquestions remain under Theorems & proofs; Verse remains under Document blocks.
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

`LatexTableInsertDialog.tsx` also contains a modal, but has no callers in the
current source; it is not listed as a reachable control. The normal Table
size picker is already compact. Math symbols, normal Matrix picker, menus,
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
  and defer table color controls. Appearance uses the shared menu and switch
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

## Nested selection and navigation (2026-10-07)

Local decision: use smooth ordinary cursor movement, visible editing scope, and
explicit parent navigation (choice B). This changes selection behavior and status
feedback; it adds no buttons or explanatory content to the Scient menus.

- Keyboard focus and the selected range have separate owners. Opening a menu,
  entering a submenu, or using a nested select retains the editing surface and
  selection. Commands restore the range before acting; root-menu Escape returns
  focus to the original surface. Clicking another editing location releases it.
- The footer shows the nesting path; faint outlines distinguish active scope from
  selected content. Retained selection has a muted fill while menus own focus.
  Guides remain visible during menu use and do not enter source, clipboard, or
  printed output.
- Ordinary text selection can cross formatting wrappers. Crossing structural math
  branches includes their owner; crossing sibling grid cells selects a rectangle
  including empty cells. Crossing an outer cell includes its nested grid.
- Left/right movement follows the existing text engine, including Hebrew. Math
  array exits use the innermost array; repeated vertical moves retain horizontal
  intent. Tab/Shift+Tab visit structural math slots and empty cells without extra
  formatting stops.
- Expand/shrink selection use Alt+Shift+Up/Down. Leave parent before/after uses
  Ctrl+Alt+Left/Right (Cmd on macOS). These are configurable in the existing
  shortcut settings. Expansion can pass from a nested editor to its containing
  table/document; shrinking returns to the prior selection. Leaving a text style
  removes that typing style while retaining other active formatting.
- Supported prose wrappers use their authored source ranges when the projection
  matches the live paragraph. Pending edits use current marked text ranges.
  Formula/table snapshots reject replaced models instead of replaying old offsets;
  prose bookmarks map through document transactions.

Implementation is local and uncommitted. Static checks are recorded in the task
report; live interaction qualification remains pending. Existing Hebrew support,
Symbols customization, and the owner's command-placement decisions are retained.
