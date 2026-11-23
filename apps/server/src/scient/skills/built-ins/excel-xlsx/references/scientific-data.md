# Scientific data in workbooks

Read when: the workbook holds measurements, samples, participants,
observations, instrument output, or any table a paper/report will cite.

## Raw stays raw

- The raw data sheet is a faithful copy of what was measured/exported:
  never edited in place, never "cleaned" by overwriting cells. Name it
  as the user specified (`Raw data` if they didn't).
- Keep cleaned and derived values on a separate sheet and trace each row
  to the raw record. A direct reference to a blank raw cell can return
  zero. For a conversion use
  `=IF(AND(ISNUMBER('Raw data'!E2),ISNUMBER($B$2)),'Raw data'!E2*$B$2,"")`,
  with B2 labeled as the conversion factor. A raw measurement of 12
  with a blank factor produces `""`. An observed zero with a factor
  of 2 produces numeric 0. Label Python-filtered views as
  snapshots and keep the filter rule and refresh command.
- Corrections to raw values (a mis-keyed weight, a swapped sample) go in a
  `Corrections` log – date, cell/sample, old → new, reason, source – and
  are applied in the processed sheet. Silently fixing raw destroys the
  audit trail and the user's trust in every other cell.

## Headers, units, types

- Units in the header, always: `Weight (kg)`, `Concentration (µmol/L)`,
  `Follow-up (days)`. Unit conversions happen in formulas with the factor
  in a labeled assumption cell, never by retyping converted numbers.
- One header row, no merged header cells over data columns, no blank rows
  inside the data block. Analysis tools (and the next agent) read the
  first contiguous block; decoration inside it breaks them.
- Write typed values: numbers as numbers, dates as real Excel dates
  (with a date `number_format`), booleans as `TRUE/FALSE`. Strings that
  look numeric (`"3.2"`, `"2024-01-05"`) are silently skipped by `SUM`,
  `AVERAGE`, `STDEV` – the sheet looks complete and computes short.
- Keep sample IDs, gene symbols, and accession numbers as literal text.
  Keep qualifiers such as `repeat` and `>` in their own columns so
  measurements stay numeric.

## Import and verify identifiers

Disable pandas inference for identifier columns before loading the CSV.
Use `dtype=str` for an all-text import or a column-specific dtype for
mixed data. With `keep_default_na=False`, supply any known missing tokens
only for the columns where they mean missing.

```python
df = pd.read_csv(
    csv_path,
    dtype={"sample_id": str},
    keep_default_na=False,
    na_values={"measurement": ["MISSING"]},
)
for row, identifier in enumerate(df["sample_id"], start=2):
    cell = ws.cell(row, 1)
    cell.value = identifier
    cell.data_type = "s"
    cell.number_format = "@"
```

Assign the string type after the value. The `@` format alone leaves
`=1+1` and `#N/A` open to openpyxl's formula and error classification.
Reopen the workbook and compare the ID values and types with the source,
including leading zeros and literal `NA`. Check genuinely empty IDs
against the key rules before writing.

When importing via a spreadsheet UI, set identifier columns to Text
before values land. UI parsing can turn symbols such as `SEPT2` into
dates and digit strings into numbers. If a symbol is already stored as
a date, report it and recover it from the source.

## Missing data and eligibility

Document the convention on the sheet or in a data dictionary. Leave
unavailable raw measurements blank and store their status separately
(e.g. unmeasured, inapplicable, excluded, or censored). For censoring,
keep the qualifier and any detection limit in separate fields. Reserve
numeric zero for an observed zero. When a derived result is unavailable,
return `""` and retain its status. See the blank guard above.

State each summary's eligibility rule and report the number of eligible
observations the calculation used. For example, count numeric values in
a helper range restricted to eligible records with `COUNT`, then
summarize that range. Document how censored measurements are handled and
count paired observations explicitly for correlation. Use `NA()` only
in named chart-helper cells whose gaps you verified in the render.
Those cells count as errors in the recalc gate.

## Provenance

Every data workbook ships with a `Data Sources` note (a sheet, or a
labeled block on the first sheet if the user forbids extra tabs):

```text
Source file/query:  extracts/cohort_export_2026-11-02.csv  (REDCap report 114)
Extracted:          2026-11-02        Rows: 1,284 (incl. header: no)
Workbook built:     2026-11-22, script build_workbook.py
Exclusions:         17 rows flagged in Processed!B (rule: consent withdrawn)
```

Per-column or per-table source notes follow the SKILL-wide rule:
`Source: <origin>, <date>`; user-supplied numbers say `user-provided`.
Record source and output record counts before and after filtering. Reopen
the workbook and count within the declared data range or by the record
key, excluding headers and totals. Styled cells can inflate `max_row`.

## Statistics: formulas or labeled Compute outputs – never head-math

- Descriptive statistics the sheet displays (mean, SD, correlation,
  counts) are Excel formulas over the data: `=AVERAGE(...)`,
  `=STDEV(...)` for sample SD, `=STDEVP(...)` for population SD,
  `=CORREL(...)`, and `=COUNTIF(...)`. Then the number is
  reproducible from the sheet itself and updates with corrections.
- Anything beyond that – regression, survival, mixed models, multiple-
  testing correction – belongs in Scient Compute / a notebook, not in a
  spreadsheet and not pasted from your own arithmetic. If results must
  appear in the workbook, put them on a `Results (Compute)` sheet labeled
  as pasted outputs with a method note: analysis, software/session,
  date, and the input sheet + row count used. Pasting a p-value with no
  method note is how unverifiable numbers enter papers.
- Hand off, don't improvise: checking numbers quoted in text against this
  workbook → `check-reported-numbers`; judging whether the statistical
  methods themselves hold up → `statistics-review`. This skill guarantees
  the workbook faithfully carries the numbers; those skills judge them.
