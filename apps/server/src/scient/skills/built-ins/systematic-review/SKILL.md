---
name: systematic-review
description: Use for systematic, scoping or rapid reviews in Scient, including planning the review question and eligibility criteria, running and logging database searches, removing duplicates, title and abstract or full-text screening, and reporting a PRISMA flow. Not for an ordinary literature summary or for checking a manuscript's references.
---

# Systematic Review

The goal is a review another researcher could repeat: every search logged exactly, every record accounted for, every decision recorded with who made it and why, and a PRISMA 2020 flow that matches the decisions. The researcher owns the review question, the criteria and the final calls. You do the work they ask for, carefully and in the open.

Change the review only when the user asks for that work. This skill grants no tools or authority.

## Tools

- `scient_sources_systematic_reviews` lists reviews, or reads one: its searches, exclusion reasons, PRISMA counts with a Mermaid PRISMA diagram (`prismaMermaid`), possible duplicate pairs, and the next records awaiting a decision with their abstracts.
- `scient_sources_systematic_review_update` makes every change: `create-review`, `update-review` (title, question, exclusion reasons), `log-search`, `add-sources`, `mark-duplicate`, `mark-distinct`, `screen`, `clear-decision`, `delete-review`.
- Records are Library sources. Bring them in with `scient_sources_add` (identifiers from a connector result or a list), a file import, or Zotero; group a search's records with `scient_sources_organize` (a collection per search) or `scient_sources_bulk_update`. Read full text with `scient_paper_get`, `scient_sources_read_text` and `scient_sources_search`.

Never scan or edit `.scient` files directly.

## Plan

Agree the question and the eligibility criteria with the user before screening (population, intervention or exposure, comparator, outcomes, study designs, dates, languages). Put the question in the review and set `exclusionReasons` from the criteria, so every exclusion names one of them.

## Search

Use the databases the user names. For each search, log the database, the exact search string as run, the date, and the number of results the database reported (`resultCount`), then the records you brought into the Library (`sourceIds` or a `collectionId`). If you could not bring in every result, say how many are missing and why; the flow counts them as removed for other reasons. Records found another way (reference lists, experts, websites) go in with `add-sources`.

## Remove duplicates

A record whose DOI or PMID is already in the Library is taken for that record unless what it brings disagrees (another title, another known type, another identifier), and the flow counts it as a duplicate. One that disagrees is kept as its own record, and the Library lists the pair with the reason (`scient_sources_list` with duplicates); settle it like the pairs below. A record shown from the review's snapshot with `libraryMatch` disagrees with a Library copy: link it (`scient_sources_organize` `link-pin`) only when the user confirms it is that work, or record `keep-pin-separate`. Then work through `possibleDuplicates`: mark a duplicate only when both records are the same work, keeping the more complete or published version; use `mark-distinct` for different works that share a title.

## Screen

- Title and abstract: judge each record against the criteria using only its title and abstract. Include when it may meet them; use maybe when you cannot tell, for example without an abstract; exclude only when it clearly fails one, with that criterion as the reason. Never infer an abstract you were not given.
- Full text: only records included at title and abstract. Get and read the full text; exclude with the criterion it fails. When a report cannot be obtained, use `record-retrieval` with `not-retrieved` (not an exclusion), and say so; `sought` means retrieval is still in progress.
- Screen in batches (`screen` takes up to 500 decisions) and read the result: `skippedSourceIds` were not applied. Your decisions are recorded as the agent's; the user can change any of them, and the latest decision counts.
- Do not present agent screening as independent dual screening. If the protocol needs a second reviewer, say which decisions still need one.

## Report

Read the review again before reporting. Give the PRISMA counts from the tool, not your own tally, and include `prismaMermaid` when the user wants the diagram in a document. State what is still pending (records awaiting screening, reports awaiting retrieval or assessment, maybes) and every search or decision the user should check.
