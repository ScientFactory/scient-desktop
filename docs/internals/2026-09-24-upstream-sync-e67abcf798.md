# T3 upstream alignment through `e67abcf798` (PR #365)

Date: 2026-09-24

This receipt records a new, bounded alignment of the official T3 `main` branch
onto Scient `main`. It is a history-preserving `--no-ff` merge of an exact
official range; no official commit was omitted, squashed, or replayed.

## Frozen boundaries and history

- Owned repository: `ScientFactory/scient-desktop`
- Owned base (current `origin/main`): `66650fd93196b635ba56c3a4130fad5fb6d5a82d`
- Previous official integration tip: `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc`
- Official target: `e67abcf798f8c4d8458755e3b4dde02c2c1f628b`
- Official target description: `v0.0.43-nightly.20260924.2187`
- Complete donor range `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc..e67abcf798f8c4d8458755e3b4dde02c2c1f628b`:
  **15 official commits**
- History-preserving merge: `0ab3e990eaff85c92ecc206cce965414ffe7c1b5`
  (first parent owned base; second parent exact official target)
- Owned-main catch-up merge: `0c10a40a5d885beedd0d59fdbb10e277f397cadf`
  (first parent the reviewed alignment head `8d80832f0c996b334da6aeb8c280e20926e030a1`;
  second parent latest owned `origin/main` at
  `5872cc9841e1d8274b6d9b99a11308c5f48b04b1`)
- Alignment branch: `codex/t3-sync-e67abcf798-20260924`
- Draft pull request: ScientFactory/scient-desktop#365
- `upstream` remains fetch-only; its push URL is `DISABLED`.

The plan measured 15 donor commits, 124 changed paths, **47 overlapping
Scient-modified paths**, zero reference snapshots, and **11 predicted
textual-conflict paths**. All 11 conflicts were resolved in the merge. The
worktree has no unresolved index entries and no conflict markers.

## Integrated behavior

- **Observability — OpenTelemetry kill switch (`e67abcf798`):** adopt the
  shared `@t3tools/shared/otelEnvironment` loader and honor
  `T3CODE_OTEL_SDK_DISABLED` / `OTEL_SDK_DISABLED` in the server CLI and the
  desktop main process. Composed with Scient's fail-closed policy: Scient's
  `safetyEnvelopeEnabled` / `SCIENT_NEXT_SAFETY_ENVELOPE` gate remains
  authoritative, and the kill switch is an additional off-switch. Scient keeps
  desktop metrics export disabled until a metric exists.
- **Interactive 3D device workspace (`78af372cf4`):** adopt upstream's
  `components/device` workspace, `client-runtime` device modules, GLB models,
  and the `desktop:trackpad-scroll-end` IPC channel/preload/`ElectronProtocol`
  wiring. Scient's `RightPanelTabs` RTL tooltip attributes are preserved.
- **Preview automation — visible browser (`894d33419d`):** adopt the optional
  `liveTabs` host-focus contract and target-tab ownership ordering, so new
  agent sessions prefer the tab the user can see. Composed with Scient's
  preview policy and `useEnvironmentHttpBaseUrl`.
- **Provider compatibility (`d4cd7d5c33`):** adopt per-harness compatibility
  ranges (codex, claudeAgent, cursor, grok, antigravity, opencode) and the
  cursor/antigravity version normalization, composed with Scient's existing
  manifest entries. The reviewed Scient Pi floor is recorded separately; Droid
  remains an exempt Factory-owned ACP release channel.
- **Server/relay (`e4eb9977f0`):** adopt the restart `startedAt` gate that stops
  replaying old agent alerts, composed with Scient's relay snapshot behavior.
- **Web/UI and a11y fixes:** composer chip-ring clipping (`9030a60eaf`), brain
  icon for the effort dropdown (`c0912debcb`), previous-worktree branch on a
  second line (`effaab94e3`), switch screen-reader state (`21e2b7de00`), CSV
  record preservation (`f1add18ae1`), and the macOS SnapShot helper Dock-icon
  fix (`6b4b19096a`).
- **Mobile (`68fb7f4b85`, `11e91f1264`):** carried for ancestry and kept
  compile-clean; mobile remains unpublished by Scient.
