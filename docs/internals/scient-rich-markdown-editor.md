# Scient rich Markdown editor

Status: accepted architecture and product contract for Scient's file-native rich Markdown
surface. Amended 2026-08-29 to re-select the editor core from ProseMirror plus a source ledger to
CodeMirror 6 source-preserving live preview (see "Amendment record (2026-08-29)"). This document
records durable invariants, dependency decisions, module boundaries, and acceptance requirements;
pull requests and their evidence remain the implementation record.

## Outcome

Scient will provide a file-native scientific writing surface in which the rendered document is
the editor. Entering edit mode must not replace the document, change its layout, serialize its
contents, or write the file. Markdown files on disk remain authoritative, agent-editable, and
portable outside Scient.

The finished experience must be suitable for sustained scientific writing rather than only
demonstrating that plain text can round-trip through a rich-text component.

## Product principles

1. **The file is the document.** No opaque database or vendor service owns canonical content.
2. **Reading and writing are one surface.** Edit mode activates the rendered view in place.
3. **No action means no mutation.** Opening, previewing, focusing, toggling modes, or closing an
   untouched file cannot change its bytes or revision.
4. **Preserve what Scient did not change.** User transactions patch the smallest safe source
   ranges; untouched Markdown, whitespace, delimiters, comments, and front matter remain intact.
5. **Rich when possible, source when necessary.** Unsupported syntax becomes an editable source
   island. It never disables rich editing for the rest of the document.
6. **Minimal chrome, complete behavior.** Ordinary writing needs a caret and contextual controls,
   not a permanent ribbon. Advanced commands remain discoverable through selection and slash
   menus, the command palette, and shortcuts.
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

The surface has three explicit states while retaining one document session:

- **Read:** rendered, selectable, links open normally, editing disabled.
- **Write:** the same rendered nodes become editable; caret, selection, block handles, and
  contextual controls appear. This is the default authoring state.
- **Source:** a full Markdown source editor for exact syntax work. A synchronized split layout is
  available when space permits.

An optional focused-Markdown interaction may reveal the source of only the active complex block.
It is not a replacement for the default in-place rich editor.

Mode changes preserve the scroll anchor, document geometry, direction, table widths, disclosure
state, last selection, and active find result. They create no document transaction.

### Minimal interaction model

- The file header contains the document name, one read/write control, source/split access, find,
  overflow actions, and a truthful saved/saving/conflict state.
- A small selection toolbar provides text format, link, and comment actions only when relevant.
- A slash menu inserts or transforms blocks and remains fully keyboard operable.
- Block handles appear on hover or keyboard focus and expose move/duplicate/delete/transform.
- Table, figure, math, code, citation, and diagram controls appear only when their node is active.
- Links open with primary click in Read. In Write, primary click selects or edits and
  Command/Ctrl-click opens, preventing accidental navigation.
- Escape moves outward through nested editors, popovers, node selection, and finally document
  focus in a predictable order.

### Node behavior

| Node                          | Write-state behavior                                                   | Markdown authority                                                        |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Paragraph and heading         | Direct rich editing with stable typography                             | Preserve original marks and delimiters until edited                       |
| Bulleted, numbered, task list | Rich list editing; Enter/Tab/Shift-Tab change structure                | Preserve bullet/delimiter style for untouched items                       |
| Table                         | Editable cells; contextual row, column, alignment, merge/split actions | Patch the table source range; retain untouched alignment and cell content |
| Link and `[[wiki link]]`      | Rendered label/chip with popover editing and completion                | Keep local relative destinations and wiki syntax                          |
| Code block                    | Syntax-highlighted; embedded CodeMirror activates on selection         | Preserve fence marker, length, language, and metadata when untouched      |
| Inline/display math           | Typeset while inactive; compact TeX editor when selected               | Keep original delimiters and source until changed                         |
| Image/figure                  | Rendered with selection, alt text, caption, path, and size controls    | Use portable relative paths and ordinary Markdown where possible          |
| Citation/footnote             | Rendered label with nested editor or inspector                         | Preserve citation keys, reference definitions, and footnote structure     |
| Mermaid/Vega/Plotly           | Rendered preview with an in-place source/config editor                 | Retain the last valid render during invalid intermediate input            |
| Raw/unknown construct         | Sanitized preview when safe plus an in-place source island             | Preserve the complete original source verbatim until explicitly edited    |

