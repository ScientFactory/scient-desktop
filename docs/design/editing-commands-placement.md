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
| Find and replace | More | Header search field, and header More | **Document** in Markdown; header in LaTeX |
| Move block up/down, Duplicate, Delete block | More | — | **Document** (Markdown only), or a menu on the block itself |
| Export | More | Header More | **Document** in Markdown; header in LaTeX |
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

Decisions 1–4 are built in the owner's local test app for review; that code is
not pushed yet.

## Still open

1. **Bold, Italic and Inline code inside Text › Formatting** (option A: hover opens
   the second card, so two clicks), or kept as bar buttons.
2. **Markdown's More becomes Document**, so both editors end with the same menu.
3. **Font size** in Text › Size (LaTeX only): which sizes, and when.
