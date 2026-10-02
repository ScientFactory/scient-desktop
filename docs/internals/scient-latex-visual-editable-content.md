# Editing inside blocks: the cause and the fix

Status: Direction for #353, proposed 2026-10-01. It details rules 1 and 2 of the [architecture note](./scient-latex-visual-architecture-note.md). Measured on the branch at `6d5cb5e8c4`, by projecting a small source and applying one edit through `applyLatexVisualDocumentChange`. References are under `apps/web/src/scient/latex/`; unnamed line ranges refer to `latexVisualDocument.ts`.

## What a writer meets today

- The body of an abstract or a theorem, and the cells of a table, are fields on one atomic block, not document content. Enabled fields allow native caret placement and text selection; in the app, a click inside a locked table or abstract selects the whole block.
- Content beyond plain text usually locks the field: maths or a reference in an abstract, a theorem, a proof, a description list or a figure caption; maths in a table cell. A locked field is shown with its commands removed.
- An accent command (`Poincar\'e`), a `%` comment, `\href` or another unsupported command turns its whole paragraph into source. Inside a list, it turns the whole list into source; so does `\item[a)]`.
- Some allowed edits also rewrite untouched source or discard formatting:
  - changing one word in a list item writes the whole list again: indentation and line breaks in the other items go, and `\textit` becomes `\emph`;
  - the same in a `quote`: `3--5` in another paragraph becomes `3–5`;
  - adding a word to a `quotation` or a bibliography entry drops `\emph{…}`;
  - adding a word to an abstract that is entirely bold drops the bold;
  - adding a word to an abstract with two paragraphs joins them;
  - a table caption with maths is offered for editing, and the edit is then refused.

## Where it comes from

These behaviors come from three parts of the current design.

1. **The general block ledger is top-level.** Paragraphs and headings have a narrow-patching attempt (`minimallyPatchedBlock`, `latexVisualDocument.ts:2869–2937`). Lists and `quote` are projected recursively and are real content on screen, but the ledgers of their children are discarded, so an edit inside serializes the whole block (`457–502`, `1611–1616`, `2002–2005`, `2396–2405`).
2. **Rich blocks are atoms with string fields.** `LatexRichPreview` has no content; bodies, captions, cells and items are attributes (`LatexVisualEditor.tsx:2614–2672`). Several fields use a plain-text decoder and fall back to `previewText` (`703–725`, `812–819`, `1243–1272`); the quotation and bibliography parsers accept marked text and then keep only the text (`937–955`, `1018–1026`).
3. **One unsupported piece rejects its container.** `parseInline` returns `null` for the paragraph, which becomes a raw block; a list or quote with one non-editable child becomes a raw block too (`304–390`, `493–495`, `1613–1615`, `1650–1662`).

Projected equality doesn't establish source preservation.

## The direction

**In the source: a recursive ledger.** Each place that holds content has an exact range and children: an environment's opening, body and closing; a list item; a paragraph; a caption; a table cell; a formatting command and its argument; a formula. Leaf source slices and trivia (comments, whitespace, delimiters) account for the source without gaps or duplicate ownership; parent entries record enclosing ranges. Offsets are UTF-16, as elsewhere in the translator.

- The ledger stays with the projection, outside node attributes, because the editor merges and splits text nodes freely. Small identity attributes are fine.
- A `\label` inside a body stays at its position as an anchored entry; it isn't masked out to make the body one contiguous range.
- A comment is source trivia. Its newline can matter to TeX. If it is shown at all, it is a marker, not prose.

**In the editor: real content inside containers.**

| Node                                                  | Content                                          |
| ----------------------------------------------------- | ------------------------------------------------ |
| Abstract, statement body, quotation, description body | block children: paragraphs, lists, display maths |
| Caption, rich title, description term                 | inline content                                   |
| List item                                             | a paragraph, then blocks, as today               |
| Table                                                 | real table, row and cell nodes                   |