### File lifecycle

- Create `.md` from the Files panel and command palette with collision-safe naming.
- Rename from the header using an expected revision; never overwrite an existing path.
- Paste, drop, or select an image; validate bytes and type on the server; write atomically to a
  configurable sibling asset directory; insert a relative path only after success.
- Autosave begins only after a user-authored document transaction and is debounced.
- Writes use compare-and-swap revisions. A conflicting external edit pauses saving and offers a
  clear compare/reload/keep-local workflow.
- Closing, switching files, renaming, or changing modes flushes or resolves pending edits without
  polling loops or fire-and-forget loss.
- Undo/redo covers document transactions, not mode changes or server refreshes.

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
| [CodeMirror 6](https://codemirror.net/docs/guide/)                                          | MIT; modular and actively maintained at its new upstream forge       | Excellent source editor, nested code/config editor, search, completion, language packages                    | **Adopt** for Source/Split and nested source islands. It is not the rich document model.                                                                                                                                                                                                         |
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
- Table editing follows the Zettlr pattern (GPL, concept reference only): a table widget whose
  cells are small embedded CodeMirror editors clamped to cell boundaries, with row and column
  commands implemented as Scient-owned CodeMirror commands.

These renderers remain behind Scient widget adapters. Their input text stays in the Markdown
file, rendering runs locally, invalid intermediate edits retain the last valid visual, and no
renderer is allowed to rewrite the document.

### Answer to rich editing without losing the preview

This is feasible and is the selected design. The editor's buffer is the file's bytes; Read and
Write are the same CodeMirror `EditorView` over that buffer. Write changes only decorations,
focus, selection, and interaction plugins, never the text. A bullet remains a bullet, a table
remains a laid-out table with editable cells, an equation remains typeset with a compact TeX
editor when active, and a figure or diagram keeps its last valid preview while its source is
being edited. Source and Split are the same buffer with the live-preview projection disabled;
they are precision tools, not the default writing experience.

Rendering is a projection over source text, not a parallel document: inline and block Markdown
punctuation is hidden or dimmed by decorations only where the selection does not intersect it,
and complex constructs are replaced visually by widgets whose underlying source stays in the
buffer until explicitly edited. This is the interaction model of Typora and Obsidian, and it has
permissive-license production evidence: Zettlr's renderer architecture covers math, citations,
tables, and diagrams as widgets over an untouched buffer, and the MIT atomic-editor package
ships the layout-stability (line-level reveal without reflow) and cursor-freeze mechanisms that
resolve the interaction's known failure modes. The prior concern that this path amounts to
hiding punctuation in a textarea does not hold: CodeMirror 6 supplies the selection, IME,
accessibility, viewport, and structure machinery, and its ecosystem demonstrates tables, nested
lists, and embedded editors on exactly this architecture. Conversely, a semantic document model
alone is unsafe for real files because normal serialization changes untouched bytes, which is
the property this product exists to guarantee.

### Selected foundation

Use CodeMirror 6 as the editing substrate: the buffer holds the file's exact bytes, live preview
is a decoration and widget projection over that buffer, and Source/Split are the same buffer with
the projection disabled. CodeMirror's transaction model, selection and IME handling, viewport
rendering, decoration system, and nested-editor support carry the invariants directly; the file
is canonical by construction rather than by preservation engineering. Complex constructs (math,
tables, figures, diagrams, code) are widget projections with embedded editors, following Zettlr's
renderer architecture and atomic-editor's stability mechanisms (cursor-proximity source reveal,
line-level reveal without reflow, post-release reveal freeze).

The document session, save queue with compare-and-swap revisions, conflict handling, typed server
layer, contracts, and asset pipeline are editor-agnostic and carry over unchanged. The source
ledger and ProseMirror surface retire when the CodeMirror surface reaches parity; the transition
is staged behind the spike gate in the amendment record below.

All selected packages are MIT-licensed. The rich surface remains isolated behind the Markdown
file mount; expensive nested source and scientific renderers load only when their surfaces are
needed, so the ordinary chat path does not initialize them.

