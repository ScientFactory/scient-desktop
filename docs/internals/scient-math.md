# Scient math rendering

Status: implemented in the T3-derived candidate; local rendering only.

## Ownership

Scient owns `apps/web/src/scient/math`: remark-math configuration, delimiter
normalization, the KaTeX runtime, the rendering components, and the stylesheet.
`katex` (0.16.47) and `remark-math` (6.0.0) are exact-pinned in `apps/web`.
KaTeX and its stylesheet/woff2 fonts ship in a lazily loaded chunk — no CDN
request. Vite emits the fonts because `katex/dist/katex.min.css` references
them through statically analyzable `url()` declarations; unlike pdf.js
(`apps/web/scripts/scientPdfAssets.ts`), no custom asset plugin is needed.

## ChatMarkdown seam

The inherited-host seam is `ChatMarkdown.tsx` only: the import block for the
three math modules, `remarkScientMath` added to both remark plugin arrays, one
`useScientMathMarkdownText` call gated on `onTaskListChange === undefined`,
and two `components` branches — `code` routes `language-math` nodes to
`ScientInlineMath`, `pre` routes them to `ScientDisplayMath`. The gate exists
because task-list toggling writes back through character offsets into the
original message string, and rewriting delimiters would shift those offsets.
`FilePreviewPanel.tsx` (rendered Markdown file previews) is the only caller
that passes `onTaskListChange`, so delimiter rewriting is disabled exactly
there; dollar-delimited math still renders in that surface, just without
backslash-delimiter normalization.

## Delimiter policy

Models emit `\(...\)` and `\[...\]`. `normalizeScientMathDelimiters` rewrites
both to dollar forms outside fenced code blocks and inline code spans, which
is where `useScientMathMarkdownText` runs before the raw text reaches
react-markdown. remark-math only opens a display block when `$$` starts its
own line, so an own-line `\[...\]` becomes a `$$` fence, replaying the
opening line's indentation so the fence still nests correctly inside a list;
a mid-sentence `\[...\]` instead degrades to inline `$...$`. Single-dollar
math is enabled (`singleDollarTextMath: true`), and the currency guard
(`isLikelyCurrencyText`) renders digit-only and digit-led-prose TeX back as
literal text at the component level, because the parser itself cannot tell a
price like `$5 and $10` from an intended math span.

## Detection

The sanitize schema keeps only `language-*` classes on `code` elements
(`hast-util-sanitize`'s default schema restricts `code` to
`[['className', /^language-./]]`), so math code nodes are recognized by
`language-math` alone — the `math-inline`/`math-display` classes remark-math
also adds do not survive. Inline versus display is decided by the surrounding
element instead: a bare `code` node is inline, one wrapped in `pre` is
display. ` ```math ` fences render as display math, matching GitHub.

## Rendering

`renderScientTexToHtml` calls `katex.renderToString(tex, { displayMode,
throwOnError: false, strict: "ignore" })`, leaving `trust` (default `false`)
and `output` (default `htmlAndMathml`) at their KaTeX defaults. Rendered HTML
is cached in an LRU cache (500 entries / 5 MiB), with cache writes performed
in an effect after render. `RenderErrorBoundary` and `Suspense` both fall back
to the literal dollar-form text — as a `<code>` element — while the KaTeX
chunk is still loading or if rendering throws.

## Verification

Coverage is co-located unit tests (`remarkScientMath.test.ts`,
`scientMathText.test.ts`, `ScientMath.test.ts`) plus
`chatMarkdownMathSeam.test.ts`, a static source audit of the `ChatMarkdown.tsx`
seam in the same style as `pdfFilePreviewSeam.test.ts`.

## Mobile

Deliberately not included. Mobile renders chat through a native Markdown
module, not this remark/rehype pipeline, so raw TeX delimiters remain legible
there as plain text rather than rendering as typeset math.

## Upstream maintenance

Do not fork T3's Markdown renderer. When `ChatMarkdown.tsx` changes upstream,
reapply this narrow adapter and rerun the focused math tests before accepting
the update. Retirement condition: if T3 adds native math rendering, drop the
Scient plugin and components and keep only delimiter normalization, if it is
still needed on top of T3's own delimiter handling.
