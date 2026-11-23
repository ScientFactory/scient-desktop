# Formulas and models

Read when: you are writing formulas, building a model (budget, forecast,
dose/sample calculation, scoring sheet), or debugging a recalc failure.

## Stay inside the verifiable function set

The lab recalculates through LibreOffice. Probe uncertain functions in a
small workbook and check both the gate JSON and the cached result.

- Use stable functions such as `SUM`, `AVERAGE`, `COUNT`, `IF`,
  `SUMIFS`, `COUNTIFS`, `INDEX`, `MATCH`, and `ROUND`. Write
  `STDEV` for sample standard deviation, `STDEVP` for population
  standard deviation, and bare `CORREL` for correlation. If you need the
  modern SD names, write `_xlfn.STDEV.S` or `_xlfn.STDEV.P` and
  verify a probe cell. Both prefixed forms passed the lab probe.
- Lab policy for new workbooks excludes `XLOOKUP`, `XMATCH`, `SORT`,
  `SORTBY`, `FILTER`, `UNIQUE`, `SEQUENCE`, `RANDARRAY`, `LET`,
  `LAMBDA`, and other spill or Microsoft 365 functions outside the
  verified set. Calc support varies by function and version.
  `LIBREOFFICE_LACKS` in `tools/recalc.py` is a detection list.
  Use exact-match `INDEX(range,MATCH(key,keys,0))` for lookups and
  `ROW()-ROW($A$1)` or an index column for sequences.
- For views sorted, filtered, or deduplicated in Python, label the view
  **Snapshot** with its source and rule. Keep per-row arithmetic live.
  Document how to rerun the generator on updated inputs, replace the
  snapshot, and repeat the workbook gates.
- Write the six functions with their storage prefixes when using
  openpyxl: `_xlfn.IFS`, `_xlfn.SWITCH`, `_xlfn.TEXTJOIN`,
  `_xlfn.CONCAT`, `_xlfn.MAXIFS`, and `_xlfn.MINIFS`. openpyxl
  stores the text you supply. Prefer straightforward older constructs
  where they express the same logic. For conditional extrema, the
  prefixed MAXIFS and MINIFS passed the lab probe. Use them after checking
  the intended cases, including no matches, or use a helper range that
  selects eligible values before applying MIN or MAX.

## Diagnose a failed recalculation

Use the wrapper `doc.py recalc` for the pass verdict. Failures may exit
1, 2, or 3. Read `error_summary` and `not_computed` for the counts and
available locations. An absent `not_computed` is normal on a pass. Trace
dependent `#NAME?` errors to their precedents before changing formulas.
The gate can identify errors even when the failed formulas have no saved
error caches. Fix new errors within scope and repeat the gate.

On data-only read-back, use `cell.data_type == "e"` to identify typed
errors. Compare their locations and values with the baseline. If a
formula should return `""`, check for `t="str"` with an empty `<v>` in
the worksheet XML. openpyxl may read that saved empty string as `None`.

Use standalone `tools/recalc.py` only for diagnosis if the wrapper is
unavailable. Its text matching can flag a literal "#N/A", miss a typed
`#SPILL!`, and exit 0 on `errors_found`. Record the formula gate as
unverified until the wrapper runs and passes.

## Anchoring: decide what moves when the formula is filled

- `$B$2` – fully fixed. Use for assumption cells every row points at.
- `B$2` / `$B2` – one axis fixed. Use when filling across periods (pin the
  parameter row) or down subjects (pin the key column).
- No `$` – fully relative. Use only for same-row neighbours.
  Write the top-left formula correctly once, then fill the block
  programmatically with the same anchoring. A block where each row was
  hand-written differently is where errors hide. After writing, `inspect`
  and confirm the formula pattern is identical across the block apart from
  the intended relative drift.

## Cross-sheet references

- Quote any sheet name containing spaces or punctuation:
  `='Raw data'!A2`, `=SUM('FY 2025'!B2:B40)`. Unquoted, Excel parses the
  space as the intersection operator and you get `#NULL!`/nonsense.
