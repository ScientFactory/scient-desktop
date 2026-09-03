# Scient rich Markdown editor

Status: accepted architecture and product contract for Scient's file-native rich Markdown
surface. Reconciled 2026-08-30 with the selected ProseMirror plus source-ledger implementation and
the removal of the non-product CodeMirror live-preview spike. This document records durable
invariants, dependency decisions, module boundaries, and acceptance requirements; pull requests
and their evidence remain the implementation record.

## Outcome

Scient will provide a file-native scientific writing surface in which the rendered document is
the editor. Opening the formatting controls or placing a caret must not replace the document,
change its layout, serialize its contents, or write the file. Markdown files on disk remain
authoritative, agent-editable, and portable outside Scient.

The finished experience must be suitable for sustained scientific writing rather than only
demonstrating that plain text can round-trip through a rich-text component.

## Product principles

1. **The file is the document.** No opaque database or vendor service owns canonical content.
2. **Reading and writing are one surface.** The rendered document is directly editable in place.
3. **No action means no mutation.** Opening, previewing, focusing, switching presentation, or
   closing an untouched file cannot change its bytes or revision.
4. **Preserve what Scient did not change.** User transactions patch the smallest safe source
   ranges; untouched Markdown, whitespace, delimiters, comments, and front matter remain intact.
5. **Rich when possible, source when necessary.** Unsupported syntax becomes an editable source
   island. It never disables rich editing for the rest of the document.
6. **Minimal chrome, complete behavior.** Ordinary writing needs a caret and contextual controls,
   not a permanent ribbon. Advanced commands remain discoverable through selection, slash menus,
   and keyboard shortcuts.
7. **Local, ownable, and durable.** Runtime editing has no paid API, hosted SDK, or network
   dependency. Dependencies must use permissive licenses and be replaceable behind Scient-owned
   adapters.
8. **Remote-safe and conflict-honest.** The same typed file operations work through local,
   desktop-hosted, and remote connections. External agent edits are never silently overwritten.
9. **Scientific content is first-class.** Math, code, tables, figures, citations, diagrams,
   visualization specifications, RTL, and mixed-direction text are part of the core contract.
10. **Upstream stays recognizable.** Scient logic lives under owned modules; inherited T3 files
    contain only narrow mounts and typed wiring protected by seam tests.

## Required user experience

### Document states

Amended 2026-08-29 after human review of the four-mode control: the explicit Read/Write/Source/
Split mode set is retired. Two presentations remain, mirroring the inherited file panel:

- **Rendered (eye on):** the rich live-preview surface, always editable on click. No state to
  enter or leave; editing controls appear only while a separate chrome toggle is on.
- **Source (eye off):** the inherited text-file editor. No second Markdown session or
  Markdown-specific source mode exists behind it.

The eye preference is global (stored exactly as `main` stores it) and a line reveal still wins
over it, since the revealed line only exists in source. There is no split pane and no second
Markdown source editor; exact-syntax work happens in the inherited source view or an inline source
island. Presentation controls never create a document transaction, and switching the eye or
formatting controls preserves scroll and selection where the surfaces allow.

### Minimal interaction model

- The file header keeps `main`'s eye toggle contract (same icons, tooltip, and
  `t3code.renderMarkdown` preference). Formatting controls live in the rich surface and remain
  collapsed until the user opens them or begins editing.
- The editing controls provide text formatting, lists, headings, links, and an overflow home for
  block insertion and less common actions. Find and replace moves to the editor's native search
  panel now; a redesigned Scient search surface is a follow-up, not part of this control row.
- Table insertion opens the existing nested-menu surface with a compact 8-by-8 visual size picker.
  Pointer hover and two-dimensional keyboard focus preview the selected rectangle without touching
  the document. Approaching an edge expands that axis progressively, up to 15-by-15. The card grows
  normally toward its initially chosen side, which is locked for that open session. When that side's
  available inline space is exhausted, the card stays still and only the grid scrolls horizontally,
  automatically revealing each new column. Rows always expand the card and never enter a vertical
  picker scroller. A popup initially placed to the left mirrors its trigger-facing origin and
  physical arrow movement. Pointer movement may continue selection for two-and-a-half cell pitches
  beyond the bottom or horizontal growth edge, so a fast pointer can reveal crossed rows or columns
  without waiting for every new cell to mount. This continuation is movement-driven and bounded:
  it stops immediately when the pointer stops or leaves that narrow region. Activation inserts the
  chosen size as one normal editor transaction. The ordinary `table` and slash commands retain the
  stable 3-by-3 default.
- In Rendered, ordinary and wiki links open with primary click after the pointer interaction is
  known not to be a drag or double-click; Command/Ctrl-click opens immediately. Both remain
  drag-selectable. Right-click/two-finger click selects the exact link and opens the app context
  menu. **Copy link** preserves the authored destination; resolvable workspace links also expose
  **Copy full path** without performing navigation. The edit action reuses the ordinary-link
  editor or searchable wiki-link picker. Wiki links also expose that picker after an exact
  selection or double-click.
