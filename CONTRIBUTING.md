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
