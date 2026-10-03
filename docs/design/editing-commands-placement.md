# Every editing command, and where it should live

For discussion between the owner and the LaTeX Visual author, 2026-10-03. Read
from the bars pilot app (the Markdown bar and the LaTeX Visual writing row, with
their menus), which includes the Visual work from PR #353. "—" means the editor does not
have it. The last column is a proposal for option A (one Text menu, hover opens
the second card).

## Proposed bar, in both editors

```
Undo  Redo | Text ▾ | Lists ▾ | Insert ▾ | Math ▾ | Document ▾
```

Each menu has the same name, place and order in both editors; each editor lists
only what its file format can save.

## The list

| Command | Markdown today | LaTeX today | Proposed home |
| --- | --- | --- | --- |
| Undo, Redo | Bar | Bar | Bar |
| Text, Heading 1–6 / Section… | Style menu | Style menu | **Text** |
| Numbered headings | — | Style menu | **Text** (LaTeX only) |
| Quote | Style menu | Style menu | **Text** |
| Bold | Bar | Bar | **Text › Formatting** |
| Italic | Bar | Bar | **Text › Formatting** |
| Strikethrough | Bar | — | **Text › Formatting** (Markdown only) |
| Inline code | Bar | Bar | **Text › Formatting** |
| Subscript, Superscript | — | — | Not now (decided) |
| Clear formatting | More | — | **Text › Formatting** |
| Font size | — | — | **Text › Size** (LaTeX only, later) |
| Text direction (Auto, LTR, RTL) | Bar | — | **Text › Direction** (Markdown only) — decided |
| Bullet list, Numbered list, No list | Lists menu | Lists menu | **Lists** |
| Task list | Lists menu | — | **Lists** (Markdown only) |
| Link | Bar | Bar, and again in Insert | **Insert** (one place) — decided; Cmd+K stays |
| Table (size picker) | Insert | Insert | **Insert** |
| Image / Figure | Insert (Image) | Insert (Figure) | **Insert** |
| Code block | Insert | Insert › More | **Insert** |
| Footnote | Insert | Insert | **Insert** |
| Citation, Cross-reference | — | Insert | **Insert** (LaTeX only) |
| Wiki link | Insert | — | **Insert** (Markdown only) |
| Divider line / Page break | Insert | Insert › More | **Insert** |
| Line break | Insert | — | **Insert** (Markdown only) |
| Theorems & proofs | — | Insert › submenu | **Insert** (LaTeX only) |
| Abstract, Table of contents, Bibliography, other blocks | — | Insert › More | **Insert › More** (LaTeX only) |
| Inline math, Display math | Insert (display only) | Math menu | **Math** — decided |
| Aligned equations, Matrix, Cases | — | Math menu | **Math** (Markdown: whatever it can store) |
| Symbols & structures | Ω button in the bar | Math menu | **Math** — decided |
| Title & authors | — | Document menu | **Document** (LaTeX only) |
| Document settings | — | Document menu | **Document** (LaTeX only) |
| Document outline | More | Sidebar button in the header | **Document** in Markdown; the sidebar in LaTeX |
| Find and replace | More | Header search field, and header More | **Document** in both — decided (the header search field stays in LaTeX) |
| Move block up/down, Duplicate, Delete block | More | — | **Document** (Markdown only), or a menu on the block itself |
| Export | More | Header More | **Document** in both — decided (LaTeX PDF and Source views keep it in the header More) |
| Keyboard shortcuts | More | Document menu | **Document** |
| Hide formatting tools | Bar (left handle) | — | Keep in Markdown — decided |
| Table rows, columns, alignment | Footer | Footer | Footer (unchanged) |
| Figure, equation, statement options | — | Footer | Footer (unchanged) |