The node view keeps its heading and controls and gives the body a content hole. Atoms remain for what is one piece: a formula, a reference, an image, anything unsupported. `defining` and `isolating` are chosen per container from the behavior wanted for paste, Backspace and lifting, and tested; not switched on everywhere. A synthetic paragraph added to satisfy the schema writes no source until edited.

**Unsupported content is a small locked piece inside a supported container.** Unsupported commands with known boundaries appear as exact source between editable text; unsupported environments inside a theorem appear as source blocks between editable paragraphs. Where the boundary of the piece can't be trusted, it grows to the smallest region whose boundary can.

**Writing: patch the smallest safe source range.** A word edit patches a text run, not a whole cell. A structural change (splitting a paragraph, adding an item or a row) may replace an enclosing range, and copies every unchanged child exactly. What goes is regenerating a whole container for an ordinary edit.

**Checking.** The three checks of rule 2, applied to the changed range: the result represents the intended edit; the source outside the allowed range is identical; what had to survive inside it did (options, widths, labels, comments, wrappers, valid Unicode). Local checks keep the document and root context, and broaden when a boundary or the interpretation changes. A narrow attempt that fails is refused; it doesn't fall through to whole-container serialization or to the permissive text fallback.

**Tables** start with a stated rectangular subset. Column specifications, row terminators, rules and their spacing are preserved. Spans and complex rule structures are handled conservatively, never normalized into ordinary cells.

None of this depends on the choice of editor framework.

## Steps

Each step has a bounded result. Each container's acceptance checks include caret behavior, composition, local Undo/Redo and basic pagination; step 5 broadens qualification. Sizes are relative; we can refine them after the prototype.

| #   | Step                                                                                                                                                                                                 | What the writer gains                                                | Size |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---- |
| 0   | Keep the recursive ranges for lists and `quote`. Patch text within existing children and preserve the surrounding source. State how structural edits (Enter, Backspace, lifting, paste) are handled. | Editing one child preserves untouched items, paragraphs and wrappers | M    |
| 1   | One theorem body with real paragraphs, marks, maths and references; title and labels preserved. Caret, composition and local Undo/Redo verified.                                                     | Direct writing inside a mathematical statement                       | M    |
| 2   | Bounded unsupported inline content and comment trivia are preserved in place, and no longer reject the surrounding list or quote where boundaries are safe.                                          | More ordinary paper prose stays editable                             | L    |
| 3   | The same model for captions first, then proof, abstract, quotation, description and bibliography bodies.                                                                                             | Rich editing across prose containers                                 | L    |
| 4   | Real table cells for a defined rectangular subset; rules, column specifications and untouched cells preserved.                                                                                       | Rich cell editing and native table navigation                        | L    |
| 5   | More structural operations; long documents, pagination, and integration with the shared session qualified.                                                                                           | Reliable split and join, item and row changes, sustained writing     | L    |

Notes on step 0, so it stays small:

- the top-level prefix and suffix comparison can stay; patch text only within matching child structure and unchanged container attributes. The current `structural` flag checks only top-level block counts;
- list items are projected after `.trim()` and quote children use offsets relative to the interior, so the ranges need rebasing, with markers, wrappers, indentation and gaps kept separately;
- child `sourceId`s restart at `latex-block-0` in each recursive projection; paths within an unchanged tree are enough for this step;
- a nested list needs descent to the changed paragraph;
- the `rawBlocks > 0` rejection stays until step 2; it counts all non-editable blocks, including locked rich previews (`latexVisualDocument.ts:1738–1739`).

Separately, please render maths in locked bodies read-only, as requested in the supplement.

## Who does what

- **You:** LaTeX parsing, the recursive ledger, patch planning, which operations are supported, the nodes and their views, and the LaTeX conversion and interaction tests. You return planned patches; saving stays with us.
- **Us:** the shared patch application and its tests (the Markdown one, extracted: bounds, overlap, surrogate pairs, CRLF), the edit and session contract, saving, recovery, coordination of outside changes, and the integration tests.
- **Together:** the identity and mapping hooks, and who edits which part of `LatexVisualEditor.tsx`.

