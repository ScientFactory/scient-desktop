# Contributing

## Scient repository boundary

This public repository is the active source for released Scient Desktop. The
product, safety, release, and verification rules in [AGENTS.md](AGENTS.md)
govern contributions before the inherited T3 guidance below. Public visibility
does not make every product direction or release operation open: scientific
features, legacy-data migration, cloud/mobile enablement, signing, releases,
and distribution still require their owning product or operational decision.

All candidate changes use short-lived branches and draft pull requests. T3
upstream merges use dedicated branches and must remain separate from Scient
product work; see [UPSTREAM.md](UPSTREAM.md).

For documentation, start at [docs/README.md](docs/README.md). Update existing
owners before adding a file: released behavior and user workflows belong in
`docs/user/`, current implementation or architecture and contributor guidance
currently live under `docs/internals/`, runbooks live under `docs/operations/`,
and upstream divergence lives in `UPSTREAM.md`. Keep temporary plans, scratch,
transcripts, and handoffs out of the repository. In the pull request, state one
of `Documentation impact: None — reason`, `Updated — paths`, or `Dependent PR —
repository and link`.

## Developer Setup

See the [development runbook](docs/operations/development.md#first-checkout) for the initial checkout,
development commands, tests, and platform-specific desktop packaging prerequisites.

## Read This First

We are not actively accepting contributions right now.

You can still open an issue or PR, but please do so knowing there is a high chance we close it, defer it forever, or never look at it.

If that sounds annoying, that is because it is. This project is still early and we are trying to keep scope, quality, and direction under control.

PRs are automatically labeled with a `vouch:*` trust status and a `size:*` diff size based on changed lines.

If you are an external contributor, expect `vouch:unvouched` until we explicitly add you to [.github/VOUCHED.td](.github/VOUCHED.td).

## What We Are Most Likely To Accept

Small, focused bug fixes.

Small reliability fixes.

Small performance improvements.

Tightly scoped maintenance work that clearly improves the project without changing its direction.

## What We Are Least Likely To Accept

Large PRs.

Drive-by feature work.

Opinionated rewrites.

Anything that expands product scope without us asking for it first.

If you open a 1,000+ line PR full of new features, we will probably close it quickly and remember that you ignored the clearly written instructions.

## If You Still Want To Open A PR

Keep it small.

Explain exactly what changed.

Explain exactly why the change should exist.

Follow the [documentation rules](AGENTS.md#documentation). Keep internal docs for decisions and
hard-to-discover constraints. Update user guides when how to use a feature changes; skip descriptions
of obvious controls and cosmetic changes.

Do not mix unrelated fixes together.

If the PR makes anything resembling a UI change, include clear before/after images.

If the change depends on motion, timing, transitions, or interaction details, include a short video.

If we have to guess what changed, we are much less likely to review it.

## Issues First

If you are thinking about a non-trivial change, open an issue first.

That still does not mean we will want the PR, but it gives you a chance to avoid wasting your time.

## Be Realistic

Opening a PR does not create an obligation on our side.

We may close it. We may ignore it. We may ask you to shrink it. We may reimplement the idea ourselves later.

If you are fine with that, proceed.
