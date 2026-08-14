# Scient math rendering

Status: implemented in the T3-derived candidate; local rendering only.

## Ownership

Scient owns `apps/web/src/scient/math`: remark-math configuration, delimiter
normalization, the math refinement plugin, the KaTeX runtime, the rendering
components, and the stylesheet. `katex` (0.16.47) and `remark-math` (6.0.0)
are exact-pinned in `apps/web`. KaTeX, its stylesheet, and its distributed
fonts (WOFF2, WOFF, and TTF) ship in a lazily loaded chunk — no CDN request.
Vite emits the fonts because the imported stylesheet references them through
statically analyzable `url()` declarations; unlike pdf.js
(`apps/web/scripts/scientPdfAssets.ts`), no asset-serving plugin is needed.
The runtime imports `katex/dist/katex-swap.min.css`, the variant KaTeX ships
with `font-display: swap` in every `@font-face`, so math paints with
fallback glyphs during a cold font load instead of staying invisible.
(KaTeX's default stylesheet declares `font-display: block`; a build-time
rewrite that only prepended `swap` lost to that later declaration, which is
why the shipped swap variant is used instead of a transform.)

## ChatMarkdown seam

The inherited-host seam is `ChatMarkdown.tsx` only: the import block for the
three math modules, `remarkScientMath` plus `remarkScientMathRefinements` in
both remark plugin arrays, one unconditional `useScientMathMarkdownText`
call, one `useScientMathRemarkPlugins` call that threads the original
message text to the refinement plugin (`remarkPlugins={remarkPlugins}` at
the render site), and two `components` branches — `code` routes
`language-math` nodes to `ScientInlineMath`, `pre` routes them to
`ScientDisplayMath`. Normalization is length-preserving (every rewrite swaps
a two-character delimiter for the two-character `$$`), so character offsets
never move and offset-based behavior — task-list toggling in rendered file
previews, list-item positions — stays correct on every surface with no
per-surface gating. The hook returns the shared static plugin array
untouched unless the message contains backslash delimiters, so the common
path allocates nothing.

## Recognition model

Recognition happens in two places, each at the altitude where its inputs are
unambiguous:

- **`normalizeScientMathDelimiters`** rewrites the backslash delimiters
  models emit — `\(...\)` and `\[...\]` — into `$$` forms on the raw string,
  because markdown escaping consumes backslashes before the tree exists. It
  refuses to touch fenced code (backtick or tilde, including unclosed
  fences), indented code lines, inline code spans, raw HTML `<code>`/`<pre>`
  regions, raw HTML tags (so attribute text like an `href` or `title` is
  never rewritten), HTML comments, escaped delimiters, unmatched openers,
  and empty pairs. Text between inline tags stays eligible — CommonMark
  treats inline-HTML content as ordinary prose.
- **`remarkScientMathRefinements`** runs on the parsed tree, where code,
  links, images, and raw HTML are structurally excluded, in three steps.
  First it downgrades incomplete or oversized math to its literal source: an
  unclosed `$$` block or ` ```math ` fence (the streaming case) and TeX
  longer than `MAX_SCIENT_TEX_LENGTH` render as plain literal blocks until a
  closing delimiter arrives. Second, a span the author wrote as `\[...\]`
  becomes display math wherever it appears: the containing paragraph splits
  into prose–equation–prose, exactly as TeX itself breaks a paragraph at
  display math. Third, a paragraph holding exactly one remaining `$$...$$`
  span is promoted to display math — this is how own-line `$$x$$` becomes a
  block equation, since remark-math treats single-line `$$...$$` as inline —
  unless the author wrote `\(...\)`, which always stays inline.

Because normalization is length-preserving, a math node's offsets address
the same characters in the original text; the refinement plugin receives
that original through `useScientMathRemarkPlugins` and reads the delimiter
at each node's start offset to recover inline-versus-display intent that the
uniform `$$` rewrite erases.

Single-dollar `$...$` is not recognized anywhere in this release.
`singleDollarTextMath` is off because parser-level `$...$` corrupts link
labels and destinations, file paths, shell identifiers, and prices, and no
later pass can repair structure the parser already destroyed. Tree-level
token heuristics were tried and rejected: they typeset shell fragments like
`$HOME/bin:$PATH`, and emphasis parsing fragments spans like `$a*b*c$`
before any tree pass can see them. Safe `$...$` recognition needs a
tokenizer-level pass with source context; until that exists, well-formed
`$x^2$` stays literal text and the supported spellings are `$$...$$`,
`\(...\)`, `\[...\]`, and ` ```math ` fences.

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
instead of serializing KaTeX's DOM. Both copy forms use `$$` — the only
dollar form that re-renders on paste now that single-dollar spans are not
recognized — with newline framing keeping display math a block. The stylesheet resets the chat surface's
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
corruption cases (including `$HOME/bin:$PATH`, emphasized `$a*b*c$`, and
escaped-dollar mixes), the authored-intent matrix for backslash delimiters,
raw-HTML attribute protection, literal-region protection,
streaming/oversized downgrades, task-list coexistence, the hard-break
surface, and an RTL prose fixture.

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