Milkdown, MDXEditor, Vditor, MarkText, Muya, and newer Typora-like projects remain interaction
and test references, not runtime foundations. Their useful ideas may be reimplemented through
Scient-owned modules; their serializer behavior is not the file-authority contract.

### Amendment record (2026-08-29): editor core re-selection

The 2026-08-23 selection (ProseMirror core plus a source ledger performing surgical byte
patches) is superseded. Trigger: sustained quality failures in the implemented surface (broken
controls, unwritable regions, latency) and a precedent study of twelve editor codebases
(MarkText/Muya, Milkdown, Vrite, BlockNote, Zettlr, HedgeDoc, StackEdit, ByteMD,
codemirror-live-markdown, atomic-editor, prosemirror-markdown, mdast-util-to-markdown) analyzed
at source level, plus Typora's own documented interaction gaps.

Findings that drove the change:

- No working editor patches source bytes through a semantic model. Editors either keep source
  text as the document (fidelity by construction: Obsidian, Zettlr, atomic-editor) or
  re-serialize a semantic tree and accept normalization (Milkdown, BlockNote, Vrite; BlockNote
  names its own markdown API lossy). The source-ledger mechanism has no precedent among them and
  concentrated the implementation's worst defects.
- prosemirror-markdown is a lossy transcoder: unknown tokens throw, reference links, HTML, and
  front matter are dropped, and list markers, emphasis, and setext headings normalize. No
  preservation hook exists in it.
- The CodeMirror live-preview path has production evidence for the full scientific surface:
  Zettlr renders math, citations, tables (per-cell embedded editors), and diagrams as widgets
  over an untouched buffer, and atomic-editor ships the stability mechanisms with unit and
  end-to-end tests under MIT.
- Logseq's lossy round-trip of user files, which drove a community repair tool and reported
  unrecoverable data loss, is the standing cost of abandoning file fidelity.

Consequences: the buffer is the file and preservation is structural. Structural commands that
ProseMirror provided (list splitting, table structure operations) become Scient-owned CodeMirror
commands. The 2026-08-23 landscape table above remains as research history; where its decisions
conflict with this record, this record governs, notably ProseMirror "adopt the core" and
CodeMirror "not the rich document model".

Staging: a disposable spike branch first mounts the CodeMirror live-preview core (reveal policy,
widget projections over a real fixture corpus, existing session/save integration) and passes a
human feel gate against the interaction model in this document. Production surface migration,
tables, and ledger and ProseMirror retirement proceed only after that gate. The product contract
in this document (states, node behavior, file lifecycle, verification matrix, budgets) is
unchanged by this amendment.

### Why the previous Lexical pass is not the base

The previous branch rebuilds a separate rich editor when Write is selected and listens to every
Lexical update. It then serializes the entire editor tree and forwards the result to autosave.
Consequently, import normalization during mode entry can be mistaken for user authorship. The
observed result included removal of a table and flattening of a nested list without typing.

Useful interaction components and backend tests from that branch may be ported only after their
behavior is revalidated against this contract. Its import/export bridge and whole-document
autosave design must not be reused.

### Implemented product shape

The surface provides the rendered view as the editor over the file buffer,
Read/Write/Source/Split, revision-bound serial
autosave, external-conflict handling, rich formatting/lists/tasks/tables, math, highlighted nested
code editing, images, wiki links, citations/footnotes, Mermaid/Vega/Plotly previews, raw source
islands, find/replace, outline navigation, structural block operations, create/rename, and secure
asset insertion. During the staged 2026-08-29 transition, the ProseMirror and source-ledger
implementation remains in place until the CodeMirror surface reaches parity.

Changes to that shape require proportional evidence for unchanged-source reuse, CRLF and Unicode,
malformed input, composition safety, RTL block direction, last-valid scientific rendering,
mode-safe links, collision-safe file operations, save recovery, and representative large-document
latency.

### Module boundaries

