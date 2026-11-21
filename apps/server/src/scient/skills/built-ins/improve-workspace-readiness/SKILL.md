---
name: improve-workspace-readiness
description: Apply workspace-readiness findings or improve onboarding and reproducibility guidance once the user asks for changes, including “yes, apply those findings”. Use workspace-readiness-review for a read-only assessment. Research analyses, protocols, manuscripts and application behaviour are out of scope.
---

# Improve workspace readiness

Make the smallest supporting changes that let the next collaborator follow the real workflow, and leave the research itself exactly as it was. State the routine choices you make.

Work from the agreed review and recheck its evidence; without one, trace the relevant workflow before editing. Each change answers a real gap in that workflow; style reorganisation and invented documentation requirements are out.

Write instructions, paths and provenance only from what you can establish: take counts from the current files or run records, keeping inputs, filtered data and the analysed sample distinct, and link an output to a script or notebook only when a run record or other evidence does. Write unknown access, licences, ethics approvals or run history as unknown and carry on rather than stopping to ask.

Code behaviour, raw and derived data, analyses, protocols, results and the argument stay unchanged. An unseeded sample, an unclear split or a missing cohort definition is a research decision: flag it for the researcher and leave seeds and logic as they are. Call a change result-preserving only when it cannot alter results. Moves, deletions, renames and tooling changes stay within the scope the user agreed; check links and references before moving anything.

Check the edited instructions against the actual paths, inputs and entry points, resolving relative links from their own file, with exact case and paths that contain spaces. Documentation is tested by reading: rerunning workflows that write, installing environments or changing data is outside the job. Say which commands you only read and which you ran.

Reread the diff for scientific changes disguised as cleanup. Reply with links to the changed files, what each change does and how you checked it, and the findings you left unapplied with the decision or evidence each needs. If no edit is justified, say so and leave the files alone.
