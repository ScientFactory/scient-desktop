---
name: excel-xlsx
description: "Build me an Excel workbook, update or audit an existing spreadsheet (.xlsx/.xlsm), or turn a CSV into Excel. Use for new workbook requests even without a filename. Use google-workspace for live Google Sheets and imports to Drive, and Scient Compute for analysis without a workbook deliverable."
---

# Excel workbooks

Deliver a workbook with formulas linked to labeled inputs and a record of
its calculation, package, and visual checks. For a read-only audit, inspect
the workbook and explain the results in place.

Call `scient_document_runtime` in this thread. When it returns `ready`, set the shell variables below to the returned paths. Run the commands from the workspace, with local input and output paths. An unavailable runtime leaves the corresponding checks unverified.

```sh
PY='<pythonPath>'
TOOLS='<toolsPath>'
DOC="$TOOLS/doc.py"
CHART="$TOOLS/xlsx_chart_cache.py"
export PATH='<nativePathPrefix>':"$PATH"
```

## Steps

1. **Check the runtime.** Use the preview for trusted fixtures. Run `"$PY" "$DOC" probe` and read `command_routes`.
   Check the XLSX inspect, validate, and recalc routes and `render.office`
   for the steps you need. Office render requires `soffice` and
   `pdftoppm`. Report unavailable checks and the outputs they leave unverified.
   **Done when** you know which checks can run.

2. **Plan a new workbook or inspect the supplied one.** Run
   `"$PY" "$DOC" inspect FILE` for an existing workbook. Read the formula and
   cache together, the cached errors, total errors, missing-cache count,
   chartsheets, and preservation flags. Inspect samples are capped. Check
   relevant cells directly using `data_only=False` for formula cells
   (`data_type == "f"`) and `data_only=True` for cached results.
   Use `doc.py text` for a quick overview. For a new workbook, list the
   sheets, inputs, and outputs requested. For a read-only audit, explain
   the requested formulas or values with cell addresses and flag missing
   or potentially stale caches. Finish the audit here without saving.
   **Done when** the workbook plan or the requested audit is complete,
   or the scope and preservation risks of the edit are clear.

3. **Read the reference for the work.**
   - Formula writing, modeling, or recalculation debugging → [Formulas and models](references/formulas-and-models.md)
   - CSV import, identifiers, or research measurements → [Scientific data](references/scientific-data.md)
   - Any existing workbook edit → [Editing an existing workbook](references/editing-existing.md)

   For an existing workbook with charts or drawings, capture the chart
   baseline from the exact, untouched file you are about to edit. Run
   `"$PY" "$CHART" check ORIGINAL --save-baseline BASELINE.json`.
   Read the baseline findings even when the command exits 1. The lineage
   check catches a baseline taken from the wrong file by mistake; it cannot
   prove descent, so only ever pass the baseline you saved from this file.
   **Done when** the plan accounts for the applicable formula, import,
   and preservation rules and the chart baseline is saved when needed.

4. **Build or edit a copy.** Use openpyxl for new workbooks and safe local
   edits. Prefer a targeted OOXML edit when a narrow change must preserve
   printer settings, drawings, custom XML, or other parts an openpyxl save
   can drop. After saving an existing workbook with openpyxl, run
   `"$PY" "$DOC" validate FILE --original ORIGINAL` and read `part_diff`.
   If any part was removed without an explanation tied to the requested
   edit, treat the save as failed and retry from the original via OOXML.
   Use pandas for bulk reshaping, joins, or CSV import, with the
   identifier recipe in the scientific data reference before type
   inference can change IDs. Write derived values as formulas and keep
   adjustable assumptions in labeled cells. Record each input source and
   date in a note or adjacent field. Flag any source you cannot identify.
   Follow requested sheet names, order, headers, and labels. If Excel
   rejects a requested sheet name (over 31 characters or containing
   `[]:*?/\`), agree on a valid name. Keep the generating script.
   **Done when** the saved copy reopens with the expected inputs, types,
   formulas, and number formats, and any removed parts are accounted for.

5. **Recalculate after every save of a workbook with formulas**, including
   input-only edits. Read the JSON from `"$PY" "$DOC" recalc FILE` even on
   failure. A pass requires exit 0, `status: "success"`, zero errors and
   zero uncomputed cells. Compare cached errors and missing results with
   the baseline on scoped edits. For diagnosis, read
   [Formulas and models](references/formulas-and-models.md).
   Hand-check up to three representative results independently at the
   displayed precision, including an affected downstream result when
   available. Test the model's response to an input change on a copy.
   **Done when** the gate and hand-checks pass or the report identifies
   unresolved cells, counts, and inherited or intentional errors.

6. **Check native charts.** After recalculation, run `"$PY" "$CHART" check FILE`
   for a new chart workbook. For an edit, add `--baseline ORIGINAL` or
   `--baseline-json BASELINE.json` to check and refresh. On new or worsened
   cache mismatches, run `"$PY" "$CHART" refresh FILE -o OUT` with the same
   baseline option, then check `OUT` before rendering and validating it.
   Review `lineage_mismatches` before treating any findings as inherited.
   A passing check can still report inherited findings. Include them in
   the handoff. See
   [Editing an existing workbook](references/editing-existing.md) for
   unsupported references and preservation checks.
   **Done when** the final chart workbook has no new or worsened findings
   or the report names the chart data or registrations still unverified.

7. **Render and look.** Run `"$PY" "$DOC" render FILE --out DIR` and view the
   returned page PNGs. Map pages to each created or changed sheet and
   affected output, using a sheet-specific render copy if a sheet is
   missing from the printout. Check sheet coverage and page order, page
   breaks and print area, clipped cells or headers, number formats,
   totals, and chart labels and gaps. Every native chart in the workbook
   must appear on a page; a chart missing from the render is a render
   defect to report, not proof the chart is fine. Adjust print settings
   as needed, then repeat applicable gates after saving.
   **Done when** the expected sheets and pages have been seen, or the report
   names which views were skipped and why.

8. **Check the final package and hand over.** Run `"$PY" "$DOC" validate FILE`
   and add `--original ORIGINAL` for an edit. Read the report. XLSX
   reports `skipped-no-xsd` for schema validation. Check the structural
   result and, for edits, review the part and relationship diff and
   confirm targeted read-back. Report the checks that passed, findings
   still open, formula and error counts, hand-checked cells, and visual
   coverage. Include the final path, scope of changes, and where inputs
   and sources live.
   **Done when** the user can see which checks passed and which are partial
   or skipped.

## File formats

- Use formula-mode loads for edits. Saving a `data_only=True` load removes
  the formulas.
- Preserve `.xlsm` using `keep_vba=True` and the same extension. See the
  editing reference for other features that need protection.
- Convert legacy `.xls` or `.ods` with `"$PY" "$DOC" convert IN OUT.xlsx`
  before editing. Check the converted file and report any conversion loss.
- Deliver `.xlsx` for an Excel request. Use CSV when the user asks for
  flat data without workbook formulas or formatting.
