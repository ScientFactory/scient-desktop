---
name: compare-sources
description: Use when the user asks to compare two or more papers or sources from their Library on a question (what each tested, on whom, how, what it found, its limits), as a table they can check and reuse, or to turn such a comparison into a cited paragraph or methods justification in a document they name. Not for checking a manuscript's references or for a systematic review.
---

# Compare Sources

The goal is a comparison the researcher can check cell by cell: every cell says what the paper reports, where, and what you read to say it, and nothing comes from memory. The researcher owns the conclusions: show how the papers differ and why, and leave the judgement to them.

Finish the comparison in this turn, without stopping for progress updates. If something cannot be finished, say exactly what is left. This skill grants no tools or authority.

## Tools

- `scient_sources_list` and `scient_sources_get` find the sources the user names (by title, citation key or source ID) and their records. If a name fits several sources, or none, ask which one they mean; never pick one yourself.
- `scient_sources_search` finds passages in their PDFs; `scient_sources_read_text` reads a PDF by page; `scient_sources_quote_check` checks a quote against the stored text before you use it.
- `scient_sources_cite` gives the citation for each source in the document's format, pinning it to this project and checking it first. Tell the user about any problem it reports, such as a retraction.
- `scient_paper_get` saves a missing PDF to the project (free copy first, then the user's library access). It changes the project: call it only when the user agreed to fetch papers.

Work inside the project; do not search the rest of the computer, and do not scan or edit `.scient` files directly.

## Start

Compare only the sources the user named. If they gave no question, read the titles and abstracts, propose 3 to 5 comparison questions suited to these papers, ask which they want, and stop.

The question sets the columns; there is no fixed form. For empirical work they are often what was tested, on whom or what, the comparator, the outcome and how it was measured, the key result, and limitations. Add a column only when the question needs it.

## Read

Read each paper with the tools, never from memory. Read the abstract of every source and the full text wherever a cell is specific: a number, a population, a measure, a method, a limitation. Record for each source whether its cells rest on full text (you opened its text in this task), the abstract or metadata only. A source whose PDF is missing or has no readable text (`no-pdf`, `no-text`, `unreadable`) rests on its abstract at most; say so.

## Write the comparison

Save it as an ordinary Markdown document in the project, such as `comparisons/<short-title>.md`, and never over an existing file. Name the project's `references.bib` in its front matter (`bibliography: ../references.bib` from `comparisons/`) so its citations resolve. In order:

1. One line at the top: this is an experimental draft made by an agent, for the researcher to check against the papers.
2. The question, and the sources compared.
3. The table, one row per source and one column per aspect.
4. One short section per finding worth using: what it is, which papers show it, and the citations.
5. Coverage: for each source, full text, abstract or metadata only, and what was not read and why. Then the date.

Rules for every cell:

- **Kind.** A cell holds what the paper reports; a value derived from reported values, with the derivation and units ("difference 4.2 percentage points: 12.1% vs 7.9%"); or interpretation, beginning "Interpretation:". Derived values and interpretation never read as reported.
- **Citation.** Every substantive cell cites its source with the citation `scient_sources_cite` gave. Put the printed page in the locator only when you saw it printed on that page (`[@smith2020, p. 1123]`), and always give the page the tool reported as "PDF page N" beside it: `[@smith2020, p. 1123] (PDF page 4)`, or `[@smith2020] (PDF page 4)` when the printed page is not shown. Never invent a page or a locator.
- **Empty is never blank.** Write `Not reported` when you checked the paper and it does not say; `Could not assess` when its text was not available or not readable; `Not checked` when you did not look.
- **Quotes** are short and checked with `scient_sources_quote_check` first; quote the text it returns.

Between the papers:

- Say when two of them may report the same study or use overlapping data (same trial, cohort, dataset, authors and period), or that you cannot tell. Never count one study twice as agreement.
- Explain differences (population, setting, measures, outcomes, datasets, analysis) instead of declaring a winner. State only what you observed: "not reported in the full text", not "not done".

Reread the document before replying, confirm every citation names a source you read, and reply with a short summary linking it by project path.

## Use it in the user's work

Only when the user asks: write a cited paragraph or a methods justification from the comparison into the document they name, at the place they say. Use the comparison's citations and claims, no new ones, in the document's citation format (`scient_sources_cite` with `format` matching it). Change only that document and only that passage, and never edit any other file. Show the user what you inserted.
