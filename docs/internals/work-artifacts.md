# Engineering work artifacts

> For maintainers. Using T3 Code? See [docs/user](../user/).

Keep planned work out of the source tree. Code search should return the product as it exists, not a mix of current behavior and abandoned intentions.

## Current facts belong in existing owners

Start from [the documentation index](../README.md). Released behavior and user
workflows belong in `docs/user/`; capability and architecture facts,
development guidance, and historical records currently share
`docs/internals/`; runbooks belong in `docs/operations/`; T3 divergence belongs
in `UPSTREAM.md` and its linked receipts. Write current owners in the present
tense and update them with the code they describe.

When the reason for a decision will matter after implementation, record it in the relevant internal document. Use a separate decision record under `docs/internals/` only when the rationale does not fit cleanly beside the current architecture.

Feature work commonly lands in slices. Update the same durable owner whenever a
later slice changes its behavior, support, limits, privacy, architecture, or
roadmap relationship. A new PR, phase, component, or milestone does not by
itself justify another Markdown file.

Create a new durable document only when all of these are true:

1. the knowledge remains useful after the pull request closes;
2. no existing owner can hold it coherently;
3. it answers a distinct lasting question;
4. its logical role, evidence boundary, and update trigger are clear; and
5. `docs/README.md` can route to it without becoming a file-per-change list.

## Planned work belongs in GitHub

Track active maintainer work in its GitHub issue or project item. The tracking item should state the outcome, constraints, and acceptance criteria, then link the pull requests that implement it. Split large efforts into one durable specification and small work items that can each close independently.

Close completed items. Update or delete invalidated work before starting the next implementation session. External proposals follow [CONTRIBUTING.md](../../CONTRIBUTING.md) and belong in Ideas discussions rather than issues.

## Temporary work stays temporary

Keep agent scratch files, exploratory research, transcripts, and session handoff notes outside the worktree. They are inputs to the work, not project documentation.

`.plans/` is gitignored as a safety net for legacy tools. Its presence does not make it an accepted project artifact. Pull requests must not add implementation plans or temporary research under another name.

A pull request records what changed and why. If a fact must survive after the pull request merges, update the relevant documentation. Otherwise, the tracking item and pull request are the record.

Every pull request records one proportional declaration: `Documentation
impact: None — reason`, `Documentation impact: Updated — paths`, or
`Documentation impact: Dependent PR — repository and link`. A dependent PR is
for a genuine cross-repository consequence and must state landing order; it is
not a reason to copy the same prose into both repositories.
