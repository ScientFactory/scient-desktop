# Google Docs – read this before any Doc read intended for editing, any Doc write, or Doc comments. Follow the operation and destination steps in SKILL.md.

## Coordinates and tabs

- Docs indices are zero-based UTF-16 code-unit offsets with exclusive ends.
  Body text commonly begins at index 1. JavaScript string length already counts
  UTF-16 units. Non-BMP characters occupy two units.
- Keep the `tab` parameter from the user's URL. Get a tab-inclusive
  `get_document` read and enumerate `tabs[]` and nested `childTabs` with IDs
  and titles. Match the content in the requested tab. Each tab and segment has
  its own index space. Put `tabId` and the applicable `segmentId` on write
  locations and ranges. An empty segment ID denotes the body.
- Locate exact text with `find_document_text_range` (pass the verified `tab_id`), or save
  the structured Doc JSON and run `"$PY" "$GW" docs-find doc.json "exact text"`.
  The helper uses each text run's API indices, refuses matches across non-text
  elements or where required indices are missing, and reports `tabId`,
  `segmentId` and `revisionId`. Treat the result as a locator. Before any
  destructive write, verify the exact text, range boundaries, tab, segment,
  revision and surrounding elements against a structured
  `find_document_text_range` or `get_document` read. Use `get_document` if
  the finder is absent or omits evidence needed for verification. Disambiguate
  repeated matches by context before writing.
- Inserts and deletes shift later indices in the same segment. Within a batch,
  use verified, non-overlapping edits from the end backwards when that preserves
  the intended structure. Otherwise batch one logical change and re-read.
  Deleting a paragraph terminator can merge neighbouring paragraphs and alter
  their structure. Preserve the terminator unless the requested operation
  calls for that structural change.
- For `replaceAllText`, preflight match counts per tab using the same match
  criteria as the request and compare the reply count afterward. For scoped
  replacements, set `replaceAllText.tabsCriteria.tabIds` to the verified IDs.
  Omitting it targets all tabs, including child tabs. A revision guard only
  checks freshness. `deleteNamedRange` and `replaceNamedRangeContent` also
  default to all tabs. Set each request's `tabsCriteria.tabIds` and inspect
  every component range before replacing a discontinuous named range. The
  replacement text goes in the first component and the others are deleted.

## Creating a Doc: import vs empty-and-native

- For an authorized new Doc, choose one route.
- **Import route** (`google_drive.import_document` with a local `.docx` or `.html`
  file, converting to native Docs): use when the document is long, heavily
  formatted, contains tables/images, or already exists as a local file. Build the
  local file with the `word-docx` skill for `.docx`; a clean semantic `.html`
  (headings, lists, tables, links – no scripts, no external CSS files) imports
  surprisingly faithfully and is easier to generate. After import, read the
  result back: import is a conversion, and conversions lose things (see verify
  checklist).
- **Empty + native route** (`google_drive.create_file`, then
  `batch_update_document` inserts): use for short documents, or when the user
  wants a Doc assembled from pieces you'll keep editing natively. Insert text
  first, apply named styles second, in separate batches with a re-read between.
- Never create-then-import over an existing shared Doc to "edit" it (SKILL.md
  same-file rule). Import creates a **new** file; it is a creation route only.
- Set the title at creation/import time; rename afterwards only via `update_file`.

## Styles: named styles, not direct formatting

- Format through paragraph named styles (`TITLE`, `HEADING_1`…`HEADING_6`,
  `NORMAL_TEXT`) via `updateParagraphStyle` with
  `fields: "namedStyleType"`. This keeps the outline/navigation working, survives
  the user's theme changes, and matches how the document's own headings are built.
- Reserve direct character formatting (bold a phrase, italic a term, a link) for
  genuinely inline emphasis via `updateTextStyle`, with a leaf-only field mask
  (e.g. `bold`, or `link`). Direct-formatting a whole paragraph to _look_ like a
  heading (big bold text) is a defect: it won't appear in the outline and breaks
  the next person's restyle.
- Before styling anything in an existing Doc, check how its current headings are
  made (`docs-outline` reports the style per heading) and match that convention.
- Lists: create with `createParagraphBullets` on existing paragraphs; remove with
  `deleteParagraphBullets`. Typing literal "- " or "1. " characters produces text
  that merely looks like a list and won't renumber. `createParagraphBullets`
  removes leading tabs to establish nesting, which shifts indices. Re-read
  positions before subsequent text edits.

## Tables

- Read tables with `google_drive.get_document_tables` (structure + cell text)
  rather than excavating them from raw body JSON.
- Build tables through requests: `insertTable` (rows × columns at a location),
  then fill cells. Cell text lives at indices **inside** the table's structure –
  after inserting a table, re-read to learn each cell's start index; do not
  arithmetic your way to cell positions (structural elements and cell markers
  consume indices invisibly).
- Filling many cells: work from the last cell backwards, or one batch per cell
  row with re-reads – same index-shift rule as body text.
- Editing an existing table's cell: find the cell by its current exact text
  (`docs-find` descends into tables) and replace that range only.
- Merged cells and column widths are structural requests
  (`mergeTableCells`, `updateTableColumnProperties`); verify visually – a merge
  applied to the wrong range is obvious in a render and invisible in text.

## Suggestions and comments

- `SUGGESTIONS_INLINE` is a read view. Use it to confirm indices around
  pending suggestions. The available `get_document` schema has no view-mode
  argument. Check the returned mode and stop position-based edits around
  pending changes if the index basis cannot be confirmed.
- Native suggestions require a confirmed tool that sends
  `writeControl.writeMode: "SUGGEST"` and supports the requested change.
  The available `batch_update_document` schema exposes revision controls
  only. If native suggestion capability is missing, stop and offer a list
  of proposed changes or direct edits with the user's consent.
- Follow the shared comment workflow in SKILL.md. Before an overlapping text
  edit, check open threads and their available anchor evidence. If the edit
  would remove the anchor of an unresolved thread, ask how to handle it.
  On partial failure inspect `commentAndSuggestionUpdateStatus` when returned
  and re-read the threads before retrying.

See the [Docs suggestions API guide](https://developers.google.com/workspace/docs/api/how-tos/suggestions).

## Pageless documents

- Check the document style for pageless mode (`documentStyle.documentFormat.documentMode`, on the relevant tab) before making layout claims.
- In a pageless Doc there are no page breaks, headers/footers don't render the
  same way, and export-to-PDF paginates arbitrarily. Don't insert manual page
  breaks or judge "page 2 looks wrong" from the PDF of a pageless Doc; verify
  structure (headings, order, tables) instead and say visual page checks don't
  apply.
- Wide tables/images that are fine pageless may overflow on PDF export. If the
  deliverable is a PDF of a pageless Doc, flag that before export, not after.

## Verify checklist (Docs)

- [ ] Read back each edited region (`get_document_text` or fresh `get_document`):
      new text present once, neighbours unchanged, no duplicated paragraph from
      a shifted insert.
- [ ] `docs-outline` on the new revision: heading hierarchy unchanged except
      where intended; no heading demoted to body text by a style write.
- [ ] If `replaceAllText` ran, the reply count matches the preflight and
      read-back confirms the intended tabs and representative untouched tabs.
- [ ] If open threads were near the edit, re-read them and verify anchor
      preservation where the editor exposes anchors.
- [ ] Export to PDF (`export_file`), render, view every changed page: table
      shapes, list numbering, heading spacing, image placement. For imported
      Docs additionally spot-check fonts, footnote/endnote survival, and table
      widths against the local source.
- [ ] The structured read-back is on the requested file ID and tab. Link that URL.
