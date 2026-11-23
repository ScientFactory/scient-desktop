# Google Sheets – read this before any Sheet read intended for editing, any Sheet write, or any formatting. Follow the operation and destination steps in SKILL.md. Charts: read `charts.md` too.

## Choose the value type

- Raw `updateCells` uses `userEnteredValue`, a typed `ExtendedValue`.
  Send `{"stringValue":"00123"}` or `{"stringValue":"=literal"}` for exact
  text, with no added apostrophe. Use `formulaValue` for intended formulas,
  `boolValue` for booleans, and `numberValue` for numbers. Write dates as
  numeric date serials with a date number format.
- Values endpoints parse strings as typed input only when
  `valueInputOption: "USER_ENTERED"` is selected. The spreadsheet locale
  affects parsing. Inputs like `1/2`, `00123`, `1E5`, percent strings and
  leading `=` may become dates, numbers or formulas. Use `RAW` for literal
  strings. An apostrophe escape belongs only to the typed-input route.
- For verification, request
  `cell_fields: "userEnteredValue,effectiveValue,effectiveFormat(numberFormat)"`
  with `get_spreadsheet_cells`. The default omits effective fields. Compare
  types, formula outputs and number formats as well as displayed text.
- If values have already been coerced, identify the affected cells and recover
  correct values from source data before making any requested correction.

## Formulas, not typed results

- Anything derivable from other cells goes in as a **formula**
  (`=SUM(B2:B9)`, `=B2/$B$12`), never as a number you calculated in your head
  or in Python and pasted. A pasted result goes stale the moment an input
  changes and is indistinguishable from source data.
- Inputs (measurements, prices, parameters) live in their own clearly labelled
  cells – an assumptions/inputs block or tab – and formulas reference them.
  Do not bury constants inside formulas (`=A2*1.175`) when the constant is an
  assumption someone will want to change; put it in a named input cell and
  reference it (`=A2*$B$1`).
- Add a **source note** for every external input: a "Source" column, a note on
  the cell, or a Sources block stating where the number came from and when.
  An unsourced input number is an unverifiable claim.
- Match the workbook's existing formula conventions (absolute vs relative
  anchoring, `IFERROR` usage, helper columns) by reading neighbouring formulas
  with `get_spreadsheet_cells` before adding your own. Extend patterns; don't
  introduce a second style.
- Array formulas and spill ranges: check whether the target area is already
  covered by a spill before writing into it – writing into a spill path breaks
  the array formula with `#REF!`-style errors.

## Bounded reads – metadata first, always

1. `google_drive.get_spreadsheet_metadata` first: sheet (tab) titles, numeric
   `sheetId`s, dimensions, named ranges. Record exact tab titles – A1 ranges
   must quote titles containing spaces or punctuation (`'Raw Data'!A1:F50`).
2. Then read only the ranges the task needs: `get_spreadsheet_range` for values,
   `get_spreadsheet_cells` when you need formulas/formats/types,
   `search_spreadsheet_rows` to locate rows by content instead of scanning.
3. Never request a whole grid (`A1:ZZ10000`, or a bare tab name on a large
   sheet) to "see what's there". Metadata dimensions + a header-row read +
   targeted searches answer that at a fraction of the cost, and a whole-grid
   dump truncates unpredictably – the missing tail looks exactly like empty
   cells.
4. Headers: read row 1 (and any frozen rows) of each relevant tab to learn the
   schema before writing values into columns by position. Confirm the column
   you think is "dose" actually says so.

## Writing and formatting (batchUpdate shapes)

- Use `google_drive.batch_update_spreadsheet` for raw Sheets requests.
  For contiguous value writes, prefer `updateCells.start` with a
  `GridCoordinate` and `rows[].values[]`. Use separate requests for disjoint
  edits. With `updateCells.range`, send a complete rectangular payload for the
  exact range. Cells in that rectangle without supplied data have the masked
  fields cleared. For example, providing only row 2 for B2:D3 clears the
  masked fields in B3:D3.
- Read `textFormatRuns` and `chipRuns` on cells whose values will be rewritten.
  Writing `userEnteredValue` erases prior runs and chips even with a narrow
  value mask. When they must survive, include compatible updated runs with
  the new text and verify them. If preservation cannot be confirmed, stop
  that rewrite and report the affected cells.
- Use `repeatCell` for uniform formatting. For example:
  `"$PY" "$GW" sheets-format <numericSheetId> "B2:D9" --bold --fg 0000FF --number '$#,##0'`.
  Check the generated narrow update mask and its color style fields
  (`foregroundColorStyle` / `backgroundColorStyle` for requested colors).
- Generate zero-based, end-exclusive grid ranges with
  `"$PY" "$GW" sheets-grid <numericSheetId> "'Raw Data'!B2:D" --sheet-title "Raw Data"`.
  The helper accepts quoted sheet names and open-ended A1 ranges. Use the
  optional title assertion for qualified input and verify the ID/title
  pairing against metadata. Missing grid bounds extend to the grid edge.
  Use bounded rectangles for `updateCells.range`. The numeric `sheetId`
  comes from `sheets[].properties.sheetId`.
- Read current formats and change the requested leaves. For example,
  masking all of `userEnteredFormat` with a payload containing only bold
  can clear existing borders or number formats.
- Insert or delete rows and columns in their own batch when later writes depend
  on shifted addresses. Re-read the affected grid before using those addresses.
  Adding a tab changes the workbook's tab inventory. Tab renames change A1
  qualifiers, and tab colors are metadata. Neither shifts row or column indices.
- Sheets has no `writeControl`. Re-read the exact target and its neighbours
  immediately before writing. This narrows the concurrency window. Compare
  both areas after the write.

## Importing a local workbook, then going native

- When the requested output authorizes a complex new Sheet, build the `.xlsx` locally with the `excel-xlsx` skill
  (formulas, formats, multiple tabs) and `google_drive.import_spreadsheet` it
  with native conversion. This beats hundreds of API value writes.
- Inspect the converted table ranges and any surviving native features first.
  Apply requested tables, filter views, validation or conditional formatting
  based on what the import actually produced.
- Verify post-import with fresh eyes: formulas that use Excel-only functions may
  arrive as errors, some number formats shift, and charts may not survive
  conversion (rebuild charts natively – `charts.md`). Run the error scan below
  on every tab of an imported workbook before calling it done.

## Verify checklist (Sheets)

- [ ] **Error scan on every sheet you touched** (and every sheet, for imports):
      read the used ranges and search values for `#REF!`, `#VALUE!`, `#DIV/0!`,
      `#NAME?`, `#N/A`, `#NUM!`, `#ERROR!`. `#N/A` from a deliberate lookup
      pattern may be expected – everything else gets explained or fixed.
- [ ] Read back each written range and its neighbours with the explicit
      verification fields above. Check formulas, literal strings, effective
      types and formats, and any rich-text runs or chips that must survive.
- [ ] Spot-check one formula chain end-to-end: change nothing, but confirm the
      precedent cells a key result points at are the inputs you think they are.
- [ ] Every tab was checked, not just the first: totals tabs and chart-source
      tabs included. List the tabs you verified in your report.
- [ ] Export to PDF, render, view: number formats readable, columns not
      truncating to `###`, print layout sane for the tabs that matter. Note
      "visual inspection not performed" if no render route existed.
