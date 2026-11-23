---
name: check-reported-numbers
description: Check every number in my abstract, text, tables and figure captions against the project's CSVs, notebook outputs, logs or analysis tables; find mismatches and numbers with no source. Use statistics-review for methods and conclusions, references for other papers' numbers, and workspace-readiness-review for project reproducibility.
---

# Check reported numbers

The goal is to know, for every number in the draft, whether the analysis outputs support it, and to say honestly how many were checked. Propose corrections in the report and edit the draft only when asked. Finish in this turn and put questions at the end.

## Inventory first

Go through the draft section by section (abstract, text, tables, captions, supplements in scope) and list every reported number, counting repeats separately: counts, percentages, means and spreads, estimates and intervals, p-values, durations, units. Count them before matching anything, so the coverage you report is a count, not an impression. The inventory is done when every section in scope has been read and every number in it has a row. Numbers that aren't results (citation years, section numbers, external facts) can be grouped and counted rather than traced.

## Trace each number

Find where each number comes from: a file and row or cell, a notebook output (`scient_notebook_read` shows saved outputs without rerunning), a log line. If the project uses Scient linked results, `scient_results_check` reports values that are out of date or edited. Match by meaning, not by resemblance: the same measure, population, time point and adjustment. When several outputs could be the source, prefer the one the methods describe and the run record supports; if they disagree and nothing says which is final, report a source conflict rather than picking the closest value. A file being newer or named "final" is a hint, not proof.

Recompute what is derived: percentages from their numerators and denominators, totals, differences, unit conversions. Use full-precision source values where they exist and round the result to the draft's precision; when only rounded inputs exist, carry their rounding bounds through and call a mismatch only when the draft value falls outside them. No blanket tolerance. Use Scient Compute for the arithmetic. Check against the outputs as they stand: a number that appears only after refitting a model or changing a filter has no source.

Give each number a status: matches, mismatch, source conflict, no source found, source stale or unreadable, or not checked (with the reason). A number without a source is unsupported, not necessarily wrong. Tracing is done when every inventory row has a status.

## Report

Before reporting, check that the ledger has a row for every number in the inventory; fix it if not. For a project draft, save `<draft-stem>.numbers-check.md` next to it, under a new name if that file already exists. Put the mismatches that change a result or conclusion first, each with location, draft value, source value and location, and the proposed correction. Then give the coverage (numbers found, checked, matched, unresolved, excluded) and the full ledger. Reply with a short summary and a link to the report.
