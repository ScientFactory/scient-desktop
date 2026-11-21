---
name: diagnose-analysis
description: >-
  Diagnose analysis code or a pipeline that gives a wrong, changed or inconsistent result,
  fails, or got slow: a number or figure that moved, results that differ between runs or
  machines, a script or notebook that errors. Use when the user says something is off,
  broken or "why did this change?". Use statistics-review to judge whether the method itself
  is sound.
---

# Diagnose analysis

A discipline for hard problems in analysis code. Keep raw data as it is throughout; work on copies and in Scient Compute.

## 1. Build a check that goes red

**This is the skill.** If you have a **tight** pass/fail check that goes **red** on _this_ problem, you will find the cause; everything after it consumes that check. Without one, reading code is guessing. Spend most of your effort here, and be creative:

- a short script that recomputes the suspicious number and compares it with the value the user trusts (an earlier output, a published table, a hand calculation);
- the pipeline run on a small fixture or subset, diffed against a known-good output;
- the same input through the old and new code (git history, an earlier notebook output) or two environments, with the outputs diffed;
- for "sometimes different": many runs with and without a fixed seed, to measure how often it happens.

Make it fast and deterministic (small inputs, fixed seeds, pinned versions). Done when one command or Compute run you have already executed detects the user's exact symptom (the same wrong number, the same error) against a stated expectation, as fast as the symptom allows. For an intermittent problem, the finish line is a recorded reproduction rate under fixed conditions; for a slowdown, measured timings against a baseline. If you truly can't build one, say so, list what you tried, and ask for what would make it possible (the trusted earlier output, the data version, the environment). Form no theory before this check exists.

## 2. Reproduce and minimise

Run the check and confirm it shows the problem the user described, not a different one nearby. Then shrink it: remove inputs, steps and options one at a time, rerunning after each, until every remaining piece is needed for the check to go red.

## 3. Hypothesise

Write 3 to 5 ranked hypotheses before testing any. Each must be falsifiable: "if X is the cause, changing Y makes the problem disappear". In analysis code the usual suspects are joins and merges that drop or duplicate rows, filters and missing-value handling, grouping and sort order, type and unit conversions, defaults that changed between package versions, randomness, and the input data itself changing. Show the ranked list to the user, since they may know what changed; carry on with your ranking if they aren't there. Done when the list is written down, before the first probe.

## 4. Test one change at a time

Each probe tests one prediction. Prefer inspecting intermediate results (row counts, keys, summaries at each step) over adding prints everywhere. Tag any temporary print or file with a marker such as `[DEBUG-a4f2]` so you can remove them all at the end. Done when one hypothesis's prediction held and the check goes green when you change what it names, with the others ruled out or ranked below it.

## 5. Fix and lock it

If the user asked only why, report the cause, the reproducing check and the exact fix you propose, showing on a copy that it restores the expected result. When they ask for the repair, fix the cause, not the symptom, and keep the check as a lasting one where the problem actually occurs (a test, or an assertion in the pipeline such as an expected row count or unique key): watch it fail before the fix and pass after. If the fix changes results the user has reported, give the old and new values side by side; whether to update a paper or figure is their decision.

## 6. Clean up and report

Remove every tagged debug change, and after a repair confirm the original problem no longer reproduces. Reply with the cause (the hypothesis that held, with the evidence), the fix (applied or proposed), the check, the results that change, and links to any changed files.
