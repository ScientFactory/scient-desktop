# Scient getting started

Scient's first-run onboarding is a short, skippable route-level flow. It is a presentation and
navigation layer over existing product capabilities, not a second provider, project, account, or
compute system.

## Product contract

The automatic flow has at most three steps:

1. **Choose an AI** appears only when no provider instance is canonically ready. It reuses the
   provider registry, readiness projection, permissions, and lifecycle setup surfaces.
2. **Preferences** stores optional local work kinds and a custom answer when **Other** is selected.
3. **Start working** hands off to the existing Add Project command, or optionally opens
   **Import projects and conversations**.

Already-satisfied steps are omitted when the journey starts, then that short journey stays stable so
Back remains predictable while readiness changes. **Skip** stays visible on every step, dismissal is
durable, and existing users with a project or thread are completed silently rather than interrupted.
Settings → Getting Started provides a manual replay route without resetting provider or project
state. Project import remains inside the onboarding journey rather than appearing as a duplicate
action on the General settings page.

The hosted static environment-connection flow remains authoritative and runs before this gate. The
getting-started flow begins only after the primary environment, entity shell, session permission,
and server config are ready.

Local clients bypass T3's additional first-run gate and route `/welcome` to Scient's manual
getting-started page. Hosted clients retain upstream's connection wizard. An unset upstream
`onboardingCompletedAt` flag must not restart a dismissed or completed Scient setup.

## Optional project import

The final onboarding step uses `ScientProjectImportAction`, which lazily mounts the upstream
`ProjectImportStep` only after an explicit click. Merely reaching the final onboarding step does
not scan history. The Add Project menu is unchanged.

The import step is extracted from T3's wizard, not reimplemented: it uses the same scanner,
project-creation commands, session importer, bounded reads, deduplication, and partial-failure
retry behavior. T3's hosted wizard uses that same component. Scient's wrapper supplies the
primary machine, existing operate permission, modal dismissal, and normal project navigation.
During an import the modal cannot be dismissed; losing permission unmounts the importer and
prevents it from starting further work. An in-flight command may already have completed on the
server. Existing project and history state remains authoritative.

An active onboarding presentation stays mounted when an imported project arrives in the shell;
it completes only after navigation succeeds or the user skips setup. Closing import without
importing does not complete onboarding. On a later launch, existing work still bypasses setup.
No provider is installed, signed in, or enabled by this import wrapper.

The [user guide](../user/welcome-wizard.md) describes history bounds and omitted content.

## State and authority

Only presentation state and optional preferences are new:

- `scient:getting-started:v1` stores `unseen`, `in-progress`, `dismissed`, or `completed`, the last
  step, and timestamps.
- `scient:personalization:v1` stores versioned work-kind and optional custom-answer values on the current
  device.

Provider readiness, installation, authentication, model discovery, authorization, projects, and
threads are always derived from their existing canonical services. The onboarding state never
claims those capabilities are ready.

The local profile is deliberately small and versioned. A future synchronized profile can migrate
these values behind the storage hook without changing the flow components or treating browser
storage as account authority.

## Extension boundary

Future personalization may add optional profile fields or consume the saved preferences, but it
should not lengthen the default first run unless evidence shows a clear benefit. New steps belong in
the provider-neutral journey resolver and must remain skippable and capability-gated.

Compute installation is intentionally absent. It should enter only after a real managed-compute
capability exists, with its own truthful size, platform, cancellation, verification, and recovery
states. A placeholder download step would create a false product promise.

## Upstream boundary

Scient presentation lives under `apps/web/src/scient/onboarding`. Narrow mounts cover the empty
chat route, General settings, generated route tree, local first-run bypass, and the direct
`/welcome` redirect. Shared import presentation remains under `components/onboarding`, with
T3's existing backend and client commands.
[`scient-onboarding-seams.json`](../../scient-onboarding-seams.json) records those boundaries. Run:

```bash
pnpm onboarding:seams:check -- --base HEAD
```

before handoff to audit the working diff and verify that owned paths do not exist in official T3
upstream.
