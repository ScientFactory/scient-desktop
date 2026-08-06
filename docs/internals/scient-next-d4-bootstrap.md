# Scient Next D4 bootstrap record

Status: private migration candidate; D4 bootstrap verified locally, draft PR
pending publication. This document is the candidate's first provenance and
safety record. It is not a release record and it does not authorize publishing,
updating, or migrating user data.

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

The candidate repository keeps `origin` as the private ScientFactory-owned
remote and `upstream` as a fetch-only official T3 remote. The upstream push URL
is deliberately set to `DISABLED`. No Synara remote is configured.

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
| Development display name        | `Scient Next Dev`                                                                     |
| Application/bundle ID           | `com.scientfactory.scient.next`                                                       |
| Development app identity        | `com.scientfactory.scient.next.dev` (concurrent deep-link launches are not supported) |
| Production protocol             | `scient-next://`                                                                      |
| Development protocol            | `scient-next-dev://`                                                                  |
| Production user-data directory  | `scient-next`                                                                         |
| Development user-data directory | `<candidate-state>/scient-next-dev/electron-userdata`                                 |
| Linux desktop entry / WM class  | `scient-next`                                                                         |
| Preview partition prefix        | `persist:scient-next-preview-`                                                        |
| Web client persistence key      | `scient-next:client-settings:v1`                                                      |

The identity values have one shared source in
`packages/shared/src/scientNextIdentity.ts`. The early Electron launcher and
the TypeScript runtime intentionally repeat only the values needed before the
bundle can load, with tests guarding the boundary.

The D4 runtime also:

- never probes or adopts T3 or current-Scient legacy user-data directories;
- does not read ambient `T3CODE_HOME` as the desktop identity root;
- uses a candidate-specific home (`~/.scient-next` by default and
  `.scient-next` in a linked development worktree), while retaining
  `T3CODE_HOME` only as an internal server compatibility input set to that same
  candidate path;
- uses `~/.scient-next` as the direct-server fallback and passes the same POSIX
  candidate home into WSL; Windows-side home paths are never forwarded to the
  Linux backend;
- disables PostHog analytics delivery and provider-account identity reads;
- fails closed for desktop and server OTLP destinations, including persisted
  observability settings;
- disables updater configuration, update-feed use, update polling, and build
  publication in the candidate; `resolveBuildOptions` also rejects signed
  artifact requests so D4 cannot consume production signing credentials;
- blocks the server connect handlers while the D4 safety marker is active,
  even if cloud/relay variables are present. The cloud source remains in the
  tree for a later selected-user enablement phase. The server/CLI test harness
  has an explicit opt-in (`SCIENT_NEXT_CLOUD_ENABLED=true`) for protocol tests;
  D4 defaults do not enable it, and browser/web enablement remains a later
  implementation decision;
- keeps the T3 cloud/relay/mobile source and build foundations present, but the
  D4 identity explicitly disables cloud configuration and relay tracing. It
  does not enable a live Scient service endpoint, production credential, cloud
  account, mobile UI, or release feed;
- guards the release, relay-deployment, mobile-publication, and screenshot
  workflow jobs with an explicit false condition. The inherited workflow files
  remain for later deliberate re-enablement; any future T3 merge must audit
  these guards before it can run publication paths;
- mobile source still carries T3's cloud/tracing foundations, but mobile builds
  and publication are outside D4 and explicitly unsupported until a later
  mobile safety review;
- accepts an explicit `SCIENT_NEXT_HOME`/`--home-dir` only as an operator-owned
  isolated override. It is never used to probe legacy data automatically; an
  operator must not point it at `.t3` or the current Scient data root;
- does not add scientific tables, migrations, project data, credentials, or
  user-data conversion. The host database remains the untouched T3 generic
  database boundary for this phase.

The `Scient Next` display label is provisional candidate labeling, not the
final public Scient rebrand. Final branding, legal copy, release identity,
signing, and updater identity remain later cutover decisions.

The marker `SCIENT_NEXT_SAFETY_ENVELOPE=true` is set by the candidate launcher and
desktop backend. It makes the telemetry and updater guards observable and
testable. Local diagnostic log files remain available; outbound delivery does
not.

## Proof 1: candidate verification

The complete workspace run completed on 2026-08-06 at 11:05 Asia/Jerusalem;
focused post-change suites completed at 11:16, and the server-router suite was
recertified at 11:33 after review-lane cleanup, from this worktree (Node
`v24.14.0`, pnpm `11.10.0`):

```text
pnpm run test                pass (207 files; 1871 passed, 7 skipped)
pnpm run typecheck           pass (existing suggestion diagnostics only)
pnpm exec vp fmt --check     pass (2423 files)
pnpm exec vp lint --report-unused-disable-directives  pass
pnpm run build               pass (web, marketing, server, desktop)
pnpm run test:desktop-smoke  pass
server-router focused       pass (120 tests)
git diff --check             pass
```

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

This record belongs to the D4 bootstrap branch. The parent Scient repository remains the authority for migration
policy and cutover decisions; this file records only candidate-local facts and
verification.
