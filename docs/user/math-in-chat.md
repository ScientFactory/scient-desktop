# Math in chat

Mathematical notation in chat responses renders as typeset math instead of
raw notation.

- Inline math, within a sentence: `$$...$$` or `\(...\)`.
- Block math, shown centered on its own line: `\[...\]` anywhere — even
  mid-paragraph, where it breaks the text the way TeX does — `$$...$$` alone
  on its line, or a ` ```math ` fence.

Rendered Markdown file previews get the same treatment.

Single dollar signs are never interpreted as math. Prices like "it costs $5
and $10 today", shell variables like `$PATH`or`$HOME/bin:$PATH`, dollars
inside file paths, links, and code — and also well-formed spans like `$x^2$`— all stay exactly as written. To typeset an expression, use`$$x^2$$`or`\(x^2\)`.

An equation still being written — for example while a response is streaming —
stays as typed until its closing delimiter arrives, then renders. If a formula
can't be rendered, or is unreasonably large, Scient shows the original
notation as typed instead of an error.

Math renders locally on your device; no network request is involved.
