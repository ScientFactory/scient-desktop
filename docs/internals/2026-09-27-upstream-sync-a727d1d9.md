# T3 upstream alignment through `de251fc297`

Date: 2026-09-27

Bounded, history-preserving alignment of the official `pingdotgg/t3code` `main`
branch into Scient's owned `main`, extended after the original candidate and then
brought forward to the latest owned `main`. Review and provenance record only. It
does not authorize a release or publication.

## Frozen boundaries and history

- Owned base for the alignment: `1ad094bbc3ffc58ad4e171f1e1ea5ce1d859ed5c`
- Previous official integration tip: `95030dc674883f0f2a7fd034b32ce742c8cf55d0`
- Official target: `de251fc2971a884cb5b1305ba4daf309dc8cccb0`
- Complete donor range: **15 official first-parent commits** after
  `95030dc674883f0f2a7fd034b32ce742c8cf55d0`, 0 merges (linear `main`)
- Initial alignment merge through `a727d1d97690c9bb12cee5760e91cfd1aa7c017d`:
  `0c33fa4233ad8c2293349803bf2ce50c5f1e876b`
  - first parent: owned base `1ad094bbc3…`
  - second parent: exact official target `a727d1d976…`
- Upstream extension merge through `de251fc2971a884cb5b1305ba4daf309dc8cccb0`:
  `a556a6905fdbd9b6121f8952a994531b4870671d`
  - first parent: the reviewed a727 candidate head
    `ec4e49717ea56591bc9989e47ee82c19d5d576d4`
  - second parent: exact official target `de251fc297…`
- Narrow Scient composition after the extension merge:
  `79f62ba2cf6c4dd01dced564a0a4c5b2c179f933`
- Latest owned `main` catch-up: `12437d152ee30d7d39313a05200fcf1c27c82d1a`
- Owned-main catch-up merge: `70a9f9d980ab4e4aa8ae391211875cfd3ff05cbc`
  - first parent: the composed upstream candidate
    `79f62ba2cf6c4dd01dced564a0a4c5b2c179f933`
  - second parent: exact latest owned `main` `12437d152…`
- Branch: `codex/t3-sync-a727d1d9-20260927`
- Alignment PR: to be created after the reviewed branch is pushed
- Nearest reachable official tag: `v0.0.43-nightly.20260927.2344`
- `upstream` remains fetch-only; push URL re-verified `DISABLED`

Every official commit in the frozen range is literal ancestry of the extension
merge. The original a727 merge remains literal ancestry of the final candidate.
No donor commit was squashed, replayed, or omitted.

The initial alignment covered 39 official paths with 21 owned overlaps and six
materialized conflicts. The extension added one official commit touching three
web-onboarding paths. The owned-main catch-up contained 64 commits across 187
files; its three-way simulation was clean and its four overlapping paths were
audited after the real merge.

## New official advancement: `de251fc297`

`fix(web): continue onboarding after incomplete history imports (#13935)` changes
partial project-history import behavior:

- A partially successful import no longer leaves the user trapped in the import
  step with an inline error and a second decision.
- Setup completes after the import attempt, including the case where every
  selected thread was skipped.
- Navigation and onboarding completion are awaited before the result is
  reported, so the warning or success toast appears in the destination rather
  than on an unmounted wizard.
- Skipped history is reported as a persistent warning; a clean import reports
  the imported thread count.
- A completion or persistence failure keeps setup open and preserves the import
  result for the retry or skip path.
- Upstream adds focused `WelcomeWizard` coverage for partial imports, clean
  imports, pluralization, and completion failure.

No migration, shared contract, provider, cloud, relay, telemetry, release,
signing, mobile-publication, Compute, LaTeX, PDF, or scientific-rendering path
changed in this advancement.

### Onboarding conflict and Scient composition

`apps/web/src/routes/welcome.tsx` was the extension's only textual conflict. The
resolution keeps Scient's hosted-only `/welcome` route: authenticated clients
still redirect to `/getting-started`, `localAvailable` remains `false`, and the
hosted-static gate remains unchanged. It adopts upstream's asynchronous
`onDone`, awaiting project-thread navigation or the `/` fallback before the import
result is shown.

