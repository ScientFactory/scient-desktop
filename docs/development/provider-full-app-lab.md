# Provider full-app lab

Status: preserved development experiment. This is not product or release
behavior, and this branch is not a current-main integration candidate.

This lab runs the normal Scient application while replacing only the web client's provider status stream and provider-lifecycle actions with synthetic state. Projects, drafts, Settings, the composer, and the model picker remain the real application surfaces. The lab never inspects provider homes, credentials, PATH, or the stable Scient app, and its lifecycle controller never runs a real installation or sign-in action.

## Authority and checkout

- Branch: `experiment/provider-full-app-lab-refreshed-20260809`
- Provider implementation base: `fc63f10e40a3bacd80b2a529551de2bf0dcb2d47`

The branch is a reproducible collaboration and preservation checkpoint. It
contains an older snapshot of production provider UI plus later synthetic
Codex and Claude scenarios. It must not be merged or described as current
product behavior without first rebuilding the lab boundary from current
`origin/main` and reconciling every production-component difference.

Use an isolated worktree rather than changing an existing checkout:

```sh
git fetch origin
git worktree add ../scient-desktop-next-ux-lab \
  origin/experiment/provider-full-app-lab-refreshed-20260809
cd ../scient-desktop-next-ux-lab
```

## Run in isolation

Use a free port offset and a lab-specific home directory. Do not reuse or stop the stable development app.

```sh
VITE_SCIENT_PROVIDER_LAB=1 \
T3CODE_PORT_OFFSET=531 \
pnpm run dev --home-dir "$PWD/.scient-next/provider-full-app-lab"
```

With offset `531`, the web app is `http://localhost:6264` and its isolated server is `127.0.0.1:14304`. Pair only with the one-time token printed by this server. Never copy a token into documentation or chat.

The floating **Provider simulation** control changes the simulated computer, jumps to a provider state, injects the next failure, or resets the lab. Install and sign-in operations advance automatically so the primary flow can be tried like a real product flow; **Advance** remains available for explicitly loaded in-progress states. Reset and cancellation clear scheduled synthetic work so an old operation cannot change a newly selected state.

Codex and Claude are synthesized. Cursor, Grok, OpenCode, and other providers
remain visible only through the inherited product surfaces; the lab does not
invent assisted lifecycle behavior for them. The lab imports the captured
provider UI and replaces only provider snapshots and lifecycle actions at the
application boundary, so the simulation does not need a second visual
implementation.

## Fresh-provider visual experiment

When the simulated computer has no ready provider, the composer renders the Scient-owned **Choose your AI** onboarding picker. Its default state does not prefer Codex or repeat the provider catalog in the main pane: the provider rail is the chooser, while the main pane gives one short instruction. Searching can surface matching provider rows, and selecting a provider opens its focused setup state. Codex continues into the synthetic assisted lifecycle; providers without an implemented assisted lifecycle route to the real provider settings surface rather than pretending that an automated flow exists.

## Codex lifecycle experiment

The Codex path stays inside the picker instead of opening a second confirmation dialog:

1. **Install Codex** is the user's consent to start a private, verified installation. The backend may still plan and validate the operation, but the user is not asked to confirm the same intent twice.
2. The same compact surface reports preparing, downloading, verifying, installing, testing, and activation progress. Cancellation is available and leaves the simulated computer unchanged.
3. After installation, **Sign in to Codex** starts the provider-owned browser flow. Scient never asks for or stores the provider password, and the sign-in page can be reopened while the flow is active.
4. Scient verifies the account and available models. When the provider becomes ready, the composer returns to the normal inherited model picker with the discovered Codex model selected.
5. Installation and sign-in failures remain in the same surface with a focused retry action. Repair, removal, and advanced troubleshooting remain outside this compact first-run flow.

This is a visual and interaction prototype backed by synthetic lifecycle state. It performs no real download, installation, browser authorization, credential access, or provider request. Managed updates follow the same reviewed `plan -> start -> verify -> activate` action shape as production; the simulator advances those states without touching a runtime.

## Preserved change inventory

The preservation checkpoint contains four deliberately distinct groups:

1. **Reusable simulator infrastructure** - the environment gate, synthetic
   provider snapshots, deterministic transitions, controller substitution,
   scenario controls, and their focused tests.
2. **Captured provider experience** - Codex and Claude inline setup surfaces,
   lifecycle presentation, model-picker setup selection, and the associated
   contracts and action helpers as they existed in this experiment.
3. **Regression coverage** - focused tests for provider switching, retained
   ready providers, authorization-code fallback, updates, failures, and model
   picker availability.
4. **Historical design QA** - `design-qa.md`, which records the exact source
   snapshot and manual states inspected on 2026-08-09. It is evidence about
   that snapshot only, not current acceptance evidence.

No screenshots, credentials, provider homes, installed runtimes, databases,
or generated local state belong in the preserved branch.

## Maintained Scient UX Lab direction

The reusable successor should be rebuilt from current `origin/main` and remain
inside this repository. A separate repository would duplicate production
components and drift from the app it is meant to simulate.

The smallest maintainable boundary is:

```text
apps/web/src/scient/uxLab/
├── ProviderLabHost.tsx
├── providerScenarios.ts
├── providerScenarios.test.ts
└── ProviderLabControls.tsx
```

Production components should receive only narrow, provider-neutral seams where
the lab needs to inject synthetic snapshots or actions. All simulation state,
scenario transitions, controls, fixtures, and explanatory copy stay under the
development-only `scient/uxLab` boundary. Normal and release builds keep the
lab disabled; enabling it requires the explicit `VITE_SCIENT_UX_LAB=1` flag
and an isolated home directory.

The maintained lab should initially prove provider onboarding across macOS,
Windows, and Linux, including fresh, installing, signing in, ready, updating,
failed, cancelled, repair, and removal states. Additional Scient journeys may
be added only when they reuse real product components and synthetic state at a
similarly narrow boundary.