- **CI/release:** upstream's release-workflow test sharding (`e407f9bb09`) is
  recorded but not applied (see below).

## Composition and targeted local corrections

Conflict resolutions:

- `.github/workflows/release.yml` — **Scient-owned**: retained Scient's release
  pipeline entirely. The upstream change shards tests inside the upstream
  release workflow; Scient's release workflow is an intentional replacement
  (publication authority seam) and has no release test job to shard. Upstream's
  donor commit remains in ancestry; its behavior is not applicable to Scient's
  pipeline.
- `.github/VOUCHED.td` — **Scient-owned**: retained Scient's deliberate trust
  list; upstream's mirrored contributor list is not adopted.
- `docs/user/updating.md` — retained Scient's `## Troubleshooting` support
  copy and did not adopt upstream's `## Mobile updates` instructions while
  Scient's mobile publication hold remains active. The upstream mobile source
  and contracts remain in history and compile-clean, but no unsupported mobile
  update path is advertised to users.
- `apps/web/src/components/ui/switch.tsx` — adopt upstream's a11y mechanics
  (only pass `aria-checked` when mixed); preserve Scient's `motion` prop.
- `apps/server/src/provider/model-manifest.json` — keep Scient's model entries,
  add upstream's compatibility ranges; take the newer upstream `updatedAt`.
- `apps/server/src/cli/config.ts` and `apps/server/src/cli/config.test.ts` —
  compose Scient's safety-envelope gate with upstream's `otel.disabled`; keep
  Scient's test and upstream's two new kill-switch tests.
- `apps/server/src/server.test.ts`, `apps/server/src/config.ts` — the server
  config carries both Scient's `otlp*Export` fields and upstream's
  `otelEnvironment`.
- `apps/web/src/components/RightPanelTabs.tsx` — keep Scient's RTL tooltip
  attributes and add upstream's device-tab tooltip.
- `apps/web/src/components/preview/PreviewAutomationHosts.tsx` — compose
  Scient's `httpBaseUrl` with upstream's visible-tab reporting.
- `pnpm-lock.yaml` — regenerated from the composed manifests (adds `three` and
  `@types/three`); not hand-merged.

Semantic issues found beyond Git's textual conflicts:

- `apps/desktop/src/app/DesktopObservability.ts`: upstream added `warnings` to
  the resolved OTLP endpoints; Scient's safety-envelope branch returned without
  it, breaking `Effect.forEach(endpoints.warnings, …)`. Added
  `warnings: otel.warnings` to Scient's branch.
- `apps/web/src/scient/markdownEditor/persistence/MarkdownSourceSurface.test.tsx`:
  `@types/three` pulls `@webgpu/types`, which adds a `GPUCanvasContext`
  `getContext` overload and broke Scient's canvas double. Cast the double to
  the mocked method's return type.
- `packages/shared/src/cliRelease.ts` + `packages/shared/package.json`:
  upstream's new mobile environment maintenance imports
  `@t3tools/shared/cliRelease`, which Scient removed when it replaced T3's
  CLI-release infrastructure. Added a SCIENT-FORK module exposing exactly the
  three helpers the mobile flow needs, pointed at
  `ScientFactory/scient-desktop` (`SCIENT_DESKTOP_RELEASE_REPOSITORY`) so the
  seam keeps Scient's release identity rather than T3's. Upstream mobile code is
  unchanged.

## Post-alignment review corrections

A follow-up review of the exact composed candidate found and fixed four
composition/qualification defects before the branch was considered ready:

- The upstream OTel test assumed `T3CODE_OTEL_SDK_DISABLED=false` could
  re-enable an endpoint inside Scient's fail-closed safety envelope. The shared
  loader still tests the override; the server composition test now asserts that
  Scient's safety envelope remains authoritative.
- Upstream's “every built-in harness” compatibility assertion crossed Scient's
  Droid/Pi drivers. Added the documented Pi floor (`0.84.4`), explicitly exempt
  Droid's Factory-owned ACP release channel, and corrected the registry reload
  expectation to retain the composed compatibility advisory.
- The upstream mobile update instructions were not exposed while Scient's
  mobile publication hold is active. The mobile source remains in history, but
  the unsupported user-facing section was removed from `docs/user/updating.md`.
