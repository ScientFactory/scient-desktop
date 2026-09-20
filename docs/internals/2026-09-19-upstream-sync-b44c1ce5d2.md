# T3 upstream alignment through b44c1ce5d2

Status: the history-preserving alignment merge is committed and the automated/source
review gates passed. This receipt records the delivery candidate; it does not claim
release publication, cloud activation, or any new publication authority.

## Frozen history

- Owned starting point: 96481ce7e0f3c4835bfd52ca1428dc1549e98fb5, the latest owned
  `origin/main` revision from which this candidate was created.
- Previous official integration: 408ff8ae9bd7eb2e7e90cbfd8b3fcfe63641bf23.
- Official target: b44c1ce5d25ee0d5a5be82e380618a886c19ea96. The range contains
  three official commits after the previous boundary.
- Nearest official tag: v0.0.43-nightly.20260919.1948. The target is six
  official commits after that tag.
- Alignment branch: codex/t3-sync-b44c1ce5-20260919.
- History-preserving merge: 5e5eb84f295f3c41bed8c9b349edf8f028dce898, with
  the owned starting point as first parent and the exact official target as
  second parent.
- The fetch-only upstream remote remains configured with push URL DISABLED.
- The merge is one bounded alignment. It is not a squash, replay, cherry-pick,
  or split implementation.

## Adopted upstream behavior

This alignment receives the three upstream fixes in the exact range:

- collapsed thought previews now render Markdown as a single plain-text preview,
  while expanded reasoning keeps the existing rich Markdown rendering;
- long confirmation-dialog titles wrap instead of overflowing or being clipped;
- Android composer placeholders stay on one line and ellipsize to the available
  width, with native regression coverage for empty, short, and long placeholders.

These changes are narrow upstream maintenance improvements and do not add a new
product surface, provider, release channel, or authority boundary.

## Deliberately retained or deferred

- Scient remains the product authority for identity, labels, state roots, provider
  lifecycle, scientific/compute surfaces, browser authorization, storage policy,
  privacy, and release decisions.
- The `MessagesTimeline` conflict retained Scient's `ScientSymbol` branding seam
  and adopted only upstream's Markdown preview imports and behavior; the upstream
  `T3Wordmark` import was not reintroduced.
- Migration history remains immutable. No migration was renumbered or reused to
  match T3; this range contains no migration or persistence-policy change.
- Scient's signed/pinned runtime, stable-release workflow, manual publication
  boundary, Azure Trusted Signing, cloud-disabled policy, and relay publication
  hold remain in force.
- No new provider update discovery, cloud/relay activation, mobile publication,
  telemetry destination, or release channel was enabled by this alignment.

## Conflict composition and semantic review

The range touched five files. One content conflict occurred, limited to the
`MessagesTimeline` import block. It was resolved by composing the upstream
Markdown preview implementation with Scient's existing identity import. The other
four files merged automatically without overlapping Scient-owned policy seams.

The upstream thought-preview test had a fixture-call defect in the imported test:
it passed the Markdown string to an options-object helper, so every case silently
used the helper's default text. The candidate corrects that test fixture to pass
`{ text: markdown }`; this changes no runtime behavior and makes the upstream
regression assertions exercise the intended inputs. No other upstream behavior was
modified.

## Qualification

The following gates passed on the composed candidate:

- `pnpm exec vp fmt --check`;
- `pnpm exec vp lint --report-unused-disable-directives`, with only the repository's
  existing advisory warning set;
- `pnpm run typecheck`, with only existing Effect suggestion diagnostics;
- the full `pnpm run test` workspace matrix: all 542 server suites completed with
  7,526 tests passed and 73 skipped; all other workspace suites passed as well;
- the focused web suite: 724 test files and 8,412 tests passed;
- `pnpm run build`;
- `pnpm run test:desktop-smoke`;
- `pnpm run brand:check` across 2,157 product-surface files;
- `pnpm run lint:mobile`, including the native source inventory check;
- conflict-marker, unmerged-index, and scoped diff checks.

The Android Kotlin unit test was not run locally because this checkout has no
Gradle wrapper for the module; the native test is included in the staged upstream
change for CI. SwiftLint, ktlint, and detekt are not installed locally, so the
native static-check script recorded those optional skips. The initial full-test
attempt hit a concurrent Electron download race in the fresh worktree; after
Electron's binary was installed once, the affected desktop tests and the complete
workspace matrix passed.

Visual acceptance remains the owner's separate manual gate and is not established
by these automated checks.

## Publication boundary

The next step is the requested pull request from this branch. It must remain open
for review and CI; auto-merge is intentionally not enabled, and no release or
cloud, relay, mobile, or signing workflow is being published or activated by this
alignment.
