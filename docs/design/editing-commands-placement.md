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
| Subscript, Superscript | — | — | **Text › Formatting** (new, both can store it) |
| Clear formatting | More | — | **Text › Formatting** |
| Font size | — | — | **Text › Size** (LaTeX only, later) |
| Text direction (Auto, LTR, RTL) | Bar | — | **Text › Direction** (Markdown only) |
| Bullet list, Numbered list, No list | Lists menu | Lists menu | **Lists** |
| Task list | Lists menu | — | **Lists** (Markdown only) |
| Link | Bar | Bar, and again in Insert | **Insert** (one place) |
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
| Inline math, Display math | Insert (display only) | Math menu | **Math** |
| Aligned equations, Matrix, Cases | — | Math menu | **Math** (Markdown: whatever it can store) |
| Symbols & structures | Ω button in the bar | Math menu | **Math** |
| Title & authors | — | Document menu | **Document** (LaTeX only) |
| Document settings | — | Document menu | **Document** (LaTeX only) |
| Document outline | More | Sidebar button in the header | **Document** in Markdown; the sidebar in LaTeX |
| Find and replace | More | Header search field, and header More | **Document** in Markdown; header in LaTeX |
| Move block up/down, Duplicate, Delete block | More | — | **Document** (Markdown only), or a menu on the block itself |
| Export | More | Header More | **Document** in Markdown; header in LaTeX |
| Keyboard shortcuts | More | Document menu | **Document** |
| Hide formatting tools | Bar (left handle) | — | Open decision (one rule for both) |
| Table rows, columns, alignment | Footer | Footer | Footer (unchanged) |
| Figure, equation, statement options | — | Footer | Footer (unchanged) |

## Decisions for the owner

1. **Link.** Proposed: Insert, with Citation, Cross-reference and Footnote. A
   link is what the text points to, not how it looks; Cmd+K stays.
2. **Bold and Italic inside Text › Formatting.** Option A as decided; their
   on/off state shows only inside the menu.
3. **Math in Markdown.** Proposed: the same Math menu, replacing the Ω button
   and the display-math item in Insert.
4. **Markdown's More becomes Document**, so both editors end with the same menu.
5. **Text direction** moves into Text (Markdown only), freeing a bar button.
6. **Subscript and superscript**: add them to both now, or later.