We agree the patch contract before step 0: source and context revisions, owned UTF-16 ranges, and ordering or rejection of coincident insertions. We agree the session hooks before step 1 and exercise them in the theorem prototype.

## The edit contract

This is our proposal for that contract. The implementation and tests are on [#415](https://github.com/ScientFactory/scient-desktop/pull/415): `sourcePatch.ts` defines the types and applies patches, `persistenceCoordinator.ts` checks versions and updates the draft, and `markdownPersistenceRegistry.ts` exposes `lease.applyEdit`. It is still a proposal: tell us what doesn't fit the planner and we change it before step 0.

```ts
interface DocumentSourcePatch {
  start: number; // inclusive, UTF-16 offset as used by String#slice
  end: number; // exclusive; equal to start for an insertion
  replacement: string;
  expected?: string; // the text the planner saw in [start, end)
}

interface DocumentSourceEdit {
  basedOnVersion: number; // the session's editVersion the plan was made on
  patches: ReadonlyArray<DocumentSourcePatch>;
}

type DocumentSourceEditOutcome =
  | { accepted: true }
  | {
      accepted: false;
      reason:
        | "version"
        | "unavailable"
        | "offset"
        | "bounds"
        | "overlap"
        | "surrogate"
        | "crlf"
        | "stale";
    };
```

The planner hands one edit to a file's session (`lease.applyEdit(edit)`) and gets the outcome back at once. An edit carries no file identifier; the lease selects the file.

- **All or nothing.** Every patch applies, or the working source is unchanged. A version, availability or patch refusal returns a reason; other exceptions propagate.
- **One version.** Plan against `draftSource` and `editVersion` from the same `lease.getSnapshot()` result. The version belongs to that session owner's lifetime. A local change advances it once if the source changes; an accepted edit that changes nothing leaves it unchanged. Adopted or merged outside changes can also advance it. Any version mismatch is refused with `version`; to replan, read a fresh snapshot.
- **Exact ranges.** Every patch's offsets refer to the same source snapshot, before any patches apply. They must be integer UTF-16 offsets with `0 <= start <= end <= source.length`; otherwise the edit is refused with `offset` or `bounds`. A boundary inside an existing surrogate pair or CRLF is refused. Replacement strings are inserted verbatim; these boundary checks do not validate their Unicode or line endings.
- **`expected`.** When given, the patch applies only if the source still holds exactly that text in the range (`stale` otherwise). Please send it for every replacement and deletion. It guards the contents of the range; `basedOnVersion` guards everything around it.
- **Order.** Patches may come in any order and must not overlap. Two insertions at one offset appear in the order given; an insertion at the start of a replaced range lands before the replacement.
- **Accepted is not saved.** `accepted: true` means the edit was accepted into the working draft, not that it was saved. The session can accept edits during a conflict or connection failure; saving remains with us.
- **`unavailable`** means the lease is inactive, the owner is disposed, or editing is held for a rename. It does not mean a save conflict or connection failure.
- **No automatic retry.** The session does not retry a refused edit or widen its ranges. The caller decides whether to replan, wait and resubmit, or tell the writer.

What the contract leaves with the planner: which ranges an edit owns, the three checks of rule 2, and everything that needs LaTeX knowledge. The session applies what it is given exactly; it does not know the format.

What is not in it yet:

- **Several files in one edit.** A change that touches the root and a chapter is two edits, and one can be accepted while the other is refused. We will propose the cross-file form with the project sessions, before step 5.
- **The root and its context.** The current contract does not invalidate a plan when another file it depends on changes, such as the root file defining a macro. We still need to agree how context revisions fit before step 0, as stated above.

## Open questions

- Which commands and macro signatures the ledger recognizes. This removes unnecessary locks; it doesn't make arbitrary TeX editable.
- How a long statement or table continues across pages in the Visual view.
- The cost of checking per keystroke on long documents. To be measured.
- A file included twice: one source entry, two places on the page.
