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

| Boundary                                              | Result                                                                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production relay deployment                           | Still pinned `if: ${{ false }}`; upstream's manual force-deploy entry point, `--force` flag, and `workflow_dispatch` input not adopted                                                                   |
| Cloud / managed-endpoint recovery                     | Machinery present but unreachable: `hasCloudPublicConfig()` requires `SCIENT_DESKTOP_IDENTITY.cloudEnabled` (default `false`) plus relay and Clerk configuration                                         |
| Outbound telemetry                                    | Fail-closed end to end. `outboundTelemetryEnabled: false`; desktop `buildObservabilityFragment` returns `{}`; `cli/config.ts` forces OTLP URLs to `undefined`; server exporters gate on an undefined URL |
| Linux `.deb` publication                              | Not published. Release artifact allowlist excludes `*.deb`; the marketing download page's `.deb` cards were removed so they cannot advertise a nonexistent artifact                                      |
| Linux `.deb` / AUR packaging                          | AUR recipes are present but unreferenced; no Scient workflow or script publishes them                                                                                                                    |
| Provider lifecycle                                    | `grok update` is manual-only when `managedRuntime.usesManagedPath`; managed binaries never self-update                                                                                                   |
| Cursor Keychain read                                  | Opt-in behind `cursorKeychainUsageEnabled` (decoding default `false`) and `readCursorUsageLimits`'s own `allowKeychain = false` default                                                                  |
| Mobile EAS publication                                | Workflows untouched; production remains `workflow_dispatch` only                                                                                                                                         |
| Signing, tags, npm, hosted web, marketing publication | Scient's rewritten `release.yml` retained; upstream's `publish_cli`, `publish_aur`, `deploy_web`, and `deploy_marketing` not adopted                                                                     |
| State roots and persistence                           | `clientSettingsStorageKey: "scient-next:client-settings:v1"` and the `SCIENT-FORK` seams unchanged (70/70 markers, identical to base)                                                                    |
| Compiled-JavaScript cache                             | Gated on `isDevelopment`, which is strictly stronger than upstream's `isPackaged`: a packaged app launched against a dev server is also treated as development                                           |
| Contributor trust / workflows                         | `upstream` push URL remains `DISABLED`                                                                                                                                                                   |

## Defects found and corrected during review

1. **Upstream latent bug — `hasCloudPublicConfig` used as a bare value.**
   Upstream's new `wantsCliLink` gate read `hasCloudPublicConfig` without
   calling it. The export is a function, so the condition was always truthy and
   the `false` branch was unreachable. Corrected to a call.
2. **Two inherited public-brand strings.** `previewAutomation.ts` and
   `cursorUsageLimits.ts` shipped user-facing "T3 Code" copy that main did not
   contain. Rewritten to Scient product language; `brand:check` now passes
   across 2,248 files.
3. **Duplicate `entry` keys in `knip.jsonc`** produced by composition; the later
   key silently overwrote the earlier one, dropping four declared entry points.
   Merged into one list per workspace.
4. **Missing closing paren** in the composed `ServerSettings` block, caught by
   another agent when the contract failed to parse.

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
2. **Local usage history for three new providers.** This range adds Cursor,
   OpenCode, and Antigravity local-history readers. The macOS Keychain read is
   opt-in, but the on-disk paths are read without an additional Scient-specific
   opt-in. Approve that read surface explicitly or gate it.
3. **`T3CODE_OTLP_SERVICE_NAME` removal.** Upstream removed
   `otlpServiceName` from `ServerConfig`; the environment override no longer
   exists. Confirm this is acceptable, or add a Scient replacement.