- Two inherited tests depended on ambient process state or asserted more than
  their named seam. The analytics default test now supplies an empty config
  provider, and the desktop-artifact test identifies the primary executable
  rather than rejecting the legitimate server self-containment probe.

These changes do not alter the upstream merge ancestry or weaken any safety
or release guard.

## Owned-main catch-up review

The later owned-main fetch contained the two latest reliability integrations
(`#364` reload preservation and `#367` Stop/session convergence). The exact
owned-main merge was clean: 34 changed paths, three overlap paths, and no
textual conflicts. The overlap was limited to additive desktop reload IPC
(`apps/desktop/src/ipc/channels.ts`, `apps/desktop/src/preload.ts`, and
`packages/contracts/src/ipc.ts`); the alignment's existing trackpad channel,
3D device wiring, preview ownership, OTel safety boundary, and provider seams
remain intact. Focused desktop, web reload, contracts, typecheck, lint, seam,
and full-workspace gates were rerun on the catch-up candidate.

## Protected boundaries

- Scient product identity, provider authority/lifecycle, scientific behavior,
  and release/publication authority remain Scient-owned.
- No release, cloud deployment, or publication workflow was enabled; the mobile
  EAS production workflow remains manual (`workflow_dispatch`).
- No migration identifier was changed or renumbered; the range contained no
  migrations.
- The official upstream remote remains fetch-only (`push` = `DISABLED`).
- The 3D device workspace is adopted as upstream mechanics; it does not
  activate any device host, runtime, or publication channel.
- Visual acceptance and production release are not claimed. PR #365 remains an
  unmerged draft for review.

## Verification

Performed on the composed candidate and the review-corrected working tree:

- `pnpm alignment:seams:check --base 66650fd93196b635ba56c3a4130fad5fb6d5a82d
--upstream-ref e67abcf798f8c4d8458755e3b4dde02c2c1f628b --snapshot index` —
  onboarding, skills, analysis, and LaTeX checks all **passed**; no reference
  snapshots.
- `pnpm exec vp fmt --check` — passed.
- `pnpm exec vp lint --report-unused-disable-directives` — passed (exit 0;
  existing advisory warnings remain, e.g. React Compiler suggestions in
  `ChatView.tsx`).
- `pnpm run typecheck` — passed across all workspace projects, 0 errors.
- `pnpm run test` — **passed across all workspaces**. On the post-catch-up
  candidate, the server package passed 533 files / 7,769 tests (22 files / 73
  tests skipped), the web package passed 121 files / 1,453 tests (4 files / 43
  tests skipped), and the scripts package passed 96 files / 1,743 tests. No
  test failures remain in the final local run.
- `pnpm run build` — passed (existing non-fatal `x11`/CommonJS `import.meta`/
  large-chunk warnings).
- `pnpm run test:desktop-smoke` — passed.
- `pnpm run brand:check` — passed across 2,226 product-surface files.
- `pnpm run knip:check` — passed.
- `pnpm run lint:mobile` — passed (14 Swift / 26 Kotlin files; optional
  SwiftLint, ktlint, and detekt unavailable and skipped).
- `git diff --check` and `git diff --cached --check` — clean.

The original hosted CI run for the pre-review head exposed the three server
composition failures described above. They were reproduced locally, corrected,
and covered by the final local suite. The follow-up hosted run for review
commit `99d5cdb84e53159fd7068e3a1dfed02b8224f121` passed every required check.
On the post-catch-up head, the first hosted CI attempt hit a transient npm
registry failure during macOS managed-Python setup; the failed jobs were
rerun without changing the compute gate, and the second attempt passed every
required check. Mobile EAS preview and hosted web deployment remained
intentionally skipped by Scient's publication holds.

## Publication boundary

Push the draft PR for review; do not merge to `main`, publish, or clean the
worktree until review and user acceptance authorize those separate actions.
`upstream-state.json` and the `UPSTREAM.md` integration pointer advance to the
exact target `e67abcf798f8c4d8458755e3b4dde02c2c1f628b` and merge
`0ab3e990eaff85c92ecc206cce965414ffe7c1b5`.
