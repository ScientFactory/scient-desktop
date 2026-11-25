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
   - **PubMed** (medicine, biology, neuroscience, psychology): field tags such as `[tiab]`, `[ti]`, `[mh]`, truncation `hippocamp*`, quoted phrases, `AND`/`OR`/`NOT`.
   - **OpenAlex** (every field, including journals PubMed lacks): searched in titles and abstracts; uppercase `AND`/`OR`/`NOT`, quoted phrases, no commas. Five operators or fewer runs fastest.
   - **arXiv** (CS, ML, maths, physics, quantitative biology): `cat:cs.LG`, `abs:"phrase"`, `ti:`, `AND`/`OR`/`ANDNOT`.
   Leave out a service that will not carry the field. Aim for queries a specialist would call complete rather than narrow: screening removes noise, but nothing recovers a paper the query missed.
3. Save it with `scient_watch_save` (weekly unless they ask otherwise). A new watch runs at once over the last 30 days. Tell the person in a sentence that the first briefing will be in Library → Watches, and that they can change the topic or the details asked for in plain words.

To change a watch, read it with `scient_watches`, then save the whole definition with its `watchId`.

## Run a watch

The scheduled prompt names the watch. The run is done when `scient_watch_publish` has returned.

1. `scient_watches` with the `watchId`: read the request, the details asked for and `recentTriage`. Papers like ones they dismissed rank lower; ones like those they kept rank higher. A note says why.
2. `scient_watch_run`: read the services' status and every page of titles (follow `nextOffset` to the end). Only titles you were handed count as screened; stopping early leaves the searched days uncovered.
3. Title screening is for recall: keep anything that could be on topic, and anything marked `noAbstract` that might be.
4. Read the kept candidates with `abstractsFor` (up to 60 ids a call) and decide on the abstract.
5. Publish with `scient_watch_publish`:
   - Picks in order of importance to this person. The first 8 are the briefing; up to 32 more appear as more matches. Picking nothing is a valid briefing.
   - `why`: one specific line on what is new for this topic, not a restated title.
   - `details`: one line per thing the watch asks about, only from text you read. Leave out what the text does not say; never estimate numbers.
   - `evidence`: what you actually read for that paper.
   - `summary`: one to three sentences on what moved this period. Name a service that failed or was partial, and its days; that gap is searched again next run.
6. End with one line in the thread: how many papers were screened and picked.