```text
packages/scient-markdown/
  source/        Buffer integrity: external-change diffing, preservation invariants, fixtures
  model/         Framework-neutral document/node capabilities and invariants
  file/          Revisions, conflict state machine, save intent, asset policy
  fixtures/      Round-trip and adversarial scientific Markdown corpus

apps/web/src/scient/markdownEditor/
  session/       One ScientDocumentSession per open file
  cm6/           Live-preview projection: reveal policy, decorations, commands, plugins
  widgets/       Math, table, code, figure, citation, diagram widget implementations
  source/        Source and split surfaces over the same buffer
  ui/            Minimal header, contextual controls, menus, status
  styles/        Owned tokens and node styles aligned with reading typography

apps/server/src/scient/markdown/
  WorkspaceMarkdownFiles.ts  Atomic create, rename, binary asset operations
  http.ts                    Typed HTTP handlers for remote-ready clients

packages/contracts/src/scientMarkdown.ts
packages/client-runtime/src/state/scientMarkdownHttp.ts
```

Inherited mounts are limited to:

- one lazy Markdown surface mount and mode control in `FilePreviewPanel`;
- one create-document action mount in `FileBrowserPanel` and the command registry;
- contract exports and server layer composition;
- package manifests and the generated lockfile.

A seam test records these mounts and fails if Scient editor logic spreads into inherited paths.

### Document session

`ScientDocumentSession` owns one immutable baseline and a stream of explicit state transitions:

```text
disk bytes + revision
        |
        v
CodeMirror buffer (the file's exact bytes) <-> live-preview projection (decorations/widgets)
        |                |
        |                +-> user edits -> dirty buffer -> debounced save intent
        +-> Source/Split edits -> the same buffer, projection disabled
        |
        v
buffer bytes -> pending bytes -> CAS atomic write
```

The same `EditorView` remains mounted in Read and Write. Decorations, focus, selection, and
interaction plugins change; the buffer text does not. Read/Write changes are session UI events,
never document edits. Source and Split bind the same buffer, so caret, selection, and scroll
continue across mode changes.

External file updates enter through a separate diff-and-merge transition that reconciles the
buffer with new disk bytes and reports conflicts. Programmatic selection, decoration, viewport,
and remote-sync transactions carry explicit metadata and can never create save intent.

### Source preservation

Preservation is structural: the buffer holds the file's bytes, so untouched regions are intact by
construction rather than by reconstruction.

- The editor never re-serializes the document; every save writes buffer bytes.
- Unsupported or unknown syntax is ordinary buffer text with no special handling. It renders as
  an editable source island by default and survives every edit elsewhere.
- Widget projections (math, tables, figures, diagrams, code) replace construct ranges visually
  only. Their source text stays in the buffer until the user edits it through the widget's
  controls or after dissolving the widget to source.
- A canonicalizing Format Document remains an explicit action with a preview/diff; it is never an
  autosave path.
- External changes are diffed into the buffer or raise a conflict; the editor never rewrites
  untouched regions to match its own preferences.

The buffer must preserve CRLF/LF, final newline state, Unicode and bidi controls, front matter,
HTML comments, reference definitions, fence length, list markers, indentation, table alignment,
entity spelling, and untouched whitespace, by never writing anything except the user's edits.

## Server and security contract

- Reuse inherited workspace-root resolution and authentication scopes.
- Resolve canonical paths and reject symlinked-ancestor escapes.
- Create and destination rename are exclusive; existing targets are never replaced.
- Rename requires the expected content revision and reports a conflict if bytes changed.
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
| No mutation on mode change | transaction spy, save spy, before/after SHA, 100-toggle test                   |
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
- Read/Write toggle performs no parse and settles in one animation frame for an already loaded
  document.
- Typing p95 stays below 16 ms for a 100 KiB representative document and below 32 ms for 500 KiB.
- Opening a 100 KiB document reaches an interactive first viewport within 250 ms on the
  qualification Mac after the lazy chunk is available.
- Long documents use viewport-aware decorations and defer heavy math/diagram work outside the
  active region.
- Inactive Plotly and Mermaid nodes do not continuously animate or repaint.
- Repeated mode toggles and file switches show no unbounded listener, DOM, or heap growth.

## Change acceptance

A rich Markdown change is reviewable only when every applicable matrix row has current evidence,
the branch is based on current owned main, the worktree is clean, and the exact candidate has been
qualified in an isolated Scient development app. Passing narrow unit tests, completing a visual
shell, or demonstrating plain-text editing is not product acceptance.
