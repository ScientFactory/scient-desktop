---
name: literature-watch
description: >-
  Follow new papers on a topic over time: set up, change or pause a literature watch ("keep me
  posted on new work about…", "alert me weekly to papers on…"), and run a watch's scheduled
  screening and briefing. Use systematic-review for a one-off systematic search and screening,
  and references for a manuscript's citations.
---

# Literature watch

A watch is a saved topic Scient searches on a schedule while it is open. Scient owns the searching, the record of every paper already judged and the dated briefings; you write the queries, judge the candidates and write the briefing. The person reads briefings in Library → Watches and keeps or dismisses papers there.

## Set up or change a watch

1. From the person's words, settle the topic, what to leave out and what they want to know about each paper (methods, sample size, species, keywords…). Ask only when the topic itself is unclear.
2. Write one query per service that fits the field, each in its own syntax:
   - **PubMed** (medicine, biology, neuroscience, psychology): title and abstract terms with `[tiab]` or `[ti]`, truncation `hippocamp*`, quoted phrases, `AND`/`OR`/`NOT`. Use MeSH `[mh]` only alongside text terms: new records get their MeSH terms weeks later.
   - **OpenAlex** (every field, including journals PubMed lacks): searched in titles and abstracts; uppercase `AND`/`OR`/`NOT`, quoted phrases, no commas. Five operators or fewer runs fastest.
   - **arXiv** (CS, ML, maths, physics, quantitative biology): `cat:cs.LG`, `abs:"phrase"`, `ti:`, `AND`/`OR`/`ANDNOT`.
     Leave out a service that will not carry the field. Aim for queries a specialist would call complete rather than narrow: screening removes noise, but nothing recovers a paper the query missed.
3. Save it with `scient_watch_save` (weekly unless they ask otherwise). A new watch runs at once over the last 30 days. Tell the person in a sentence that the first briefing will be in Library → Watches, and that they can change the topic or the details asked for in plain words.

To change a watch, read it with `scient_watches`, then save the whole definition with its `watchId`.

## Run a watch

The scheduled prompt names the watch. The run is done only when `scient_watch_publish` has returned; never end the turn before that, even when nothing fits (publish no picks).

1. `scient_watches` with the `watchId`: read the request, the details asked for and `recentTriage`. Papers like ones they dismissed rank lower; ones like those they kept rank higher. A note says why.
2. `scient_watch_run`: read the services' status and screen the titles. While `allTitlesRead` is false, call it again with the `runId` and `nextOffset`. Only titles you were handed count as screened.
3. Title screening is for recall: keep anything that could be on topic, and anything marked `noAbstract` that might be.
4. Read the kept candidates with `abstractsFor` (up to 30 ids a call, with the `runId`) and decide on the abstract. A paper with no abstract can still be picked, with `title` as its evidence.
5. Publish with `scient_watch_publish`:
   - Picks in order of importance to this person. The first 8 are the briefing; up to 32 more appear as more matches. Picking nothing is a valid briefing.
   - `why`: one specific line on why it matters for this watch, not a restated title. Call a result new or first only when the text says so.
   - `details`: one line for each thing the watch asks about, such as `Code: released (github.com/…)` or `Sample size: not stated in the abstract`, only from text you read. Never estimate numbers. arXiv abstracts end with the authors' comments, which often link code.
   - `evidence`: what you actually read for that paper.
6. End with one line in the thread: how many papers were screened and picked.
