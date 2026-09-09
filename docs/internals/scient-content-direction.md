# Scient content direction

Status: implemented in the T3-derived candidate; local presentation only.

## Contract

`ClientSettings.contentDirection` is the explicit `auto | rtl | ltr` contract.
It is separate from application-shell direction, is decoded with the default
`auto`, and is not sent to providers or stored in conversation events.

`ContentDirectionScope` is the web-only boundary. Chat rendering and the
Lexical composer consume that scope; the app shell, project picker, terminals,
file browser, and other technical surfaces remain unchanged.

## Markdown boundary

`ChatMarkdown` keeps T3's existing remark/rehype pipeline, sanitizes raw HTML,
and then applies the small `rehypeScientBidi` transform. The transform adds
direction only to conversational structural elements (`p`, headings,
blockquotes, lists, tables, and details). In automatic mode, each complete
list gets one aggregate direction: any RTL prose makes the whole list RTL; an
English-only list is LTR; items do not receive competing per-item overrides.
Nested lists inherit their parent list direction. In automatic mode, table
structure follows the dominant prose direction across the whole table. Code,
equations, literal TeX, and scientific identifiers such as `HER2` and `cN0` do
not decide column order. English-only prose tables can therefore remain LTR
inside an RTL message, while technical terms do not flip a Hebrew table. Each
cell resolves its own text direction without changing the table's column
order. A mixed cell becomes LTR only when at least 70% of its strong characters
are LTR; otherwise RTL wins. Pure-script cells keep their own direction, while
neutral cells follow the table. Automatic visual
alignment is resolved once per logical column from all of its cells: ordinary
prose is the primary signal, identifier-only columns use their raw script as a
fallback, and neutral or tied columns follow the table. Every unaligned cell in
that column receives the same physical left or right alignment even when its
local text direction differs. Authored GFM left, center, and right alignment
remains authoritative. Row and column spans are mapped to logical columns in
the rendered tree; the GFM editor continues to enforce its existing rectangular
table model. The renderer and editor table node view use the same column rule,
and the resulting metadata never enters Markdown source. The editor caches
immutable row counts and updates cell attributes only when a column result or
table structure changes, preserving the large-table typing budget. An
explicit user mode remains authoritative. Headings use the resolved message
direction except inside table cells, where they follow the cell. The transform
does not duplicate or replace the T3 Markdown renderer and intentionally leaves
code elements alone.
Wide chat tables give the DOM viewport and Base UI scrollbar the same resolved
direction, keeping the custom thumb synchronized with Chromium's RTL scroll
coordinates.
Standalone right-flow arrows in clearly RTL prose within an RTL-base message
are normalized to their left-flow counterparts. Technical content, links, and
ambiguous arrow usage are left unchanged. An explicitly LTR-base message never
rewrites arrows, even when a local block contains Hebrew.

The stylesheet is scoped to `.chat-markdown[data-scient-content-direction]` and
uses logical properties for list padding, blockquote borders, task-list
spacing, and table alignment. This keeps the divergence narrow and makes an
upstream Markdown update straightforward to rebase.

## Copy boxes

Source-code fences and titled fences are always LTR. Plain-text fences (`text`,
`plaintext`, and `txt`) use strong-script detection only when the content is
unambiguous: strong Hebrew/Arabic-family text is RTL, strong Latin text is LTR,
and mixed text uses the selected conversation mode or browser `auto`. A fence
may explicitly set `dir=auto`, `dir=rtl`, or `dir=ltr` in its metadata. During
assistant streaming, the message base is seeded once per message (preferably
from the preceding user message) and held stable; after completion, the full
response is resolved again. Plain-text boxes still use their own content rule.

## Composer

The composer plugin changes only the Lexical root and its direct paragraphs for
fixed modes. Automatic mode removes the explicit root direction and preserves
Lexical's native `dir="auto"` paragraph behavior. The plugin is mounted at the
existing composer seam and does not alter prompt serialization.

## Upstream maintenance

The setting contract and Scient bidi modules are Scient-owned. The only
inherited host edits are the ChatMarkdown renderer, ChatView scope, composer
plugin mount, and settings panel entry. Do not fork T3's renderer or add
direction logic to provider, server, persistence, or shell code. When T3's
Markdown or composer seams change, reapply this narrow adapter and rerun the
focused bidi tests before accepting the upstream update.
