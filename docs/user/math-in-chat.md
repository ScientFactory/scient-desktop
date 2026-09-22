# Math in chat

Mathematical notation in chat responses renders as typeset math instead of
raw notation.

- Inline math, within a sentence: `$x^2$`, `$$...$$`, or `\(...\)`.
- Block math, shown centered on its own line: `\[...\]` anywhere — even
  mid-paragraph, where it breaks the text the way TeX does — `$$...$$` alone
  on its line, or a ` ```math ` fence.

Rendered Markdown file previews and the Markdown editor get the same treatment.

Long block equations wrap automatically at mathematical break points to fit the
available width. Fractions, matrices, grouped expressions, and authored alignment
stay intact. When one of those parts is still too wide, the equation scrolls
horizontally with a thin scrollbar. Equation numbers keep their own space and
move below when needed. This changes the presentation only; copying or editing
the equation preserves its TeX source.

Ordinary dollars stay text. Single-dollar math renders only when the span
actually reads as math: prices like "it costs $5 and $10 today", shell
variables like `$PATH`or`$HOME/bin:$PATH`, and dollars inside file paths,
links, and code all stay exactly as written. When a dollar span is ambiguous,
Scient leaves it as typed—`$$x^2$$`and`\(x^2\)` always typeset.

An equation still being written — for example while a response is streaming —
stays as typed until its closing delimiter arrives, then renders. If a formula
can't be rendered, or is unreasonably large, Scient shows the original
notation as typed instead of an error.

Math renders locally on your device; no network request is involved.
Where typeset math is unavailable, the readable TeX notation remains visible.

Scientific subscripts and charges, such as `$PCO_2$` and `$HCO_3^-$`, are
recognized as inline math. When selecting and copying rendered math, even a
partial selection of an equation copies the complete formula as Markdown/TeX.
Rich-text destinations receive that source once, alongside the surrounding
formatting, rather than a duplicate or incomplete representation of the equation.

## Authoring math

Editable Markdown and supported `.tex` / Markdown source editors share a math
command catalog. The **Ω** toolbar opens searchable symbols, fractions, roots,
equation insertion, and a matrix picker. Search for “alpha” or “beta”; Enter
inserts the first result, Down focuses the results, and arrow keys navigate them.
Escape closes the palette. Commands edit the existing source through the editor's
own transactions and undo history; they do not modify a compiled PDF.

Default examples:

| Action            | Keys                      |
| ----------------- | ------------------------- |
| Open math palette | Ctrl+Space                |
| Inline equation   | Cmd/Ctrl+M                |
| Display equation  | Cmd/Ctrl+Shift+M          |
| Alpha / beta      | Alt+M, then G, then A / B |
| Fraction          | Alt+M, then F             |

On Mac, Alt means Option and Control+M is also a math sequence prefix.
Command+M and Control+Space may be reserved by native menus or input methods.
Use the toolbar or assign an alternative in **Settings → Shortcuts**.
These are supported LyX-style math sequences, not an implementation of every LyX action.

Inside an equation, typing a recognized command such as `\alpha` then Space or
Tab completes it. The completion setting can restrict this to Tab or turn it off.
Optional automatic operators turn `->`, `<=`, `>=`, `!=`, and `+-` into
math notation. Ordinary prose, code, comments, and literal math text arguments
are not operator-completion targets.

The matrix picker supports up to 20 rows and columns, with two columns for cases
and aligned expressions. Tab and Shift+Tab navigate supported cells; Enter can add
a row. Row/column operations refuse malformed or unsupported matrices.

Source editing is conservative: ambiguous delimiters, multi-selections, opaque
LaTeX constructs, and read-only content are not rewritten. LaTeX commands needing
a package require it to be explicitly declared; the palette does not silently
change the preamble. Markdown math rendering is distinct from exact compiled TeX
layout. Visual-mode source mapping and layout integration are separate work.
