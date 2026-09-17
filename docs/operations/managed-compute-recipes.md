# Managed Compute recipes

## Ownership and release policy

Scient owns curated capability sets, not a general-purpose package manager. PyPI supplies
packages; checked-in `pyproject.toml` and `uv.lock` select exact versions and artifacts. The
installer uses locked wheels, no source builds, and app-owned environments. Normal user/project
Python and licensed MATLAB installations are never updated by this system.

`renovate.json5` limits dependency proposals to the two managed recipe directories. It groups
patch/minor candidates, keeps the MATLAB helper separate, refreshes transitive locks weekly,
requires approval for Python interpreter proposals, and never automerges. Human review must
consider major/API changes and security releases; the weekly schedule is not a promise of
immediate vulnerability remediation. Renovate's [PEP 621 manager](https://docs.renovatebot.com/modules/manager/pep621/)
updates the Python manifest and uv lock rather than requiring a second package updater.
Changing package membership, Toolkit groups, installer artifact policy, or verification semantics
is an app-level change. It cannot be enabled in older apps merely by publishing metadata.

## Candidate and qualification

1. Review a dependency PR. Do not hand-edit frozen lock contents.
2. With full Git history, run `node apps/server/scripts/compute-recipes.ts seal` and then `check`.
   This derives exact hashes and a stable revision from the last manifest/lock commit. The metadata
   file is a build input, not installed state. No packages or app profiles are modified.
3. Run the affected Compute unit tests and opt-in production tests. Qualification explicitly
   disables the public feed so it cannot test an unrelated published release.
4. Merge only after review and required CI. Publishing is restricted to trusted `main` code;
   untrusted pull requests cannot use release credentials or the licensed self-hosted runner.

`scient-compute-recipes.yml` reuses the real Python kernel workflow, including all eight optional
Toolkit combinations, retained kernels, and scientific file workflows. Both Linux x64 and macOS
ARM64 must succeed. The job asserts its actual native target; it does not qualify Windows,
Intel macOS, or Linux ARM64 by inference. The publisher rejects a target list different from its
qualification matrix. The app's existing bundled installer support remains unchanged.

MATLAB helper publication is a separate manual dispatch. It needs a dedicated licensed macOS
ARM64 runner and tests each supported release: R2024b, R2025a, R2025b, R2026a. Each matrix entry
checks that the configured executable really belongs to that release. A missing runner, license,
installation, or failed/skipped matrix prevents helper promotion. Testing only R2026a locally
does not qualify the full release matrix.

## Promotion and withdrawal

After qualification, a separate protected publication job validates catalog/lifecycle tests,
mints the existing release GitHub App's contents-write token, and publishes `catalog.json` to
`automation/compute-recipes-v1`. No installer or candidate package runs with that token. The job
checks the source SHA, ancestry, and changes to runtime/policy/gates since qualification. Catalog
sequence increments are serialized, file writes use GitHub's content-SHA compare-and-swap, and
the job verifies the resulting content. It never force-pushes, merges a dependency PR, or changes
installed environments. Specification URLs always use an immutable repository commit.

The first publication bootstraps only the purpose actually qualified; it does not implicitly
publish the other runtime. Repeating a publication of the same immutable recipe is a no-op.

For an unsafe recipe, dispatch the same workflow on `main` with its purpose and exact
`recipeIdentity` hash in `withdraw`. The protected publication job records the withdrawal without
requiring broken packages to pass qualification again. The identity must already exist in the
published purpose. Withdrawals are monotonic; repair by publishing a newly qualified revision,
not rewriting or un-withdrawing the old one. User environments never downgrade automatically.
Current sessions continue; subsequent install/update/repair/Toolkit changes honor withdrawals
known to that client. Offline clients cannot know a withdrawal they have not fetched.

## External setup required before live publishing

Code alone does not enable the service. A repository administrator must:

- Enable/install Renovate for this repository and approve its initial configuration.
- Configure `compute-recipe-publication` to permit only `main`, with required reviewers; make
  `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` available there. Restrict the GitHub App to this
  repository and its required contents permission. Protect the catalog branch against other
  writers. Never publish credentials in the catalog.
