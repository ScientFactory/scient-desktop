---
name: compare-sources
description: >-
  Compare two or more papers or sources on a question (what each tested, on whom, how, what it
  found, its limits) as a table the user can check and reuse, or turn such a comparison into a
  cited paragraph or methods justification in a document they name. The papers can be in the
  Library or named by title, DOI or citation key. Use references to check a manuscript's
  references and systematic-review for a systematic review.
---

# Compare Sources

The goal is a comparison the researcher can check cell by cell: every cell says what the paper reports, where, and what you read to say it. The researcher owns the conclusions: show how the papers differ and why, and leave the judgement to them.

Finish the comparison in this turn. If something can't be finished, say exactly what is left.

## Find the sources

Compare the sources the user named. Find each in the Library (`scient_sources_list`, `scient_sources_get`) by title, citation key or source ID. When a name fits several sources, ask which one they mean. When it fits none, identify it by its DOI, PMID, arXiv ID, ISBN or publisher record (search first for a title). Ask only if you still can't tell which work is meant.

Writing to the Library is the user's call. When they asked you to fetch or add sources, or said to get what you need, add missing ones with `scient_sources_add` and save missing PDFs with `scient_paper_get`, passing the Library `sourceId` so the PDF attaches; check it is attached before reading it through the Library. Otherwise work from what the Library holds and from open text with a stable link, and mark which cells rest on the abstract. If the user asked you to write nothing, also use the existing citation keys and give the comparison in chat.

## Choose the columns

The question sets the columns. With no question given, compare what the papers have in common (usually design, population, methods, outcomes, findings and limitations), say which focus you chose, and continue. For empirical work the columns are often design, population or setting, intervention or exposure, comparator, outcome and how it was measured, the key result, and risk of bias or limitations. Add a column only when the question needs it.

## Read

Read each paper with the Library tools: the abstract of every source, and the full text wherever a cell is specific (a number, population, measure, method or limitation). Record for each source whether its cells rest on full text (opened in this task), the abstract or metadata only. A source whose PDF is missing or has no readable text (`no-pdf`, `no-text`, `unreadable`) rests on its abstract at most. If a number sits in a figure or table that text extraction garbles, look at the page image or mark the cell `Could not assess`.

## Write the comparison

Save it as a Markdown document in the project, such as `comparisons/<short-title>.md`, as a new file unless the user asked you to update one. Name the project's `references.bib` in its front matter (`bibliography: ../references.bib` from `comparisons/`) so citations resolve. In order:

1. The question, and the sources compared.
2. The table, one row per source and one column per aspect.
3. One short section per finding worth using: what it is, which papers show it, and the citations.
4. Coverage: for each source, full text, abstract or metadata only, the pages read, and what was not read and why. Then the date.

Every cell:

- **Kind.** Reported (what the paper says); derived, with the derivation and units ("difference 4.2 percentage points: 12.1% vs 7.9%"); or interpretation, beginning "Interpretation:". The reader can always tell which.
- **Numbers.** Each result with its measure, the population or denominator, the time point, whether it was adjusted, and its uncertainty (confidence or credible interval, or standard error). An SD is the spread of the data, not uncertainty. Odds ratios, risk ratios, hazard ratios and mean differences are different measures, as are estimates of different quantities: keep them in their own terms, with no computed winner or pooled number. Say when a paper's primary outcome is not the outcome of the question.
- **Citation.** Every substantive cell cites its source with the citation `scient_sources_cite` returns, and a locator you actually saw: the PDF page the tool reported, plus the printed page when one is printed (`[@smith2020, p. 1123] (PDF page 4)`), or the section, table or figure for a source without pages. `scient_sources_cite` also pins the source and updates `references.bib`, so it is a Library write; report any problem it flags, such as a retraction.
- **Empty is never blank.** `Not reported` when you checked the relevant text and it doesn't say; `Could not assess` when its text was unavailable or unreadable; `Not checked` when you didn't look. A search that finds nothing is not proof of absence.
- **Quotes** are short, checked with `scient_sources_quote_check`, and copied from the text it returns.

Between the papers:

- Flag when two may report the same study or overlapping data (same trial, cohort, dataset, authors and period), when one pools the others (a meta-analysis that includes the trials beside it), or that you can't tell. One study counts once as agreement.
- Explain differences (population, setting, measures, outcomes, datasets, analysis) rather than declaring a winner, in terms of what you observed: "not reported in the full text", not "not done".

The comparison is done when every cell has content or one of the three empty labels, every substantive cell has a citation and locator, and the coverage section covers every source. Reread the document, confirm every citation names a source you read, and reply with a short summary and a link to it.

## Use it in the user's work

When the user asks, write a cited paragraph or methods justification from the comparison into the document they name, at the place they say. Use the comparison's citations and claims only, in the document's citation style: `scient_sources_cite` with `format` `markdown` or `latex`; for other formats, the document's own citation mechanism, or clearly marked references and a note on what you couldn't insert. Change only that passage (plus the bibliography updates `scient_sources_cite` makes), reread every inserted sentence against the table, and show the user what you inserted.
