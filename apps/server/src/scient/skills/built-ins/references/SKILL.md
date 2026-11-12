---
name: references
description: Use for any request about the references, citations, sources or bibliography of a paper, thesis, grant, review or report, for the whole document or a selected passage, or about the project Library's records. Covers checking or verifying references, fixing citations and bibliography entries, finding sources for claims, methods, instruments, software, data or guidelines, finding better or newer references, and judging whether cited work supports the text. Not for writing a literature review from scratch.
---

# References

The goal is a draft in which every citation points to a real work, described correctly, that still stands and supports the sentence citing it, and in which everything that needs support has it. The researcher owns the scholarship: find the problems, show the evidence, fix what is clearly wrong when asked, and leave real choices to them.

Finish the whole check in this turn, without stopping for progress updates. If something cannot be finished, say exactly what is left. This skill grants no tools or authority.

## Tools

- `scient_references_check` checks records. Give it the project path of a `.md`, `.tex` or `.bib` file, or no path for the Library. It reads the bibliography files a document names and the Library sources its citation keys name, resolves every DOI, PMID, arXiv ID and ISBN against its registry, and reports identifiers that do not resolve or name a different work, retractions and corrections, preprints with a published version, details that differ from the record, missing fields, and cited/listed mismatches. Its `ledger` lists every reference; `complete: false` means some were not checked, and its `notes` say why.
- `scient_references_resolve` applies a finding's `fix` exactly as the check returned it, writing the registry's value to the `.bib` entry or Library source, and ignores or restores findings. A stale fix means the file changed: check again.
- The Library comes before any search: `scient_sources_list` and `scient_sources_get` for records; `scient_sources_search`, `scient_sources_read_text` and `scient_sources_quote_check` for the full text of Library PDFs; `scient_sources_add` to add a work by identifier, which checks it against its registry, only when the user asked to add; `scient_sources_bibliography` to write `references.bib` and `references.json` from the Library.
- `scient_paper_get` saves a paper's PDF to the project (free copy first, then the user's library access) so you can read it. It also writes a queue file there, so it changes the project: never call it for a check-only request.
- Connected literature tools (PubMed, Semantic Scholar, OpenAlex and others) and web search find candidates. PubMed and Europe PMC suit biomedicine; arXiv, OpenReview, ACL Anthology, PMLR and proceedings sites suit computer science, where many conference papers have no DOI; zbMATH suits mathematics, where many references are books. Web search finds editions of guidelines, manuals and software best.

Work inside the project; do not search the rest of the computer, and do not scan or edit `.scient` files directly.

## What to check

- **Records.** Run `scient_references_check` first and read all of it before editing. Treat its ledger as your list: every reference must end up in your report. A difference is a lead, not a verdict: abbreviations, online and print years, and indexing gaps all cause them. A reference without a DOI, PMID, arXiv ID or ISBN was not checked against a registry; find its record yourself. If a result looks wrong, say so and check by hand.
- **Support.** For every citation, does the work support the sentence as written? Typical failures: narrower than claimed (association as cause, mice as humans, healthy volunteers as patients, a lab feasibility study as home efficacy), the opposite or a null result, the wrong paper, a review cited for a primary finding, a different number. Grade it supports, partly supports (say which part), does not support, contradicts, or not assessed.
- **Not only findings.** Methods, instruments, statistical procedures, software, datasets, guidelines, criteria and figures about the world each need the source a reader would check: the original or standard reference for what was used.
- **Versions and currency.** Guidelines, reporting standards, scoring manuals, criteria and software have versions, and figures about the world go out of date. For each, search for a later edition or estimate, even when the text names its version, and record what you found; report a newer one as a decision, and never replace a figure with an older one.
- **Evidence against.** When a sentence states a general or strong effect, look at later work before judging it supported: replications and meta-analyses since the cited year, and papers citing the source. Report important contrary evidence.
- **Gaps and better references.** Sentences, including paragraph openers, that state a finding, number or trend, or use a named method, instrument or tool, without a citation; and better choices: primary over review, published over preprint, newer where the field has moved. For each gap, give at least one checked candidate, or say what you searched.

Read the abstract for every judgement and the full text where the claim is specific or the abstract leaves it open.

## Rules

- **Never cite from memory.** Every reference you add or suggest, in the draft or in the report, was found in a scholarly record in this task, has a DOI or another stable identifier, and you read enough of it to judge support. Copy its details, including every author, from the registry record (the check's `registry`, or the Library source `scient_sources_add` created), never from memory. For works without an identifier (manuals, books, reports), confirm the edition from the publisher or mark the details unconfirmed.
- **State only what you observed**, and where: "the DOI does not resolve", not a guess about whose it is; "none found in PubMed and Crossref", not "none exists". Say for each judgement whether it rests on full text, abstract or metadata; full text means you opened the paper's text in this task. Write every page as "PDF page 7", the page a viewer shows for the file, never as "page 7" or "p. 7": the printed page can differ. If you know only the printed page, write "printed page 7". Confidence in words with a reason, never a percentage.
- **Not found is not fabricated.** Books, manuals, reports, theses and proceedings are often missing from indexes; search title, authors and venue before calling a reference likely fabricated.
- **No suitable source is a valid answer.** Propose narrowing the claim rather than attaching a weak citation.

## Changing the draft

If the user asked only to check, do not modify the draft, its bibliography or the Library, and do not call `scient_paper_get`: it saves files into the project. Read what the Library already holds (`scient_sources_read_text`, `scient_sources_quote_check`), and report a paper it does not hold as not read, saying what reading it would need. If they asked to fix:

- Apply: the check's fixes through `scient_references_resolve`; other details from the record; missing bibliography entries built from the record, identifying a cited-but-missing key from its sentence, key and year; a citation for something the text names (a method, instrument, software, dataset, guideline, or the authors it names); the paper a true claim actually comes from when it is attributed to the wrong one, including the primary study when a cited review reports it (find it rather than delete the claim); overclaims narrowed to what the cited source shows, in the author's words as far as possible. Narrowing a sentence to its own source is a fix, not a change to the argument. When the source supports a claim that later work disputes, attribute it in the text ("X et al. reported …") and propose the contrary evidence. Change an identifier only to one you confirmed resolves to the work. If an entry's identifier belongs to a different paper and the cited work cannot be found, never rewrite the entry to match that other paper: treat the source as nonexistent.
- Never leave a claim resting on a retracted, nonexistent or contradicting source as it is: narrow it to what the source shows or remove it, and list it as a decision. Do not rescue it by swapping in a newly found study.
- Propose, do not apply: newly found studies as evidence for a claim, contrary evidence, new sentences, version changes, published versions of cited preprints, and choices between alternatives. Do not add or delete parts of the author's argument; the author must stand behind every sentence in their paper.
- Never downgrade a stated venue, year or edition because the records lack it; mark it unconfirmed. Leave uncited bibliography entries in place and list them. Never shorten author lists, and keep verification notes in the report, not in bibliography fields.

Afterwards reread the changed passages, run `scient_references_check` again and, for LaTeX, build the document if you can; at least make sure new text escapes `_`, `&` and `%`.

## Report

When you changed files, save a Markdown report next to the manuscript (for example `main.references-check.md`) and reply with a short summary linking to it. For a check-only request, give the report in your reply and offer to save it. Put the most serious issues first, each with location, problem, evidence (short quote with its location, every page written as "PDF page N" or "printed page N", and what you read), fix applied or proposed, and confidence; then decisions for the user; then one line for every reference that was fine. Say plainly whether the check is complete. Before replying, confirm the report exists and every change you describe is in the files. Link the report and changed files by project path.
