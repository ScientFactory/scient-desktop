# T3 upstream alignment through 0ff87f251d

Status: the history-preserving alignment is composed and locally qualified. This
receipt records the open PR delivery candidate; it does not claim visual
acceptance, release publication, cloud activation, mobile publication, or new
publication authority.

## Frozen history

- Owned starting point: `5a948c444477c1dc32cb6d142e0a705936a920af`, the latest
  owned `origin/main` revision when this alignment was prepared.
- Previous official integration: `d6f291303ddc0c9a14f570266a4d9eff6d431593`.
- Official target: `0ff87f251dafb32703d5f531e7b248ad0a581ee2`. The exact
  first-parent range contains four official commits and touches 10 paths
  (`+550/-32` in the aggregate upstream diff).
- Nearest official tag: `v0.0.43-nightly.20260920.1990`; the target is four
  official commits after that tag.
- Alignment branch: `codex/t3-sync-0ff87f25-20260920`.
- History-preserving alignment merge:
  `ec14794dc1739984a7106cfd2b261fff132de7c2`, with owned `main` as the first
  parent and the exact official target as the second parent.
- The fetch-only `upstream` remote remains configured with push URL `DISABLED`.
- This is one full alignment range. It is not a squash, replay, cherry-pick, or
  split implementation. The small follow-up test commit only adapts incoming
  coverage to Scient's shared citation component:
  `e5f191b7a7` (`test(web): cover citation dismissal on shared chip`).
- A final narrow composition fix, `fix(web): preserve dictated citation drafts
on dismissal`, also forwards voice-inserted text through the same draft
  tracking callback used by typed comments.

## Upstream behavior included in this alignment

All four official commits in the frozen range are included:

- **Citation comment dismissal** (`0ff87f251d`): clicking away, losing focus,
  or losing the rendered source no longer silently drops a changed valid
  comment. Scient composes this with its shared `CitationChip`, file citations,
  optional voice input, explicit Cancel behavior, and the over-length-draft
  guard. The draft remains open when it cannot yet be saved safely.
- **Whitespace-aware pull-request diffs** (`4a560b4e4e`): the PR diff toolbar
  now exposes the existing whitespace preference. The rendered view can hide
  whitespace-only changes, while review positions continue to resolve against
  the unfiltered source files. The cache key includes the mode, and changing
  the mode clears pending review selection state.
- **Pull-request detail menu icon alignment** (`7445aa733a`): the checkout and
  question menu icons use the upstream vertical alignment correction.
- **Pull-request state glyph alignment** (`599c9776eb`): the state glyph is
  aligned to the row's title content and the header's back-button hover area is
  preserved by moving the horizontal inset to padding.

No upstream behavior in this range was omitted. Scient-owned product policy,
provider lifecycle, identity, scientific surfaces, storage/migration history,
telemetry/privacy, cloud/relay, mobile publication, signing, and release
authority remain governed by the existing Scient seams.

## Conflict composition and semantic review

Git predicted one textual conflict in
`apps/web/src/components/chat/AssistantCitationChip.tsx`. The resolution
retains Scient's generalized shared-chip structure and file-citation handling,
while composing upstream's source-unavailable state, draft tracking, dismissal
decision helper, fallback positioning, and controlled popover close behavior.
The incoming upstream test was adapted to instantiate Scient's shared
`CitationChip`; no assistant-only duplicate component was introduced.

The remaining overlapping files were auto-merged and reviewed semantically:
the shared comment editor keeps Scient's voice control and create/edit labels,
and both typed and dictated edits update dismissal draft state. The diff parser
preserves source-file line identity for review comments, and
the PR UI changes remain limited to the intended toggle/cache/positioning
seams. There are no conflict markers or unmerged paths.

## Protected-boundary review

- No server, persistence, migration, provider, desktop updater, telemetry,
  OTLP, cloud, relay, signing, release, or mobile-publication path was touched
  by this range.
- Existing Scient release/publication guards and disabled mobile/relay paths
  remain present.
- The whitespace toggle changes review presentation only; it does not change
  the source patch, review anchor identity, or server-side comment contract.
- Citation dismissal commits only a changed valid draft, preserves an invalid
  over-length draft for correction, and keeps explicit Cancel/Escape as discard
  paths.

## Qualification

- Focused web alignment tests: 4 files, 40 tests passed.
- Full workspace tests: web 116 files with 1,429 passed and 43 skipped;
  desktop 183 files with 1,679 passed; all other workspace suites passed.
- Full `pnpm run typecheck` passed; output contains only the repository's
  existing Effect suggestion diagnostics.
- `pnpm run lint` passed with existing repository warnings and no errors.
- `pnpm exec vp fmt --check` passed.
- `pnpm run build` passed. The build reported existing third-party direct-eval,
  large-chunk, and optional native-module warnings.
- `pnpm run test:desktop-smoke` passed.
- `pnpm run brand:check` passed across 2,159 product-surface files.
- `pnpm run lint:mobile` passed its static check. SwiftLint, ktlint, and detekt
  were not installed locally and were skipped by the repository script.
- Conflict-marker, unmerged-index, and whitespace checks passed.

The first full test attempt encountered a generated Electron install race in
the isolated worktree; the three affected desktop suites passed after the
dependency completed installation and the full suite was rerun. This was an
environment setup issue, not a test or source failure.

## Publication boundary

The open pull request is the delivery boundary for this alignment. It remains
open intentionally so later official upstream commits can be incorporated into
the same PR before merge. Visual acceptance, merge, release publication, and
any cloud, relay, mobile, or signing workflow remain separate authorized steps.
