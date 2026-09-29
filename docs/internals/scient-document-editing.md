# Scient document editing foundation

> **Status: proposal under discussion — not accepted.** First drafted 2026-09-26.
> Revised 2026-09-29 with reviews from Claude, Codex, and Astra. Nothing here
> changes current behavior.
>
> Status labels used below:
>
> - **Direction** — agreed by the product owner; details are still open.
> - **Proposed** — a recommendation that has not been agreed yet.
> - **Hypothesis** — a behavior to test in the running app before it becomes a
>   rule.
> - **Open** — needs a decision before the work that depends on it starts.
>
> This record extends, and does not replace,
> [the rich Markdown editor contract](./scient-rich-markdown-editor.md). That
> contract remains the accepted source for source preservation, the Markdown
> document session, the verification matrix, and the performance budgets. Once
> this record is accepted, the rules shared by all formats move here, and that
> document keeps the Markdown-specific ones.

## Approach — Proposed

Scient builds **one document-editing system through concrete Markdown
improvements, with LaTeX involved early enough to test every important
architectural boundary.**

1. **Guarantees first.** Components and ownership follow from what must always
   hold (see [Guarantees](#guarantees--proposed)).
2. **Markdown is the starting point, not the final answer.**
   - The Markdown editor provides working code, source-preservation machinery,
     and regression coverage.
   - It does not automatically decide the new experience or every shared
     interface. For each area, the choice is made deliberately: keep the Markdown
     approach, adopt an idea from LaTeX, combine them, or redesign.
3. **LaTeX is tried early and thinly.** LaTeX is the harder format: multi-file
   documents, preambles and packages, pages, dense math. A thin LaTeX path on
   each shared piece shows a wrong boundary while it is still cheap to change. We
   do not wait until the last stage to find out whether LaTeX fits.
4. **Share by responsibility, not by visual resemblance.**
   - Things that look alike may share controls and conventions without sharing
     one implementation. For example, a Markdown table and a LaTeX table may share
     a picker and navigation without sharing one node schema.
   - There is no universal editor component full of per-format branches.
5. **Consistency means the same behavior for the same intention.** Saving,
   finding, making text bold, and editing an equation behave the same wherever
   they apply. A code editor, a scientific document, and the chat composer do not
   have to behave identically.
6. **Would this difference help the person writing?** Every difference between
   editors is tested against this question. If a difference helps the writer, it
   stays. If it exists only because the editors were built separately, it is
   unified.
7. **Sharing appearance is separate from sharing implementation.** The editors
   can become visually consistent before every internal part is shared, and
   shared internals do not force identical layouts.
8. **Interaction rules are tested before they are written down.** Behaviors this
   record marks as hypotheses become rules only after they have been exercised in
   the running app.
9. **Measure instead of estimating.** Every step reports before-and-after results
   from the same tests and documents.
10. **Few changes in flight.** Only a small number of implementation changes run
    at once, so failures stay understandable.

## Why this exists

Scient has two rich editors for scientific writing, and they are growing apart:

- **Markdown.** The rich Markdown editor on `main` is built directly on
  ProseMirror, with a source ledger, a persistence coordinator, and KaTeX math
  edited through the shared math input controller. It is mature and tested. It
  also carries design debt:
  - object editors are mounted inside the document flow;
  - keyboard dispatch is layered three or four times;
  - `view.ts` and `ScientMarkdownControls.tsx` are about 1,900 lines each;
  - a stale projection is corrected by a queued microtask.
- **LaTeX.** The Visual view in
  [PR #353](https://github.com/ScientFactory/scient-desktop/pull/353) uses Tiptap
  and MathLive.
  - It has its own localStorage draft journal, toolbar and footer, and its own
    math, table, and figure editing.
  - It keeps `.tex` authoritative and patches only changed blocks, but each
    keystroke converts and re-checks the whole document.
  - It contributes design ideas this record adopts: the footer, the Documents
    panel, the Insert menu, document checks, and zoom.
- **Beyond the two rich editors.** An inventory of every editing surface on
  `main` (2026-09-29) found differences a user notices:
  - find works differently in rich and source views;
  - the same keys mean different things in different editors;
  - there are two sets of conflict messages and three kinds of view switch;
  - crash recovery exists only for Markdown and chat drafts.

The formats differ in syntax, in how constructs map to document nodes, and in
their output: for Markdown the rendered page is the output, for LaTeX the
compiled PDF is. Most of what makes an editor trustworthy is not format-specific.

## Scope — Proposed

| Level                                                                                                | What is unified                                                                                                                                                  | What can remain different                                   | In scope                                                     |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| **All file editors**: Markdown and LaTeX rich views; Markdown, LaTeX, code, and Compute source views | Sessions, saving, recovery, conflict handling, revision identity, status vocabulary; one conflict notice; one view switch in the header; one keyboard vocabulary | Editing engine; execution and output workflows (build, run) | **Yes**                                                      |
| **Rich document editors**: Markdown and LaTeX                                                        | Command conventions, toolbar and footer components, floating editors, keyboard ownership, common writing tools                                                   | Schemas, specialized blocks, layout, format capabilities    | **Yes**                                                      |
| **Other text surfaces**: chat composer, source notes, PR descriptions, comments, forms               | Relevant visual and interaction conventions                                                                                                                      | Their own workflows                                         | **No.** A reference for consistency, not a migration project |

**Out of scope:** PDF reader internals, the TeX build service, multi-user
collaboration, and MDX.

## Guarantees — Proposed

These hold for every format and every view:

1. **Opening or switching views never changes the source.** Focusing,
   selecting, zooming, and closing also leave bytes and revision untouched.
2. **An edit preserves unrelated source text.** This holds between blocks _and
   inside an edited block_. Spelling, delimiters, command names, dashes, line
   breaks, and whitespace outside the edited span stay exactly as written.
3. **Rich and source views work on the same working text.** No view keeps a
   second copy that could overwrite another.
4. **Unsaved work survives interruption and never silently overwrites external
   changes.** Refresh, crash, reconnect, and a second window all preserve it.
   Agent edits to the same file are merged or surfaced as a conflict, never lost.
5. **Focus, selection, and undo stay predictable** through saves, validation, and
   external updates.
6. **Unsupported syntax stays intact and reachable.** It becomes an exact-text
   source island and never disables rich editing elsewhere.
7. **Unsupported operations fail without discarding the user's input.**
8. **Editing, saving, and producing a PDF are distinct and visibly so.**

### Source and session model

The central relationship is:

```text
working text in the session → rich and source views → saved revision → derived output (PDF)
```

| Version            | What it is                                                                   | Owner                                               |
| ------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| **Working text**   | The current text, including unsaved edits. Every view is a projection of it. | The document session                                |
| **Saved revision** | The bytes most recently published to disk, identified by a revision          | The workspace file system (compare-and-swap writes) |
| **Built revision** | For LaTeX, the revision a PDF was compiled from                              | The build service                                   |

- **The session owns** the working text, revisions, persistence, recovery, and
  reconciliation.
- **Views submit edits against an identified revision.** No view maintains its
  own saving system.
- **Format adapters own interpretation and source-preserving updates.** Each one
  declares which operations it supports and when a broader reparse is needed.
- **Status reports these as distinct facts:** editing, saved, and, for LaTeX, "PDF
  from an older revision".

### Hard questions — Open (answered in writing in stage 1)

These are where individually good components still add up to an unreliable
editor. Each needs a written answer before shared code depends on it.

1. **Selection.** How do selection and caret survive projection updates and
   external edits?
2. **Undo ownership.** Who owns undo across the rich view, the source view, and
   embedded editors such as math and code? Today, switching an `.md` file between
   rich and source views loses undo history.
3. **Object editors and external edits.** What happens to an open object editor
   when an agent changes its source?
4. **Save acknowledgements.** How does a save acknowledgement relate to newer,
   still-unsaved work?
5. **Build freshness.** How is LaTeX build freshness tied to specific source
   revisions?
6. **Refused edits.** How does an unsupported operation fail without losing what
   the user typed?

## Product principles

These sit on top of the guarantees.

1. **Rich when possible, source when necessary.**
2. **Never offer an edit that cannot be saved.** A region is editable only if a
   representative edit to it round-trips. Controls appear according to what the
   format can do. Markdown never shows disabled LaTeX-only controls.
3. **Every control has one home.** The page holds only content. Commands, object
   properties, status, and transient editors each have one predictable place,
   and none of them moves the document.
4. **Quiet when safe, clear when at risk.** Routine saving is invisible. Status
   draws attention only when work is at risk or needs a decision.
5. **Honest about output.** For LaTeX, the compiled PDF is the actual output and
   is always identifiable as such. The writing canvas never presents itself as an
   exact preview.
6. **Few steps.** Creating, inserting, and navigating take the fewest steps that
   remain safe. Anything that can be defaulted, or edited in place later, is not
   asked for up front.
7. **Keyboard-complete, direction-aware, local.** Every action is reachable from
   the keyboard, RTL and mixed-direction text work throughout, and editing needs
   no hosted service.

## Responsibility boundaries — Proposed

| Layer                          | Shared responsibility                                                                                                            | Stays format-specific                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Document session**           | Working text, revisions, save ordering, recovery, external changes, conflict state                                               | Format-aware reconciliation where a merge needs syntax knowledge                 |
| **Format adapter**             | One interface for projecting source into an editable document and applying supported edits back as exact text changes            | Parsing, syntax preservation, which regions are editable, the construct registry |
| **Rich-editor infrastructure** | Transaction integration, per-block verification, selection mapping, the object-editor lifecycle, command routing, source islands | Schemas and specialized blocks                                                   |
| **Editor interface**           | Toolbar and footer components, menus, focus conventions, status presentation, find controls                                      | Which commands exist; format-specific object properties                          |
| **Document services**          | Document creation, asset selection, document-check and navigation interfaces                                                     | TeX roots, preambles, bibliographies, builds, SyncTeX                            |

- **Source and rich views can share controls without sharing implementations.**
  For example, one find bar can drive ProseMirror search in the rich view and the
  source editor's own search in source view.
- **The session does not depend on ProseMirror.** Source views are session
  clients too, which is how every file editor gains recovery and agent-edit
  merging.

## Experience model

### Two modes of one Scient editor — Proposed

Markdown and LaTeX look like **two modes of the same Scient editor**. Someone
moving between them already knows where things are and how to use them. The
document itself does not have to look identical.

| Part                            | Recommendation                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **The surrounding interface**   | The same visual design: header, toolbar, footer, menus, icons, spacing, status, and dialogs                       |
| **Common editing interactions** | The same behavior: selecting text, editing math, inserting images, finding text, opening object controls          |
| **The document canvas**         | Shared styling defaults, with deliberate differences only where the format requires them and they help the writer |

For example, selecting a table reveals its properties in the same place, using
the same controls. LaTeX adds options for numbering, captions, or table
environments where they exist. It does so without a different toolbar design, and
without filling Markdown with disabled LaTeX controls.

Ordinary content (a paragraph, a heading, an equation, a table) should feel very
close in both. Format-specific content (a numbered theorem, a title block, a
cross-reference) is expressed properly in its own format.

### Experience study — Proposed

Before the shared interface is built, a short, time-boxed, hands-on study runs in
the real app. It compares exact candidate revisions, using paired `.md` and
`.tex` documents, and is organized by **task**:

- write prose with inline and display math;
- edit a table and a figure;
- encounter unsupported syntax;
- switch between rich and source views with unsaved edits;
- navigate and search a long document;
- observe saving, a conflict with an agent's edit, and recovery;
- create a document and, for LaTeX, build its PDF.

For each task it records:

- what the user is trying to do;
- what each surface does today;
- the decision: keep Markdown's approach, adopt LaTeX's, combine, or redesign;
- the proposed behavior;
- how success will be recognized.

**How the visual comparison runs:**

1. The same proposed header, toolbar, and footer are placed around both
   documents first, to settle the overall identity.
2. The canvas alternatives are then compared separately (see
   [Canvas](#canvas--proposed)).
3. Typography is compared separately again.

The study covers the tasks the next stages need. Later tasks are studied when
their stage comes up.

### Surface anatomy — Direction

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Header   file name · view switch · file actions                      │
├──────────────────────────────────────────────────────────────────────┤
│ Toolbar  document-level commands · priority overflow into More       │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Page   the document itself, rendered and directly editable         │
│          · selection toolbar and Insert menu appear at the caret     │
│          · object editors float, anchored to their object            │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ Footer   [selected object's properties]        [position · status]   │
└──────────────────────────────────────────────────────────────────────┘
```

Each zone has one job:

| Zone    | Job                                                            | Holds                                                                         | Never holds                                                                    |
| ------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Header  | Which file and which view                                      | File name, view switch, file actions (rename, export)                         | Status, formatting                                                             |
| Toolbar | Document-level commands                                        | Text style, lists, link, Insert, math, undo and redo, More                    | Controls that change with the selection; it does not reflow as the caret moves |
| Page    | Content                                                        | The document, the selection toolbar, the Insert menu, floating object editors | Controls placed in the document flow                                           |
| Footer  | Where you are, what is selected, what state the document is in | Properties of the selected object, position, counts, checks, file state       | Document-level commands                                                        |

**Placement rule:**

- Editing an object's _content_ (formula source, diagram or chart source) happens
  in a floating editor next to the object.
- Changing an object's _properties or structure_ happens in the footer:
  - table: rows, columns, alignment, style, caption;
  - equation: type, numbering, label;
  - image: width, caption, alt text;
  - code block: language.
- Nothing is inserted into the page to edit an object.

### Footer — Direction (contents are hypotheses)

The footer concept is agreed and shared by both formats. Its contents, overflow,
and narrow right-panel behavior are tested in the study before they are fixed,
so it does not become a permanently crowded strip.

```text
[Table  + row  + column  align ▾  style ▾  caption]    Table · r3 c2 · 1,284 words · 2 issues · 1 source block · ●
```

**Left: properties of the selected object.**

- A slot owned by the editor controller. Node views register their controls
  there; they do not search the DOM for it.
- Empty when plain text is selected.
- Uses the app's shared UI primitives, not native `<select>` or `<details>`.

**Right: status**, listed in priority order. Which items stay at narrow widths is
decided by the study.

1. **File state.** One quiet indicator for the three versions:
   - hidden while routine saves are healthy;
   - shown when publishing is unusually slow;
   - the recovery action on a conflict or an exhausted failure;
   - for LaTeX, also build freshness ("PDF from an older revision").
2. **Position.** The caret's context ("Heading 2", "Table · row 3, column 2",
   "Equation"). For LaTeX, the page comes from the last built PDF through
   SyncTeX, labeled with the revision it belongs to. It is never a simulated
   page.
3. **Checks.** "2 issues" when the document has problems; clicking opens the list.
   Hidden when there are none.
4. **Source islands.** "1 source block" when content is kept as exact source;
   clicking moves to the next one. Hidden when there are none.
5. **Count.** Words in the document or in the selection.

**Accessibility.**

- The footer is not one large live region. Caret movement is never announced.
- Only file-state changes that need attention, and new check results, are
  announced politely.
- Every footer control is reachable from the keyboard, and one shortcut moves
  focus into the footer.

### Object editors — Proposed

Floating editors for object _content_:

- inline and display math;
- Mermaid, Vega-Lite, and Plotly source;
- the citation and reference picker.

Each is portaled and anchored to its object, with one active at a time per
surface. See [Object editor layer](#object-editor-layer--proposed).

### Views — Proposed

Both formats use the same vocabulary:

- **Write** — the rich page.
- **Source** — the exact text.
- **PDF**, and side-by-side combinations — LaTeX only.

The view switch lives in the file header for every format, replacing today's
three different switches.

**Open:**

- whether Markdown gains a side-by-side view;
- which view LaTeX opens in by default.

### Canvas — Proposed

The biggest visual decision is the canvas. The baseline is **one calm writing
canvas shared by both formats**, with the same:

- selection styling;
- width and zoom controls;
- object outlines;
- editing affordances.

**Typography varies intentionally:**

- Markdown uses Scient's reading typography, following the app's appearance
  settings.
- LaTeX may reflect its document class: text width derived from page size and
  margins, and font sizes from the class options. How much of this fidelity helps
  is decided in the study.

**Pagination is a separate capability,** not the defining difference between the
editors.

- Simulated pages look like an exact PDF preview even when fonts, line breaks,
  and page breaks differ from the compiled output.
- They are also costly: #353's pagination measures every block on each change.
- Pagination stays only if it helps writing and navigation enough to justify
  that cost.
- Page position comes from the real PDF (see [Footer](#footer--direction-contents-are-hypotheses)).

**Canvas alternatives the study compares for LaTeX:**

1. A continuous canvas with Scient's reading width.
2. A continuous canvas at the document's page text width.
3. Simulated pages (#353 today).

**Open:** LaTeX in dark mode. White paper on a dark surround, as in a PDF reader,
or a dark page that follows the app.

### Keyboard — Proposed

- **The same command uses the same key in every file editor:** bold, italic,
  heading levels, lists, link, insert math, Insert menu, find and replace, undo,
  redo, and focus footer.
- **Conflicting keys are resolved by the study.** Today Alt+↑/↓, Cmd+Enter, and
  Cmd+Alt+F mean different things in different editors.
- **Format-only commands** live in that format's scope.
- **Hypothesis:** Escape moves outward in one fixed order everywhere:
  1. nested editor;
  2. object editor;
  3. popover or menu;
  4. selection.

### Visual language — Proposed

- **Shared stylesheet.** Chrome styles (toolbar, footer, menus, popovers, object
  editors, find bar, Documents panel) move to one shared stylesheet built on app
  tokens.
- **Per-format document styles.** Each format keeps only its _document_ styles:
  content typography, and page width for LaTeX.
- **Shared editor typography tokens** for prose, code, and measure. One
  code-highlighting theme across rich code blocks and source views.
- **No hard-coded colors** in chrome.
- **Validation in the running app.** Every change to look and feel is checked with
  screenshots, and short recordings for interaction. Automated checks and the
  owner's visual acceptance are recorded separately.

## Documents panel — Direction

A right-panel surface that is the home for writing in a project, for Markdown and
LaTeX alike. The concept comes from #353. This record keeps the concept and
removes the steps that are not needed.

### Layout

```text
┌ Documents ─────────────────────────────── [Files] ┐
│ New                                               │
│ [Note] [Lab entry] [Paper draft] [Report] [Blank] │  ← templates, both formats
│ [Assignment] [Proposal] [Thesis] …                │
│                                                   │
│ [Find a document…]                                │
│ Recent                                            │
│   ▸ paper/main.tex          LaTeX                 │
│       sections/intro.tex                          │
│   · notes/2026-09-26.md     Markdown              │
│ In this project                                   │
│   …                                               │
└───────────────────────────────────────────────────┘
```

### Creating a document: two steps

1. **Pick a template.** A title field opens inline on that card. The derived file
   path shows underneath as a quiet hint; clicking the hint edits it.
2. **Press Enter.** The file is created (create-only, never overwriting) and opens
   in Write view with the caret in the body.

Nothing else is asked:

- **Author** is filled in from the user's profile.
- **Course, institution, and date** are edited on the page itself, in the title
  block.
- **No confirmation noise:** there is no source preview, no success toast, no
  "Saved" notice, and no explanatory footnote.
- **Failures stay inline.** An existing path or an invalid name shows an inline
  message on the same field.

### Lists

- **One list for both formats**, each entry marked with a format icon, with search
  at the top. Recents come first, then everything else in the project.
- **LaTeX shows root documents only.** Included chapters are nested under their
  root, using the existing root resolution. They are not listed as separate
  documents.
- **Duplicate** is an action on any document row. It replaces #353's separate
  "use a project template" flow.
- **Recents** use the app's storage helpers, not raw `localStorage`.

### Templates

- **Markdown:** a small set, such as Note, Lab notebook entry, Meeting notes, and
  Paper draft (with front matter).
- **LaTeX:** #353's five (Assignment, Report, Proposal, Thesis, Blank).
- Templates are data, one file each.
- User and project templates ("Save as template") come later.

### Where new documents go — Proposed

- **Markdown:** a single file in the folder currently selected in Files, or the
  project root.
- **LaTeX:** its own folder, `<title>/main.tex`. Templates that cite also get a
  `references.bib` beside it, because a LaTeX document grows into a folder of
  figures, bibliography, and build output. **Open:** confirm this layout.

### One create path

- The small **+** in the file browser stays, for quick untitled files, and gains a
  `.tex` option.
- It and the Documents panel call one shared create service, which owns naming,
  collision handling, and template filling. There is no second creation
  implementation.

## Shared writing tools — Proposed

Each of these is implemented once. The format adapter supplies the items, the
syntax, and the rules.

1. **Insert menu.** `/` on an empty line and Cmd/Ctrl+/ open one searchable menu.
   It replaces Markdown's slash menu and #353's Insert dialog. Items come from the
   format's construct adapters, so only constructs that can actually be saved are
   offered.
2. **Outline.** A collapsible side panel listing headings, plus figures, tables,
   and equations where the format labels them. It replaces Markdown's More-menu
   outline and #353's navigation pane.
3. **Document checks.** See [Document checks](#document-checks--proposed). The
   seed of this is #353's Review dialog.
4. **Zoom, fit, width, and pinch.** One canvas control for both formats.
5. **Figure and image picker.** Lists the project's images and supports upload.
   Paths resolve from the document's _build context_: the root file's folder for
   LaTeX, the file's own folder for Markdown.
6. **Citation and cross-reference picker.**
   - Sources: the Sources library, `packages/scient-citations`, linked `.bib`
     files, and the document's labels and headings.
   - Inserts `[@key]` in Markdown, `\cite{key}` or `\ref{label}` in LaTeX.
   - Neither editor uses Sources today.
7. **Document properties.** One place for metadata: title, author, and date in
   LaTeX; front-matter fields in Markdown. It opens from the toolbar's More menu.
   LaTeX adds page layout (paper, base font, margins, paragraph style) and writes
   _only the setting that changed_.
8. **Table picker.**
   - Markdown's progressive size picker, combined with #353's style presets.
   - Presets are per format.
   - Presets that need a package are offered only when that package is available
     or can be added.
9. **Find and replace.** The shared find bar and search plugin. Atoms (math,
   citations, source islands) are searched through their source text. The LaTeX
   Write view has no find today.
10. **Cite selection to chat.** Markdown's `FileCitation` capture extends to LaTeX
    through the session's mapping from document ranges to source ranges.

### Document checks — Proposed

Checks run on the source after a quiet delay and never block editing. Results
appear as the footer count and as a list that jumps to each location.

| Format   | Checks                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LaTeX    | Repeated labels, references to missing labels, citations missing from linked bibliographies, missing images, packages or declarations a construct needs but the root does not load |
| Markdown | Broken wiki links, missing images, undefined footnotes and reference links, links to missing headings                                                                              |

## Architecture

### Editing framework: ProseMirror directly — Proposed

**What this decision is, and is not.** Neither framework guarantees source
fidelity. Fidelity comes from the source model, the format adapters, how
transactions are verified, and the tests. Markdown has it because of its source
ledger, not because of ProseMirror. Tiptap does not prevent sharing either:
Tiptap runs on the same ProseMirror packages, and plain ProseMirror plugins work
inside it.

**Why direct ProseMirror is still recommended for document editors:**

- **One block-view style and one editor core** are shared with the Markdown
  editor. Shared node views (math, source island, table, figure) are written
  once, not once per wrapper.
- **The transaction pipeline stays visible and owned.** With Tiptap, StarterKit
  behaviors (input rules, paste handling, list and heading commands) must each be
  audited or disabled against the preservation guarantee.
- **One fewer major dependency** to keep aligned in the document editors. The
  chat composer keeps Tiptap; it is upstream code and outside this effort.

**How it is validated:** a thin LaTeX path on the shared core (stage 4) measures
fidelity, responsiveness, focus stability, and complexity, instead of estimating
the port from line counts. The record keeps this as a recommendation until the
owner settles it.

### Format adapter contract — Proposed

A format plugs in through one adapter. The shape below is a starting point. It
settles when a second real consumer (the thin LaTeX path) uses it, not before.

```ts
interface DocumentFormatAdapter<Context> {
  /** Parse source into top-level blocks with exact ranges plus a ProseMirror doc. */
  project(source: string, context: Context): Projection;
  /** Exact text changes for the next doc, or a typed refusal. Verified per changed block. */
  apply(previous: Projection, next: PMNode): SourceEdit | Refusal;
  /** Incremental adoption of an external source change, reusing unchanged nodes. */
  adoptExternal(previous: Projection, source: string): Projection | null;
  /** Merge of baseline/local/disk for the session's reconciliation step. */
  reconcile(base: string, local: string, disk: string): string | Conflict;
  /** Document context that other files contribute (e.g. LaTeX root preamble). */
  context: ContextResolver<Context>;
  /** Source checks shown in the footer. */
  check(projection: Projection, context: Context): readonly DocumentIssue[];
}
```

The rules every adapter follows:

- **Blocks carry exact source ranges.** Unchanged blocks are copied byte for byte.
- **Verification is local.** Only the changed blocks are re-serialized and
  reparsed. The whole document is never converted or checked on each keystroke.
- **Minimal patch first.**
  - An edit inside a block becomes the smallest text patch, verified by
    reparsing that block. This is what Markdown's `minimallyPatchedTextBlock`
    does.
  - Re-serializing a whole block is the fallback for real structural changes.
- **Source islands** are one shared rich-editor facility with a per-format label.
- **Construct adapters.** Inside a format, each supported construct (heading,
  list, figure, table, theorem, citation, …) registers:
  - how it is recognized, and a bounded parse;
  - its node;
  - its serialization;
  - what it needs from the document (packages, declarations);
  - when direct editing is safe;
  - its tests.

  The registry feeds the Insert menu and document checks, and it replaces an
  ever-growing parser switch.

- **Editability is proven, not assumed.** See the
  [conformance suite](#measuring-instrument--proposed).

### Document session and persistence — Proposed

**Generalize the Markdown session incrementally, preserving its behavior
first.**

- `@scientfactory/scient-markdown`'s session, persistence coordinator, and
  checkpoint become a format-neutral package, working name
  `@scientfactory/scient-document`.
  - `reconcileMarkdown` becomes a per-format strategy.
  - The ledger and projection stay in `scient-markdown`.
- The web registry, leases, ordered transport, departure guards, and recovery UI
  move to shared code.
- Markdown moves first, with no behavior change.
- Markdown's stale-projection path is fixed in the move. A rejected change is
  never pushed into the view and then corrected by a microtask.

**Prove it with a second consumer that is not ProseMirror: LaTeX source
editing.** Before the LaTeX Visual view uses the session, the LaTeX source view
moves onto it. That shows the session is independent of both Markdown and
ProseMirror, and users gain recovery and agent-edit merging for `.tex`. The
qualifying cases:

- typing while a save is pending;
- an agent changing the same file;
- switching views with unsaved edits;
- closing and recovering;
- reconnecting, or opening the file in a second window;
- rejecting a stale edit without losing newer work.

Other source views (code, Compute) may follow once the LaTeX source view
qualifies (**Open**).

**Server-ordered operations are a separate, later evolution.** The session
design carries explicit revisions and operation identities now, and it prefers
exact text changes over whole-document snapshots. That keeps a later move to
server-ordered operations (the 2026-09-21 reliability proposal) possible. It is
not promised to be effortless, and it is qualified as its own step.

**Multi-file LaTeX edits are explicitly limited.** Saves to a chapter and its
root preamble are sequential, not atomic. Until failure and recovery behavior
for coordinated edits is defined, an edit that needs a change in another file
(for example, a figure in a chapter needing `\usepackage{graphicx}` in the root)
is refused with guidance, and a document check reports the missing requirement.
No input is lost when an edit is refused.

### Object editor layer — Proposed

This takes the ownership rules from the 2026-09-21 proposal and applies them to
both formats. The first implementation is Markdown math, which exercises source
preservation, focus, keyboard ownership, undo, validation, and positioning
together. It is completed as an experience before the layer is generalized to
other objects.

- **Covers:**
  - inline and display math;
  - Mermaid, Vega-Lite, and Plotly source;
  - the citation and reference picker.

  Object _properties_ are edited in the footer, not here.

- **Ownership.**
  - The node view owns source changes, validation, and its persistent input
    instance.
  - The layer owns which editor is open, where it is placed, collision handling,
    dismissal, and returning focus.
- **Anchoring.** The rendered object stays in place as the anchor. Opening,
  validating, resizing, or closing an editor never changes document layout.
- **No remounting.** Attribute transactions, validation results, save
  acknowledgements, and presentation refreshes never remount the active input.
- **Invalid input is normal.**
  - Incomplete TeX or JSON is saved exactly as typed.
  - The last valid render is only a presentation cache.
  - A small, stable error status appears only after validation, never on every
    keystroke.
- **Hypotheses to test in stage 3:**
  - changes apply as the user types;
  - Escape closes the editor;
  - each editing session of an object is one undo step.

### Math — Open (decided in stage 3)

These are shared whichever input wins:

- **Source model.** Math is TeX in both formats. Delimiter and environment
  spelling is preserved as written.
- **Rendering.** KaTeX through `scient/math`, which chat and Markdown already
  share.
- **Catalog.** Merge `scient/math/input/catalog` with #353's LyX-derived symbol
  catalog (827 entries, with Unicode and package metadata) into one catalog
  that carries package requirements. It serves the palette, completion, and
  LaTeX preamble additions.
- **Controller.** `MathInputController`, which already abstracts the host editor
  through `MathInputAdapter` and knows the `latex` format.

The **input** choice is made in stage 3, the floating math editor, by comparing
the options with real formulas from both formats:

| Option                                                                                   | For                                                                              | Against                                                                                                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A. Source field + controller + palette and completion (Markdown today)                   | Exact source; native IME, undo, and selection; no new dependency; already shared | Less WYSIWYG for complex expressions                                                                                      |
| B. MathLive structured field (#353)                                                      | Structured editing of fractions and matrices                                     | Large dependency; the patched build bundle is a maintenance burden; it normalizes source; a second renderer next to KaTeX |
| C. A by default, with MathLive as an optional structured mode inside the floating editor | Both benefits                                                                    | Two input paths to qualify                                                                                                |

### Keyboard scopes — Proposed

- `KeyboardScope` becomes a registered set rather than a closed union. #353
  already adds `latex` and `table` scopes and a shared list of writing commands;
  that work is the starting point.
- A `source` scope brings source views into the same configurable system.
- Each surface has **one** dispatch path. Markdown's layered dispatch (direct
  props, plugin keymap, workspace sequence, React fallback) collapses into it.
- Splitting `view.ts` and `ScientMarkdownControls.tsx` follows from these
  extractions. It is not a separate refactor.

### Tables — Proposed

- **Shared:** the size picker (#353 already moved it to
  `scient/writing/DocumentTableSizeMenu.tsx` for both editors), navigation
  conventions, command vocabulary, and footer properties.
- **Per format, at least initially:** the node schema and serialization.
  - Markdown: GFM with inline cells and spans rejected.
  - LaTeX: tabular, tabularx, and longtable, preserving each cell's source
    through structural operations.
  - A shared schema is considered only if both formats turn out to need the same
    one.
- A structural action is offered only when every affected cell can be rewritten
  without loss.

### LaTeX output relationship — Open

- The Visual view approximates layout from the document class, options, and
  explicit geometry. The PDF is authoritative.
- Whether builds run automatically on save (current `main`) or only on request
  (#353) is a product decision outside this record.
- Either way, the footer's file state reports which revision the PDF shows.

## Proposed module layout

```text
packages/scient-document/            (new; generalized from scient-markdown)
  session  persistence coordinator  text changes  checkpoint contract
packages/scient-markdown/            (kept; Markdown adapter logic)
  sourceLedger  reconciliation
packages/scient-latex-source/        (Open; pure LaTeX projection, testable in Node)

apps/web/src/scient/documentEditor/  (new; shared rich-editor infrastructure and interface)
  controller/  objectEditors/  chrome/ (toolbar, footer, menus)  find/  islands/
  checks/  persistence/  keyboard bindings
apps/web/src/scient/writing/         (exists in #353; shared writing controls, e.g. table picker)
apps/web/src/scient/documents/       (Documents panel, create service, templates)
apps/web/src/scient/markdownEditor/  (Markdown adapter, nodes, Markdown-only UI)
apps/web/src/scient/latex/           (LaTeX adapter, nodes, page canvas, build and PDF)
apps/web/src/scient/math/            (render, input controller, merged catalog)
```

Names are working titles; `documentEditor/` and `writing/` may merge. Upstream
seams remain as the Markdown contract describes: inherited files mount Scient
modules and contain no editing policy.

## Quality

### Measuring instrument — Proposed

Built in stage 1 and used by every stage after it:

- **Document corpus.** Realistic papers and a thesis in both `.md` and `.tex`
  (multi-file included), plus a regression file for every defect found so far.
  #353's review contributed `~`, dashes, `\textit`, multi-line paragraphs,
  formatted table cells, labels with `_`, and fragments that need root
  declarations. All fixtures are synthetic.
- **Adapter conformance suite.** Any format adapter must pass it:
  - projecting and applying with no edit yields identical bytes;
  - every region marked editable accepts a representative edit, with bytes
    outside it unchanged (property-based, over generated and corpus documents);
  - external changes are adopted without disturbing unchanged blocks;
  - typing stays within the performance budget on a 500 KB document.
- **Baselines.** The suite runs against the Markdown adapter and against #353's
  current LaTeX translator, so every later step reports a before and after.

### Evidence per stage

Each stage provides three distinct kinds of evidence:

- **Correctness:** conformance and regression tests, recovery and conflict
  checks.
- **Interaction:** real keyboard, selection, undo, IME and RTL input, and view
  switching, tested in a browser, not only in markup tests.
- **Experience and performance:** the owner's visual acceptance in a candidate
  app, and measurements on long documents.

A passing source-preservation test does not prove that editing feels good, and
an attractive screenshot does not prove that recovery works.

Existing Markdown tests are a baseline, not proof that every current Markdown
behavior is desirable.

## Delivery — Proposed

### Stages

The shared and Markdown work lands on `main` as reviewable increments. The LaTeX
work stays in **one PR (#353) for now**, organized into clear commits and
checkpoints and regularly merged with `main`. How PRs are split is not the
organizing concern.

| Stage                               | Shared and Markdown work (owner)                                                                                                                                                                                                                                                                                   | LaTeX work (contributor, by assignment)                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Agreement**                    | Agree this record; refresh the implementation baseline on `main` and #353, and check existing work and ownership before creating branches                                                                                                                                                                          | —                                                                                                                                                                                      |
| **1. Baseline and contracts**       | Answer the [hard questions](#hard-questions--open-answered-in-writing-in-stage-1) in writing; define minimal revision, change, and adapter contracts; build the [measuring instrument](#measuring-instrument--proposed) and record baselines. **In parallel:** the [experience study](#experience-study--proposed) | Preserve regression cases; identify capability and fidelity gaps; harden the LaTeX translator against the minimal contract and conformance suite (local verification, minimal patches) |
| **2. Session foundation**           | Extract the session through Markdown with no behavior change; validate it with LaTeX source editing as the second consumer                                                                                                                                                                                         | Help connect LaTeX source; remove the separate draft journal once the replacement is verified                                                                                          |
| **3. First shared interaction**     | Complete floating math editing in Markdown: focus, selection, undo, validation, placement, and the math input decision. Starts once the study has answered its questions                                                                                                                                           | Exercise the same object-editor lifecycle with LaTeX math                                                                                                                              |
| **4. Early rich LaTeX integration** | Adjust shared boundaries based on actual use                                                                                                                                                                                                                                                                       | Thin LaTeX path on the shared core: open, prose and math, raw source, edit, save, switch to source, reopen. Includes an unsupported command and an included chapter. Measured.         |
| **5. Broader writing experience**   | Footer (after narrow-panel testing), commands, find, Insert, outline, keyboard, document creation                                                                                                                                                                                                                  | Format-specific controls; migrate the remaining constructs one by one: tables, figures, references, title, layout, and pagination if kept                                              |
| **6. Qualification**                | Recovery, external changes, responsiveness, and the owner's visual review                                                                                                                                                                                                                                          | The same checks, plus root context, builds, and multi-file behavior                                                                                                                    |

The session work and the experience study progress independently. Floating math
is the first visible shared improvement, and it starts when the study has
settled its interaction questions. Existing useful LaTeX behavior is preserved
while its implementation is replaced. Small, self-contained fixes land whenever
convenient.

### Working model and coordination

- **Direction.** The product owner sets the direction for everything, including
  the LaTeX branch.
- **Ownership of work.**
  - The owner drives the shared foundation, the Markdown work, and part of the
    LaTeX work.
  - #353's author continues LaTeX work through clearly assigned tasks.
- **This record explains the system; assignments define the next deliverable.**
  Each assignment states:
  - the bounded area the assignee owns;
  - the behavior to preserve or improve;
  - the shared interface to build against, and whether it is still provisional;
  - acceptance criteria and known dependencies.
- **Ownership is agreed before either side changes shared files or the same
  LaTeX component.** Shared code includes the session, rich-editor
  infrastructure, editor interface, keyboard, math input, and writing controls.
  Changes to it keep the Markdown editor's tests passing.
- **Framework.** New LaTeX work avoids Tiptap-specific building blocks (React
  node views through Tiptap, reliance on StarterKit behaviors), so less has to
  move in stage 4. Investment in LaTeX logic (the translator, construct coverage,
  layout, templates) carries forward regardless.
- **No new persistence path.** The LaTeX branch does not grow new draft or save
  mechanisms; it moves to the shared session in stage 2.

### Next steps

1. **Update this record** in #373 to reflect the agreed approach,
   responsibilities, and decision status.
2. **Refresh the implementation baseline** on `main` and #353, and check for
   existing work and ownership before creating implementation branches.
3. **Prepare the experience study:** isolated candidate apps, paired `.md` and
   `.tex` fixtures, and a concise decision sheet.
4. **Define the contributor's first assignment:** LaTeX adapter fidelity and
   regression coverage against the minimal shared contract.
5. **Start the first implementation slice:** extract the document session through
   Markdown, then prove it with LaTeX source. The study meanwhile prepares
   floating math editing as the first visible shared improvement.

## Working on shared pieces

### Read first

- This record, for direction and open decisions.
- [The rich Markdown editor contract](./scient-rich-markdown-editor.md). It is the
  accepted rulebook for:
  - source preservation ("Source preservation", "Incremental work");
  - the Markdown document session ("Document session" and the coordinator
    paragraphs under "Selected foundation");
  - the verification matrix;
  - the performance budgets.
- [Keyboard ownership](./scient-keyboard.md), [math rendering](./scient-math.md),
  and the [LaTeX build](./scient-latex.md).

### Code to build on, not duplicate

| Concern                                 | Start here                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Session, saving, conflicts, recovery    | `packages/scient-markdown/src/{session,persistenceCoordinator,reconciliation}.ts`; `apps/web/src/scient/markdownEditor/persistence/`   |
| Minimal source patching                 | `apps/web/src/scient/markdownEditor/prosemirror/projection.ts` (`minimallyPatchedTextBlock`) and `externalProjection.ts`               |
| Source islands                          | `apps/web/src/scient/markdownEditor/nodes/{rawBlockNodeView,codeMirrorCodeEditor}.ts`                                                  |
| Math input                              | `apps/web/src/scient/math/input/` (`MathInputController`, `MathInputAdapter`), `apps/web/src/scient/math/` (KaTeX)                     |
| Toolbar and find                        | `apps/web/src/scient/markdownEditor/ui/dockChrome.tsx`, `ui/ScientFindBar.tsx`, `prosemirror/search.ts`                                |
| Tables                                  | `apps/web/src/scient/markdownEditor/prosemirror/{tables,tableNavigation}.ts`, `apps/web/src/scient/markdownEditor/tableContextMenu.ts` |
| Keyboard                                | `apps/web/src/scient/keyboard/`                                                                                                        |
| File surfaces and departure guards      | `apps/web/src/scient/fileSurfaces/`                                                                                                    |
| Rendered cards (diagrams, charts, code) | `apps/web/src/scient/presentation/`                                                                                                    |

## Relationship to PR #353

**Carried forward** onto the shared core. Each item is measured against the
conformance suite; none is assumed to move unchanged.

- `.tex` authority with patching limited to block ranges.
- The translator's knowledge of LaTeX structure.
- The layout profile derived from `classes.dtx`.
- The pagination approach, already a ProseMirror plugin, if simulated pages are
  kept (see [Canvas](#canvas--proposed)).
- The footer concept.
- Page-width and document-class typography for the LaTeX canvas.
- The Documents panel concept and the LaTeX templates.
- The Insert menu, outline pane, Review checks, and zoom controls, as shared
  tools.
- The symbol catalog and package metadata.
- The table presets and the shared table picker.
- The keyboard scopes and writing-command list, as a starting point.
- The adapter-registry and source-popover recommendations.

**Not carried forward:**

- Tiptap React node views (if the ProseMirror direction is confirmed).
- The localStorage visual draft journal (replaced by the shared session).
- Whole-document conversion and checking on every keystroke.
- The MathLive bundle patch (subject to the math step).
- Scient metadata written as comments into the preamble.
- The development-launcher and PID-handoff files; those fixes are handled on
  `main` by #377.

## Decisions to discuss

1. **Approach.** One document-editing system, developed through Markdown
   improvements and validated early against LaTeX.
2. **Editing framework.** ProseMirror directly for document editors, as a
   recommendation validated by the thin LaTeX path in stage 4.
3. **Roles and assignments.** The owner and Claude on shared and Markdown work;
   the contributor on LaTeX through assignments.
4. **Stage order.** Session foundation and study in parallel first; floating math
   as the first visible improvement.
5. **Hard questions.** Selection, undo ownership, object editors under external
   edits, save acknowledgements, build freshness, refused edits.
6. **Math input.** Option A, B, or C, decided in stage 3.
7. **Views.** The shared Write/Source/PDF vocabulary in the header; LaTeX's
   default view; whether Markdown gets a side-by-side view.
8. **Canvas.** Continuous versus paged for LaTeX; how much document typography
   the LaTeX canvas reflects; LaTeX in dark mode.
9. **Footer contents** at narrow widths.
10. **New LaTeX documents.** Use the `<title>/main.tex` folder layout or not.
11. **Session scope.** Package name and boundary; which source views follow LaTeX
    source.
12. **Build policy.** Automatic or on request (outside this record).
