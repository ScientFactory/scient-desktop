# Contributor request: a capability table and tests for the LaTeX translator

Status: request to the author of #353, 2026-10-01. Extended the same day: the table is per operation, and section 2 lists cases reproduced at `6d5cb5e8c4`.

This is the request that the [hands-on review](https://github.com/ScientFactory/scient-desktop/pull/353#issuecomment-5907716544) and the [architecture note](./scient-latex-visual-architecture-note.md) refer to.

It asks for evidence, not fixes: a table of what the translator supports, and tests that back it. It comes after the small fixes in the review. Fixes for the structural items (rules 1 and 2 of the note) are separate and come after it.

## 1. A capability table

A short markdown table, in the PR or as a test fixture, with one row per construct the translator recognizes: paragraph, heading, list, the maths forms, table variants, figure, theorem-like blocks, proof, abstract, title metadata, citations and references, and so on. For each:

- **How it is shown:** rendered, shown as source, or something else (please name it, for example a stripped preview).
- **What can be edited, one line per operation.** "Table: editable" isn't enough: editing a cell, adding a row and changing an alignment keep different things. For each operation the construct supports (edit text, format, insert, delete, each structural change):
  - what must survive it: options, widths, labels, comments, formatting, line layout;
  - which packages or root declarations it really requires.
- **Where:** root file, included file, with or without the packages it needs.
- **Limits and refusals.** For example, for labelled equations: the row count and equation type are fixed, and comments and numbering inside nested environments stay source-only.
- **What happens to a command it doesn't recognize** inside that construct.

Anything unsupported should be stated, not left out.

## 2. Tests behind the table

Translator-level tests: project a source, apply one small edit, and check the exact resulting text.

- **Preservation.** One test per case:
  - no edit at all: projecting and applying an unchanged document returns the identical text, for LF and CRLF line endings, with and without a final newline;
  - `~` in a paragraph;
  - `--` and `---`;
  - `\textit` versus `\emph`;
  - a paragraph written over several lines;
  - splitting a paragraph;
  - bold on an italic word;
  - adding and removing table rows and columns when cells contain formatting;
  - a table label containing `_`;
  - a labelled equation, both the supported edits and the refused ones;
  - an editable theorem or abstract that has a `\label`, line wrapping, or `\emph{…}`;
  - inserting a block directly after a display equation;
  - changing only the font size: call `updateLatexVisualLayoutSource` with only `baseFontPt` changed, and check that geometry, paragraph settings and unrelated source stay exact (the page-settings UI path is separate, editor-level evidence);
  - hiding an author.

  The last two were reported earlier and look fixed in the branch. Please keep them as regression tests.

- **Cases reproduced at `6d5cb5e8c4`, and related regression cases.** Rules 2 and 7 of the architecture note describe the failures and the output we saw. Please add them with the result they should have:
  - bold, italic or code on a word gives one wrapper for the run (`\textbf{Hello}`), not one per character;
  - the same on a partial selection, on overlapping marks, across a space, and next to an existing `\emph` or `\textit`;
  - formatting `e` followed by a combining accent (U+0301) gives one wrapper around both, and formatting `😀` gives `\textbf{😀}`; both stay intact through a UTF-8 round-trip;
  - changing only a figure's caption leaves `\centering`, indentation and the label where they were;
  - changing the code of an `lstlisting` with options leaves `[language=Python]` in the opening line;
  - adding `\vec`, `\frac`, `\hat` or `\mathcal` to a formula requires no package;
  - a paragraph appended at the end of an `\input` chapter is written to the chapter file, or refused; the same at the start of a chapter, in an empty chapter, in a file without a final newline, and for `\include`.

- **To check, not yet reproduced by us:** changing a column's alignment in a table whose column spec has a width, such as `p{0.3\textwidth}`. In our attempt the edit was refused, which is fine. Please state in the table what the operation does with widths, and add the test.

- **Accepted.** For each operation the table calls supported: it is accepted within its preconditions, and the text outside the edited range is identical.
- **Refused.** For each operation that is unsupported or outside its preconditions: the translator refuses, and the source is unchanged. For an edit in an included file that needs a change in a separate root file: it is planned only when the root context is usable and `allowRootUpdates` is set, and refused otherwise.

**Traceability.** Each operation in the table names the test or fixture that backs it.

**Cases that fail today** (several of the preservation cases will): please mark them as expected failures, each stating the behavior it should have, and list them in the table as known gaps. That way a passing suite isn't read as full support. Before merge, each one is either fixed or stated in the table as outside what is supported, where the operation is refused and the input kept.

## Not part of this request

- **Fixes for the structural items.** They follow the architecture note, after this. The fixes for the reproduced cases above are yours too, in the order the note gives; each lands with its test.
- **The blank-equation change in shared maths input,** which fails two Markdown tests in the branch. We will resolve it.
- **Tests at the editor and saving level:** that typed text is kept when an edit is refused, behavior on outside changes, and saves across two files. These need the editor and the saving integration. We will write them with the persistence migration and ask for your help with the LaTeX specifics.
- **Timing measurements.** We will take them, with the test documents we are preparing.

## Please avoid

- New draft, journal or save mechanisms.
- Substantial new Tiptap-specific infrastructure without talking to us first. Repairs to the current implementation are fine.
- Changes to shared modules (the keyboard system, maths input, `scient/writing/`, the Markdown editor) without agreeing them first.
- Reshaping the branch's history. It stays one PR.

## Done when

- The table is in the PR, or posted as a comment.
- The tests run in the PR. They pass, with the expected failures listed.
- A short note says anything that surprised you while writing them.

Questions about scope are welcome on #353 or #373.