Upstream fixes the inline import step still used by the hosted wizard. Scient's
local Getting Started flow uses the extracted shared `ProjectImportStep` and
`ScientProjectImportAction`, so the same behavior was composed there rather than
leaving the local path with the old trap:

- partial results are retained outside render state and passed to `onDone`;
- the shared step completes automatically after a partial attempt;
- the blocking inline error and “Continue without the rest” decision are gone;
- the local import action shows the warning or success result only after it has
  closed the dialog or successfully opened the imported thread;
- a failed completion/navigation releases the importing state and preserves the
  warning for retry or skip.

Focused tests cover the hosted wizard, the extracted shared step, and Scient's
lazy import action.

## Owned-main catch-up

The frozen alignment base was no longer the owned `main` tip. After the upstream
extension merge was committed and the worktree was clean, exact owned `main`
`12437d152…` was merged with `--no-ff`. The catch-up is a normal merge commit; it
does not replace the official second parent or advance `integrationBase` by
itself.

The catch-up brings the already-reviewed fork redesign, sidebar sections,
`Add project` in the new-thread row, dev-app signing isolation, thread-read MCP
bridge, and their migrations. Its migration `058_ProjectionThreadSections`
follows the alignment's `057_ProjectionThreadsAutoSettleDisabledAt`; no recorded
migration ID was reused or reordered.

### Cleanly merged overlaps reviewed

- `ChatView.tsx`: the fork redesign's running-turn fork, context delivery, and
  PDF continuity coexist with the alignment's corrected offline/reconnect banner.
  The composed file contains the fork entry points and no “Finishing an update”
  description for an offline server.
- `Sidebar.tsx`: the a727 row accessibility labels, current-row semantics, and
  presentational list structure coexist with the new user-defined Sections view,
  section-aware drag/drop, and section rendering. Section rows continue through
  the same accessible thread-row path.
- `ui/sidebar.tsx`: the alignment's `viewportTabIndex` behavior and the new
  pressed-toggle variant are both present.
- `UPSTREAM.md`: the owned-main pointer and alignment pointer were reconciled;
  there is one current-alignment record and no duplicated pointer.

The staged catch-up had no conflict markers or unmerged index entries.

## Owner decisions applied

- `node-pty` stays on `^1.1.0`; the Linux arm64 artifact is still built on arm64
  hardware and does not consume upstream's new prebuild.
- The Cursor Keychain disclosure remains a separate documentation change.
- Delivery ends at a pull request for review; no merge to `main`, publication,
  release, cloud activation, or mobile activation.

## Conflict resolutions from the original a727 range

