---
name: excel-xlsx
description: "Create, edit, audit or recalculate an Excel workbook, including .xlsx, .xlsm, chart work, and CSV-to-Excel. Use google-workspace for native Google Sheets and Scient Compute for analysis without a workbook deliverable."
---

# Excel workbooks

Deliver the requested workbook at the agreed destination. Preserve the values,
formulas, and workbook features outside the requested change.

## Edit an existing workbook

1. **Locate the change.** Identify the sheet, cells, and intended value types or
   formatting. Keep the source as the recovery point and stage the edit in a
   copy. Deliver a new file when requested. If the task calls for replacing the
   original, check that it still matches the source you read before publishing.
   For a locked or actively coauthored workbook, use the editor's supported
   workflow or deliver the staged copy and report the conflict.
2. **Preserve the workbook.** Read [Editing an existing workbook](references/editing-existing.md).
   Use a targeted package edit or a compatible editor for files with features
   that a library save could lose. Read formulas in formula mode. A workbook
   loaded with `data_only=True` is for inspecting cached values.
3. **Refresh results when affected.** For a charted edit, save the original
   baseline with `xlsx_chart_cache.py check ORIGINAL --save-baseline BASELINE`.
   After changing a formula or input, or if the save discards formula caches,
   run `doc.py recalc COPY` and read its verdict. Then check the chart with
   `xlsx_chart_cache.py check COPY --baseline-json BASELINE`. For new cache
   mismatches, use `refresh COPY -o OUT --baseline-json BASELINE` and check OUT.
   The lab uses LibreOffice on a disposable copy and transfers calculated
   results back. Check affected outputs independently. Report new, inherited,
   and uncomputed results separately and name the engine used.
4. **Verify before delivery.** Reopen the final copy. Check that stored values
   and formula definitions across all sheets, including hidden sheets, differ
   only as requested. Verify formula caches separately. Compare relevant
   formats, chart registration, package parts and relationships. Preserve
   calculation and print settings unless the task calls for changing them.
   When visible layout matters, inspect the affected view. An input written
   with old or missing dependent caches is still an incomplete edit when
   updated results were requested. Finish the calculation and read-back before
   calling the file ready.

## Build or audit a workbook

- For an import, match the source schema and verify exact text identifiers,
  numbers, dates, and missing values after reopening. Use [Scientific data](references/scientific-data.md)
  for measurement tables, sample IDs, and CSV inference.
- For a model or live calculation, use [Formulas and models](references/formulas-and-models.md).
  Put adjustable assumptions in labeled cells and record the provenance of
  external inputs. Check the outputs against an independent calculation and
  test input sensitivity when the model's behavior is part of the request.
- For a read-only audit, inspect formulas and cached results without saving the
  source. Report findings by sheet and cell and identify caches you could not
  verify. For analytical results, keep the source and the calculation that
  produced them available to the user.

## Local tools

For trusted fixtures, `scient_document_runtime` gives the Python executable
and tools directory. Use the `doc.py` commands for the checks the task needs.
`inspect` samples formulas and preservation risks. `validate --original`
compares package parts and relationships. `recalc` verifies the recalculation
result. `render` shows the LibreOffice layout. Use `probe` to diagnose a
missing route. The editing reference gives the chart helper commands.

For changes to the layout or export of right-to-left or bilingual sheets,
check where the first logical column appears, then check mixed-language
headings, signs, percent values and wrapping in the cells. When delivering a PDF, reopen the exported file and
check print boundaries, repeated headings and clipped columns against the
workbook. Report which visual checks were possible.

Use an isolated worker for unfamiliar files when required by the runtime.
Keep macros and the `.xlsm` extension when applicable. If a legacy file needs
conversion, verify the converted baseline and report conversion losses.
Link the final workbook and report the checks that affect confidence in it.
