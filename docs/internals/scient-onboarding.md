# Scient getting started

Scient's first-run onboarding is a short, skippable route-level flow. It is a presentation and
navigation layer over existing product capabilities, not a second provider, project, account, or
compute system.

## Product contract

The automatic flow has at most three steps:

1. **Choose an AI** appears only when no provider instance is canonically ready. It reuses the
   provider registry, readiness projection, permissions, and lifecycle setup surfaces.
2. **Preferences** stores optional local work kinds and a custom answer when **Other** is selected.
3. **Start working** hands off to the existing Add Project command.

Already-satisfied steps are omitted when the journey starts, then that short journey stays stable so
Back remains predictable while readiness changes. **Skip** stays visible on every step, dismissal is
durable, and existing users with a project or thread are completed silently rather than interrupted.
Settings provides a manual replay route without resetting provider or project state.

The hosted static environment-connection flow remains authoritative and runs before this gate. The
getting-started flow begins only after the primary environment, entity shell, session permission,
and server config are ready.

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

Implementation lives under `apps/web/src/scient/onboarding`. The inherited T3 surface has three
narrow mounts: the empty chat route, General settings, and generated route tree.
[`scient-onboarding-seams.json`](../../scient-onboarding-seams.json) records those boundaries. Run:

```bash
pnpm onboarding:seams:check -- --base HEAD
```

before handoff to audit the working diff and verify that owned paths do not exist in official T3
upstream.
