# T3 upstream sync through `aff9318bf4`

Date: 2026-09-22

## Boundaries

- Owned repository: `ScientFactory/scient-desktop`
- Owned base: `02f8826b4f5be8462845dd2d43beaa5e1b56856d` (latest fetched `origin/main`)
- Previous official integration tip: `9a609a4e444ba739d6fcd607769d68b679b0bcc5`
- Official target: `aff9318bf46beaf05cc7155b428d3f0b8711efd2`
- Official target tag: `v0.0.43-nightly.20260922.2096-1-gaff9318bf4`
- Exact donor range: `9a609a4e444ba739d6fcd607769d68b679b0bcc5..aff9318bf46beaf05cc7155b428d3f0b8711efd2` (7 commits)
- History-preserving merge: `7c8197ae12bf0076de0bec61b5d0e463021ca497`
- First parent: `02f8826b4f5be8462845dd2d43beaa5e1b56856d`
- Second parent: `aff9318bf46beaf05cc7155b428d3f0b8711efd2`
- Alignment branch: `codex/t3-sync-aff9318b-20260922-latest`
- `upstream` remains fetch-only; its push URL is `DISABLED`.

The remote owned main advanced with PR #337 while the first composition was
being qualified. The alignment was rebuilt from the newer main instead of
carrying already-merged owned changes as PR noise.
After qualification, owned main advanced again with the release-note-only PR
#338. Its single-file change was merged into this same alignment branch as
`8324d36cd0`, without repeating the upstream alignment or runtime gates.

## Adopted upstream behavior

All seven official commits in the donor range were integrated:

- The pull-request comment and review flows now share the upstream composer,
  while Scient's selection, review, ask-in-chat, and product-identity seams
  remain composed around it.
- Failed attachment uploads retry after reconnect, with the corresponding
  web/mobile queue coverage preserved.
- Browser-hosted webview focus dismisses host menus using upstream's narrow
  pointer replay behavior.
- Sidebar thread renaming keeps text selection available while the rename
  interaction is active.
- Spinner and refresh-icon sizing use upstream's explicit size/tone APIs.
- Redundant component `className` restyling is removed where upstream's
  component contract already owns the styling.
- The upstream `shadcn/no-restyle` lint rule and its test/ceiling guard are
  present as a non-regression check.

## Conflict composition

The merge presented eight textual conflict seams:

- `.github/workflows/ci.yml`: retained Scient's brand gate and adopted the
  upstream restyle lint check.
- `AGENTS.md`: retained Scient's ownership and alignment authority while
  incorporating upstream's useful shared quality defaults.
- `ModelPickerContent.tsx`: retained the Scient provider setup overlay and
  removed only redundant upstream sizing classes.
- `SidebarChrome.tsx`: retained Scient release-note, undo-notice, and update
  pill composition while adopting the upstream no-restyle cleanup.
- `UsagePage.tsx`: retained Scient's refresh/layout placement and adopted the
  explicit refresh-icon size API without duplicating the refresh control.
- `_chat.index.tsx` and `settings.tsx`: retained Scient product labels and
  data attributes while adopting the upstream cleanup.
- `pnpm-lock.yaml`: regenerated from the merged manifests rather than
  hand-editing generated resolution data.

The upstream restyle ceiling of `1207` was not a valid Scient baseline: the
product already has deliberate component styling at many call sites. The
guard therefore uses the measured Scient baseline of `1728` after the latest
main typography changes. It still fails on growth and can be lowered as
existing call sites are migrated; it is not disabled or widened without a
measured reason.

The Vite+ upgrade also made an existing desktop update-test harness return an
unnameable inferred Alchemy type. The merge includes a narrow explicit layer
output/error type for that test helper. No runtime update behavior changed.

## Protected boundaries

- No Scient release or publication authority was restored to upstream.
- Scient's product identity, provider lifecycle, project/environment policy,
  telemetry/release gates, and desktop update policy remain owned locally.
- The upstream remote remains fetch-only.
- Migration identifiers were not renumbered.
- No visual acceptance or production release was performed in this pass.

## Verification

Passed on the final refreshed merge:

- changed-path seam audit: onboarding, skills, analysis, and LaTeX seams all
  passed; reference snapshots were listed separately and not treated as
  product seams
- `pnpm exec vp lint --report-unused-disable-directives` (warnings only)
- `pnpm run lint:restyle-ceiling` — 1728 findings at the measured ceiling
- `pnpm run typecheck` — all 29 projects, no errors
- `pnpm run build`
- `pnpm run test:desktop-smoke`
- `pnpm run brand:check` — 2210 product-surface files
- `pnpm exec vp fmt --check`
- `git diff --check` and `git diff --cached --check`
- isolated desktop update tests — 48 passed
- isolated server `projects.writeFile` error-route test — 1 passed, 223
  skipped

The parallel root `pnpm run test` completed the package, mobile, web, and
desktop batches, including 750 web files/8770 tests and 185 desktop
files/1696 tests, but the server batch reported one 120-second timeout in the
pre-existing `routes websocket rpc projects.writeFile errors` test. That test
file is unchanged by this alignment; running the test in isolation passed in
5.63 seconds. This is recorded as a suite-level contention/timeout signal,
not claimed as a green full-suite result; hosted CI remains authoritative.

The build emitted existing non-fatal bundler warnings for the optional Linux
`x11` import and `import.meta` in the CommonJS Effect bundle.

## Publication boundary

The upstream merge is integrated in the isolated alignment branch. Delivery
through a pull request and any subsequent release remain separate actions;
this alignment does not authorize publication.