- An active editable table keeps one quiet, out-of-flow corner handle. Primary click selects the
  complete table. Right-click/two-finger click on that handle, or on an unselected table cell,
  opens the app table menu and reuses the existing row, column, alignment, direction, selection,
  and deletion commands. Link menus take precedence inside cells, while selected prose retains
  the platform text menu. Opening or cancelling the table menu cannot alter source or save state.
- Internal-link activation verifies the exact workspace entry through the existing server-owned
  directory operation before changing the active file. Missing files, malformed paths, failed
  checks, and missing same-document headings keep the current document open and show compact
  feedback anchored to the activated link; direct file-opening failures retain their normal file
  surface. External links keep the established shell-opening path.
- Mermaid, Vega-Lite, and Plotly cards own their normal hover, pointer, wheel, drag, and
  double-click behavior in both the preview and rendered editor. Source editing is an explicit
  authoring action in the card's More menu or native right-click/two-finger menu; it never follows
  from ordinary chart interaction.
- Escape moves outward through nested editors and popovers in a predictable order. Enter on a
  keyboard-selected citation, math, footnote definition, or raw source island moves the caret into
  its field, so every source-like atom is reachable without a pointer. One-line citation and math
  fields leave through their physical arrow boundaries (mirrored for RTL citation text), Enter, or
  Escape; Backspace removes an already-empty inline atom. IME composition publishes one source
  transaction only after composition ends.
- A click on rendered code opens the nested editor with the caret at the clicked position. The
  rendered code and the editor share one text geometry (font, line height, wrapping, tab width);
  a click on the block header opens the editor without moving its caret.

The persistent rendered editor owns a scoped presentation layer that tracks the established
`FileMarkdownPreview` measure, inset, type scale, rhythm, contrast, links, quotes, code, images,
and table separators. It does not mount `ChatMarkdown`, swap DOM trees, or import the global
`.chat-markdown` class: selection, caret geometry, editable tables, exact-source islands, and
source-preserving transactions remain editor-owned. Narrow parity tests read both presentations
so an upstream preview change becomes an explicit review instead of silent visual drift.

Editing-specific exceptions are intentional and bounded: authored spaces remain caret-visible;
tables stay fully editable instead of gaining the preview's collapsed-cell truncation; and
selection, source, and formatting controls appear only while interacting. These exceptions may
not alter Markdown source unless the user performs an editing command.

### Node behavior

| Node                          | Rendered-editor behavior                                                     | Markdown authority                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Paragraph and heading         | Direct rich editing with stable typography                                   | Preserve original marks and delimiters until edited                     |
| Bulleted, numbered, task list | Rich list editing; Enter/Tab/Shift-Tab change structure                      | Preserve bullet/delimiter style for untouched items                     |
| Table                         | Editable cells; contextual row, column, and alignment actions                | GFM table with one header row; preserve cell content on save and reopen |
| Link and `[[wiki link]]`      | Underlined label; click follows, while drag/double-click selects for editing | Keep explicit, reference, GFM-autolink, relative, and wiki syntax       |
| Code block                    | Syntax-highlighted; embedded CodeMirror activates on selection               | Preserve fence marker, length, language, and metadata when untouched    |
| Inline/display math           | Typeset while inactive; compact TeX editor when selected                     | Preserve `$…$`, `$$…$$`, `\(…\)`, or `\[…\]` when edited                |
| Image/figure                  | Rendered with selection, alt text, caption, path, and size controls          | Use portable relative paths and ordinary Markdown where possible        |
| Citation                      | Bracketed label while reading; one always-present inline field while writing | Preserve citation keys and source syntax                                |
| Footnote                      | Numbered marker navigates to one directly editable definition with backlinks | Keep generated labels internal and preserve repeated-reference binding  |
| Mermaid/Vega/Plotly           | Preview-identical interactive card; explicit menu action opens source        | Retain the last valid render during invalid intermediate input          |
| Reference definition          | Hidden while reading; compact exact-source disclosure while authoring        | Preserve the complete definition verbatim until explicitly edited       |
| Other raw/unknown construct   | One persistent in-place source field; no separate preview/editor             | Preserve the complete original source verbatim until explicitly edited  |

Recognized scientific fences remain `code_block` nodes for source fidelity, selection, and nested
CodeMirror editing. Their NodeView is presentation-neutral while inactive: the same shared
Mermaid/Vega-Lite/Plotly renderer used by the established preview owns spacing, typography, and
visual chrome and receives the pointer events inside the rendered card. Only an explicit **Edit
source** action selects the node and opens the nested code surface; the rendered visual remains
mounted alongside it. The same editor-owned command backs both the More-menu item and the native
context menu, so those entry points cannot drift into separate editing behavior.

Footnotes are one paired document feature rather than an ordinary hyperlink or an editable label.
The Insert menu and `/footnote` command create a collision-free reference plus its definition in
one undo step, then focus the definition body. Reader-facing numbers follow first reference order;
repeated labels share a number and receive individual return backlinks. The definition body is its
only text surface and edits directly in place without a second box. Clicking a marker scrolls to
and focuses the definition without moving the caret into that field; clicking the body edits it.
Return backlinks expose a visible **Back to text** tooltip. The marker's
native context menu is limited to
footnote navigation, copying the internal fragment, removing that occurrence, and deleting the
definition only with its final reference. Missing definitions remain visibly non-dead and removable.

