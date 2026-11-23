# Editing an existing workbook

Read when: the file already exists – especially one the user, a
collaborator, or another tool built. Preservation beats convenience:
recreating their file "cleaner" is data loss with good intentions.

## 1. Inspect the workbook and its ZIP parts

Run `"$PY" "$DOC" inspect FILE` and read `preserve_warnings`. For narrow edits,
also list the ZIP parts (for example, `unzip -Z1 FILE`). Prefer targeted
OOXML if you find `xl/printerSettings/*`, `xl/drawings/*`, `customXml/*`,
or other parts openpyxl may drop. Printer settings can be present even
when every applicable `preserve_warnings` flag is false.

| Flag true                      | What an openpyxl save does to it                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openpyxl_save_drops_drawings` | openpyxl rewrites supported charts and drawings and can drop whole charts, chart styles and colors, theme overrides, printer settings, and media. Check `drawing_charts` and `drawing_shapes`. |
| `drawings_shapes`              | Non-chart drawing content (shapes, pictures, text boxes, connectors, other graphic frames) is present                                                                                          |
| `slicers`                      | Slicers are dropped (their tables/pivots remain but lose the control)                                                                                                                          |
| `pivot_tables`                 | Pivot tables are not round-tripped faithfully; expect loss/corruption risk on save                                                                                                             |
| `macros_vba`                   | VBA survives **only** if you load with `keep_vba=True` and save back as `.xlsm`                                                                                                                |

Inventory external workbook links through the XLSX package relationships.
Record targets and which are relative. Also record existing typed errors
by address and value, defined names, merges, and chartsheets. Inspect
caps the formula and merge samples. If inspect fails or you need exact
coverage, use openpyxl to check the cells and ranges directly. List
`Workbook.chartsheets` separately and iterate cell rows only through
`Workbook.worksheets`.

When shapes, slicers, or pivots need to survive, edit the relevant OOXML
parts directly or use an editor that preserves those features. If neither
path is available, tell the user which parts are at risk before saving.

For an OOXML edit on a copy:

1. Read the workbook's sheet entry and resolve its relationship ID via
   the workbook's relationships to find the worksheet part. Resolve
   relative targets from the workbook part. A sheet's order does not
   determine its filename.
2. Patch the target cells and preserve unrelated parts byte-for-byte.
   If the cell uses a shared string referenced elsewhere, append an edited
   copy to `sharedStrings.xml` and repoint just the target cell. Check that
   existing rich-text runs and formatting survive.
   When changing `<f>`, remove its stale `<v>` and reset the cell's
   cached type (`t` attribute). Review the calculation chain, including
   any `calcChain` part and relationship, when adding or removing
   formula cells.
   When the edit adds a sheet or chart through XML, also register: the
   `<sheet>` entry and its relationship in `xl/workbook.xml` and
   `xl/_rels/workbook.xml.rels`; content-type overrides for each new
   worksheet, drawing and chart part in `[Content_Types].xml`; the sheet's
   `<drawing r:id>` plus `xl/worksheets/_rels/sheetN.xml.rels`; the
   drawing's chart relationship; any new `cellXfs` styles; and the sheet
   list and count in `docProps/app.xml` (`TitlesOfParts`, `HeadingPairs`).
3. Obtain fresh caches for dependent outputs after any formula or input
   change. For outputs that cannot be recomputed, clear stale caches
   and report those cells as unverified. Review any extra part changes
   made during recalculation.
4. Run `"$PY" "$DOC" validate FILE --original ORIGINAL` on the final copy.
   Read the structural check and compare ZIP parts and relationships
   against the original. Verify the intended cells and relevant preserved
   features by targeted read-back. XLSX reports `skipped-no-xsd` for
   schema validation.

After any openpyxl save of an existing workbook, run the same validation
command and inspect `part_diff.removed`, even if the structural check
passes. If the requested edit does not explain each removal, start again
from the original and patch the relevant OOXML parts. Verify the repaired
copy's part and relationship diff and read back the affected cells.

## 2. Loading rules that prevent the classic disasters

- **Never save a `data_only=True` load.** That mode reads cached values
  and holds no formulas; saving writes values-only and permanently
  deletes every formula in the file. `data_only=True` is read-only,
  for inspection. Edit loads are `data_only=False` (the default).
- **`.xlsm`:** `load_workbook(path, keep_vba=True)`, save to an `.xlsm`
  filename. Loading a macro file without `keep_vba`, or saving it as
  `.xlsx`, strips the macros without a word.
- Load with `keep_links=True` to retain external workbook links and
  confirm their relationships survive. Resolve relative link targets
  from the delivered workbook's location, especially when saving into
  another directory. Verify an affected pivot's refresh separately in
  the intended editor and report it as unverified if you cannot run it.
- Work on a copy / versioned filename until gates pass. The user's
  original is the only recovery point if a save corrupts the package.
- Preserve what you didn't come to change: sheet order, tab colors,
  print settings, frozen panes, filters, conditional formatting. If a
  library round-trip drops one of these, that is a fidelity loss to
  report, not background noise.

## 3. Writing into someone else's sheet

- **Write only input cells.** In an existing model, distinguish inputs
  (hardcoded values, often colored/filled as such) from formulas. Update
  the inputs the user named; **every existing formula stays exactly as it
  is unless the user asked to change that calculation.** "Fixing" an
  unfamiliar formula while updating inputs is how audited models break.
  If a formula looks wrong, report it with the cell address and your
  reasoning – change it only on instruction.
- **Match the file's conventions**, not your defaults: its number formats
  per column, its input coloring, its date format, its thousands/decimal
  style. New rows copy the style of the row above (`copy` the cell style
  objects as needed). Assigned openpyxl styles are shared and immutable.
  To adjust one cell's style, copy or construct the component, then
  assign the replacement.
- **Merged cells: write the anchor only.** In a merged range only the
  top-left cell holds the value; writing to any other cell in the range
  raises or silently does nothing. Check `ws.merged_cells` (inspect
  lists them) before writing a block. Unmerge/re-merge only if the user
  asked for a layout change.
- **Partial (rich-text) cell formatting needs the flag.** A cell where
  only some characters are bold/colored ("_p_ < 0.05" styling, mixed
  units) is stored as rich text. openpyxl needs
  `load_workbook(..., rich_text=True)` to preserve and edit those runs;
  a plain load-and-save flattens them. Assigning `cell.value = "new
  text"` also flattens – rebuild with `CellRichText`/`TextBlock` when
  the existing cell has runs.
