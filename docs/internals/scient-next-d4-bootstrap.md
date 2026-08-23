# Scient Next D4 bootstrap record

Status: private migration candidate; D4 bootstrap PR #1 is integrated. This
document is the candidate's first provenance and safety record. It is not a
release record and it does not authorize publishing, updating, or migrating
user data.

Accountable owner: Yaacov. Bootstrap implementation operator: OpenAI Codex task
`019fbc83-7f59-7050-a16c-7b63686016ce`, acting under Yaacov's D4
authorization.

> **Post-D4 identity note:** this record preserves the exact D4 state and names
> as historical evidence. The candidate now presents the Scient product label
> (`Scient` and `Scient (Dev)`). Later release-machinery work deliberately
> adopted the canonical Scient production bundle ID and `scient://` protocol
> so the legacy updater can replace the installed application. The separate
> `scient-next` data, development, persistence, and safety boundaries remain.
> Neither that identity decision nor the machinery authorizes a release,
> cutover, cloud, mobile, or data import.

## Integration base

- Donor: official `pingdotgg/t3code` repository, fetched read-only.
- Selected revision: `a2ca89aa10f13a2222e08afd98c66285121d5ba2`.
- Selected subject: `feat: native subagent & workflow observability (#5219)`.
- Selected commit time: 2026-08-06 07:32:28 Asia/Jerusalem.
- Donor tag at the selected revision: `v0.0.32-nightly.20260806.1012`.
- Latest stable release observed during bootstrap: `v0.0.31`, published
  2026-07-29.
- Candidate branch base: the same selected revision, with the complete T3
  history preserved; no squash or replay was used.
