---
name: references
description: >-
  References, citations or bibliography of a paper, thesis, grant, review or report, for the
  whole document or a passage, or the project Library's records. Check or verify references,
  fix citations and bibliography entries, find sources for claims, methods, instruments,
  software, data or guidelines, find better or newer references, and judge whether cited work
  supports the text. Use compare-sources for an evidence table of named papers and
  systematic-review for a database search and screening. Writing a literature review from
  scratch is a different task.
---

# References

The goal is a draft in which every citation points to a real work, described correctly, that still stands and supports the sentence citing it, and in which everything that needs support has it. The researcher owns the scholarship: find the problems, show the evidence, fix what is clearly wrong when asked, and leave real choices to them.

Finish the whole check in this turn. If something can't be finished, say exactly what is left.

## What the tools cover

`scient_references_check` checks records against registries, one identifier per entry. Its coverage has limits that it doesn't always flag:

- `ledger` lists the entries it handled, including ones it could not check; read `notes` even when `complete` is true.
- It stops at 500 references and 300 findings (`omittedFindings`); a second run covers the same ground.
- It reads only the file you give it, so LaTeX `\input` and `\include` files need their own check.
- Hand-typed citations in a Word file with reference-manager fields can be missing from it.
- It checks records only. A clean result says nothing about support.

`scient_references_resolve` applies a finding's `fix` as the check returned it; a stale fix means the file changed, so check again. Search the Library before anything else. Many computer-science conference papers and mathematics books have no DOI: use proceedings, publisher and zbMATH records for them, and the issuing body for editions of guidelines, manuals and software.

The writing calls are `scient_references_resolve`, `scient_paper_get` (saves a PDF), `scient_sources_add`, `scient_sources_import_file` (adds a project's .bib, .ris or CSL-JSON file to the Library, skipping entries it holds), `scient_sources_cite` (pins sources and updates `references.bib`) and `scient_sources_bibliography` (rewrites `references.bib`). Keep to the project folder, and leave `.scient` files to the tools.

## What to check

- **Records.** Run `scient_references_check` and read all of it before editing. Build your own inventory of the citations and reference list in scope and reconcile it with the ledger, so every reference ends up in your report. A difference is a lead, not a verdict: abbreviations, online and print years and indexing gaps all cause them. Find the record yourself for a reference without an identifier.
- **Support.** For every citation, does the work support the sentence as written? Typical failures: narrower than claimed (association as cause, mice as humans, healthy volunteers as patients, a lab feasibility study as home efficacy), the opposite or a null result, the wrong paper, a review cited for a primary finding, a different number. Grade it supports, partly supports (say which part), does not support, contradicts, or not assessed.
- **Not only findings.** Methods, instruments, statistical procedures, software, datasets, guidelines, criteria and figures about the world each need the source a reader would check: the original or standard reference for what was used.
- **Versions and currency.** Guidelines, reporting standards, scoring manuals, criteria and software have versions, and figures about the world date. Search for a later edition or estimate and record what you found. Keep the edition the work actually used and report a newer one as a decision; replace a statistic only with a newer estimate.
- **Evidence against.** When a sentence states a general or strong effect, look at later work before calling it supported: replications and meta-analyses since the cited year, and papers citing the source. Report important contrary evidence.
- **Gaps and better references.** Sentences, including paragraph openers, that state a finding, number or trend, or use a named method, instrument or tool, with no citation; and better choices: primary over review, published over preprint, newer where the field has moved. For each gap, give at least one checked candidate, or say what you searched.

Read the abstract for every judgement and the full text where the claim is specific or the abstract leaves it open. For a long document, take claims the argument rests on first, then numbers, then retracted or contested sources, then the rest.

The check is done when every reference in your inventory has a record status and a support grade (or a reason it has none), and every gap has a candidate or a search record.

## Evidence rules

- **Never cite from memory.** Every reference you add or suggest, in the draft or the report, comes from a scholarly record or publisher page found in this task, read far enough to judge support. Copy its details, every author included, from that record; give its DOI or other stable identifier when it has one, and mark any detail you could not confirm.
- **Report what you observed, and where:** "the DOI does not resolve", "none found in PubMed and Crossref". For each judgement, say whether it rests on full text (opened in this task), abstract or metadata. Say whether a page number is the PDF page or the printed page. Give confidence in words with a reason.
- **Missing from indexes is common** for books, manuals, reports, theses and proceedings. Search title, authors and venue before calling a reference likely fabricated.
- **No suitable source is a valid answer.** Propose narrowing the claim rather than attaching a weak citation.

## Changing the draft

A check-only request leaves the draft, its bibliography and the Library as they were: use none of the writing calls, read what the Library holds and open full text on the web (PubMed Central, arXiv, the publisher's page) without saving it, and report a paper you couldn't read as not read, with what reading it would need.

When asked to fix:

- **Apply:** the check's fixes through `scient_references_resolve`; other details from the record; missing bibliography entries built from the record, identifying a cited-but-missing key from its sentence, key and year; a citation for something the text names (a method, instrument, software, dataset, guideline, or the authors it names); the paper a true claim actually comes from when it is attributed to the wrong one, including the primary study when a cited review reports it (find it rather than delete the claim); overclaims narrowed to what the cited source shows, in the author's words as far as possible. Narrowing a sentence to its own source is a fix. When the source supports a claim that later work disputes, attribute it in the text ("X et al. reported …") and propose the contrary evidence. Change an identifier only to one you confirmed resolves to the work.
- **When the cited work can't be found** and its identifier belongs to a different paper, keep the entry as it is, report the work as not found and the claim as unsupported, and list it as a decision for the author.
- **A claim resting on a retracted, nonexistent or contradicting source** is always flagged. Narrow it if the cited source supports a narrower version; otherwise propose a supported revision or removal as a decision for the author, rather than swapping in a newly found study.
- **Propose, for the author to decide:** newly found studies as evidence, contrary evidence, new sentences, version changes, published versions of cited preprints, choices between alternatives, and anything that adds to or removes from the argument. The author must stand behind every sentence.
- **Keep what the author stated:** a venue, year or edition the records lack is marked unconfirmed; uncited bibliography entries stay and are listed; author lists stay complete; verification notes go in the report, not in bibliography fields.

Afterwards reread the changed passages, run `scient_references_check` again and, for LaTeX, build with `scient_latex_build` if you can; at least check that new text escapes `_`, `&` and `%`.

## Report

When you changed files, save a Markdown report next to the manuscript (for example `main.references-check.md`) and reply with a short summary and a link to it. For a check-only request, give the report in your reply and offer to save it.

Put the most serious issues first, each with location, problem, evidence (a short quote with its location and what you read), fix applied or proposed, and confidence. Then the decisions for the user, then the references that were fine (one line each, or grouped for a long list).

Say plainly whether the check is complete, with the coverage: references checked out of the total, claims checked for support, and anything skipped (caps, unvisited files, papers not read). Check that any file you saved holds what you describe.