- A literal apostrophe inside a quoted name is doubled:
  `='Don''s sheet'!A1`.
- Renaming a sheet in openpyxl does **not** rewrite formulas that mention
  it. Rename first, then write formulas – or rewrite the formula strings
  yourself and recalc to prove no `#REF!` appeared.

## Formatting is part of the formula

A correct value displayed wrong is a wrong workbook. Set `number_format`
on every formula cell (and numeric input):

- Percent cells hold **fractions**: store `0.18`, format `0.0%`. Storing
  `18` with a `%` format displays `1800%`; storing `0.18` unformatted
  displays `0.18` next to a "%" header and misleads every reader.
- Dates are serial numbers: a formula returning a date (`EDATE`, `DATE`,
  `A2+30`) needs a date format (`yyyy-mm-dd`) or it shows `45292`.
  Conversely a day-count difference (`=B2-A2`) must be plain number
  format or it shows as a 1900 date.
- Currency/accounting, thousands separators, and decimal places should be
  consistent down a column; totals commonly one format class bolder, not
  a different precision.
- Ratios/proportions: decide fraction vs percent once per column and make
  the header say which (`Proportion` → `0.00`; `Percent (%)` → `0.0%`
  over fractions, or plain numbers if values are already ×100 – never both).

## Model construction rules

- **One formula per period block.** Columns that represent months/years/
  visits carry the _same_ formula across, differing only by column drift.
  If period 7 needs an exception, that exception belongs in an input row
  ("one-off adjustment") read by the common formula – not a one-off edited
  formula nobody will spot next quarter.
- **Guard expected missing inputs and zero denominators.** A blank cell
  used in arithmetic can become zero. Require a numeric measurement and
  conversion factor with `=IF(AND(ISNUMBER(A2),ISNUMBER($B$2)),A2*$B$2,"")`.
  Label B2 as the conversion factor. A measurement of 12 with a missing
  factor returns `""`. An observed zero with a factor of 2 returns
  numeric 0. For a legitimate zero denominator, use
  `=IF(OR(ISBLANK(A2),ISBLANK(B2),B2=0),"",A2/B2)` and label
  when the ratio is unavailable. Reserve `IFERROR` for a specific
  expected error with a defined fallback. Use `NA()` only in named
  chart-helper cells with a render-verified gap. It counts as a formula
  error in the gate, so identify the expected cells in the report.
- **Totals sum the cells above them** (`=SUM(B2:B40)`), including when you
  "already know" the total. Cross-checks are separate cells:
  `=ABS(total - independent_total) < 0.01`-style check rows that nothing
  else depends on, labeled `Check (TRUE = ok)`.
- **No circularity by accident.** If recalc stalls or values look frozen,
  look for a formula whose precedents include its own cell (common when a
  total range quietly grows to include the total row).
- **Text that looks numeric breaks arithmetic quietly.** `"12"` from a
  sloppy write is ignored by `SUM` and errors in `*`. Write numbers as
  numbers (see `scientific-data.md`); if a total looks short, suspect
  string cells first.

## Financial-model conventions (finance deliverables only)

Apply only when the workbook is a financial model or the user/template
already uses them – never impose on scientific data sheets:

- Font/fill meaning: hardcoded inputs in blue font (`0000FF`) on a light
  fill, formulas in black, links to other sheets/files in green. Whatever
  palette you use, put a legend on the cover/assumptions sheet.
- Negatives in parentheses via accounting/`#,##0;(#,##0)` formats; zeros
  shown as `-` in statements only if the template already does.
- Assumptions sheet first (or outputs first if the user's house style says
  so – follow the file in front of you), workings in the middle, checks
  last; no output cell hardcodes a plug to force a balance.

Outside finance, the transferable core is smaller: inputs visually
distinct from formulas, a legend if color carries meaning, checks that
nothing depends on.