- For MATLAB, configure the protected `compute-matlab-qualification` environment, dedicated
  `scient-matlab-qualification` runner, and valid installations/licenses. Define
  `SCIENT_TEST_MATLAB_R2024B`, `SCIENT_TEST_MATLAB_R2025A`, `SCIENT_TEST_MATLAB_R2025B`,
  `SCIENT_TEST_MATLAB_R2026A` executable paths and repository variable
  `SCIENT_MATLAB_QUALIFICATION_ENABLED=true` only when this matrix is available.
- Dispatch and observe the first successful qualified publication. Verify the public catalog
  URL, source hashes, and native test evidence before declaring live updates operational.

Until then, apps fall back to the bundled recipe and truthfully report an unavailable update
check. This implementation does not itself install a GitHub App, create approval rules, furnish
MATLAB licenses, or claim native qualification on machines it has not tested.

## Verification and manual acceptance

Automated tests cover bounded/malformed sources, hashes, capability changes, source authority,
platform/installer compatibility, deduplicated checks, persisted cache, offline install fallback,
withdrawals, no downgrade, immediate cancellation, pinned Toolkit/Repair behavior, selection
preservation, and retained in-use generations. The existing manager/provisioner tests continue
covering failed verification/activation, ownership, cache reuse, cancellation and cleanup.

Manual acceptance after deployment: open Settings with and without network access; check that
runtime readiness is unaffected; install once and verify the selected recipe; publish a newer
qualified recipe and check that Update appears without reinstalling the app; add/remove a Toolkit
before Update and confirm the recipe does not change; update with a live session and confirm the
old session survives while a new session uses the new recipe; cancel during catalog/download
work and confirm immediate feedback and no activation. Review MATLAB separately.

### Local qualification — 2026-09-17

Implementation was reviewed in the isolated `scient-compute-updates-20260917` worktree, based on
PR #287 commit `f42da5a278a34a1039b6b331c6e4b0778e7f83b0`. No computer use or live catalog
publication was performed, and the other Compute agent's checkout/dev app was left unchanged.

- Final backend Compute suite: 520 passed, 17 opt-in tests skipped. The new publication tests
  exercise the real CLI with synthetic Git/GitHub effects: bootstrap, idempotence, content-SHA
  guards, withdrawal, unknown withdrawal rejection, and stale qualification rejection.
- Web Compute suite: 357 passed. Shared client polling: 17 passed.
- Full server suite on the frozen final code: 7,171 passed, 72 opt-in skips across 529 files
  (406 seconds). All other 26 workspace package suites passed with 15,872 tests, for 23,043
  passing tests across the workspace checks, excluding separately invoked live qualification.
- Real managed Python product qualification: all eight Toolkit combinations passed, including
  production-service execution and retained kernels (635 seconds).
- Real fetched-recipe transaction: direct installation, revision update while the old generation
  is acquired, receipt reload, and rejection of a corrupted follow-up passed (109 seconds).
  This uses the current frozen packages with synthetic newer recipe metadata; it does not claim
  to qualify arbitrary future package versions or a live GitHub feed.
- Real MATLAB R2026a product/helper qualification passed; final repeat took 65 seconds. The
  other three MATLAB releases and Linux native jobs remain CI/operator qualification, not
  locally observed results.
- All-workspace typechecks and production builds passed, as did repository formatting,
  lint (existing unrelated warnings), affected dependency-boundary checks, recipe sealing/
  validation, workflow syntax checks, and patch whitespace checks. The final server bundle
  includes the web build, Compute bridges, and both managed specifications.

The generic desktop smoke command reported success, but that is not evidence of an isolated,
visually reviewed, rebuilt development app. Manual acceptance and the external setup above
remain separate from source/backend qualification.

Earlier broad attempts were not clean: an unchanged analytics HTTP fixture raised an empty-JSON
exception (its isolated repeat and subsequent package run passed), and a server run spanning
the final interrupted-download edit used an older cached implementation with the new test.
The fresh full-server result above supersedes that mixed-snapshot run; the analytics fixture
was not modified or silently excluded.
