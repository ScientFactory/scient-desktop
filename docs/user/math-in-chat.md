# Math in chat

Mathematical notation in chat responses renders as typeset math instead of
raw notation.

- Inline math: `$...$`, `$$...$$`, or `\(...\)` within a sentence.
- Block math, shown on its own line: `$$...$$`, `\[...\]`, or a ` ```math `
  fence.

Rendered Markdown file previews get the same treatment.

Ordinary dollars stay text. Prices like "it costs $5 and $10 today", shell
variables like `$PATH`, and dollars inside file paths, links, and code are
never turned into math.

An equation still being written — for example while a response is streaming —
stays as typed until its closing delimiter arrives, then renders. If a formula
can't be rendered, or is unreasonably large, Scient shows the original
notation as typed instead of an error.

Math renders locally on your device; no network request is involved.
