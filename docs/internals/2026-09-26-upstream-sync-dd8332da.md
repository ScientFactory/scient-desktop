# T3 upstream alignment through `dd8332da`

Date: 2026-09-26

This receipt records a bounded, history-preserving alignment of the official
`pingdotgg/t3code` `main` branch into Scient's owned `main` line. It is a review
and provenance record. It does not authorize a release, publication, or a merge
into owned `main`.

## Frozen boundaries and history

- Owned repository: `ScientFactory/scient-desktop`
- Owned base (first parent): `910f5b4d55c0423f8c4fa23758fcd0919a7e7497`
- Previous official integration tip: `d4a33457cb0da797728f4846a9da8592d7d81d36`
- Official target (second parent): `dd8332da57355bccd7e666289267f2c94597debd`
- Donor range: **69 official commits**
- History-preserving merge: `836fbc899b4e9b05212c1c8eeb1c9de3438bcc31`
- Alignment branch: `codex/t3-sync-dd8332da-20260926`
- Nearest reachable official tag: `v0.0.43-nightly.20260926.2282`; the target is
  15 commits past that tag.
- `upstream` remains fetch-only with push URL `DISABLED`.
- No owned-main catch-up was required: the frozen base was already the current
  `origin/main` tip.

The plan measured 488 changed official paths, 201 overlapping Scient-modified
paths, and 57 predicted textual-conflict paths. Every predicted conflict
materialized; all 57 were resolved. No upstream commit was squashed, replayed,
or omitted, and the exact official target is literal ancestry of the merge.

## Conflict resolution

Conflicts were classified rather than accepted wholesale:

- **Composed both sides (additive):** usage provider kinds, `ServerSettings`
  usage accounting and Cursor keychain opt-in, web usage/settings panels,
  mobile usage providers, knip entry lists, CSS custom properties, Codex
  session runtime, Grok maintenance resolution.
- **Scient-owned policy retained:** `.github/workflows/release.yml`,
  `.github/workflows/deploy-relay.yml`, and the cloud fail-closed guard in
  `apps/server/src/server.ts`.
- **Upstream mechanics adopted:** WAL size limit, managed-endpoint recovery
  plumbing, compiled-JavaScript cache, observability wiring, orchestrator and
  Git-VCS fixes, terminal idle-shell close.
- **Test harnesses:** both sides' cases composed; no coverage was deleted to
  resolve a conflict.

### Notable compositions

- `apps/server/src/persistence/Layers/Sqlite.ts` keeps Scient's bun/node runtime
  loader, retired-thread filesystem cleanup, and `runScientMigrations` ledger,
  and adds upstream's `WAL_SIZE_LIMIT_BYTES` and `journal_size_limit` pragma.
  Upstream added no desktop migration in this range, so no migration renumbering
  was required; `Migrations.ts` and `scient-fork/` are byte-identical to the
  owned base.
- `apps/server/src/server.ts` retains the `hasCloudPublicConfig()` early return
  while composing upstream's ~190 added lines in that file. Upstream had removed
  the guard, which would have run managed-tunnel reconciliation without cloud
  configuration.
- `apps/web/src/components/ChatView.tsx` keeps Scient's nullable `projectId`
  guard; upstream dropped the guard because upstream no longer has
  projectless threads, which Scient retains.
- `apps/web/src/index.css` keeps `--tracking-subtle` and adds `--text-4xs` /
  `--text-5xs`.
- `scripts/build-desktop-artifact.ts` keeps upstream's Linux `deb` build target;
  it is inert in Scient because the release pipeline's artifact allowlist
  excludes it.

## Protected-boundary results

