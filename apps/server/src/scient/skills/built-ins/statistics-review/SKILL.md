---
name: statistics-review
description: Check the statistics in my results, table or analysis before I send it; are the tests, uncertainty and conclusions right? Use check-reported-numbers to match draft numbers to outputs, ml-evaluation-audit for model evaluation, and reporting-guideline-check for a journal checklist.
---

# Statistics review

The goal is a review the researcher can act on: every reported test checked, each problem located and explained, with a concrete fix. It is a review, so leave the draft and the analysis as they are unless asked to change them, and finish it in this turn. Questions for the researcher go at the end, after the finished review.

## Read

Read the results and whatever explains them: methods, table notes, the analysis plan or preregistration, and linked outputs or notebooks (`scient_notebook_read` shows saved outputs without rerunning anything). Work out the question, the design, the outcome, the comparison and the analysed population. Note what is missing instead of guessing it.

## Check

Keep a ledger of every reported test and estimate: where it is, the estimate with its uncertainty, n, the test statistic, df where the test has them, and the p-value. Then look for the problems that matter in practice:

- **Wrong test for the design.** Check that each test fits how the data were collected and what they look like. Identify the independent sampling or assignment unit (participant, animal, cluster) and check that the analysis handles clustering and repeated measurements; check each n against its stated unit, and df against the model and test.
- **Incomplete or inconsistent reporting.** An effect without its size or interval, spread and precision confused (SD, IQR vs SEM, CI), p-values printed as `.000` (should be `p < .001`), or a p-value that cannot follow from its statistic and df. Recompute what you can from the reported values. Call a mismatch only when the reported details (df, sidedness, corrections) determine the calculation and the result falls outside rounding; if a missing detail could explain the difference, say which detail is needed and mark the value unverified. Use Scient Compute for the arithmetic.
- **Multiplicity and selection.** Many outcomes, subgroups or analyses with no plan or correction, outcomes that differ from the plan, or selection that reuses the data being tested.
- **Conclusions the numbers don't support.** A difference claimed from one significant and one non-significant result without a test of the difference; non-significance read as no effect; causal claims without a design and stated assumptions that support them; statistical significance read as importance; post-hoc power used to explain a null.

Say also what is done well, so the researcher knows what to keep. Every number in the review comes from the draft, the outputs or your own recomputation. Done when every ledger row has a status (checked, problem, or not checkable and why).

## Report

For a project draft, save `<draft-stem>.statistics-review.md` next to it, without overwriting an existing file. Put the most consequential problems first, each with location, what is wrong, why it matters and the fix. Then give the ledger and what you couldn't check. Reply with a short summary and a link to the report. For a short passage pasted into chat, answer in chat.
