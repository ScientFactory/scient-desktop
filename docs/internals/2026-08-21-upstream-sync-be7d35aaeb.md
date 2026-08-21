# Upstream sync through `be7d35aaeb`

Date: 2026-08-21

## Provenance

- Scient parent: `72c78f00cc09b735e13b27bf750c7cb573062e86`
- Official T3 tip: `be7d35aaeb49a04483ec5e0d2284e8b5b70a3b6e`
- Previous official cursor: `beab6886f45bf42906d0bd01aefe5dfe9e66a867`
- Integrated range: `beab6886f4..be7d35aaeb`
- Official commits: 31
- Official files changed: 115 (+2700/−5523 before Scient composition)
- Merge commit: `c23301d34aba2041797a72e1b2455e0db359f126`
- Worktree:
  `/Users/yaacov/REPOs/ScientFactory-worktrees/scient-desktop-next-t3-sync-be7d35aaeb-20260821`
- Branch: `agent/t3-sync-be7d35aaeb-20260821`

The merge commit has the owned Scient parent first and the exact official T3
tip second. No official commit was replayed, rebased, squashed, or
cherry-picked.

## Official range received

1. `8824f8f24f` retries failed thread bootstraps with a fresh id.
2. `21e80a0636` copies terminal selection instead of a blank clipboard.
3. `aa17ec6e7d` restores the sparse hourly usage breakdown.
4. `0929907ff9` reconciles orphaned provider sessions.
5. `490f48ed98` fixes the subagent row's cut left border.
6. `cd14b3ec21` unifies composer control rounding.
7. `5ff5f735e5` shows the pointer on the add-project button.
8. `730ce9edd9` enables the Cursor provider by default.
9. `1afe5545b7` fixes thread jumping after reorder.
10. `4bdbd8ce15` keeps Daybreak models out of legacy models.
11. `fe87502084` reconciles provider default tests.
12. `f0fb83aff1` polishes theme library buttons, search, and import dialog.
13. `7107a98a22` vouches two contributors.
14. `68966c1e66` adds space above composer task tabs.
15. `e723501227` lists skills with slash commands.
16. `6d3bf01b4f` shows the full path in file link tooltips.
17. `820e5639c3` serves HTML assets with a UTF-8 charset.
18. `12c497083e` gives `git worktree add` a longer timeout on large repos.
19. `9167622a4e` moves implementation plans out of the repository.
20. `45a2c4b2a6` updates the user count in AGENTS.md.
21. `20e5a33968` restricts editor deep links.
22. `6d5c6c4a67` prevents pinned threads reshuffling after drop.
23. `18f6d03489` encodes shifted characters correctly in the terminal.
24. `f3fcfe1f63` resolves sidebar provider icons from the thread's environment.
25. `ce8ca5bb3d` hides thread jump hints while the terminal is focused.
26. `e2697d63ec` keeps following the stream after scrolling back to the live edge.
27. `d7b9a689fe` parallelizes the test suite and splits out Rust checks.
28. `8f7da3b99e` boots the macOS native lint runner only on native changes.
29. `9f12eab383` stops committing pull request assets.
30. `549201fcfd` defaults GitHub clones to HTTPS.
31. `be7d35aaeb` stops preview loading rerenders.

## Conflict composition