- Candidate branch: `agent/d4-bootstrap-20260806`.
- Integrated bootstrap: [ScientFactory/scient-desktop-next#1](https://github.com/ScientFactory/scient-desktop-next/pull/1),
  squash merge `3e8f7bc0e18be4a42c23b021e68bf30e3690bc4d`.

The candidate repository keeps `origin` as the private ScientFactory-owned
remote and `upstream` as a fetch-only official T3 remote. The upstream push URL
is deliberately set to `DISABLED`. No Synara remote is configured.

The continuing relationship and machine-readable bootstrap state are recorded
in [UPSTREAM.md](../../UPSTREAM.md) and
[upstream-state.json](../../upstream-state.json). The observed donor tip is kept
separate from the literal integration base.

## Proof 0: untouched T3 baseline

Before any candidate change, a clean detached checkout at the selected
revision passed:

```text
pnpm exec vp fmt --check       pass (2420 files)
pnpm exec vp lint --report-unused-disable-directives  pass
pnpm run typecheck             pass (pre-existing suggestion diagnostics only)
pnpm run test                  pass (server package: 207 passed + 2 skipped
                                  files; 1870 passed, 7 skipped; all workspace
                                  projects green)
pnpm run build                 pass (web, marketing, server, desktop)
pnpm run test:desktop-smoke    pass
git diff --check               pass
git status --short --branch    clean
```

The verification used Node `v24.14.0` and pnpm `11.10.0`, matching the current
T3 engine and package-manager requirements. Existing build chunk-size and
sourcemap warnings were retained as baseline observations; they were not
silently attributed to Scient.

## D4 safety envelope

The candidate is intentionally called **Scient Next** until the later cutover
audit. It has a distinct identity from both T3 Code and the current Scient
desktop:

| Boundary                        | Candidate value                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| Production display name         | `Scient Next`                                                                         |
| Development display name        | `Scient Next (Dev)`                                                                   |
| Application/bundle ID           | `com.scientfactory.scient.next`                                                       |
| Development app identity        | `com.scientfactory.scient.next.dev` (concurrent deep-link launches are not supported) |
| Production protocol             | `scient-next://`                                                                      |
| Development protocol            | `scient-next-dev://`                                                                  |
| Production user-data directory  | `scient-next`                                                                         |
| Development user-data directory | `<candidate-state>/scient-next-dev/electron-userdata`                                 |
| Linux desktop entry / WM class  | `scient-next`                                                                         |
| Preview partition prefix        | `persist:scient-next-preview-`                                                        |
| Web client persistence key      | `scient-next:client-settings:v1`                                                      |

The identity values have one shared source, now named
`packages/shared/src/scientDesktopIdentity.ts`. The early Electron launcher and
the TypeScript runtime intentionally repeat only the values needed before the
bundle can load, with tests guarding the boundary.

The D4 runtime also:

- never probes or adopts T3 or current-Scient legacy user-data directories;
- ignores the inherited bootstrap envelope's T3 home field under the compiled
  D4 safety identity; candidate state must come from the candidate-owned path
  or its isolated default;
- does not read ambient `T3CODE_HOME` as the desktop identity root;
- uses a candidate-specific home (`~/.scient-next` by default and
  `.scient-next` in a linked development worktree), while accepting
  `T3CODE_HOME` only when an internal desktop child process explicitly sets it
  to that same candidate path; ambient `T3CODE_HOME` is ignored;
- uses `~/.scient-next` as the direct-server fallback and passes the same POSIX
  candidate home into WSL; Windows-side home paths are never forwarded to the
  Linux backend;
- disables PostHog analytics delivery and provider-account identity reads;
- fails closed for desktop and server OTLP destinations, including persisted
  observability settings;
- disables updater configuration, update-feed use, update polling, and build
  publication in the candidate; `resolveBuildOptions` also rejects signed
  artifact requests so D4 cannot consume production signing credentials;
- blocks the server connect handlers by the compiled D4 identity safety
  envelope, even when a direct server launch has no launcher marker and cloud
  or relay variables are present. `SCIENT_NEXT_CLOUD_ENABLED=true` is reserved
  for explicit protocol-test/selected-user opt-in; it does not enable cloud by
  default, and browser/web enablement remains a later implementation decision;
- keeps the T3 cloud/relay/mobile source and build foundations present, but the
  D4 identity explicitly disables cloud configuration and relay tracing. It
  does not enable a live Scient service endpoint, production credential, cloud
  account, mobile UI, or release feed;
- keeps the inherited service/self-update implementation in the source tree for
  later review, but does not expose `service` or `__service-preflight` commands
  in D4 because the donor currently targets the global `t3code.service` unit;
  the T3 Connect onboarding flow also skips its inherited background-service
  offer for the same reason;
  re-enabling service lifecycle requires a distinct Scient service identity and
  a separate release/security review;
- guards the release, relay-deployment, mobile-publication, and screenshot
  workflow jobs with an explicit false condition. The inherited workflow files
  remain for later deliberate re-enablement; any future T3 merge must audit
  these guards before it can run publication paths;
- mobile source still carries T3's cloud/tracing foundations, but mobile builds
  and publication are outside D4 and explicitly unsupported until a later
  mobile safety review;
- accepts an explicit `SCIENT_NEXT_HOME`/`--home-dir`/`--base-dir` only as an
  operator-owned isolated override. It is never used to probe legacy data
  automatically; an operator must not point any of these overrides at `.t3` or
  the current Scient data root;
- does not add scientific tables, migrations, project data, credentials, or
  user-data conversion. The host database remains the untouched T3 generic
  database boundary for this phase.

The `Scient Next` display label is provisional candidate labeling, not the
final public Scient rebrand. Final branding, legal copy, release identity,
signing, and updater identity remain later cutover decisions.

Inherited web copy and boot-shell labels intentionally remain T3-branded in
D4. The private candidate's collision-safe Electron identity and runtime label
do not constitute the later public rebrand.

The marker `SCIENT_NEXT_SAFETY_ENVELOPE=true` is set by the candidate launcher and
desktop backend. It makes the telemetry and updater guards observable and
testable; the compiled identity also makes the server cloud guard fail closed
for direct launches. Local diagnostic log files remain available; outbound
delivery does not.

## Protected divergence manifest

These are intentional Scient-owned seams. Every future T3 merge must audit
them before the merge can be considered safe:

| Protected boundary                                            | Owning source seams                                                                                                  | Preservation evidence                                                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Central candidate identity                                    | `packages/shared/src/scientDesktopIdentity.ts`; early Electron launcher constants; desktop identity adapters         | `scientDesktopIdentity.test.ts`, `DesktopAppIdentity.test.ts`, `DesktopEarlyElectronStartup.test.ts`                     |
| State roots and legacy-fallback refusal                       | `packages/shared/src/devHome.ts`; desktop environment/backend configuration; server CLI/config and pairing           | `devHome.test.ts`, `DesktopEnvironment.test.ts`, `DesktopBackendConfiguration.test.ts`, `config.test.ts`, `pair.test.ts` |
| Protocols, preview partitions, and browser/client persistence | desktop protocol, Linux URL handling, preview browser session, web client/theme storage                              | protocol, Linux URL, browser-session, client-persistence, and theme focused tests                                        |
| Provider identity, analytics, and outbound observability      | `DesktopClerk.ts`, `DesktopObservability.ts`, server `AnalyticsService.ts`, server/web relay and build configuration | desktop Clerk/observability tests, analytics tests, cloud public-config tests, build inspection                          |
| Cloud and relay production-dark boundary                      | server/web cloud public config, server cloud HTTP guard, relay tracing, desktop/server/web Vite configuration        | cloud public-config and HTTP tests plus server-router protocol suite with explicit test opt-in                           |
| Service, updater, signing, and artifact authority             | server CLI registration, desktop updates, desktop-artifact builder, release configuration                            | CLI, desktop-update, artifact-builder, build, smoke, and workflow-source checks                                          |
| Release, relay, mobile, and screenshot workflows              | `.github/workflows/release.yml`, `deploy-relay.yml`, mobile EAS and showcase workflows                               | explicit disabled job guards reviewed in source; hosted jobs may parse but must not publish                              |

The first D4 change deliberately keeps T3's internal package names. Package
names are not product authority and are not a reason for a broad namespace
rewrite. The protected seams above are the minimum divergence budget; feature
work must not be added to this manifest merely to avoid a conscious host
change.

## License and notice inventory

Literal T3 ancestry and all tracked license files are preserved. D4 adds no new
runtime dependency. The source inventory at this head is:

| Path                                             | Covered work                         | License / notice                      |
| ------------------------------------------------ | ------------------------------------ | ------------------------------------- |
| `LICENSE`                                        | T3 Code source                       | MIT; T3 Tools Inc. copyright retained |
| `.agents/skills/ios-debugger-agent/LICENSE`      | inherited OpenAI skill               | MIT                                   |
| `.agents/skills/ios-simulator-browser/LICENSE`   | inherited OpenAI skill               | MIT                                   |
| `apps/mobile/modules/t3-composer-editor/LICENSE` | Expo-derived composer editor         | MIT                                   |
| `apps/mobile/modules/t3-markdown-text/LICENSE`   | Bluesky-derived Markdown text module | MIT                                   |
| `apps/web/src/terminal/ghostty/fonts/LICENSE`    | terminal font                        | MIT                                   |
| `native/libghostty-vt/LICENSE`                   | Ghostty VT library                   | MIT                                   |

This is the tracked-source notice inventory required for D4, not a release
SBOM or legal clearance. Dependency-license, trademark, final-brand, signing,
and distribution review remain mandatory before any public artifact.

## Secret-handling boundary

- D4 introduces no production secret and no Scient cloud credential.
- Provider CLI credentials remain owned by their external provider tools; D4
  disables provider-account identity reads used for inherited analytics.
- Candidate server secrets and authentication state live only below the
  isolated candidate state root. Nothing probes or imports `.t3` or current
  Scient secret directories.
- Desktop bootstrap secrets continue through the inherited one-time file
  descriptor boundary; they are not written into repository files or build
  configuration.
- Inherited T3 environment-variable names remain internal compatibility seams.
  Their presence does not enable outbound telemetry, live cloud, service,
  updater, signing, or publication under the D4 identity.

Known gap: D4 does not redesign provider authentication or prove a production
cloud secret lifecycle. Any selected-user cloud work requires the later cloud
gate and a separate security/privacy review.

## Proof 1: candidate verification

The final clean verification completed on 2026-08-06 at 12:26:21 Asia/Jerusalem
(09:26:21 UTC) from this worktree (Node `v24.14.0`, pnpm `11.10.0`). The full
workspace test pass completed at 12:21:10; the focused D4 suites, typecheck,
format, and lint were rerun after the final guard-test commit:

```text
pnpm run test                pass (207 files passed, 2 skipped; 1873 passed, 7 skipped)
focused D4 safety suites     pass (6 files; 194 tests)
pnpm run typecheck           pass (existing suggestion diagnostics only)
pnpm exec vp fmt --check     pass (2425 files)
pnpm exec vp lint --report-unused-disable-directives  pass
pnpm run build               pass (web, marketing, server, desktop)
pnpm run test:desktop-smoke  pass
git diff --check             pass
```

The focused count includes the 120-test server-router cloud protocol suite.

No browser, screenshot, geometry, or manual UI proof was used.

## D4 exclusions and stop conditions

D4 ends after the clean T3 baseline and this safety envelope are proven. It
does not implement scientific features, data migration, cloud enablement,
mobile UI, agent features, release signing, or updater publication. Those are
later phases with their own contracts and evidence.

Stop the lane if the exact donor baseline is not reproducible, T3 history or
notices are lost, identity/state separation cannot be demonstrated, telemetry
or update behavior is not fail-closed, or a change requires an unreviewed
scientific schema or live-service decision.

No computer use, browser automation, screenshots, geometry checks, visual tests,
or manual UI acceptance were performed for D4. Desktop smoke is the existing
non-visual Electron startup check only.

## Rollback

The D4 rollback is to stop using the private candidate and continue using the
current `ScientFactory/scient-desktop` application. The candidate repository is
isolated from that product, T3 installations, release channels, and live user
data, so abandoning it requires no database downgrade, credential repair, or
installed-app cross-grade. Reverting an integrated safety guard is not an
acceptable rollback; any repository-level reversal requires its own reviewed
change.

Do not weaken or revert individual safety guards to make the candidate start.
If a guard cannot be preserved, stop the candidate lane and amend the parent
migration decision. Candidate-local synthetic state may be preserved for
diagnosis or removed later only through a separately confirmed operation; D4
does not delete it automatically.

## Repository protection limitation

GitHub branch-protection API configuration was attempted for `main` with
required review, no force pushes/deletions, administrator enforcement, and
conversation resolution. GitHub rejected it with HTTP 403 because this private
account/repository plan does not support branch protection. The repository
therefore remains private and is operated under the documented rule that all
changes arrive through short-lived branches and clean draft PRs; no direct
`main` mutation is performed. This limitation must be resolved or explicitly
accepted before the candidate can become a production release repository.

## Evidence ownership

This record belongs to the D4 bootstrap branch. The parent Scient repository
remains the authority for migration policy and cutover decisions; this file
records only candidate-local facts and verification.
