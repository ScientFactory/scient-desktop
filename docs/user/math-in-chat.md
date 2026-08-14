# Math in chat

Mathematical notation in chat responses renders as typeset math instead of
raw notation.

- Inline math, within a sentence: `$x^2$`, `$$...$$`, or `\(...\)`.
- Block math, shown centered on its own line: `\[...\]` anywhere — even
  mid-paragraph, where it breaks the text the way TeX does — `$$...$$` alone
  on its line, or a ` ```math ` fence.

Rendered Markdown file previews get the same treatment.

Ordinary dollars stay text. Single-dollar math renders only when the span
actually reads as math: prices like "it costs $5 and $10 today", shell
variables like `$PATH`or`$HOME/bin:$PATH`, and dollars inside file paths,
links, and code all stay exactly as written. When a dollar span is ambiguous,
Scient leaves it as typed — `$$x^2$$`and`\(x^2\)` always typeset.

An equation still being written — for example while a response is streaming —
stays as typed until its closing delimiter arrives, then renders. If a formula
can't be rendered, or is unreasonably large, Scient shows the original
notation as typed instead of an error.

Math renders locally on your device; no network request is involved.
