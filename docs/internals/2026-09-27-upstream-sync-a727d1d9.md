# T3 upstream alignment through `a727d1d976`

Date: 2026-09-27

Bounded, history-preserving alignment of the official `pingdotgg/t3code` `main`
branch into Scient's owned `main`. Review and provenance record only. It does not
authorize a release or publication.

## Frozen boundaries and history

- Owned base (first parent): `1ad094bbc3ffc58ad4e171f1e1ea5ce1d859ed5c`
- Previous official integration tip: `95030dc674883f0f2a7fd034b32ce742c8cf55d0`
- Official target (second parent): `a727d1d97690c9bb12cee5760e91cfd1aa7c017d`
- Donor range: **14 official first-parent commits**, 0 merges (linear `main`)
- Merge: `0c33fa4233ad8c2293349803bf2ce50c5f1e876b`
- Branch: `codex/t3-sync-a727d1d9-20260927`
- Alignment PR: [#378](https://github.com/ScientFactory/scient-desktop/pull/378)
- Nearest reachable official tag: `v0.0.43-nightly.20260927.2331`
- `upstream` remains fetch-only; push URL re-verified `DISABLED`
- No owned-main catch-up: the frozen base was already the current `origin/main`

The merge base of `origin/main` and the official target is exactly the recorded
`integrationBase`, so the shared trunk had not diverged. All 14 donor commits
are literal ancestors of the merge; none was squashed, replayed, or omitted.

39 official paths changed; 21 overlapped owned changes; 6 predicted conflicts,
and exactly 6 materialized.

## Owner decisions applied

- `node-pty` stays on `^1.1.0` (PR #372 open item 1). Resolved to `1.1.0`.
- The Cursor Keychain disclosure is a separate documentation change, not part of
  this alignment (PR #372 open item 3).
- Delivery ends at a pull request for review; no merge to `main` and no
  auto-merge.

## Conflict resolutions

| Path                                                     | Classification      | Resolution                                                                                                                                                                                              |
| -------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/usage.ts`                        | composition         | Adopt `ForwardCompatibleArray` for `buckets`/`sources`; keep Scient's `pi` provider kind, the `UsageAccounting*` schemas, and both `USAGE_CONTRACT_VERSION = 6` and `USAGE_MERGE_COMPATIBLE_SINCE = 4`. |
| `apps/web/src/components/usage/UsagePage.tsx`            | composition         | Adopt upstream's `contractMismatches` reporting and `cursorKeychainAccessEnvironments`; keep Scient's `Spend` metric list, `UsageAccountingView`, analytics calls, and topbar layout.                   |
| `apps/web/src/components/ui/scroll-area.tsx`             | composition         | Add upstream's `viewportTabIndex` prop to Scient's `DirectionProvider` structure. `ui/sidebar.tsx` consumes it and merged cleanly.                                                                      |
| `apps/server/src/provider/CodexDeveloperInstructions.ts` | Scient-owned policy | Upstream re-adds the whole `T3_CODE_*` instruction block that Scient replaced with `buildScientAwareness(capabilities)`. Kept the owned mechanism.                                                      |
| `scripts/build-desktop-artifact.ts`                      | obsolete divergence | Upstream edits a `${stem}` WSL-archive block that does not exist here. Kept the owned `resolveWslPrebuildArch` gate; removed the unreachable upstream `ptyCandidates`.                                  |
| `scripts/build-desktop-artifact.test.ts`                 | obsolete divergence | Every upstream test hunk depends on the removed `${stem}` fixture machinery. Kept the owned file.                                                                                                       |

## Usage contract: verified end to end

`ForwardCompatibleArray` replaces `Schema.Array` for `buckets` and `sources`
while the contract version stays at 6. Because `pi` is a Scient-owned
`UsageProviderKind` (PR #333, not present in `upstream/main`), this needed an
end-to-end compatibility check rather than a version-bump judgement.

Verified by direct decode against the composed schema:

- a summary whose `buckets` contain an unknown provider **decodes
  successfully**, so `contractVersion` stays readable and
  `isCompatibleUsageContractVersion` can still exclude and _report_ the
  environment instead of losing the payload;
- only the unknown element is dropped; known buckets survive;
- required fields are still enforced, so this is element tolerance rather than
  blanket acceptance.

Scient's provider-authoritative accounting rides on a different array
(`accounting.sources`, still `Schema.Array`) and is untouched by this change.

`pnpm-lock.yaml` produced no net diff: upstream's transitive churn
(`tough-cookie@6.0.1` removal, `lru-cache` bump) is already reflected in owned
`main`.

## Product-identity composition

Two upstream commits introduce runtime strings naming the upstream product:

- `apps/server/src/usage/cursorUsageReader.ts` (#13870) — inside
  `apps/server`, so it is enforced by `brand:check` and would have failed the
  gate. Now reads "the Mac running Scient".
- `packages/shared/src/otelEnvironment.ts` (#13736) — outside the brand
  product-surface set, but that file keeps the product name in comments only,
  and the warning is surfaced through `DesktopObservability`. Now reads
  "which Scient does not export to".

The two tests asserting those exact strings were updated to match; no assertion
was removed or weakened. `brand:check` passes across 2252 product-surface files.

## Device-tool instructions: intent applied to relocated Scient text

Upstream #13908 relaxes "do not call simctl, adb" to "prefer, and they remain
available". Two of its three files are untouched by Scient and adopted it
verbatim (`apps/server/src/mcp/toolkits/device/handlers.ts`,
`docs/internals/devices.md`). The third edits a constant Scient deleted, so the
same relaxation was applied to Scient's relocated copy in `ScientAwareness.ts`.

Left unaligned, the always-on awareness would have forbidden `simctl`/`adb` while
the `device_open` quick-start text in the same turn told the agent they were
available. This is a judgment call and it does change agent instructions; it is
called out for review.

## Telemetry boundary

`#13736` adds `OTEL_<SIGNAL>_EXPORTER=none`. Unset behaviour is unchanged
(`exporter.value === undefined` falls through to the existing endpoint check),
unknown exporter names are dropped with a warning, and the existing kill switch
still wins outright. Scient's own safety envelope in `DesktopObservability`
(`SCIENT_DESKTOP_IDENTITY.outboundTelemetryEnabled`) is untouched. The change can
only narrow what is exported, never widen it. The three WSL-forwarded variable
names are added to `DesktopBackendConfiguration.ts` and enable nothing.

## Cleanly merged overlaps reviewed

`ChatView.tsx` (#13083) auto-merged with the largest semantic risk in the range:
owned hunks jump from line 2566 to 3263, so the 2705-3215 banner region upstream
edits is untouched on the owned side. The removed `reconnectingThroughVersionSkew`
was a local const with no remaining references, and every other symbol in the
region (`versionMismatch`, `serverUpdateState`, `updateRunning`,
`reconnectWarningGraceElapsed`, `showVersionMismatchBanner`) is still used. The
update flow never depended on the removed "Finishing an update" banner, which
only appeared when no update was running.

`Sidebar.tsx` (#13491) auto-merges: the accessibility additions touch thread,
draft and search rows, and the owned change in the same file is the new-thread
target picker, roughly 190 lines away. The protected `SidebarUpdatePill` seam
renders from `SidebarChrome.tsx`, outside the edited rows, and is unchanged.

The Cursor Keychain default-on decision (`cursorKeychainUsageEnabled` defaulting
to `true`) lives in `packages/contracts/src/settings.ts`, which this range does
not touch, so it is preserved. An explicit opt-out stays off.

## Verification

Run with Node `v24.19.0` and pnpm `11.10.0` on candidate head `0c33fa4233`.

| Check                                                  | Result                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `pnpm exec vp fmt --check`                             | pass                                                                    |
| `pnpm exec vp lint --report-unused-disable-directives` | pass (exit 0; only pre-existing warnings in untouched mobile/web files) |
| `pnpm run typecheck`                                   | pass (exit 0; pre-existing suggestion diagnostics only)                 |
| `pnpm run test`                                        | see below                                                               |
| `pnpm run build`                                       | pass — see note                                                         |
| `pnpm run test:desktop-smoke`                          | pass                                                                    |
| `pnpm brand:check`                                     | pass (2252 files)                                                       |
| `git diff --cached --check`, `git diff --check`        | pass                                                                    |
| `pnpm alignment:seams:check --head HEAD`               | onboarding, skills, analysis, latex all passed                          |
| `node scripts/verify-upstream-provenance.mjs`          | pass                                                                    |

`pnpm run test` is not clean in this environment, and none of the failures are
attributable to this alignment:

- **9 pre-existing web failures** in `authBootstrap.test.ts`,
  `environments/primary/bootstrap.test.ts` and `environments/primary/httpLayer.test.ts`.
  Verified by running the same three files in a throwaway worktree at the owned
  base `1ad094bbc3`: **identical 3 files / 9 tests failed there.** None of these
  files is touched by the range. They resolve environment URLs against a running
  backend, which another agent's candidate occupies on this machine.
- **2 `apps/desktop` snapshot tests** (`HyprlandSnapShot`, `KdeSnapShot`) assert
  file mode `0o755` but observe `0o700`. This shell's umask is `0077`, and
  `0o755 & ~0077 == 0o700`. Re-run under `umask 022` they pass (23 tests), and the
  full desktop package passes 1466 tests.
- `scripts` and `web` were killed with exit 137 (SIGKILL) during the parallel
  full-suite run on this loaded machine; each passes when run on its own
  (`scripts` 496 tests).

`build` note: `apps/desktop`'s build step is `vp pack`, which launches the dev
app and waits for a live dev server, so the full build gate is not runnable
standalone. It was completed through the documented candidate lifecycle
(`pnpm dev:app:start`) for this worktree, which built the bundle as
`Scient (Dev) · scient-t3-sync-a727d1d9.app` in this worktree with its own state
root and ports. The other agent's `scient-fork-redesign` candidate was left
running and untouched.

## Not established here

Visual and interaction acceptance. The isolated candidate for this exact head is
available for it, and the changed user-visible surfaces are: the Usage page
(`Spend` metric plus version-mismatch reporting), sidebar keyboard traversal and
row announcements, an offline environment now reporting "offline" instead of
"Finishing an update", and the Connections status tooltip.

## Follow-ups for the owner

1. **`Spend` is unreachable in the UI.** Pre-existing on `main` from PR #372, not
   introduced or worsened here. `UsagePage.tsx` renders `USAGE_METRIC_OPTIONS`
   (which includes `spend`) but guards both entry points with `isUsageMetric`,
   which is built from upstream's `METRIC_OPTIONS` and so rejects `"spend"`.
   `selectMetric` already handles `"spend"`. Deliberately left unfixed to keep
   this merge reviewable.
2. **`docs/user/usage.md` Cursor disclosure** (PR #372 open item 3) remains open:
   the doc does not state that a token derived from the CLI login is sent to
   Cursor's API.
3. Upstream #13867's wrong-architecture prebuild test is not portable to
   Scient's archive layout. The guarantee is enforced by `resolveWslPrebuildArch`
   and the required-member list, but has no dedicated test in this layout.

## Publication boundary

This record authorizes review only. It does not authorize merging to `main`,
publishing a release, activating cloud or mobile, or changing product policy.
