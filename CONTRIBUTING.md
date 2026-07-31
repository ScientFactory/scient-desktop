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
   manual verification, and author self-review below.
7. Request peer review when another person's judgment would improve the change.
   Peer review is useful but is not a default merge gate.

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

## Manual Verification

The author must manually exercise every changed user-facing behavior before
requesting review. Test the real affected journey and any failure,
cancellation, restart, recovery, empty, or loading state that is part of the
risk.

In the pull request, record the environment, starting state, actions performed,
and observed result. Include before-and-after screenshots for visible UI
changes. Include a short recording when motion, timing, or interaction cannot
be judged from still images.

For changes with no user-facing behavior, manual product testing may be marked
`Not applicable` with a short reason.

## Author Self-Review

Before marking a pull request ready or merging it, inspect the complete final
diff as if someone else wrote it. Confirm that:

- every changed file belongs to the stated outcome;
- the change addresses the real failure or need;
- existing primitives were considered before adding duplicate logic or state;
- important failure and recovery behavior is handled;
- tests and documentation match the implemented behavior;
- temporary logging, debugging artifacts, secrets, and unrelated changes are
  absent; and
- limitations and deferrals are stated explicitly.

Agent-assisted work has the same requirement. The contributor who submits the
pull request remains accountable for understanding and reviewing the result.
Request peer review when it adds useful judgment, especially for risky,
security-sensitive, or product-direction changes. Do not request a reviewer
solely to satisfy a mergeability gate.

## Review And Completion

A pull request is ready to merge only when:

- its scope and evidence match the final diff;
- required checks pass on the current head;
- relevant manual verification and author self-review are complete; and
- review conversations are resolved.

Passing CI is necessary but does not prove that the product behavior, design,
ownership boundaries, or recovery behavior is correct. Author self-review and
any requested peer review must judge those alongside the test evidence.

Security vulnerabilities must be reported privately through
[SECURITY.md](SECURITY.md), not through a public issue or pull request.
