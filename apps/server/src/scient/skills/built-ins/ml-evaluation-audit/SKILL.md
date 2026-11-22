---
name: ml-evaluation-audit
description: "Audit whether I can trust this machine-learning score before submission: train/test splits, leakage, tuning, baselines, metrics and variation across runs. Use check-reported-numbers for score transcription, statistics-review for general inference, reporting-guideline-check for a checklist, and workspace-readiness-review for reproducibility."
---

# ML evaluation audit

The goal is an honest answer to "would this score hold up on new data like the intended use?", with every problem located and, where the data allow, measured. It is an audit: leave code, data, splits and project notes as they are and propose fixes instead of retraining, unless asked. Finish in this turn and put questions at the end.

## Read

Read the claim, the methods, the pipeline code and configuration, split files, predictions and run logs. Work out the intended use, the unit that must be independent between training and test (patient, subject, site, document, time period), when predictions would be made in practice, and which inputs exist at that moment. Mark unknowns instead of guessing them.

## Check

- **Leakage across the split.** Where identifiers allow, compute how many test units also appear in training (count, denominator and percentage) rather than saying leakage is possible. Check duplicates and near-duplicates. Trace every fitted step (imputation, scaling, feature selection, resampling, encoding, learned representations) and confirm it was fitted on training data only, within each fold. Look for features that encode the label or would not be available at prediction time.
- **Tuning and selection.** Hyperparameters, features, thresholds, checkpoints and calibration chosen without touching the final test set; repeated test access or best-of-many runs reported as one.
- **Baselines and metrics.** Methods compared on the same cases and splits, with simple baselines. Metrics that suit the task and the claim: for a rare outcome, judge results against the prevalence and a trivial baseline, and report discrimination, precision-recall and calibration rather than accuracy alone (the chance level for precision-recall is the prevalence, for ROC AUC 0.5); for multiclass or regression, the averaging and the naive baseline.
- **Uncertainty.** Variation from training (seeds, splits) is different from sampling uncertainty on the evaluation population (an interval or resampling at the independent unit, keeping pairs when models share test cases). Say which of these the available runs and predictions can show; a single run reported without either is a finding.
- **Claims.** Generalisation, superiority and readiness for use, each against the evidence actually shown.

Do counts and metric checks in Scient Compute on the project's data, writing nothing to project files. Read saved notebook outputs with `scient_notebook_read` and rerun notebooks only when asked. If Scient recorded the evaluation runs, `scient_results_list` shows them, and `scient_results_check` checks values linked into the manuscript. Every run, count and interval in the audit comes from the project or your own computation. Done when each area above has a located problem, a finding of sound with its evidence, or the reason it couldn't be checked.

## Report

For a project audit, save `<draft-stem>.ml-evaluation-audit.md` beside the manuscript (or `ml-evaluation-audit.md` beside the evaluation code), without overwriting an existing file. Lead with the problems that most change the trust in the score, each with location, evidence (including the numbers you computed), impact and the proposed fix. Then list what was checked and found sound, and what couldn't be checked. Reply with a short summary and a link to the report.
