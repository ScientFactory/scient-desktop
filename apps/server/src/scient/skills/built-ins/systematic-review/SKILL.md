---
name: systematic-review
description: >-
  Systematic, scoping or rapid reviews in Scient: planning the review question and eligibility
  criteria, running and logging database searches, removing duplicates, title and abstract or
  full-text screening, and reporting a PRISMA flow. Use compare-sources for a comparison of a
  few named papers and references for checking a manuscript's references; an ordinary
  literature summary is a different task.
---

# Systematic Review

The goal is a review another researcher could repeat: every search logged exactly, every record accounted for, every decision recorded with who made it and why, and a PRISMA 2020 flow that matches the decisions. The researcher owns the question, the criteria and the final calls. Do the work they ask for, in the open, and finish it in this turn; change the review only for that work.

## Tools

`scient_sources_systematic_reviews` reads a review: its searches, exclusion reasons, PRISMA counts and diagram (`prismaMermaid`), possible duplicate pairs, and up to 25 records awaiting a decision per read. `scient_sources_systematic_review_update` makes every change. Records are Library sources: bring them in with `scient_sources_add`, a file import or Zotero, and group a search's records with `scient_sources_organize` (a collection per search) or `scient_sources_bulk_update`. Read attached full text with `scient_sources_read_text` and `scient_sources_search`; to fetch a missing PDF, give `scient_paper_get` the DOI or URL and the record's `sourceId`, and check it is attached before using the Library text tools. Leave `.scient` files to the tools.

## Plan

Agree the question and eligibility criteria with the user before screening (population, intervention or exposure, comparator, outcomes, study designs, dates, languages). Criteria the user already gave are used exactly as given. Put the question in the review and set `exclusionReasons` from the criteria, so every exclusion names one of them.

Say which review type you are following:

- **Systematic review:** PRISMA 2020 reporting.
- **Scoping review:** Population, Concept and Context instead of PICO; PRISMA-ScR reporting; chart the evidence; risk of bias only if asked.
- **Rapid review:** name every shortcut (one database, one screener, English only) and the check that compensates for it.

## Search

Use the databases the user names. Build each search from free-text terms and the database's controlled vocabulary (such as MeSH) where it has one. Page through to the end of the results, or say where you stopped and why.

Log each search once with `log-search`, carrying all its records: `database` with its platform (PubMed, Ovid MEDLINE), `query` exactly as run, `searchedOn`, `resultCount` as the database reported it, limits and filters in `notes`, and the records you brought into the Library (`sourceIds` or a `collectionId`). Logging the same database, query and date again replaces the earlier log, so log the whole search, not page by page. When you couldn't bring in every result, record how many are missing and why in `notes`; the flow counts them as removed for other reasons. Records found another way (reference lists, experts, websites, trial registries) go in with `add-sources`.

## Remove duplicates

Importing can return an existing Library record, and a record already in the user's Library is not necessarily a duplicate within this review. Keep each search's raw hit count in its log and reconcile the PRISMA counts against it. Records that disagree with their Library copy are kept separately and listed as pairs (`scient_sources_list` with duplicates). Work through those pairs and the review's `possibleDuplicates`: mark a duplicate only when both records are the same work, keeping the more complete or published version, and use `mark-distinct` for different works that share a title. For a record showing `libraryMatch`, read the duplicate notes in `references/methods.md` before linking it. Two reports of the same trial are separate reports of one study: keep both and note the link.

## Screen

- **Pilot first.** Screen a varied sample (about 10 to 20 records, or the protocol's pilot), note any criterion that was hard to apply and how you applied it, then carry on with the rest. Show the pilot in your report for the researcher to check.
- **Title and abstract:** judge each record from its title and abstract alone. Include any record that may meet the criteria, including one with no abstract whose title doesn't rule it out; exclude only when the available text clearly fails a criterion, naming it. Keep `maybe` for a decision deferred for adjudication, then resolve it or list it as outstanding. Judge only the text you were given.
- **Full text:** only records included at title and abstract. Read the full text and exclude with the criterion it fails. A report that can't be obtained gets `record-retrieval` with `not-retrieved`, not an exclusion; `sought` means retrieval is still under way.
- Screen in batches (`screen` takes up to 500 decisions) and read the result: `skippedSourceIds` were not applied.
- **Finish line:** each stage has no pending records, no `maybe` decisions (a maybe drops out of the pending count) and no outstanding retrieval. Report whatever is unresolved, by stage.
- **Who decided.** Your decisions are recorded as the agent's; the user can change any of them, and the latest counts. Agent screening is single screening, so report it as provisional until the protocol's independent screening is done; for a full systematic review that means a second person independently checks every full-text eligibility decision. For a rapid review, name the shortcut and its check.

## Report

Read the review again just before reporting and take every count from that read: searches, records, duplicates, includes, maybes, exclusions and pending. Give the PRISMA counts from the tool, and `prismaMermaid` when the user wants the diagram in a document.

The tool's final box counts included _reports_ although it is labelled studies: in a document, label it "Reports included" and give "Studies included" separately once reports are linked to studies. Use the PRISMA 2020 template that fits (registers are counted separately from databases). Mark the flow provisional while selection, retrieval or study linkage is unresolved.

State what is still pending (records awaiting screening, reports awaiting retrieval or assessment, maybes) and every search or decision the user should check, and link any files you saved.

For work after screening (extraction, risk of bias, synthesis, certainty), read `references/methods.md` first (with `scient_skill_read_resource`) and do only the phases the user asked for.