| File                                  | T3 behavior adopted                                                                                                                                                                                         | Scient behavior retained                                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`            | Parallelized workspace test job, sharded server job with presence-gated single `thread-transfer-results` artifact, dedicated Rust job, gated macOS native analysis with fail-open detector, PR-asset guard. | Documentation fast path (`paths-ignore`), brand check, vanilla runner fleet (`ubuntu-24.04`/`macos-26`), release smoke lane.                                                 |
| `docs/internals/ci.md`                | Gate narrative for Test/Test Server/Rust and the mobile-native gate.                                                                                                                                        | Documentation workflow paragraphs and release/promotion documentation.                                                                                                       |
| `.github/VOUCHED.td`                  | Superset trust list (contains every prior entry plus ten new vouches).                                                                                                                                      | Nothing dropped; union equals upstream's version.                                                                                                                            |
| `apps/server/src/http.ts`             | UTF-8 charset header groundwork (`lowerPath`, conditional `.html/.htm` Content-Type) inside the shared body.                                                                                                | Parameterized `assetResponseHeaders(filePath, cacheControl)` signature powering range-capable PDF/media serving; blank-line restoration.                                     |
| `apps/web/src/components/Sidebar.tsx` | Per-environment provider entries, jump-hint suppression on terminal focus, sortable layout animation, richer row comments, pinned-block list wrapper.                                                       | Component-scope `renderThreadRow` with Quick Chat labels/icons/projectless guards; delete-vs-modify resolved by keeping the moved helper and porting upstream edits into it. |

## CI feature adjudication

Every overlapping CI feature was compared across base, Scient, and upstream:

- Adopted from upstream: the general `test` job (`--parallel --concurrency-limit
4`), the matrix `test_server` job relying on `fileParallelism: false`,
  presence-gated transfer-budget publishing under the exact artifact name
  `thread-transfer-results`, the dedicated `rust` job (Rust toolchain removed
  from Check), the `mobile_native_changes` detector gating macOS static
  analysis (API-only, rename-aware, truncation fail-open), and the removal of
  per-shard diagnostics artifacts that had no consumer.
- Kept from Scient: the documentation-only fast path paired with
  `documentation.yml`, the `brand:check` identity step, the vanilla
  `ubuntu-24.04`/`macos-26` runner fleet (no Blacksmith labels anywhere,
  including the adopted jobs), the release smoke lane, and all Scient-only
  workflows (provenance, LaTeX managed install, release promotion).
- Repaired incidentally: Scient's previous shard-suffixed artifact names
  (`thread-transfer-results-N-of-3`) could never match the name hardcoded in
  `thread-transfer-report.cjs`, so PR transfer-budget comments had silently
  stopped publishing; upstream's single gated artifact restores that contract.

## Scient adaptations

### Server asset layer

The merged `assetResponseHeaders` keeps Scient's optional `cacheControl`
parameter (required by the asset route's `asset.cacheControl` call site) and
adds upstream's lowered-path charset logic. PDFs continue to receive their
media type from the MIME map alone; SVG sandboxing is unchanged; the route
order and range-request machinery are untouched.

### Sidebar

Upstream edited its inline row renderer in place while Scient had moved that
renderer to component scope with Quick Chat seams. The resolution keeps the
component-scope helper and ports upstream's semantic changes into it:
per-environment provider entry lookup, the wake-comment block, and the
jump-label context. The search-result rows keep their projectless label
handling. Jump hints now hide while the terminal is focused, matching
upstream's shortcut-context model.

### Bootstrap retry

T3's failed-bootstrap retry resets a draft's thread id through the
project-scoped ref helper, which rejects the null project id that Scient's
projectless drafts legitimately carry. The merged code builds the draft target
ref directly so Quick Chat drafts get the same retry benefit without a type
error.

### Repository hygiene

Upstream deleted `.plans/*` and `.github/pr-assets/*` and ignores both paths;
the merge adopts those deletions. The pr-assets guard step remains as the
sentinel against recommitting evidence. Deleted planning content remains
recoverable from history.

## Validation

- seam verifiers: brand check (1346 files), Quick Chat (8 mounts, 36 reviewed
  projectless decision paths), analysis (10 owned roots), LaTeX (6 owned roots)
- focused server suites: `http.test.ts` plus `src/assets/` (3335 tests)
- full web unit suite: 386 files, 3437 tests
- full server suite across three shards: 313 files each, 3335 tests each
  (one transient flake in shard 3 on the first pass; clean on isolated rerun)
- desktop/shared/client-runtime suites: 63 files, 594 tests
- contracts suite: 25 files, 307 tests
- Rust: `cargo fmt --check` plus 15 resource-monitor tests
- `pnpm exec vp fmt --check`
- `pnpm exec vp lint --report-unused-disable-directives`: 15 non-blocking
  warnings (14 pre-existing on `origin/main`; one inherited from upstream's
  theme-library rewrite), 0 errors
- `pnpm run typecheck`: 0 errors
- production web build and desktop pipeline build with preload symbol checks
- desktop smoke test passed
- upstream provenance verifier passed at integrationBase `beab6886f4` pre-commit
- `git diff --check`

No browser automation, live-data access, publication, signing, or release
action was performed.