Top-level link definitions remain raw source-ledger nodes because their exact spelling is part of
the document authority. They are omitted from read presentation, as in the established Markdown
preview, and appear as compact collapsed rows in the authoring surface. Expanding a row edits the
same exact source field; there is no copied form model or definition reserialization layer.

### File lifecycle

- Create `.md` or `.markdown` from the Files panel with collision-safe naming.
- Rename from the header using an expected revision; never overwrite an existing path.
- Paste, drop, or select an image; validate bytes and type on the server; write atomically to a
  configurable sibling asset directory; insert a relative path only after success.
- Autosave begins only after a user-authored document transaction and is debounced.
- Writes use compare-and-swap revisions. A conflicting external edit pauses saving and offers a
  clear compare/reload/keep-local workflow.
- Closing, switching files, renaming, or changing presentation waits for pending edits to settle
  or enter visible recovery, without polling loops or fire-and-forget loss.
- Undo/redo covers document transactions, not presentation changes or server refreshes.

## Architecture decision

### Open-source landscape review (verified 2026-08-23)

The investigation reviewed 120 current search results across editor foundations, Markdown-native
editors, source-preservation behavior, and scientific rendering. The primary documentation,
repositories, licenses, release state, and relevant round-trip reports of the serious candidates
were then read directly. Stars are not an architectural criterion; they are useful only as a weak
signal of ecosystem size.

The decisive distinction is between **semantic round-trip** and **source round-trip**. Most rich
editors can parse Markdown into a document tree and serialize an equivalent document. That does
not preserve the file: semantically equivalent output may change list markers, emphasis
delimiters, soft breaks, table whitespace, entity spelling, fences, comments, or unsupported
extensions. Scient requires semantic editing plus exact reuse of every source range the user did
not change.