- Inserting rows/columns in openpyxl (`insert_rows`) does **not** reliably
  rewrite every formula reference, merged range, and chart series the way
  Excel does. Prefer appending below the data or writing into existing
  blank structure; if you must insert, recalc + inspect + render and
  verify key totals by hand before delivering.
- Hidden sheets, very-hidden sheets, and named ranges pointing at them
  are usually machinery (lookups, parameters). Leave them hidden and
  untouched unless the task is about them.

## 4. Chart gotchas (when the edit touches charts)

openpyxl can create and adjust native charts, but several properties are
easy to lose or write invalidly:

- Setting some chart properties pulls in defaults that change appearance:
  touching series smoothing/markers can reset others. Change one thing,
  render, compare.
- `roundedCorners`, series `overlay`/gap width, and the axis `delete`
  flags must be set explicitly when recreating a chart – omitting them
  doesn't mean "Excel default", it can mean an absent element a strict
  reader rejects or a visibly different chart. If a copied chart renders
  with overlapped bars or a missing axis, check these first.
- A `DateAxis` needs its cross-axis wiring (`crossAx` pointing at the
  value axis id, and vice versa) set correctly; openpyxl examples that
  skip this produce charts Excel repairs or refuses. After any axis-type
  change, validate and render – don't trust the save.
- Editing the data range behind a chart: the series formula
  (`SERIES(...)` refs) does not auto-extend when you append rows. Update
  the series references explicitly and confirm on the render that the
  new points appear.
- Recalculation can update worksheet results while leaving chart
  series caches stale. Run the chart check from the skill after recalc.
  It follows worksheet and chartsheet drawings to registered chart parts,
  flags unreachable charts and drawings, and compares local A1 series
  references with saved worksheet values. Use the baseline from the exact
  pre-edit workbook to catch charts that lost their sheet attachment or
  disappeared from the package. `check --save-baseline BASELINE.json` can exit 1 for
  existing findings while successfully saving the baseline. Look for
  `saved_baseline` in its report before using the JSON.
- The baseline records the ZIP part list and SHA-256 of each part. It
  allows changes to worksheet, shared-string, and calculation-chain bytes,
  chart caches, and document-property modification dates. If the report
  lists `lineage_mismatches`, refresh stops before writing and the chart
  findings are reported without inheritance. Review the listed parts against
  the untouched original. For an intentional change to a chart formula or
  drawing, run a full chart check and review its findings against the original.
  Regenerate an older baseline JSON from the original workbook.
- With a baseline, refresh repairs new and worsened cache points it can
  verify. Use `--all` only when the edit also calls for repairing inherited
  cache mismatches. Refresh keeps each cache's existing format code and
  leaves any unverifiable series intact. Use
  `doc.py validate OUT --original FILE` to confirm a cache-only refresh
  changes only the expected chart parts. A nonzero exit means the output
  still has new or worsened findings and needs review before delivery.
- When building a chart with text categories, use a string reference
  (`strRef`) for the label cells.
- If the check finds broken links, unsupported references such as
  multi-area or external ranges, or a chart type it cannot verify, report
  the affected charts and series as unverified. If registration is part
  of the authorized edit, repair it and repeat the check. A render can
  show live worksheet values even while a stale cache remains.
- Charts whose render looks right in LibreOffice but whose data labels
  were positioned by hand in Excel can still differ in Excel. Report
  chart fidelity as "verified in LibreOffice render", not as pixel-proof.

## 5. Check a scoped edit

- Compare original and saved sheets by coordinate, after mapping any requested
  structural shifts. Include hidden sheets, typed literals, formula definitions
  and changed cell styles. Read populated cells or changed worksheet parts
  instead of allocating the whole Excel grid. Check added and removed cells.
- Read formula caches separately. An affected formula can keep its definition
  and have a new result. Confirm affected outputs, check new errors or missing
  caches by location, and report volatile or external results you cannot verify.
- Review changed package parts and relationships. Check chart registration even
  when a chart's contents should stay fixed. Refresh caches only for affected
  series or when explicitly asked to repair inherited issues.
- Check visible layout when it matters to the edit. If a narrower view needs a
  temporary print setup, use a render-only copy. Preserve the output's settings.
