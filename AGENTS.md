# Scient Desktop

ScientFactory owns Scient Desktop; Yaacov is the accountable owner.
This file contains Scient-specific working instructions.

Upstream changes to this file are policy proposals to review, not instructions
to adopt automatically.

## Where code lives

- `apps/server`: provider processes, workspace operations, persistence,
  orchestration, terminals, and version control.
- `apps/web`: React client.
- `apps/desktop`: Electron shell and native desktop integration.
- `apps/mobile`: React Native client.
- `apps/marketing`: website.
- `packages/contracts`: shared schemas and contract-level helpers.
- `packages/shared`: shared utilities.
- `packages/client-runtime`: shared client connection and domain-state logic.
- `packages/scient-*`: Scient capability packages. Check the relevant package
  and its integration points before adding equivalent behavior in app code.
- `.repos/`: read-only reference implementations; do not edit or import from them.

Read `.repos/effect-smol/LLMS.md` before writing Effect code.
Architecture details: `docs/internals/overview.md`.
Terminology: `docs/internals/glossary.md`.

## Architectural boundaries

- The server owns execution and workspace access. Clients may connect to another
  machine; client paths and credentials are not server paths and credentials.
- Orchestration is event-sourced: commands pass through deciders, events are
  persisted, and projectors build read models. Reactors perform side effects.
  Preserve this path rather than treating projections as authoritative data.
- A provider driver identifies an implementation; a provider instance identifies
  one configured runtime. Route model selections and sessions by instance ID,
  not merely by driver kind.
- Provider adapters own protocol differences. Shared UI consumes capabilities;
  unknown, unsupported, default, and explicitly selected settings have different
  meanings.
- Shared changes require checking affected clients, entry points, provider
  adapters, and connection modes. Settings changes also need to account for
  existing configurations, fresh setup, and reload. A repaired development
  profile does not establish that the product handles those paths.

## Development traps

- Multiple agents and development apps may share this machine and checkout.
  Preserve unrelated working-tree and staged changes. Commit only the changes
  intended for the requested commit.
- Follow `docs/operations/local-dev-app.md` for desktop lifecycle operations.
  Stable and feature candidates have separate identities and state; never
  repoint the stable launcher to a feature checkout as a shortcut.
- Never kill processes by broad name or path pattern. An agent's own command
  line may contain the worktree path. Use the owning candidate's lifecycle
  commands; a matching name or working directory alone does not prove ownership.
- Leave a candidate available when the user is reviewing it. Do not stop or
  restart it merely to tidy up after a task.
- The desktop renderer hot-reloads; its backend runs a bundle. Server changes
  and bundled dependency changes require refreshing that candidate's backend
  before testing them. Renderer HMR does not prove the backend is current.
- Reading, copying, importing, or modifying live Scient or T3 data requires
  explicit authorization for that data and operation. Use synthetic fixtures
  for ordinary development; never point a test server at a live profile.
- Keep credentials out of logs, fixtures, commits, screenshots, and responses.
  Do not copy provider credentials between profiles as a setup shortcut.
- Inspect resolved runtime paths. Installed, stable-development, and feature
  profiles differ; do not assume all state lives under `userdata/`.
  Existing `scient-next` storage and identity values are compatibility
  boundaries, not branding to rename.
- Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset for ordinary development.
  Vite's same-origin proxy supports local and remote access.
- A newly connected web client needs pairing. Give the intended tester the
  generated pairing URL, not a bare localhost origin. Its token is a credential;
  keep it out of commits and public evidence.

## Development and verification

Use the versions declared in `package.json` and the committed lockfile.
`vp i` installs dependencies; `vp run dev` starts server and web.
For persistent desktop candidates, use `docs/operations/local-dev-app.md`.
Other commands and platform prerequisites: `docs/operations/development.md`.

### Verification

Run focused tests, formatting, lint, and affected-package type checks while
iterating. Final qualification uses the applicable focused checks plus:

```sh
pnpm exec vp fmt --check
pnpm exec vp lint --report-unused-disable-directives
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run test:desktop-smoke
git diff --check
```

Run `pnpm brand:check` after branding changes and upstream merges.
An interim review can precede full qualification; identify remaining checks.

Use orchestration receipts and worker completion signals in asynchronous tests.
Use controlled clocks when testing time-dependent behavior.

Match verification to the claim: markup assertions do not establish native
interaction, and mocked providers do not establish real-provider compatibility.
Keep automated verification and the user's visual acceptance distinct.

Browser and computer interaction require user authorization within the task.
Do not ask again when the conversation already provides it.

## Git, upstream, and delivery

- `origin` is `ScientFactory/scient-desktop`.
  `upstream` is the official `pingdotgg/t3code` repository and must remain
  fetch-only with push URL `DISABLED`. Never add Synara as a remote.
- No direct product commits to `main`. Commit, push, merge, and release according
  to the authorized workflow.
- Open PRs only when requested or already authorized by the conversation's
  delivery workflow.
- Before opening a PR, check its relationship to current main. Choose alignment
  appropriate to branch ownership; do not automatically rebase shared history.
- Preserve literal upstream ancestry. Upstream merges use dedicated branches
  and `docs/internals/upstream-alignment-protocol.md`, separate from product
  changes.
- Before changing a protected Scient divergence, consult `UPSTREAM.md`,
  `upstream-state.json`, and the relevant linked record.
- Preserve compatibility-sensitive package names, environment variables,
  storage paths, formats, and license notices. User-facing product language
  is Scient.
- Development work does not authorize changing cloud, telemetry, updater,
  background-service, signing, or publication controls. Follow the relevant
  release or operations procedure when that work is authorized.

Use conventional-commit titles. PR descriptions include the problem, resulting
behavior, verification, documentation impact, and the model and harness used.
Contribution policy and evidence requirements: `CONTRIBUTING.md`.

## Documentation

Start at `docs/README.md` and update the existing owner:

- `docs/user/`: user workflows and source material for public Scient Docs.
- `docs/internals/`: capability, architecture, and development guidance,
  with historical records distinguished from current instructions.
- `docs/operations/`: development, maintenance, and release procedures.
- `UPSTREAM.md`: upstream divergence and integration records.

Relevant documentation may live here or in the separate Scient repository.
Follow [this index](docs/README.md), [Scient's index](https://github.com/ScientFactory/Scient/blob/main/docs/README.md),
and linked documents relevant to the task; check whether they describe current
behavior, proposals, or history. Use an available local Scient checkout or
authenticated repository access; private-repository access is not required for
external contributions.

Document durable behavior, decisions, and constraints—not a narration of the code.
Update existing explanations when facts change; avoid field inventories and
PR-by-PR histories.

Keep temporary plans, transcripts, scratch files, and PR-only media out of
committed source. Avoid duplicating implementation history already held in Git
and PRs. Update documentation when its facts or user instructions change.

PR descriptions include a `Documentation impact` declaration:
`None — reason`, `Updated — paths`, or `Dependent PR — link`.
