---
name: workspace-readiness-review
description: Review reproducibility and onboarding; can another researcher or agent understand this workspace, rerun its work and verify its outputs? Use improve-workspace-readiness to apply the findings. Ordinary project orientation, proofreading and release checks are other tasks.
---

# Workspace readiness review

Return a prioritized review of whether the next person could pick up the requested work, with file evidence for each finding. The review is read-only: read files, documentation and saved outputs, and leave analyses, builds, installs and anything that writes to the researcher. Judge against the project's own workflow rather than a score or a folder template.

Work out the project's purpose from its files and instructions, then trace one representative workflow end to end: instructions, inputs, environment, entry point, run record, output. Follow the paths and entry points the documentation names, not its headings, and give file and line evidence. Keep what is documented apart from what was actually run.

For research work, look at what matters for that workflow:

- where the inputs come from, their version, access conditions, licence or ethics record, and what the variables mean;
- raw versus derived data, and anything that overwrites inputs;
- environment versions and lockfiles, the real commands, relative paths and host requirements;
- randomness, seeds, how splits are made and where preprocessing is fitted; flag silent choices and leakage risks and leave the analysis design to the researcher;
- what links important tables and figures to a run and its inputs (saved notebook outputs via `scient_notebook_read`, Scient linked results via `scient_results_check`). Two files side by side don't prove one made the other.

Check reported counts against the current files or tool results, keeping inputs, filtered data and the analysed sample distinct. A count that depends on randomness with no run record is unverified; mark it so, since choosing a seed and rerunning is the researcher's decision.

Missing access leaves a step unverified; it doesn't show the data or an approval is absent. Read restricted data only when the requested work needs it, not to complete a checklist.

Finish with the purpose, what you covered, what is already in good shape, and the findings in priority order, each with its consequence, the smallest fix and links to the files. Say what you verified and how, and what stays uncertain. If the workspace is ready for the requested work, say so. Offer to apply the fixes; applying them is a separate request.