| Boundary                                              | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production relay deployment                           | Still pinned `if: ${{ false }}`; upstream's manual force-deploy entry point, `--force` flag, and `workflow_dispatch` input not adopted                                                                                                                                                                                                                                                                                                                                                                                                          |
| Cloud / managed-endpoint recovery                     | Machinery present but unreachable. `hasCloudPublicConfig()` is satisfied by `SCIENT_DESKTOP_IDENTITY.cloudEnabled` (default `false`) **or** by `SCIENT_NEXT_CLOUD_ENABLED=true`, and then requires relay and Clerk configuration. That env var is a pre-existing, intentional Scient activation lever recorded in `docs/internals/scient-next-d4-bootstrap.md`, not something this range introduced. With the gate false, every cloud HTTP handler is also stubbed to `cloudIntegrationDisabled()`                                              |
| Outbound telemetry                                    | Fail-closed end to end. `outboundTelemetryEnabled: false`; desktop `buildObservabilityFragment` returns `{}`; `cli/config.ts` forces OTLP URLs to `undefined`; server exporters gate on an undefined URL                                                                                                                                                                                                                                                                                                                                        |
| Linux `.deb` publication                              | Not built and not published. The `deb` electron-builder target is **not enabled**: because electron-builder lists every built format in `latest-linux.yml`, and `scripts/verify-scient-release-assets.ts` requires every manifest entry to exist in the published asset set with a matching size and SHA-512, building a `.deb` would make the Linux release attestation fail on a payload the pipeline never publishes. The marketing download page carries no `.deb` card (it never did on the owned base; upstream's addition was not taken) |
| Linux `.deb` / AUR packaging                          | AUR recipes are present but unreferenced; no Scient workflow or script publishes them                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Provider lifecycle                                    | `grok update` is manual-only when `managedRuntime.usesManagedPath`; managed binaries never self-update                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Cursor Keychain read                                  | Opt-in behind `cursorKeychainUsageEnabled` (decoding default `false`) and `readCursorUsageLimits`'s own `allowKeychain = false` default                                                                                                                                                                                                                                                                                                                                                                                                         |
| Mobile EAS publication                                | Workflows untouched; production remains `workflow_dispatch` only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Signing, tags, npm, hosted web, marketing publication | Scient's rewritten `release.yml` retained; upstream's `publish_cli`, `publish_aur`, `deploy_web`, and `deploy_marketing` not adopted                                                                                                                                                                                                                                                                                                                                                                                                            |
| State roots and persistence                           | `clientSettingsStorageKey: "scient-next:client-settings:v1"` and the `SCIENT-FORK` seams unchanged (70/70 markers, identical to base)                                                                                                                                                                                                                                                                                                                                                                                                           |
| Compiled-JavaScript cache                             | Gated on `isDevelopment`, which is strictly stronger than upstream's `isPackaged`: a packaged app launched against a dev server is also treated as development                                                                                                                                                                                                                                                                                                                                                                                  |
| Contributor trust / workflows                         | `upstream` push URL remains `DISABLED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Defects found and corrected during review

1. **API-shape mismatch across the fork — `hasCloudPublicConfig`.**
   Upstream and the merge base define
   `export const hasCloudPublicConfig = Boolean(...)`, a boolean constant, so
   upstream's new `wantsCliLink` gate reading it as a bare value is correct
   upstream code. Scient's own fork had already converted it to
   `export function hasCloudPublicConfig(): boolean` and folded the
   `SCIENT_DESKTOP_IDENTITY.cloudEnabled` kill switch into it. Composing the
   two therefore turned upstream's bare read into an always-truthy function
   reference: the condition could never take its `false` branch, and the
   composed file failed typecheck with TS2774. Corrected to a call. This is an
   adaptation to a Scient API change, not a fix to an upstream defect; the
   initial draft of this receipt recorded it the other way round, and an
   independent review of the merge caught the misattribution.
   Note also that the retained fail-closed early return already parks every
   unconfigured case before that fiber runs, so the inner ternary's `false`
   branch is defensive rather than reachable.
2. **Two inherited public-brand strings.** `previewAutomation.ts` and
   `cursorUsageLimits.ts` shipped user-facing "T3 Code" copy that main did not
   contain. Rewritten to Scient product language; `brand:check` now passes
   across 2,248 files.
3. **Duplicate `entry` keys in `knip.jsonc`** produced by composition; the later
   key silently overwrote the earlier one, dropping four declared entry points.
   Merged into one list per workspace.
4. **Missing closing paren** in the composed `ServerSettings` block, caught by
   another agent when the contract failed to parse.
5. **Linux `.deb` build target would have broken the release attestation.**
   Upstream's `c13f7d93ff` adds `deb` to the electron-builder Linux target
   list, and upstream's own comment states that electron-builder then lists both
   formats in `latest-linux.yml`. `scripts/verify-scient-release-assets.ts`
   requires every entry of that manifest to exist in the published asset set
   with a matching size and SHA-512, while the release pipeline's copy
   allowlist publishes the AppImage only. Building a `.deb` therefore leaves the
   attestation demanding a payload that is never published, and the next
   authorized Linux release would fail closed. The target is not enabled; the
   now-dead `buildConfig.deb` block, its `maintainer`/`synopsis` control-file
   fields, and the fpm-only `XZ_DEFAULTS` environment were removed with it, and
   the artifact test now asserts an AppImage-only target. No release-smoke
   fixture covers a multi-payload Linux manifest, so add one before any future
   change to the target list.
6. **Heap snapshots were written world-readable.** Upstream's new `SIGUSR2`
   handler wrote a full V8 heap snapshot — which the operations guide itself
   says contains tokens, secrets, and thread content — at the process umask,
   into a logs directory that is not `0700`, and outside storage cleanup. The
   write now goes through a `.partial` file that is `chmod 0600` and renamed,
   matching `ServerSecretStore`, and a test asserts the resulting mode.
7. **The operations guide advertised an unreachable capability.** The new
   `docs/operations/observability.md` text documented OTLP export and the
   `OTEL_EXPORTER_OTLP_*` variables without stating that Scient's safety
   envelope disables all outbound export, so an operator would configure a
   collector and see nothing. A banner now states the constraint and names the
   supported artifacts.
8. **Conflict resolution dropped a test-harness injection point.** `server.test.ts`
   conflicts were resolved by keeping Scient's layer chain wholesale, which
   silently discarded upstream's `options.layers.httpClient` override. Four
   cloud-seam tests inject a stub client so they never reach the network; with
   the override ignored they used the real `FetchHttpClient` and failed. Two of
   those four exist on the owned base and pass there, so this was a genuine
   regression that the local run could not reveal, because the same tests are
   blocked locally by the missing Clerk fixtures on both the base and the
   branch. It was caught by hosted CI, and the conditional provide has been
   restored. The general lesson is recorded here deliberately: a Git conflict
   hunk can be much smaller than the region a `--ours`-style resolution
   discards, and a clean local run is not evidence that a cloud-seam test still
   works.

## Verification

Run on the merge commit, in the repository's declared Node and pnpm, with
`VITE_HTTP_URL` and `VITE_WS_URL` unset and a normal umask, as `AGENTS.md`
requires:

- `pnpm exec vp fmt --check` — **passed**
- `pnpm exec vp lint --report-unused-disable-directives` — **passed**, advisory
  React compiler / effect suggestions only
- `pnpm run typecheck` — **passed**, 0 errors
- `pnpm run test` — server 541 files passed / 22 skipped with 3 files failing;
  web 758 passed; desktop 117 passed / 4 skipped; all other suites passed
- `pnpm run build` — **passed**
- `pnpm run test:desktop-smoke` — **passed**
- `pnpm brand:check` — **passed** across 2,248 product-surface files
- `pnpm knip:check` — **passed**
- `pnpm upstream:provenance:check` — **passed** at `integrationBase d4a33457`
  before this record advanced it
- `pnpm alignment:seams:check --base 910f5b4d55 --upstream-ref dd8332da --head HEAD`
  — onboarding, skills, analysis, and latex seams all **passed**
- `git diff --check` and `git diff --cached --check` — **clean**
- `pnpm-lock.yaml` regenerated from the composed sources with
  `pnpm install --lockfile-only`; no generated conflict block was hand-edited

### The three failing server test files

`apps/server/src/bin.test.ts` (10), `apps/server/src/cli/pair.test.ts` (1), and
`apps/server/src/server.test.ts` (24) fail because they need external Clerk and
cloud fixtures that are not available locally. This was verified rather than
assumed: a clean worktree at the owned base was built and the same three files
were run there under identical conditions, producing the same failures. The
three additional `server.test.ts` failures are **new upstream tests** (absent
from the base) inside the same environmentally-blocked cloud/relay group, and
they fail with the same signature as their neighbours. No test that passes on
the base fails here. Hosted CI remains the authority for this group.

Two further `server.test.ts` tests failed once under parallel load and pass in
isolation and on a clean re-run; they are load-sensitive, not regressions.

## Not claimed

No live-provider, mobile-device, release-signing, publication, or manual
production-cloud test was performed. User-facing desktop behavior has not had
proportional visual and interaction acceptance; automated checks do not
establish it. Two desktop snapshot tests are umask-sensitive and require a
normal umask to pass, which is an environment property, not a code property.

## Publication boundary

This branch is a review candidate only. It must not be merged, promoted,
released, or published without separate explicit authorization. The alignment
opens no mobile EAS, hosted web, cloud deployment, relay deployment, signing,
release, or npm publication authority.

## Open items for the owner

1. **Pre-existing broken reusable-workflow reference.** `main` does not contain
   `.github/workflows/release-desktop.yml`, but
   `.github/workflows/desktop-macos-preview-publish.yml:287` still calls it. The
   deletion dates from the previous alignment (`b55129b948`), not this one. The
   macOS preview publish path is therefore broken on `main`. Restoring the
   upstream workflow would also restore the upstream packaging path this
   repository deliberately replaced, so this needs an explicit release decision.
2. **Local usage history for three new providers, and an opt-in asymmetry.**
   This range adds Cursor, OpenCode, and Antigravity local-history readers. The
   `cursorKeychainUsageEnabled` opt-in is **macOS-only**: the gate sits inside a
   `platform === "darwin"` condition, so on Linux and Windows the Cursor CLI
   `auth.json` is read unconditionally and the derived access token is sent to
   `cursor.com/api/dashboard/get-filtered-usage-events`, with no Scient opt-in
   and no UI control. The same asymmetry exists on the limits path in
   `cursorUsageLimits.ts`. `docs/user/usage.md` describes the macOS toggle in
   language that reads as though it governs Cursor credential use generally.
   Triggers are user-initiated (only the `serverGetUsageSummary` RPC starts a
   scan; no background scan exists), which bounds the exposure. Decide whether
   to extend the opt-in to all platforms or to state the asymmetry plainly.
3. **`T3CODE_OTLP_SERVICE_NAME` removal.** Upstream removed
   `otlpServiceName` from `ServerConfig`; the environment override no longer
   exists. Confirm this is acceptable, or add a Scient replacement.
4. **External (non-managed) Grok installs can now self-update.** Upstream's
   one-click `grok update` is adopted, but gated to `makeManualOnlyProviderMaintenanceCapabilities`
   whenever `managedRuntime.usesManagedPath` is true, so a Scient-managed binary
   never updates outside the managed-runtime lifecycle. An external install
   now gains a user-triggered self-update where the base was manual-only. This
   matches the existing Codex and Cursor policy for external installs, so it is
   recorded as a deliberate behavior change rather than a defect, but it is the
   one provider-lifecycle behavior this alignment widens.
5. **No release-smoke coverage for a multi-payload Linux manifest.** The
   attestation failure in defect 5 would not be caught by any existing gate,
   because the captured fixture and the release smoke test both carry an
   AppImage-only `latest-linux.yml`. Add a case with a second Linux payload so
   any future divergence between the electron-builder target list and the
   release copy allowlist fails fast.
6. **Pre-existing, outside this range:** `.github/workflows/mobile-eas-production.yml`
   lines 8-26 describe merge-driven store builds and OTA publication, while the
   trigger is `workflow_dispatch` only and the job is pinned `if: false`. The
   header could mislead a future owner into removing that guard. Reported, not
   changed, because the file is not part of this alignment.

## Independent review

The composed merge was reviewed independently after the fact, in two passes: a
correctness review of the merge composition, and a protected-boundary,
privacy, and supply-chain audit against the composed diff.

The correctness pass found no merge-composition defect in `server.ts`, the
Sqlite setup ordering, the two orchestration reactors, the three provider
drivers, or the composed contracts. It confirmed that both branches of the
retained cloud guard complete the `cloudLinkParked` deferred so nothing can
park forever, that the Sqlite setup order is intact (pragmas, `runMigrations`,
`runScientMigrations`, then retired-thread cleanup), and that every
`Record<UsageProviderKind>` consumer covers all seven kinds. It caught the
misattribution now recorded and corrected in defect 1, and surfaced open item 4.

The boundary audit passed all nine protected areas — relay and cloud
deployment, recovery reachability, telemetry, credentials, provider update
authority, release and publication authority, mobile publication, supply chain,
and the new native dependency — and found no path that could activate a
capability this alignment was meant to hold. It raised three real defects that
are now fixed and recorded above: the Linux `.deb` target that would have
failed the release attestation (defect 5), the world-readable heap snapshot
(defect 6), and the operations guide advertising an unreachable OTLP export
(defect 7). It also corrected two inaccurate rows in this receipt's boundary
table, added open items 5 and 6, and noted that the pre-existing
`SCIENT_NEXT_CLOUD_ENABLED` environment variable is a cloud activation lever
that a reviewer should know about.
