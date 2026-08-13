# Scient math rendering

Status: implemented in the T3-derived candidate; local rendering only.

## Ownership

Scient owns `apps/web/src/scient/math`: remark-math configuration, delimiter
normalization, the math refinement plugin, the KaTeX runtime, the rendering
components, and the stylesheet. `katex` (0.16.47) and `remark-math` (6.0.0)
are exact-pinned in `apps/web`. KaTeX, its stylesheet, and its distributed
fonts (WOFF2, WOFF, and TTF) ship in a lazily loaded chunk — no CDN request.
Vite emits the fonts because `katex/dist/katex.min.css` references them
through statically analyzable `url()` declarations; unlike pdf.js
(`apps/web/scripts/scientPdfAssets.ts`), no asset-serving plugin is needed.
The build does rewrite the stylesheet once:
`apps/web/scripts/scientKatexFontDisplay.ts` injects `font-display: swap`
into KaTeX's `@font-face` rules so math paints with fallback glyphs during a
cold font load instead of staying invisible.

## ChatMarkdown seam

The inherited-host seam is `ChatMarkdown.tsx` only: the import block for the
three math modules, `remarkScientMath` plus `remarkScientMathRefinements` in
both remark plugin arrays, one unconditional `useScientMathMarkdownText`
call, and two `components` branches — `code` routes `language-math` nodes to
`ScientInlineMath`, `pre` routes them to `ScientDisplayMath`. Normalization
is length-preserving (every rewrite swaps a two-character delimiter for the
two-character `$$`), so character offsets never move and offset-based
behavior — task-list toggling in rendered file previews, list-item positions
— stays correct on every surface with no per-surface gating.

## Recognition model

Recognition happens in two places, each at the altitude where its inputs are
unambiguous:

- **`normalizeScientMathDelimiters`** rewrites the backslash delimiters
  models emit — `\(...\)` and `\[...\]` — into `$$` forms on the raw string,
  because markdown escaping consumes backslashes before the tree exists. It
  refuses to touch fenced code (backtick or tilde, including unclosed
  fences), indented code lines, inline code spans, raw HTML `<code>`/`<pre>`
  regions, escaped delimiters, unmatched openers, and empty pairs.
- **`remarkScientMathRefinements`** runs on the parsed tree, where code,
  links, images, and raw HTML are structurally excluded, in three steps.
  First it downgrades incomplete or oversized math to its literal source: an
  unclosed `$$` block or ` ```math ` fence (the streaming case) and TeX
  longer than `MAX_SCIENT_TEX_LENGTH` render as plain literal blocks until a
  closing delimiter arrives. Second, a paragraph holding exactly one
  `$$...$$` span is promoted to display math — this is how own-line `\[...\]`
  and `$$x$$` become block equations, since remark-math treats single-line
  `$$...$$` as inline. Third, it recognizes single-dollar `$...$` spans in
  ordinary text under strict token rules.

`singleDollarTextMath` is deliberately off: parser-level `$...$` corrupts
link labels and destinations, file paths, shell identifiers, and prices, and
no component-level guard can repair structure the parser already destroyed.
The refinement plugin's token rules are: the opener must not follow a word
character, backslash, or dollar and must not precede whitespace; the closer
must not follow whitespace and must not precede a digit (protecting
`$5-$10`) or another dollar; the span must be single-line and within the
length bound; all-caps identifiers (`$PATH$`, `$USD$`) stay text; spaced
content must contain an operator or control sequence (`$5 and $10` stays
text, `$a + b$` is math); compact numeric spans — `$42$`, `$1/2$`,
`$12-15$` — are math. A text run containing an escaped `\$` opts out of
recognition entirely, since escaping is invisible in node values.

## Detection

The sanitize schema keeps only `language-*` classes on `code` elements, so
math code nodes are recognized by `language-math` alone. Inline versus
display is decided by the surrounding element: a bare `code` node is inline,
one wrapped in `pre` is display. ` ```math ` fences render as display math,
matching GitHub.

## Rendering

`renderScientTexToHtml` calls `katex.renderToString` with `throwOnError:
true` inside a try/catch and returns null for TeX KaTeX cannot parse; the
components then show the literal dollar-form source instead of KaTeX's red
error markup, so the malformed-math fallback matches the loading and
error-boundary fallbacks. `maxSize: 50` caps user-specified dimensions so a
pathological `\rule{500em}{500em}` cannot distort the conversation;
`maxExpand` stays at KaTeX's default 1000. `trust` (default false) and
`output` (default htmlAndMathml) keep their safe defaults. Rendered HTML is
cached in an LRU cache (500 entries / 5 MiB), with cache writes performed in
an effect after render; cache reads and writes are skipped while the message
is still streaming — matching the Shiki highlight cache — so the growing
prefixes of an unclosed block never occupy entries. Every rendered or
fallback math element carries `data-markdown-copy` with its dollar-form
source, so highlight-and-copy (`markdown-clipboard.ts`) round-trips math
instead of serializing KaTeX's DOM. The stylesheet resets the chat surface's
aggressive `overflow-wrap`/`word-break` inside equations and keeps wide
display math scrolling inside its own container.

## Verification

Coverage is co-located unit tests (`scientMathText.test.ts` for the
normalizer's protection and length-preservation properties,
`remarkScientMath.test.ts` for the refinement plugin's tree transforms,
`ScientMath.test.ts` for the KaTeX runtime and component fallbacks) plus
`chatMarkdownMathSeam.test.ts`, which combines a static source audit of the
`ChatMarkdown.tsx` seam (the `pdfFilePreviewSeam.test.ts` pattern) with
pipeline regressions through the real plugin chain and sanitizer: dollar
corruption cases, literal-region protection, streaming/oversized downgrades,
task-list coexistence, and an RTL prose fixture.

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
