# Scient content direction

Status: implemented in the T3-derived candidate; local presentation only.

## Contract

`ClientSettings.contentDirection` is the explicit `auto | rtl | ltr` contract.
It is separate from application-shell direction, is decoded with the default
`auto`, and is not sent to providers or stored in conversation events.

`ContentDirectionScope` is the web-only boundary. Chat rendering and the
Tiptap composer consume that scope; the app shell, project picker, terminals,
file browser, and other technical surfaces remain unchanged.

## Markdown boundary

`ChatMarkdown` keeps T3's existing remark/rehype pipeline, sanitizes raw HTML,
and then applies the small `rehypeScientBidi` transform. The message base uses
the same prose thresholds as local blocks; when aggregate prose is in the
mixed band, top-level Markdown blocks provide one vote each. Code, links, and
equations are excluded before that evidence is counted. The transform adds
direction only to conversational structural elements (`p`, headings,
blockquotes, lists, tables, and details). In automatic mode, each complete
paragraph or list uses its strong prose characters and the complete message as
context. At least 45% RTL prose makes that structure RTL; at most 30% keeps it
LTR; between those thresholds it follows the message direction. Each complete
list is counted once, items do not receive competing overrides, and nested
lists inherit their parent list direction. Code and math nodes do not
participate in prose counts. In automatic mode, table
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
explicit user mode remains authoritative. Headings use the direction of the
section they introduce, standalone headings use their own prose, and headings
inside structural containers inherit that container. The transform does not
duplicate or replace the T3 Markdown renderer and intentionally leaves code
elements alone.
Wide chat tables give the DOM viewport and Base UI scrollbar the same resolved
direction, keeping the custom thumb synchronized with Chromium's RTL scroll
coordinates.
Standalone right-flow arrows in clearly RTL prose are normalized to their
left-flow counterparts, independently of the automatic message base. Technical
content, links, and ambiguous arrow usage are left unchanged. An explicitly
LTR message never rewrites arrows.

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

## Clipboard

Rich-paste targets (Word, Google Docs, Pages) do not see Scient's stylesheet,
so a copy that contains any strong RTL character carries direction in its
`text/html` flavour only; `text/plain` and every copy without RTL text stay
byte-identical, and no bidi control characters are added.
`scient/clipboard/clipboardDirection.ts` marks a detached copy after the T3
sanitizer runs: every paragraph, heading, quote, list item, table cell, and
code block gets `dir` plus `style="direction:…;text-align:…"`, and lists and
tables get `dir` plus `direction`. Each block keeps the direction chat
displayed (the `rehypeScientBidi` result already on the copied DOM); list items
inherit their list, a block without one uses the chat paragraph rule, cells
keep their column's alignment unless an authored alignment exists, source code
stays LTR, and a plain-text box keeps its displayed direction. Inline content
copied without its block is wrapped in a `span` with that block's direction.
Inside RTL blocks, inline code, math source, LTR link and file-chip text, and
URLs or file paths written as prose become `<span dir="ltr"
style="direction:ltr;unicode-bidi:embed">`. `span dir` is the form Word itself
writes for direction runs, so it is preferred over `bdi`; the explicit
`unicode-bidi:embed` is what the macOS HTML importer maps to a writing
direction (a bare `dir` computes to `isolate`). Google Docs keeps only paragraph
direction, which is what matters most for punctuation. Plain LTR words stay
prose so trailing punctuation keeps the paragraph direction. Before the
sanitizer runs, an RTL copy's controls and cards become content
(`scient/clipboard/clipboardContent.ts`): chips rendered as buttons become their
Markdown copy (code, link text, or text), details become a bold summary
paragraph followed by the body, and diagram and chart cards become an LTR code
block with their fence source, so the HTML carries what the plain flavour
carries.

The Copy message button adds the same HTML only for messages with RTL text.
It renders the message's Markdown (the plain flavour's own text) with the
chat's GFM, math, line-break, raw-HTML, and `rehypeScientBidi` profile into an
inert document, so the result does not depend on whether the virtualized row is
mounted or a details block is collapsed; a mounted row only supplies the
displayed message direction. Images become their alt text, links to local,
context, or citation targets become their label, and math keeps its `$`
source. The wrapper carries `data-scient-message-copy`, and the Markdown
document editor pastes that copy's Markdown text, as for every other Copy
message paste.

## Composer

The composer adapter changes only the Tiptap root and its direct paragraphs,
lists, and blockquotes. Automatic mode resolves the complete draft from its
aggregate prose and, for closely mixed drafts, one vote per direct structural
group. It then applies the same 30%/45% prose rule used by rendered Markdown.
Code nodes do not participate, and every complete list keeps one direction.
Fixed modes remain authoritative. The adapter is mounted at the existing
composer seam and does not alter prompt serialization.

## Upstream maintenance

The setting contract and Scient bidi modules are Scient-owned. The only
inherited host edits are the ChatMarkdown renderer, ChatView scope, composer
plugin mount, settings panel entry, and the clipboard seams in
`markdown-clipboard.ts`, `useCopyToClipboard.ts`, `MessageCopyButton.tsx`, and
the two Copy message call sites in `MessagesTimeline.tsx`. Do not fork T3's renderer or add
direction logic to provider, server, persistence, or shell code. When T3's
Markdown or composer seams change, reapply this narrow adapter and rerun the
focused bidi tests before accepting the upstream update.