## Decided (owner, 2026-10-03)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Where does Link go? | **Insert**, next to Citation, Cross-reference and Footnote. No Link button in the bar; Cmd+K stays. |
| 2 | How does the Insert button look? | **The word "Insert"**, not a plus icon. |
| 3 | Math in Markdown? | **The same Math menu as LaTeX**, replacing the Ω button and the "Math equation" item in Insert. |
| 4 | Text direction? | **Moves into the Text (Style) menu** (Markdown only), freeing a bar button. |
| 5 | Subscript and superscript? | **Not now.** |
| 6 | Markdown's "hide formatting tools" handle? | **Keep it.** |
| 7 | How does the Math button look? | **The word "Math"** alone, no Σ icon, in both editors. |
| 8 | Where do Find and replace and Export go in LaTeX Visual? | **The Document menu**, with Title & authors and Document settings. The header's More then lists only what the row has no room for, and is hidden while everything fits. The Export card is only as wide as "PDF" and "Word". |
| 7 | Screen-blocking editing dialogs? | **None wanted.** Link becomes a compact popover; remaining modal controls are inventoried below for conversion. |

Decisions 1–4, 7 and 8 are built in the owner's local test app for review; that code is
not pushed yet.

## Still open

1. **Bold, Italic and Inline code inside Text › Formatting** (option A: hover opens
   the second card, so two clicks), or kept as bar buttons.
2. **Markdown's More becomes Document**, so both editors end with the same menu.
3. **Font size** in Text › Size (LaTeX only): which sizes, and when.

## Screen-blocking dialogs (owner review, 2026-10-03)

**Decision:** editing controls must not block the document with a modal backdrop.
Use compact anchored popovers for short forms; larger settings and reference
workflows need a nonmodal panel. Link and Document settings have been converted in the local
pilot so far. This inventory is based on current pilot source inspection,
not a visual or native interaction sweep; size varies by window.

| Action / entry point | Markdown | LaTeX Visual | Status / proposed replacement |
| --- | --- | --- | --- |
| Insert › Link; link keyboard shortcut | Compact nonmodal popover | Changed from modal to compact nonmodal popover beside Insert (256px, capped to viewport) | **Fixed in local pilot; code not pushed.** Text and address fields retained; no screen backdrop. |
| Insert › Figure | Local image controls; no corresponding editor modal found | Modal figure form | Pending: anchored figure popover or nonmodal panel. |
| Insert › Citation | Unavailable | Modal reference picker | Pending: nonmodal source picker panel. |
| Insert › Cross-reference | Unavailable | Same modal reference picker | Pending: anchored picker or nonmodal panel. |
| Insert › More › Bibliography | Unavailable | Modal bibliography form | Pending: compact popover or nonmodal panel. |
| Document › Document settings | Unavailable | Nonmodal popover beside Document, with the original card layout and controls (512px, capped to viewport) | **Fixed in local pilot; code not pushed.** Original sizes, spacing, labels and help restored at the owner's request; redesign deferred. No backdrop. |
| Title & authors: missing title or custom formatting fallback | Unavailable | Modal Document title guidance | Pending: inline guidance or compact popover. Ordinary title fields are inline, not modal. |
| Keyboard shortcuts (Markdown More / LaTeX Document) | Large modal shortcut settings | Same large modal shortcut settings | Pending: nonmodal shortcuts panel. |
| Keyboard shortcuts › My shortcut reference | Nested modal reference sheet | Same nested modal reference sheet | Pending: view within shortcuts panel. |
| Keyboard shortcuts › New/Edit math action | Nested modal action form | Same nested modal action form | Pending: compact form within shortcuts panel. |
| Export › Word | Modal export/progress/install UI | Same modal export/progress/install UI | Pending: nonmodal export panel or status popover. Native file-save windows are separate OS UI. |
| Matrix action through LaTeX's overflow command path | Math palette is nonmodal | Modal matrix form still wired to the overflow action; normal Math menu uses the compact grid picker | Pending: reuse compact grid picker for overflow too. |

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
