# Scient Codex runtime and authentication

> Codex-specific deep dive. Shared lifecycle ownership and action semantics are documented in
> [Provider lifecycle architecture](./provider-lifecycle.md).

Scient owns the assisted Codex lifecycle around T3's existing Codex driver. T3 remains authoritative
for provider instances, app-server transport, sessions, model discovery, skills, and agent turns.
Scient adds runtime selection, managed-runtime actions, authentication supervision, and recovery
diagnostics without creating another provider registry or credential store.

## Authentication authority

Browser success is not authentication proof. Scient subscribes to both
`account/login/completed` and `account/updated` before starting login, waits for the matching login
ID, and treats `account/read` as authoritative. Because OS credential stores can lag the
notification, the login process remains alive while Scient retries that read within a bounded
window.

A fresh Codex app-server process using the same executable, effective `CODEX_HOME`, launch
arguments, environment, and working directory must then observe the account. Only after that proof
does the lifecycle manager refresh the canonical provider snapshot. Codex continues to own its
passwords, access tokens, refresh tokens, credential files, persistence, refresh, and revocation.

## Runtime selection

Selection is derived from existing authority rather than separately persisted:

1. A configured custom executable path always remains authoritative.
2. Otherwise, an installed, capability-healthy Scient-managed runtime wins over PATH Codex.
3. If the private copy is unhealthy, a capability-healthy PATH runtime may keep the provider
   available while Settings continues to expose repair and removal.
4. If neither runtime is healthy, the private copy remains the explicit repair target.

Installing the managed runtime is therefore the durable selection. The managed runtime's atomic
installed/active state is the only selection record; there is no second preference file or hidden
per-instance setting that can drift from it.

The capability probe opens the app-server account API with the exact effective Codex home used by
the provider instance, including an auth-overlay shadow home. It does not infer compatibility from
`codex --version`. The managed installation is shared by the Scient environment: default-runtime
Codex accounts move together, while accounts with explicit custom executable paths remain
unchanged.

## Diagnostics boundary

Runtime diagnostics are optional so older servers and cached snapshots remain compatible. They
contain only display coordinates needed for recovery: active source, version, native backend,
effective home, and executable. They contain no provider account payload, password, access token,
refresh token, or credential-file contents. Remote clients label these as server paths rather than
pretending they describe the client device.

## Upstream seam

All behavior lives in Scient-owned lifecycle, contract, and UI modules. The only T3-owned source
mount is the Codex driver call that passes the server working directory and already-resolved
effective home into Scient's runtime resolver. Future T3 updates should preserve that narrow mount
and reconcile the surrounding driver normally.
