# Architecture note for the LaTeX Visual editor (#353)

Status: Direction for #353, proposed 2026-10-01. Reviewed against the branch at `6d5cb5e8c4`. Extended the same day with cases reproduced at that commit: the three checks in rule 2, file ownership of insertions in rule 7, and the rule for shared modules.

This note goes with the [hands-on review](https://github.com/ScientFactory/scient-desktop/pull/353#issuecomment-5907716544). The review said what to change; this says how the deeper items should be built, so each is done once and fits the shared editing plan in the [design record](./scient-document-editing.md). It was written after reading the branch at `6d5cb5e8c4`, including `docs/internals/scient-latex-visual.md` and the two fixes that followed the review.

## What is already right

These stay as they are, and the rest of the note builds on them:

- **`.tex` is the authority.** The adapter is bounded, and what it doesn't understand stays byte-for-byte as source.
- **Unaffected blocks stay exact.** An edit to one paragraph changes only that paragraph's bytes.
- **Source and Visual share one revision-checked saver,** and each included file saves through the same mechanism.
- **Ordinary typing is already protected.** The live editor document is kept when conversion or a save is refused, and maths fields explain several refusals.
- **The labelled-equation fix (`6d5cb5e8c4`) is the pattern to follow.** For the subset it supports, it:
  - keeps `\label`, `\tag`, `\notag` and `\nonumber` outside the maths editor;
  - patches only the changed range inside a row;
  - refuses a change that would cross a protected command.

  Its limits are reasonable: the row count and equation type are fixed, and comments, malformed commands and numbering inside nested environments stay source-only.

- **The selection fix (`39619117d7`) removes the reported title deletion.** Positions are clamped, not mapped, and history is still reset; rules 3 and 4 cover the general case.

## Who owns what

**We own saving, completely.** Saving governs the same file whether a change comes from Source, Visual, a maths field or an agent, so it sits beneath all of them. That covers:

- the shared session and save coordinator (#415 is the foundation, not yet the finished integration);
- recovery storage and restoring;
- reconciling outside changes, conflict decisions, and connecting the session to each view;
- every LaTeX view and every included file's session;
- retiring the old paths once their replacements are proven.

**You own what a valid change is:** parsing, source ranges, which operations are supported, how each construct is shown, and the tests and capability table that prove it.

**Where the two meet,** the session will call an adapter hook, and you supply the LaTeX side of it: which source ranges map to which parts of the editor, and which existing objects survive a change. Both sides touch `LatexVisualEditor.tsx`, so we agree who edits which part before that work starts.

**Shared modules keep working for Markdown.** The keyboard system, maths input and `scient/writing/` serve both editors. A change there keeps Markdown's behavior unless we agree a change to it, and the Markdown tests pass with it. Where LaTeX needs something different, it is expressed through the LaTeX adapter, not by changing what every consumer gets. One case exists in the branch: inserting a new blank equation now inserts nothing where it inserted `{}`, and two Markdown maths tests fail (`editorAdapters.test.ts`, `mathInput.test.ts`). Markdown on `main` is not affected. We will resolve this one.

**Until the migration lands:** please don't add or rework draft, journal or save mechanisms. Repairs to existing behavior are fine; tell us first if they touch those paths.

**One repair should not wait for the migration, and it is ours.** Restoring a recovered draft today writes the whole recovered source over the current buffer. The stored base revision isn't checked when the draft is read (`visualDrafts.ts:26`), so changes made since can be overwritten. The raw typing snapshot is also installed automatically. Until recovery moves into the session:

- recovery whose base no longer matches must show a comparison and ask. This covers both the Restore action and the automatic reinstall of the raw typing snapshot;
- the current source is checked again at the moment the user applies the recovery, not only when the comparison opens. If the source or its context changed in between, the earlier choice isn't applied: the comparison is refreshed and the user is asked again;
- where a safe merge can't be established, the recovered text stays available to read or copy;
- nothing is replaced without an explicit choice;
- the recovery record is kept until the replacement is acknowledged as saved, or the user discards it. Only the recovery version covered by that exact acknowledgement is cleared; later recovered or pending work stays.

We will propose this change to you before it lands on the branch.

## Three kinds of text

Most of the saving and recovery questions come down to keeping these apart:

| Kind                 | What it is                                                                                                                                                                         | Owner                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Working source**   | The current source accepted into the session. It includes unsaved text, and text that is syntactically incomplete but contained in its object's range.                             | The document session              |
| **Pending input**    | Exact input that is not yet part of that source: a composition in progress, prose waiting to be converted, an operation the adapter refused or that was based on a stale revision. | One recovery owner in the session |
| **Published source** | The revision the file system has acknowledged.                                                                                                                                     | The workspace file system         |

Two consequences:

- **A failed save doesn't change what kind of text it is.** Accepted working source stays working source; the session records the save error or conflict. It doesn't become pending input.
- **Pending input is never published,** and it is not offered as "recovered source". It can be recovered and shown again as what it is.

Your design already protects pending input, through the field journals and the raw editor snapshot. That protection is right. What changes is where it lives and how it ends:

- **One recovery record per file, in the session,** replacing the source checkpoint, the document-level typing snapshot, and the per-field journals. We will define its contents with you. It has to cover both input inside one object and document-level prose that hasn't been converted. Each piece is stored with the source and context it was based on, and with the physical file it belongs to. The adapter owns the encoding, and the encoding is versioned.
- **Every pending input has a defined end:** accepted into the source, kept for more editing, or discarded by the user. Closing the document, switching views, an outside change that deletes or replaces the object, or a change of root keeps it as recoverable work. It doesn't vanish.
- **Deferral is visible and bounded.** While a composition is in progress, outside updates wait, as the Markdown editor already does. They resume when the composition ends. If the outside change overlaps the pending input, that is shown as a conflict.
- **Nothing is blocked silently.** If Update PDF has to wait for unresolved input, it says so and offers the way to resolve it.

We will do this consolidation as part of the migration. It is described here so new code doesn't add a fourth store.

## The rules

Each rule answers one of the [hard questions](./scient-document-editing.md#hard-questions--answered-for-latex-in-the-architecture-note) in the design record, and each comes from something seen in the review.

### 1. Showing: don't drop or change meaning.

Supported content is rendered without removing or altering what it says. Where the editor can't interpret something, it shows the exact source, clearly marked. Text made by stripping commands (`previewText`) must not stand in for document content.

This doesn't ask for a pixel-exact page. As your document says, the canvas is a CSS approximation of layout, and the compiled PDF is the authority for exact output. Things that depend on a build, like reference numbers, are shown honestly as unresolved or out of date.

- **Why:** theorem and proof bodies currently read as mathematics with the symbols removed (review items 2 and 6).
- **In #353:**
  - statement bodies (theorem-like blocks, proofs, abstracts) show their real content: paragraphs, inline maths, `\eqref`, display maths;
  - whatever can't be handled appears as a source part inside the block, and doesn't lock the whole body;
  - a locked block may render its maths for reading, with a "source only" mark.
- **How to start:** statement bodies are a single attribute on an atomic node today, so making them real editable content is a substantial change. First render the locked bodies read-only. For editing, the cause and the steps are in [Editing inside blocks](./scient-latex-visual-editable-content.md): lists and `quote` keep their children's ranges first, then a thin prototype on one statement type. Please agree the approach with us before changing the node structure broadly.

### 2. Editing: change the range that was edited, and nothing else.

An edit inside a block becomes the smallest source change. Writing a whole block again from its attributes is only for a real structural change to that block, and for newly inserted blocks.

- **Why:** editing an editable theorem or abstract moves its `\label`, collapses its line breaks, and drops `\emph{…}` or a bold title (review item 5).
- **In #353:**
  - reuse the ranges that exist, and add the ones that are missing. Scientific blocks record body and title ranges only when the whole block is editable. Abstracts record none. A `\label` inside a body is masked before the body range is computed, so one span isn't enough;
  - verify the smallest affected region. Broaden the check when an edit changes syntax boundaries or what surrounding text means, such as a closing brace or a new macro;
  - add an exact-bytes check: after an edit, everything outside the edited range is byte-identical. Keep the existing structural round-trip check next to it. On its own it normalizes whitespace and some wrappers, so it passes while bytes change;
  - inserting a block must not add a blank line where the source had a single newline, because that splits the paragraph that continued below.

**Three checks, not one.** Today the main acceptance check is that the rewritten source projects back to the content the editor asked for (a guarded text-edit fallback exists beside it). Every case below passes that comparison, so it doesn't establish that the source was preserved. An accepted edit has to satisfy all three:

1. the result represents the intended edit (the existing check);
2. the source outside the ranges the operation is allowed to touch is identical;
3. the source inside those ranges keeps what it had to keep: options, widths, labels and comments of the construct, and text that is still valid Unicode.

**Cases reproduced at `6d5cb5e8c4`** (each by projecting a source, applying one edit, and reading the result):

| Edit                                                                  | Result today                                                                                                                       | Should be                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Bold on the word `Hello`                                              | `\textbf{H}\textbf{e}\textbf{l}\textbf{l}\textbf{o}`                                                                               | `\textbf{Hello}`                                 |
| Bold on text containing `😀`                                          | The character is split in two and each half is wrapped; the result has unpaired surrogates and does not survive a UTF-8 round-trip | One wrapper around the run; the character intact |
| Change a figure's caption                                             | `\centering` is added and the indentation is removed                                                                               | Only the caption text changes                    |
| Change `print(1)` to `print(2)` in `lstlisting[language=Python]`      | `[language=Python]` moves into the listing body                                                                                    | Only the code changes; the option stays          |
| Add `\vec{x}`, `\frac{a}{b}`, `\hat{x}` or `\mathcal{A}` to a formula | `\usepackage{amsmath}` is added                                                                                                    | No package: these are core LaTeX                 |

- **Fix formatting first:** one wrapper per marked run, with Unicode characters intact. The marks are applied one UTF-16 unit at a time today (`latexVisualDocument.ts:2865`). The mapping between editor offsets and source offsets is defined, and syntax is never inserted inside a character. Tests cover a whole word, a partial selection, overlapping marks, spaces, an existing `\emph` or `\textit`, combining characters, and characters outside the basic plane.
- **The Unicode case** was checked on the translator's output: it contains unpaired UTF-16 surrogates, and a UTF-8 round-trip replaces them with replacement characters. A full save to disk was not exercised.
- **Package requirements** come from a symbol table that lists `amsmath` for commands LaTeX provides itself (`mathSymbols.ts`). In an included chapter, a package requirement is a change to the root (rule 7), so a wrong one makes an ordinary chapter edit depend on the root.

### 3. Outside changes: the projection can be rebuilt; the user's interaction cannot be thrown away.

Your document calls the editor model disposable. That is right for its content: it can always be rebuilt from source. What the user is in the middle of is different:

- the selection;
- a composition;
- the focused field or maths editor;
- pending input.

Those are preserved, or explicitly resolved, before anything is rebuilt.

- **Why:** adopting an outside change replaces the full editor content and resets history. The reported title deletion is fixed; focus and field identity in the general case are not yet established.
- **The rule:**
  - prefer the smallest update that is known to be safe, including a change inside a block, not only whole-block replacement. A replaced block loses the caret's place inside it;
  - reuse the objects and subtrees that survive, and map the selection through the change;
  - take context into account: the same bytes can need re-interpreting when the preamble or root changes;
  - when a small update isn't safe, a full re-projection is allowed, after pending input is retained and the interaction is resolved;
  - identify fields and maths editors by something stable. Today field journals use ids derived from the block index, and maths fields a position captured at mount; both shift when a block is inserted above.
- **Ownership:**
  - we own the session side: when an update is offered, deferral, and conflicts;
  - you supply the LaTeX mapping and identity reuse through the adapter hook.

  This starts after that hook and the split of `LatexVisualEditor.tsx` are agreed.

### 4. Undo: never let it overwrite an adopted outside change.

Your concern is correct: Undo must not replay an edit from an obsolete revision. Resetting history guarantees that, and it stays as the fallback.

Keeping history is possible on the incremental path, but it has to be proven case by case. Applying the outside change as a non-undoable step (`closeHistory` with `addToHistory: false`) isn't enough on its own. If a local edit changed `a` to `b` and an outside change then turned `b` into `c`, Undo gives back `a` and overwrites the outside change.

- **So:**
  - keep undo and redo only where tests show local history can't overwrite adopted outside work;
  - define a conservative policy for overlaps in text, formatting and objects (for example, resetting history when an outside change touches a range that local history also touched);
  - keep the reset fallback until those cases are covered.
- **The test to hold:** after an outside change, Undo reverses surviving local edits and leaves the adopted outside change in place.

### 5. Refused edits: the text stays, with a reason and a way forward.

When an operation is refused, what the user typed stays in the editor as pending input. It is marked as not yet part of the document, with a short reason and clear choices: keep editing, discard, or open the source.

- **Why:** ordinary typing already keeps its document on a refusal. Some other paths don't yet. Some immediate source-publication refusals reinstall the previous projection. A refused field edit shows only an "Editing draft" chip while Update PDF stays disabled.
- **In #353:** extend the protection that typing and maths fields already have to those remaining paths.

### 6. Saving and building are separate, visible facts.

- **Saved** means published to the file. **Recoverable** means the recovery record has it. They are separate acknowledgements.
- **The PDF's state comes from the build evidence.** Today the build service reports current or out of date. The design record adds "unknown", for evidence that is incomplete; reporting it is part of our scheduler work. Today, missing evidence is treated as out of date, while incomplete evidence can still report current. Treating incomplete evidence cautiously also needs our service changes.

**When the PDF builds** (decided; this replaces the earlier wording of review item 17):

| Trigger                                                                                                                    | What happens                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| The PDF comes into view                                                                                                    | No PDF yet, or out of date: build. Current: show it                      |
| Cmd+S                                                                                                                      | Save now. Then build if the PDF is in view                               |
| Update PDF                                                                                                                 | Always available, whatever the view or setting                           |
| Idle: the PDF is in view and out of date, and for about 45 seconds the user has neither edited nor interacted with the PDF | Build once                                                               |
| "As I type", only when chosen in the setting                                                                               | Also build after a 2–3 second pause in editing, while the PDF is in view |

- **"In view"** means PDF mode, or Split with the PDF selected as its preview. Split with Visual doesn't count. Switching Split's preview from Visual to PDF, and coming back to the PDF from another view, both count as the PDF coming into view.
- **By default, typing doesn't build.** Only the "as I type" choice adds a build after a pause in editing.
- **The setting, "Update the PDF automatically",** has three choices: when idle (default), as I type, never. "Never" turns off only the two timed rows, idle and as I type. Opening the PDF, Cmd+S and Update PDF work the same under every choice.
- **Interacting with the PDF** means scrolling, zooming, selecting, searching, or moving the pointer over it. A pointer resting on the PDF doesn't count. Any interaction, and any edit, restarts the 45 seconds.

**What holds for every build, however it was requested:**

- **It builds what is saved.** A request waits for saves that are in progress, for the root and the files it includes. If something needs the user (a save error, a conflict, pending input the build would leave out), the request doesn't wait in the background. It says what is unresolved and how to resolve it, and the user asks again afterwards. It is never just disabled.
- **One running, one waiting.** Requests made during a build collapse into a single follow-up build.
- **Timed builds don't repeat on the same inputs.** After an idle or as-I-type build, successful or failed, the next timed build needs a changed input. An explicit request can always retry.
- **Timed builds apply only while their conditions hold.** A timed build that hasn't started is dropped when the PDF leaves view, or when the setting no longer allows it.
- **Background, then swap.** The old PDF stays usable while the new one builds, with no blank screen and no spinner over the page. Only a successfully published PDF is swapped in, in one step. Zoom and rotation are kept, and the view stays on the same page number, limited to the new page count, at the same scroll position.
- **A swapped-in PDF is judged against the latest inputs.** If the published PDF's inputs differ from the latest inputs, it is shown and still counts as out of date. The service's own repeat passes within a build belong to one request. If the service can't publish a result because inputs changed during compilation, the previous PDF stays and the build counts as failed.
- **A failed build changes nothing on screen except a small mark on the button.** The details and the log are behind a click.
- **Without a TeX installation, no build is submitted.** The request offers the installation instead.
- **Messages stay minimal.** Nothing is shown when all is well. An out-of-date PDF is shown by the button reading "Rebuild PDF". No explanatory paragraphs.

**Ownership:**

- **We provide** the scheduler, the setting, Cmd+S, the connection to saving (which files must be published, and how a request waits), the build store and service changes it needs, and the shared hooks for PDF visibility and interaction.
- **You connect the LaTeX surface** through those hooks: report when the PDF is in view, pass on Update PDF, and show the result or the unresolved reason. We agree the interface with you before that connection starts.
- **Please don't build a separate scheduler in the branch.** Until ours is active, builds stay explicitly requested. `0a74929cc1` is a useful reference for the pause mechanism.
- **Yours now, independent of the scheduler:** review item 18 (the banner), and Update PDF saying why when it can't run.

**Not specified here.** The scheduler gets its own specification and tests when we build it. That specification settles:

- the exact timer transitions when the mode or the view changes;
- how input identity is recorded for "the same inputs", including across reopening;
- how "unknown" freshness is reported and handled;
- whether an outside change to an included file restarts the quiet period.

### 7. Context: one source per file, whatever root interprets it.

A chapter is one file with one working source. Which root and preamble interpret it is recorded with the projection, and a change of root refreshes what is supported without creating a second copy of the text.

**An inserted block names the file it belongs to.** The assembled document doesn't contain enough to decide where a new paragraph goes, and today the destination is worked out from a text difference (`latexProjectVisual.ts:263`). Reproduced at `6d5cb5e8c4`: a paragraph appended after the last line of an `\input` chapter is written into the root, after the `\input` line, although the chapter was the preferred destination. With `\include` the same edit is refused at the page boundary, which is the safe outcome. The rule: an edit carries the file it is meant for and a mapped position in that file. The routing checks that intent and refuses when ownership can't be established; it doesn't pick a file from the difference alone. Tests cover the start and end of a chapter, an empty chapter, a file without a final newline, root content directly before and after the include, and `\input`, `\include` and the generated page separators. You own the LaTeX mapping; we agree the shape of the edit with you, because the session uses it too.

**Edits that need a change in another file.** The design record says to refuse these until failure and recovery across two saves is defined. The branch already supports one kind: adding a package or declaration to the root when a chapter needs it, accepted only when every affected buffer is unchanged and available. We keep that one kind as a stated exception. The two saves are independent: the chapter may save without its declaration, or the declaration may save while the chapter edit is still unpublished. Our saving work will give this exception the following guarantees, with the migration. The edit counts as fully saved only when both revisions are acknowledged. Until then, every unacknowledged part is kept for retry or recovery, and each file's state is shown. Before retrying when the outcome is unknown, the files are read again, work done in between is kept, and the declaration isn't added twice. We own the tests for these cases (one save fails, an acknowledgement is lost, a file changes before the retry, the app closes in between); translator tests cover only planning and refusal. Please don't add other kinds until the migration defines the general case. When the root isn't available, the operation is refused, the input is kept, and the message says which change the root needs.

## The editor framework

Not decided in this note. The shared session has no dependency on Tiptap or ProseMirror, so the migration and these rules proceed with the editor as it is.

- **When it is decided:** after a thin LaTeX integration on the shared session, and before any broad rebuild of the rich-editing components. The integration measures source fidelity, focus, composition, undo, performance, and how much special glue it needed. The statement-body prototype in rule 1 feeds the same decision.
- **Until then:** build new reusable behavior against framework-neutral interfaces, or plain ProseMirror, where practical. Repairs to the current implementation are fine. Talk to us before adding substantial new Tiptap-specific infrastructure.

## What this means for the review items

| Review item                                            | State and approach                                                                                                                                             | Who                                                 | When                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1. Labelled equations                                  | Implemented for the supported subset in `6d5cb5e8c4`. Its limits go in the capability table.                                                                   | You                                                 | Table: with the contributor request                                            |
| 4. Title deleted after an outside change               | The reported case is fixed in `39619117d7`. General interaction and history follow rules 3 and 4.                                                              | You and us                                          | After the adapter hook is agreed                                               |
| The small fixes in the review                          | As listed there                                                                                                                                                | You                                                 | Now                                                                            |
| Contributor request                                    | Tests and the capability table                                                                                                                                 | You                                                 | Now, after the small fixes                                                     |
| Formatting; Unicode                                    | Rule 2: one wrapper per run, the three checks                                                                                                                  | You                                                 | First of the fixes                                                             |
| Insertion after an `\input` chapter                    | Rule 7: the edit names its file                                                                                                                                | You, with us for the shape of the edit              | After formatting and Unicode                                                   |
| Listing options; figure captions; package requirements | Rule 2                                                                                                                                                         | You                                                 | After those two                                                                |
| 5. Whole-block rebuilds                                | Rule 2, detailed in [Editing inside blocks](./scient-latex-visual-editable-content.md)                                                                         | You                                                 | After the contributor request                                                  |
| 2, 6. Statement bodies; rendering                      | Rule 1. First, show a locked body with its maths rendered, read-only. Then [Editing inside blocks](./scient-latex-visual-editable-content.md), from its step 0 | You                                                 | Rendering: right after the fixes above. Editing: after the contributor request |
| Blank-equation change in shared maths input            | Shared modules keep working for Markdown                                                                                                                       | Us                                                  | With the recovery repair                                                       |
| 17. When the PDF builds                                | Rule 6                                                                                                                                                         | Us: scheduler and setting. You: connect the surface | After the scheduler lands                                                      |
| Recovery restoring an older copy                       | The interim repair above, then the migration                                                                                                                   | Us                                                  | Repair: soon. Migration: next                                                  |
| Refused edits on the remaining paths                   | Rule 5                                                                                                                                                         | You                                                 | With rule 2                                                                    |
| Shared frame, Documents, rename, Settings              | Shared work in the design record                                                                                                                               | Us                                                  | In parallel                                                                    |

## How we will know it holds

- **A small set of real documents:** theorems, proofs, labelled equations, accents, tables, figures, included files. We provide it; your tests run against it.
- **Tests that can't pass by accident:**
  - no block displays a stripped preview string as its content;
  - after any supported edit, bytes outside the edited range are identical;
  - formatting a run of text produces one wrapper, and the result is valid Unicode;
  - a block inserted in a chapter is written to that chapter's file, or refused;
  - the Markdown tests pass with every change to a shared module;
  - an outside change while typing, while composing, and while a field is focused keeps the selection, the field and the pending input, or resolves them explicitly;
  - after an outside change, Undo reverses surviving local edits and never overwrites the adopted change.
- **The capability table from the contributor request,** stating for each construct how it is shown, and for each operation on it what is supported, what survives, and what is refused.
- **Known gaps before merge.** Before merge, supported operations pass, unsupported ones refuse without losing input, and each known failure is either fixed or stated as outside what is supported.

## Order of work

**You:**

1. realign the branch with `main`, and the small fixes from the review;
2. the [contributor request](./scient-latex-visual-contributor-request.md): tests and the capability table, including the cases reproduced above;
3. the source-preservation fixes: formatting and Unicode first, then insertion after an `\input` chapter, then listing options, figure captions and package requirements;
4. statement bodies shown with their maths rendered, read-only (rule 1);
5. [editing inside blocks](./scient-latex-visual-editable-content.md), in its steps: lists and `quote` keep their children's ranges, then one theorem body with real content, then the rest;
6. the LaTeX side of rule 3, once the adapter hook is agreed.

**Us:**

1. the interim recovery repair, and the blank-equation regression in shared maths input;
2. the test documents your tests run against, and timings of per-keystroke work on small, medium and large documents;
3. the build scheduler (rule 6), with its own specification;
4. map the current persistence paths: which views write, which buffers hold unpublished input, how restoring works, how included files are identified;
5. define the recovery record and the adapter hook with you;
6. move LaTeX onto the shared session, with one active saver per file throughout;
7. test it under typing during saves, outside edits, view switches, recovery, and failures across several files;
8. retire the old paths.

The shared frame proceeds in parallel.
