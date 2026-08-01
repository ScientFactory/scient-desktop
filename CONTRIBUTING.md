# Contributing

Scient is early, and we keep product direction and implementation scope tight.
Focused bug fixes, reliability improvements, performance improvements, and
maintenance work are welcome. Discuss a non-trivial feature or direction change
in an issue before investing in a large implementation.

Pull requests are labeled with a `vouch:*` contributor-trust status and a
`size:*` diff size. These labels help maintainers route review; they do not
replace verification or maintainer judgment.

## Choose A Focused Change

- Keep one coherent outcome per pull request.
- Explain the problem, why it belongs in this repository, and what changes for
  users or maintainers.
- Do not mix unrelated cleanup or opportunistic fixes into the same diff.
- Preserve private data, credentials, local artifacts, and unrelated work.

Small changes are easier to verify and review, but size alone is not the goal.
Use the smallest scope that solves the real problem without leaving a brittle
workaround.

## Branch And Pull Request Flow

1. Start from the current `main` branch.
2. Create a short-lived branch for the change, such as `feature/...`, `fix/...`,
   `docs/...`, or `chore/...`.
3. Run focused checks while developing.
4. Push the branch and open a draft pull request against `main` when hosted
   checks or early feedback will help.
5. Review failures in the pull request's **Checks** section, fix them on the
   same branch, and push again. GitHub reruns the checks for the new head.
6. Before marking the pull request ready, complete the baseline verification,
   manual verification, and Quality Review below.
7. Request peer review when another person's judgment would improve the change.
   Peer review is useful but is not a default merge gate.
8. Before merge, complete Integration Readiness Review against the exact final
   head, including human review of the rendered candidate for UI changes.

Do not create a second staging branch that copies `main`. The task branch and
its pull request already provide the integration and CI loop. If `main` moves,
update the task branch as GitHub requires and revalidate the current head.

Merging to `main` integrates the change but does not publish a desktop release.
Release promotion to `release/stable` is a separate reviewed decision.

### Dependent Changes And Stacked Pull Requests

Use GitHub stacked pull requests when one focused change genuinely depends on
another unmerged change. A stack is a linear chain: the bottom pull request
targets `main`, and each higher pull request targets the branch immediately
below it. Do not use a stack as a holding queue for unrelated work, and do not
replace `main` with a staging or shadow-main branch.

Plan the complete stack before implementation. Put shared contracts and other
foundations in lower layers, and put their consumers in higher layers. Every
layer must remain a coherent review unit, include the tests that prove its own
behavior, and depend only on its own branch or a lower branch. Run the relevant
verification for every layer and run combined integration, runtime, visual, or
release-risk verification against the exact top-of-stack head.

One coordinator owns the stack's branch order, synchronization, submission,
and merge. Keep the live stack in one dedicated worktree; parallel agents may
review exact heads or work in separate stacks, but must not concurrently mutate
branches in the same stack. Before creating a stack, fetch `origin`, confirm
that the local trunk exactly matches `origin/main`, and inspect existing
worktrees and hosted pull requests for overlapping ownership.

The supported non-interactive flow uses GitHub CLI 2.90.0 or later and the
official `github/gh-stack` extension:

```sh
gh --version
gh extension install github/gh-stack
# Agents should also install GitHub's gh-stack skill for their host. For Codex:
gh skill install github/gh-stack gh-stack --agent codex --scope user

git config rerere.enabled true
git config remote.pushDefault origin
gh stack init --base main BRANCH
gh stack add NEXT_BRANCH
gh stack submit --auto
gh stack view --json
```

While Stacked Pull Requests remains in public preview, stop before retrying a
mutation when extension output contradicts the remote refs or GitHub pull
request and stack state. The coordinator must verify the intended order,
bases, heads, and draft state through authoritative Git and GitHub APIs before
using a documented REST fallback. Never infer success from extension output
alone or repair an uncertain stack by repeatedly submitting or linking it.

Stacks are submitted as drafts by default. Review and stabilize them from the
bottom up. Before merging any contiguous portion, confirm that every included
pull request is non-draft, linear, current with the protected stack base, green
at its exact hosted head, and supported by accurate evidence. Use the
stack-aware merge command with the repository's squash policy:

```sh
gh stack merge STACK_OR_PR_NUMBER --yes --squash
```

Do not use `gh pr merge` for a stacked pull request. Do not rely on auto-merge
while GitHub Stacked Pull Requests remains a public-preview feature.

Maintaining a published stack may rewrite its feature branches. The only
permitted forced update is the explicit `--force-with-lease` behavior performed
by `gh stack` on coordinator-owned stack branches after a fresh fetch and
ownership check. Never force-update `main`, `release/stable`, donor branches,
ordinary pull-request branches, or a branch owned by another active task. Stop
on a lease mismatch or ambiguous ownership instead of overriding it.