| Path                                                     | Classification      | Resolution                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/usage.ts`                        | composition         | Adopt `ForwardCompatibleArray` for usage buckets and sources; keep Scient's `pi` provider kind, accounting schemas, contract version 6, and merge compatibility since version 4. |
| `apps/web/src/components/usage/UsagePage.tsx`            | composition         | Adopt contract-mismatch and Cursor Keychain-environment reporting; keep Scient's Spend metrics, accounting view, analytics calls, and topbar layout.                             |
| `apps/web/src/components/ui/scroll-area.tsx`             | composition         | Add upstream's `viewportTabIndex` prop to Scient's `DirectionProvider` structure.                                                                                                |
| `apps/server/src/provider/CodexDeveloperInstructions.ts` | Scient-owned policy | Keep `buildScientAwareness(capabilities)` instead of restoring the upstream `T3_CODE_*` prompt block.                                                                            |
| `scripts/build-desktop-artifact.ts`                      | obsolete divergence | Keep Scient's `resolveWslPrebuildArch` gate; upstream edited archive machinery that does not exist here.                                                                         |
| `scripts/build-desktop-artifact.test.ts`                 | obsolete divergence | Keep Scient's archive-layout tests rather than restoring the removed `${stem}` fixture machinery.                                                                                |

## Usage contract: verified end to end

`ForwardCompatibleArray` replaces `Schema.Array` for usage `buckets` and
`sources` while `USAGE_CONTRACT_VERSION` remains 6. Scient's `pi` provider kind
is not in upstream, so the composed schema was decoded directly:

- an unknown provider bucket is dropped without losing the summary or its
  contract version;
- known buckets survive;
- required fields remain required;
- a contract-mismatched environment can still be named and reported.

Scient's provider-authoritative `accounting.sources` remains a strict array and
is untouched.

## Product-identity composition

Two a727 upstream strings naming the inherited product were relabelled to Scient:
the Cursor usage reader and the OTel environment warning. `brand:check` passes
across 2,292 product-surface files.

## Device-tool instructions

Upstream's relaxed `simctl`/`adb` guidance was adopted in the generic device
quick start and applied to Scient's relocated always-on awareness copy. Device
tools remain preferred; raw platform tools remain available for work those
tools do not cover.

## Telemetry boundary

The a727 range adds per-signal `OTEL_<SIGNAL>_EXPORTER=none`. It can only narrow
export; unset behavior is unchanged, unknown exporter names are dropped with a
warning, and Scient's safety envelope remains authoritative. The extension adds
no telemetry change.

## Verification

Qualification ran on the composed code at owned-main catch-up head
`70a9f9d980ab4e4aa8ae391211875cfd3ff05cbc`. Documentation and state-only commits
may follow without invalidating runtime evidence.

| Check                                                                                                                                            | Result                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `pnpm exec vp fmt --check`                                                                                                                       | pass                                                                                       |
| `pnpm exec vp lint --report-unused-disable-directives`                                                                                           | pass; existing advisory warnings only                                                      |
| `pnpm run typecheck`                                                                                                                             | pass across all workspaces; suggestions only                                               |
| `pnpm --filter @t3tools/web test -- WelcomeWizard ProjectImportStep ScientProjectImportAction Sidebar ChatView UsagePage ThreadStatusIndicators` | pass; 769 files, 8,924 tests                                                               |
| `pnpm run test`                                                                                                                                  | pass across all workspaces                                                                 |
| server package                                                                                                                                   | 558 files passed, 22 skipped; 8,055 tests passed, 73 skipped                               |
| web package                                                                                                                                      | 769 files passed; 8,924 tests passed                                                       |
| desktop package                                                                                                                                  | 191 files passed; 1,741 tests passed                                                       |
| scripts package                                                                                                                                  | 104 files passed; 1,796 tests passed                                                       |
| `pnpm run build`                                                                                                                                 | pass; existing chunk-size, MathJax `eval`, optional `x11`, and `import.meta` warnings only |
| `pnpm run test:desktop-smoke`                                                                                                                    | pass                                                                                       |
| `pnpm brand:check`                                                                                                                               | pass across 2,292 files                                                                    |
| `pnpm run knip:check`                                                                                                                            | pass                                                                                       |
| `pnpm run lint:mobile`                                                                                                                           | static pass; SwiftLint, ktlint, and detekt unavailable and explicitly skipped              |
| `pnpm alignment:seams:check --base 1ad094bbc… --upstream-ref de251fc297… --head HEAD`                                                            | onboarding, skills, analysis, and latex passed                                             |
| `git diff --check`, `git diff --cached --check`                                                                                                  | pass                                                                                       |

## Not established here

Visual and interaction acceptance, live-provider behavior, release signing,
publication, production cloud, and mobile-device qualification are not claimed.
The final candidate must be launched from its exact head for manual review.

## Follow-ups for the owner

1. `Spend` remains unreachable in the Usage UI because the existing
   `isUsageMetric` guard is built from upstream's metric list. This predates the
   alignment and was deliberately kept out of the merge.
2. `docs/user/usage.md` still needs the Cursor token-disclosure language tracked
   by the preceding owner item.
3. Upstream's wrong-architecture Windows prebuild test is not portable to
   Scient's archive layout; `resolveWslPrebuildArch` and the required-member list
   remain the enforcement.

## Publication boundary

This record authorizes review only. It does not authorize merging to `main`,
publishing a release, activating cloud or mobile, or changing product policy.