| Candidate                                                                                   | License and current state                                            | What it gives us                                                                                             | Decision for Scient                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [ProseMirror](https://prosemirror.net/docs/guide/)                                          | MIT; modular core maintained at its new upstream forge               | Mature schema, transactions, persistent view, NodeViews, selection mapping, tables, accessibility primitives | **Adopt the core**, behind a Scient adapter. Its normal Markdown serializer is not the file-authority layer.                                                                                                                                                                                     |
| [CodeMirror 6](https://codemirror.net/docs/guide/)                                          | MIT; modular and actively maintained at its new upstream forge       | Excellent source editor and nested code/config editor                                                        | **Adopt** for editable code blocks. It is not the product's rich document model or a parallel Markdown save path.                                                                                                                                                                                |
| [Lexical](https://github.com/facebook/lexical)                                              | MIT; active, large ecosystem                                         | Strong React integration, immutable state, accessibility, custom nodes, Markdown import/export               | Keep where inherited UI already uses it, but do not use its tree as Markdown authority. The promising [mdast package](https://lexical.dev/docs/packages/lexical-mdast) now retains several syntax choices, but is explicitly experimental and still does not preserve arbitrary untouched bytes. |
| [Tiptap](https://github.com/ueberdosis/tiptap)                                              | MIT core; active; optional commercial/cloud suite exists             | Polished headless ProseMirror extension ecosystem and useful interaction references                          | Do not add the abstraction layer. It does not solve exact source authority, and Scient needs direct transaction and serialization policy. No paid or hosted Tiptap component is required.                                                                                                        |
| [Milkdown](https://github.com/Milkdown/milkdown)                                            | MIT; active; ProseMirror plus remark                                 | The strongest Markdown-oriented framework reference, plugin architecture, polished Typora-like interactions  | Reference and selectively port ideas. Its parse-to-tree/serialize path does not establish unchanged-byte preservation.                                                                                                                                                                           |
| [MDXEditor](https://mdxeditor.dev/editor/docs/diff-source)                                  | MIT; active; Lexical-based                                           | Rich Markdown/MDX editing, source and diff modes, extensible visitors                                        | Reference its source/diff UX. Source is a separate mode and export still crosses a document model; it does not meet Scient's byte contract.                                                                                                                                                      |
| [Slate](https://github.com/ianstormtaylor/slate)                                            | MIT; active but explicitly beta with breaking APIs                   | Highly customizable React editor primitives                                                                  | Reject as the foundation: not Markdown-native, table/science behavior would be largely ours, and its API stability warning is material.                                                                                                                                                          |
| [Remirror](https://github.com/remirror/remirror)                                            | MIT; active ProseMirror React toolkit                                | React bindings and extension conventions                                                                     | Reference only; another policy layer without a source-preservation solution.                                                                                                                                                                                                                     |
| [BlockNote](https://github.com/TypeCellOS/BlockNote)                                        | Primarily MPL-2.0 with separately governed XL packages; active       | Excellent Notion-style block interactions and a ready-made UI                                                | UX reference only. Its block model is not Markdown authority, MPL obligations are less clean than the selected permissive stack, and XL licensing complicates the ownership boundary.                                                                                                            |
| [MarkText](https://github.com/marktext/marktext) / [Muya](https://github.com/marktext/muya) | MIT; MarkText active, standalone Muya repository archived            | Mature desktop interaction reference and real-time rich preview                                              | Do not embed. Muya's documented Markdown-to-HTML-to-Markdown pipeline necessarily normalizes source, and the reusable standalone repository is archived.                                                                                                                                         |
| [Vditor](https://github.com/Vanessa219/vditor)                                              | MIT; active                                                          | WYSIWYG, instant-rendering, and split modes in one package                                                   | Strong interaction/test reference. It is a large opinionated editor and provides no evidence of exact unchanged-byte preservation.                                                                                                                                                               |
| [TOAST UI Editor](https://github.com/nhn/tui.editor)                                        | MIT; repository open, latest published editor release found was 2023 | Established GFM Markdown/WYSIWYG editor with plugins                                                         | Reject as a new foundation because of release staleness, dual-mode conversion, and weak fit for our scientific/source contract.                                                                                                                                                                  |
| [Cherry Markdown](https://github.com/Tencent/cherry-markdown)                               | Apache-2.0; active                                                   | Broad Markdown features, extensible engine, split and rich modes                                             | Useful compatibility reference, not the foundation; it brings a full editor policy and no exact-source guarantee.                                                                                                                                                                                |
| [coflat](https://github.com/chaoxu/coflat)                                                  | MIT; created in 2026, three stars when reviewed                      | Interesting CodeMirror 6 Typora-style experiment including math/citation editing                             | Watch and borrow ideas only. It is far too new and small to become a core dependency.                                                                                                                                                                                                            |

Several newer projects and demos were also inspected and filtered out because they were thin app
shells, lacked evidence of file fidelity or accessibility, used copyleft/unclear licensing, or
were too immature to place beneath an authoritative scientific file editor.

### Scientific rendering components

The scientific preview stack is also fully local and ownable:

- [KaTeX](https://github.com/KaTeX/KaTeX) is MIT and provides fast self-contained TeX rendering.
- [Mermaid](https://github.com/mermaid-js/mermaid) is MIT and remains a text-authoritative diagram
  renderer.
- [Vega](https://github.com/vega/vega) is BSD-3-Clause and
  [Plotly.js](https://github.com/plotly/plotly.js) is MIT; both can render local declarative
  visualization specifications without a hosted service.
- Table editing follows useful structural ideas from Zettlr (GPL, concept reference only), while
  keeping table cells in the selected ProseMirror document and implementing row, column,
  and alignment commands in Scient-owned modules. Merge/split, arbitrary header-cell toggles,
  and width resizing are not enabled: GFM cannot represent them. A richer representation must
  be designed and round-trip qualified before those controls are enabled.

These renderers remain behind Scient widget adapters. Their input text stays in the Markdown
file, rendering runs locally, invalid intermediate edits retain the last valid visual, and no
renderer is allowed to rewrite the document.

### Answer to rich editing without losing the preview

This is feasible, but it requires separating the rich interaction model from file authority.
Scient presents one persistent ProseMirror document while a source ledger retains the original
Markdown ranges. A user transaction serializes only the changed block or applies a bounded inline
patch; every untouched range is reused from the source ledger. Unsupported constructs remain raw
source nodes instead of being dropped or normalized.

The ordinary eye switch in the inherited file panel chooses between the rich editor and source
view. It is a presentation change, not a document transaction. A pending save must settle before
that switch, a tab departure, or route navigation can unmount the editor.

### Selected foundation

Use ProseMirror as the rich document and transaction layer, behind Scient-owned schema,
projection, NodeView, and controller adapters. Use `markdown-it` for tokenization and a
Scient-owned source ledger for bounded source reuse. Use CodeMirror only inside editable code
blocks, where source editing is the interaction itself.

Scient dock menus execute editing commands after their close-complete lifecycle. The command
owns its destination focus (document, nested editor, or picker); Escape keeps normal trigger
focus. This composition is local to the rich editor, not a change to T3's menu primitives.
Lazy code editing retains the rendered block until its nested editor is ready, avoiding a
temporary empty block and layout collapse.

GFM table cells contain inline content directly. The Scient table-navigation adapter handles
only cell-edge arrows, since the upstream table handler expects a paragraph inside each cell.
It reuses ProseMirror's boundary detection, table map, selections, and caret scrolling; movement
within a cell stays native. Row nodes disallow gap cursors between cells; gap cursors remain
available outside the table. Arrow navigation must not mutate source, recreate the table, or
insert toolbar rows. Cursor/selection decorations are positioned outside document flow, and
wide tables scroll within their existing wrapper. Keep this adapter limited to inline cells;
paragraph-based cells should use the upstream handler.

The active table has a small, out-of-flow select button only in write mode, plus the same action
in the dock's unified **More actions** menu. The dock keeps only the common add-row, add-column,
and alignment controls visible; it does not add a second table-specific ellipsis. Both table
selection actions create the upstream `CellSelection` spanning every cell: selection
does not modify source, create an undo step, or start a save. The chrome wraps `TableView` without
replacing its content or column machinery. The handle and unselected table cells also open one
native context menu whose items call these same commands; the menu is not another table model or
save path. Direction belongs to the table as one block (including
when invoked from a cell) and uses the existing `<div dir="ltr|rtl">` Markdown convention. Auto
removes that wrapper and derives column order from the dominant strong script across the complete
table, not only its header. An explicit table direction overrides that structural inference, while
each cell derives text flow from its own dominant strong script and falls back to the automatic
table direction only when tied or neutral. A manual table direction therefore changes column order
without changing cell punctuation flow. GFM left, center, and right column alignment remains
physical and does not flip with cell direction. Cell direction is decoration only: no cell-level
HTML format or second table model is introduced. Explicit document commands begin separate undo
steps, even when invoked in quick succession.

One workspace surface owns exactly one editor controller, one document session, and one serial
save queue. React mounts that controller but does not mirror the document source in component
state. Compare-and-swap revisions, explicit retry/discard recovery, typed server operations, and
the asset pipeline remain independent of the editor library.

The persistence coordinator observes every draft transition, not only eligible save intents.
Undo-to-baseline cancels debounced work; undo or discard during an in-flight write compensates
against the acknowledged revision. Edits made during conflict recovery remain the current draft.
An authoritative read can retire a command and release flush waiters even if its response never
arrives. A late acknowledgement cannot clear a newer observed external conflict. If the watcher
observes an in-flight save before its command reply while newer typing is queued, confirming that
same snapshot must clear both the apparent conflict and its queue pause; newer typing then saves
against the acknowledged revision.

Controller callbacks forward to current host bindings without remounting the rich editor. The
file adapter keys controller ownership by environment, workspace root, and relative path. The
pending-surface adapter reads current departure state when a link or host control invokes it.

NodeViews that depend on state outside the document register with one controller-owned
presentation channel. Workspace-index changes retry unresolved images and refresh wiki-target
status; appearance changes refresh rendered code. Neither path creates a transaction or save.

Document direction is also presentation state. The controller derives stable block directions
from visible prose while technical nodes remain LTR. In an RTL prose block, only standalone
right-flow arrow glyphs are mirrored with decorations; code, math, links, source bytes, copied
text, undo history, and save state remain unchanged.

All selected packages are MIT-licensed. The rich surface remains isolated behind the Markdown
file mount; expensive nested source and scientific renderers load only when their surfaces are
needed, so the ordinary chat path does not initialize them.

Scientific-fence validation shares the existing near-viewport activation policy with the
visual cards: validating Mermaid renders it, so an unvisited fence must not start that work
eagerly. Once activated, validation follows source/theme changes and retains the last valid
preview during invalid edits; stale asynchronous results cannot replace newer source. This is
first-visit deferral, not suspension of previously visited blocks or whole-document virtualization.

If a nested code editor cannot load or initialize, its rendered source stays visible and no
document edit is dispatched. A local notice offers Retry and points to the existing Markdown
source mode; failure must not escape as an unhandled rejection. A late failure after leaving the
block is ignored, and a successful retry removes the notice without creating another editor.

Milkdown, MDXEditor, Vditor, MarkText, Muya, and newer Typora-like projects remain interaction
and test references, not runtime foundations. Their useful ideas may be reimplemented through
Scient-owned modules; their serializer behavior is not the file-authority contract.

### Amendment record (2026-08-30): one product editor

A dev-only CodeMirror live-preview spike was evaluated after early ProseMirror interaction
failures. Its source-buffer model remained technically interesting, but it did not reach feature
or interaction parity with the repaired rich surface. Shipping both paths would create two save,
conflict, command, and accessibility implementations selected by hidden local state. The spike
and its runtime gate were therefore removed. This document records the product architecture that
actually ships: ProseMirror plus the source ledger, with CodeMirror limited to code-block source
islands. Reconsidering the substrate requires a separate measured replacement, not another
in-product toggle.

### Why the previous Lexical pass is not the base

The previous branch rebuilds a separate rich editor when Write is selected and listens to every
Lexical update. It then serializes the entire editor tree and forwards the result to autosave.
Consequently, import normalization during mode entry can be mistaken for user authorship. The
observed result included removal of a table and flattening of a nested list without typing.

Useful interaction components and backend tests from that branch may be ported only after their
behavior is revalidated against this contract. Its import/export bridge and whole-document
autosave design must not be reused.

### Implemented product shape

The rendered view is directly editable and provides revision-bound serial autosave,
external-conflict handling, rich formatting/lists/tasks/tables, math, highlighted nested code
editing, images, wiki links, citations/footnotes, Mermaid/Vega/Plotly previews, raw source islands,
find/replace, outline navigation, structural block operations, create/rename, and secure asset
insertion. The inherited eye switch exposes the ordinary source editor when precision editing is
needed. The rich editor claims plain Markdown (`.md` and `.markdown`) only; MDX remains on T3's
ordinary rendered/source preview because MDX fidelity has not been established.

Changes to that shape require proportional evidence for unchanged-source reuse, CRLF and Unicode,
malformed input, composition safety, RTL block direction, last-valid scientific rendering,
presentation-safe links, collision-safe file operations, save recovery, and representative
large-document latency.

### Module boundaries

```text
packages/scient-markdown/
  sourceLedger.ts  Reuses untouched source ranges and applies bounded patches
  session.ts       Baseline, draft, revision, and explicit save intent
  saveQueue.ts     Serial debounced CAS save and retry/discard recovery

apps/web/src/scient/markdownEditor/
  prosemirror/   Schema, source projection, commands, plugins, session, controller
  nodes/         Owned math, code, image, reference, raw, task, and wiki NodeViews
  ui/            Formatting, find, lifecycle, save status, and wiki-link controls
  assets/        Authenticated image-upload client
  *.tsx          File/workspace lifetime adapters

apps/server/src/scient/markdown/
  WorkspaceMarkdownFiles.ts  Atomic create, rename, binary asset operations
  http.ts                    Typed HTTP handlers for remote-ready clients

packages/contracts/src/scientMarkdown.ts
packages/client-runtime/src/state/scientMarkdownHttp.ts
```

### T3 upstream seams

Quality behavior stays in Scient-owned modules; inherited files only compose it with the host.
These are the intentional overlaps to inspect during every bounded T3 alignment:

| Inherited seam                                                     | Why it remains                                                                              | Composition rule                                                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FilePreviewPanel.tsx`                                             | The host owns file loading, source preview, breadcrumbs, and save notices.                  | Keep one lazy rich-editor mount for `.md`/`.markdown`; retain T3's ordinary MDX renderer; do not move parser or save policy here.                       |
| `FileBrowserPanel.tsx`                                             | The inherited file toolbar is the discoverable create location.                             | Keep one owned create button and refresh both the T3 tree and the shared completion index after success.                                                |
| `FileBreadcrumbNavigator.tsx`                                      | Rename belongs on the visible current filename.                                             | Preserve only the generic optional current-file control slot; the rename operation remains owned.                                                       |
| `ChatView.tsx`                                                     | It owns route and right-panel lifecycle, the points that can unmount a dirty file.          | Call the Scient pending-departure adapter before activation, close, panel, and route actions. Keep `RightPanelTabs` upstream-shaped and presentational. |
| workspace contracts, RPC composition, and `WorkspaceFileSystem.ts` | Remote clients and filesystem authority must use the host's authenticated project boundary. | Extend the existing typed operation and path authority; never create a Markdown-only filesystem root or client-authoritative path.                      |
| package manifests and lockfile                                     | The lazy rich bundle still needs local parser/editor dependencies.                          | Keep only runtime dependencies used by the selected product path.                                                                                       |

The static seam test records the UI mounts. The server tests cover containment, exclusive create,
revision-aware rename, atomic publication, and image validation. Scient-owned
`MarkdownTransportServerTests.ts` cases register through the existing `server.test.ts` harness:
real authenticated WebSocket saves/renames and multipart HTTP uploads must preserve revisions,
typed failures, exact asset paths, and scope denial without writes. This loopback transport proof
does not replace remote-client acceptance. An upstream change that supplies equivalent behavior
should replace the seam only after those acceptance tests still pass.

#### Current main integration (2026-08-31)

The feature was rebased onto owned main `6e608aadf29ad083c46c8552fea6a1ce4b4e7554`, then onto
freshly fetched main `3b6cd6fda7169be4001461fc4404a327203eb92d` when PR #218 landed during the
final checks. Main contains the separately qualified T3 integration through `e4f7b14fa`.
No official upstream merge or divergence-policy change was added to this feature branch.
The tested checkpoint before that last rebase is `269a78b6c70873b079a992636bccb712acd527fc`.

The subsequent alignment onto owned main `83ffde24dc63c8d883613718aaec47b2362948e6` preserved
all 46 feature patches unchanged. That main range has no same-file feature overlaps; its shared
visual-card and appearance changes retain their existing mounts and are covered by the combined
Markdown/presentation regression lane. It does not change the editor's document or save model.

The main alignments touch these six shared paths:

- `FilePreviewPanel.tsx`: compose the rich plain-Markdown mount alongside main's
  `FileMarkdownPreview` fallback. Preserve its file-relative image resolution, task updates, MDX,
  and inherited source editor. The earlier rebase corrected a textual conflict and an older
  commit's reintroduction of `ChatMarkdown` at that fallback. The final composition also retains
  main's pending-file guard, agent mutation hints, and binary-image cache invalidation.
- `ChatView.tsx`: retain main's video-attachment lifecycle alongside Scient's local
  pending-file-departure adapter, file citations, artifact templates, and mutation hints.
- `FileBrowserPanel.tsx`: share the tree/link-index refresh between manual refresh, file creation,
  and main's agent mutation hint. Its callback depends on the current environment and workspace,
  so a context change cannot refresh an old completion index.
- `useWorkspaceFileRefresh.ts`: retain main's watcher-primary, mutation-hint fallback alongside
  the Markdown save-error and conflict callbacks; pending local edits still defer the fallback.
- `packages/client-runtime/package.json`: retain main's work-log and Codex Markdown exports
  alongside the Markdown operation exports.
- `pnpm-lock.yaml`: preserve both directive and frontmatter entries at the only final-rebase
  textual conflict. The composed lockfile passes the pinned frozen install and supply-chain check.

The editor core, Markdown server operations, and inherited `RightPanelTabs` had no intervening
main overlap. This is an exact integration record, not a reason to skip the next changed-path audit.

#### Previous owned-main alignment (2026-09-01)

The 51-patch feature branch was subsequently rebased onto freshly fetched owned main
`06e8489afc9e430da6cf1fd591f7f608a964141d` (PR #223, the current bounded T3 alignment).
That main commit is an ancestor of the rebased persistence checkpoint
`ccbb712da0ee17143516cbe27026ac8ee8e99f75`; no merge commit or upstream divergence policy was
introduced here. The frozen-lockfile install succeeds on the composed tree.

The rebase produced one textual conflict, in `FileBrowserPanel.tsx`. Its resolution retained
main's directory-expansion state (`areAllDirectoriesExpanded` / `setAllDirectoriesExpanded`) and
the Scient completion-index refresh (`refreshProjectEntriesQuery` / `setProjectFileQueryData`).
The latter remains necessary because the inherited tree refresh and wiki-link completion cache
serve different consumers. No editor-core, source-ledger, save-queue, Markdown transport, or
`RightPanelTabs` file overlapped the new main range.

A post-rebase changed-path audit again found only the intentional seams listed above. The
subsequent source-safety review changes are confined to `apps/web/src/scient/markdownEditor/` and
`packages/scient-markdown/`; they add no inherited T3-file overlap. This is the preferred shape:
keep source projection, command policy, nested-node behavior, and tests in Scient-owned modules,
while leaving the host files as lifecycle and transport composition points.

#### Latest owned-main alignment (2026-09-03)

After the source-editing review, the clean feature branch merged freshly fetched owned main
`cb735ab0acf3c713ca3d2eeba0a68a0b63e468a1` as merge
`cec1b3856f86741c5f89215a921dce08c8d98937`. The owned-main commit adds the managed-runtime
catalog reconciler and publication workflow; it does not alter the Markdown editor, source ledger,
save coordinator, or Markdown transport.

Git auto-merged two paths that the feature branch had changed. In `apps/server/src/server.ts`, the
result retains both the existing `scientMarkdownHttpApiLayer` and main's
`ManagedRuntimeCatalogReconciler.layer`. In `docs/README.md`, the provider-runtime operations entry
and the rich Markdown architecture entry are both present. No conflict resolution or product-policy
adaptation was required. The official `upstream` remote was refreshed separately and remains
fetch-only with push URL `DISABLED`; no unreviewed official T3 commit was merged into this feature
branch.

The exact merged tree passed the frozen-lockfile install and supply-chain check, repository format
and lint gates, repository-wide typecheck and tests, production build, desktop smoke test, Scient
brand check, and strict Markdown performance qualification. These automated results do not replace
the owner's pending visual and interaction acceptance in the development app.

### Document session

`ScientDocumentSession` owns one immutable baseline and a stream of explicit state transitions:

```text
disk source + revision -> source ledger -> ProseMirror projection
                                      |             |
                                      |             +-> explicit user transaction
                                      |                         |
                                      +-> untouched ranges <----+ bounded patch/changed-block serialization
                                                                |
                                                                v
                                                     save intent -> serial CAS write
```

The workspace owns the controller and save queue; the React document adapter only mounts the
controller. External file updates enter through an explicit session transition. A clean editor
adopts the new source and revision; a dirty editor pauses the queue and exposes retry/discard
recovery. Programmatic adoption, selection, decoration, viewport, and remote-sync transactions do
not create save intent.

### Source preservation

Preservation is range-based, not a claim that a semantic editor never serializes:

- Unchanged source-ledger blocks are copied byte-for-byte into the next draft.
- A bounded inline edit follows corresponding text nodes, not concatenated cell/list text.
  A candidate patch must parse to the intended node content and structure; otherwise it uses
  the changed-block serializer. Document-level reference definitions supply shared parse context.
  Editing/removing a definition refreshes only its derived consumer blocks, through mapped
  transactions outside undo history; the source change itself remains undoable. Rebind parsed
  baselines to the same context so unchanged reference syntax is not rewritten on the next save.
- Reference links and images retain their definition label alongside the resolved destination.
  Changed-block serialization emits a reference, not a frozen inline URL; changing display text
  cannot change the definition key. An explicit destination edit detaches that dependency.
  This provenance is owned by the Scient parser/schema adapter, not the generic T3 renderer.
- Save acknowledgement updates only the persistence baseline. The source ledger stays paired
  with its parsed document and stable identities, including through repeated structural saves.
- A structurally changed block is serialized from the edited ProseMirror node; normalization is
  confined to that changed block.
- Unsupported syntax is retained as an owned raw node and reuses its original source while
  unchanged.
- Invalid mappings, including Unicode boundary hazards, fall back to changed-block serialization
  rather than throwing or touching adjacent ranges.
- External changes are adopted only while clean or surfaced as a revision conflict while dirty.

GFM tables retain exactly one header row and column-level alignment after structural edits.
Unsupported spans/width transactions are rejected rather than published lossily. Cell breaks use
the inert `<br>` form without enabling arbitrary HTML; literal text and boundary spaces are
escaped as needed to survive parsing. Link editing sets/removes a destination explicitly, and
ordinary URL destinations are decoded once at the filesystem boundary; raw wiki paths are not.

Golden and adversarial tests therefore assert that CRLF/LF, final newline state, Unicode and bidi
controls, front matter, HTML comments, reference definitions, fence length, list markers,
indentation, entity spelling, and whitespace remain unchanged outside the user's edited range.

## Server and security contract

- Reuse inherited workspace-root resolution and authentication scopes.
- Resolve canonical paths and reject symlinked-ancestor escapes.
- Create and destination rename are exclusive; existing targets are never replaced.
- Rename requires the expected content revision and reports a conflict if bytes changed.
- Saves, binary creates, and renames share canonical-path mutation locks. Root and parent
  symlink aliases must identify the same lock; re-resolve after waiting and reject a changed
  target. Rename locks both identities in sorted order and rejects same-file aliases before
  acquiring them. These are in-process operation guarantees, not a cross-process filesystem
  transaction against arbitrary external writers.
- Binary writes validate decoded size, content signature, extension compatibility, and supported
  image policy. SVG is sanitized or rejected according to the existing preview policy.
- Use same-directory temporary files, fsync where supported, atomic rename, and cleanup.
- Refresh workspace entries only after a successful operation.
- Existing authenticated typed project RPC remains the create/write/rename transport used by
  connected Scient clients. Authenticated typed HTTP handles multipart binary asset ingestion.
  Both delegate to the same workspace path/revision authority; duplicate file semantics are not
  created in the transport layers.
- Error contracts distinguish invalid input, outside-root path, resolved escape, conflict,
  existing destination, unsupported media, excessive size, and operational failure.

## Upstream integration policy

- Feature work starts from current owned `origin/main`; official T3 commits enter only through a
  separate bounded upstream merge.
- All implementation lives under Scient-owned directories wherever possible.
- Inherited mounts contain no parser, serializer, save, or product-policy logic.
- Heavy editor code is lazy and does not alter `ChatMarkdown` or the chat composer.
- Every upstream-overlap file gets a seam test or a stable, easily recomposed mount.
- Before review, rebase onto the then-current owned main, rerun seam tests, inspect upstream
  overlap, and record any conscious adaptation. Do not mix an upstream merge into this branch.

## Qualification requirements

Changes to the rich Markdown surface must prove the relevant rows below with current evidence.
Data-loss, accessibility, security, and file-conflict defects are release blockers. Automated
tests are necessary but do not replace proportional review in the real web/desktop surface.

## Verification matrix

| Requirement                | Required evidence                                                              |
| -------------------------- | ------------------------------------------------------------------------------ |
| No mutation on view switch | transaction spy, save spy, before/after SHA, repeated eye-toggle test          |
| Rich visual continuity     | same mounted view identity plus geometry and screenshot differential           |
| Source preservation        | golden and property tests showing only intended source ranges changed          |
| External edit safety       | deterministic revision-conflict integration tests and real two-writer exercise |
| Lists and tables stay rich | interaction tests plus real-app keyboard exercise                              |
| Scientific nodes           | valid/invalid transition tests and visual/runtime evidence per node            |
| RTL and mixed direction    | Hebrew/English fixtures, caret/navigation checks, rendered screenshots         |
| Accessibility              | semantic inspection, keyboard map, focus order, screen-reader announcements    |
| Remote readiness           | authenticated HTTP tests and remote-connected client exercise                  |
| Performance                | recorded budgets on representative small, medium, and large fixtures           |
| Upstream isolation         | changed-path audit, seam tests, current-main rebase, overlap report            |
| Ownability                 | license inventory, no hosted dependency, offline runtime exercise              |

## Performance budgets

Budgets are qualification thresholds, not aspirations:

- Rich editor code is absent from the initial chat bundle and loaded on demand.
- Formatting-dock expansion does not remount or reparse the document and settles in one animation
  frame for an already loaded editor.
- Typing p95 stays below 16 ms for a 100 KiB representative document and below 32 ms for 500 KiB.
- Opening a 100 KiB document reaches an interactive first viewport within 250 ms on the
  qualification Mac after the lazy chunk is available.
- Long documents use viewport-aware decorations and defer heavy math/diagram work outside the
  active region.
- Inactive Plotly and Mermaid nodes do not continuously animate or repaint.
- Repeated presentation switches and file changes show no unbounded listener, DOM, or heap growth.

## Change acceptance

A rich Markdown change is reviewable only when every applicable matrix row has current evidence,
the branch is based on current owned main, the worktree is clean, and the exact candidate has been
qualified in an isolated Scient development app. Passing narrow unit tests, completing a visual
shell, or demonstrating plain-text editing is not product acceptance.