## Automated Verification

Use the smallest reliable test that can fail for the behavior being changed.
Bug fixes require regression proof unless automation is genuinely impractical.
If a meaningful check cannot be run, explain why and provide the best repeatable
manual verification instead.

Run focused package or test-file checks while iterating. Before marking a code
pull request ready, run the baseline from the repository root:

```sh
bun install --frozen-lockfile
bun run fmt:check
bun run lint
bun run typecheck
bun run test
bun run build:desktop
```

Add scope-specific checks when relevant:

- Web or interaction behavior: `bun run --cwd apps/web test:browser:stable`
- Release workflow behavior: `bun run release:smoke`
- Platform-specific behavior: the focused owning-package tests plus the hosted
  platform job

Documentation-only changes may use focused documentation and diff checks
locally; hosted CI remains authoritative. Record exactly what was run rather
than writing only "tests pass."

## Manual Verification And Human UI Review

Every changed user-facing behavior must be manually exercised by a human before
merge. The author should do this before requesting final review when practical.
Test the affected journey and relevant failure or recovery states in proportion
to the risk.

Every user-visible UI or interaction change requires human inspection of the
rendered candidate. Apply product judgment to the relevant behavior, hierarchy,
copy, states, interaction, visual quality, responsiveness, and accessibility.
Automated checks and agent-operated acceptance support but never replace this
inspection. The human may be the author, product owner, or another suitable
reviewer; this is not a non-author approval requirement. Without human
inspection, the change is not integration-ready.

Record the candidate, reviewer, environment, steps, and result. Include
before-and-after screenshots, plus a short recording when still images cannot
show the interaction.

For changes with no user-facing behavior, manual product testing may be marked
`Not applicable` with a short reason.

## Quality Review

Before marking a pull request ready, establish its intended outcome and
acceptance criteria, then inspect the complete candidate diff against its base,
affected tests, and documentation. Start with reuse, quality, and efficiency:
prefer suitable existing primitives, preserve coherent ownership and failure
handling, and avoid unnecessary work or resource retention. These are prompts,
not limits; follow any material concern revealed by the change.

Confirm that the scope and solution are coherent, tests and documentation
match, temporary or unrelated material is absent, and limitations are explicit.

Agent-assisted work has the same requirement. The contributor who submits the
pull request remains accountable for understanding and reviewing the result.
Record material findings and whether each was resolved, found not applicable or
incorrect with rationale, accepted by the appropriate owner as residual risk,
or deferred to an owned follow-up. Do not broaden a focused pull request
through speculative cleanup.

## Integration Readiness Review

Before merge, review the exact final head in its current `main` context,
including its intent, dependencies, evidence, conversations, and integration or
release impact.

Apply the concerns relevant to the change without treating them as limits:

- correctness, reliability, concurrency, lifecycle, performance, recovery,
  regressions, and paths that could lose drafts, messages, projects, files, or
  worktrees;
- security, privacy, credentials, sessions, permissions, approvals,
  migrations, destructive actions, updater behavior, packaging, and release
  safety; and
- architecture, ownership, reuse, maintainability, Scient identity, test
  sufficiency, product behavior, UX, information hierarchy, interaction,
  visual consistency, responsive behavior, and accessibility.

Investigate broadly and report precisely. Validate an alleged defect against
the current code and evidence with a concrete trigger, affected invariant,
observable impact, and root cause. For other material findings, name the
relevant principle and practical consequence. Keep missing evidence distinct
from a proven defect, state material uncertainty, and consolidate duplicate
symptoms.

Treat tests, fixtures, and workflows as evidence-bearing code. Confirm that
green results were not obtained by weakening assertions, removing meaningful
cases, making required checks conditional or non-blocking, or merely changing
fixtures to accept the new output. Intentional verification-gate changes must
be explicit and justified.

When separate perspectives would improve confidence and capable review agents
are available, use them independently and read-only for distinct concerns, then
reconcile their findings. Reviewer arrangement remains risk-based, not fixed.

Record whether the candidate is integration-ready, not integration-ready with
findings, or blocked. Recheck only what later changes could invalidate, but
issue the final verdict for the new head. For a small unchanged candidate, one
proportional pass may satisfy both review stages when it covers both purposes.

## Review And Completion

A pull request is ready to merge only when:

- its scope and evidence match the final diff;
- required checks pass on the current head;
- relevant manual verification and Quality Review are complete;
- Integration Readiness Review finds the exact candidate ready;
- required human UI review is complete when the change is user-visible; and
- review conversations are resolved.

Passing CI is necessary but does not prove that the product behavior, design,
ownership boundaries, or recovery behavior is correct. Quality Review,
Integration Readiness Review, and any requested peer review must judge those
alongside the test evidence.

Security vulnerabilities must be reported privately through
[SECURITY.md](SECURITY.md), not through a public issue or pull request.
