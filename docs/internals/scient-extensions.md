# Scient Extensions

Status: proposition approved for implementation on `claude/scient-extensions`.
Companion feature: **Secrets** (separate owner, see [Secrets integration](#secrets-integration)).

## Purpose

One place where a user sees and manages everything that extends what Scient and
its agents can do, regardless of who owns it:

| Kind                                      | Owner                                    | Examples                                                                            | Mutable from Scient                                                 |
| ----------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Connected service** (connector)         | Scient, per user                         | Linear, Notion, Hugging Face, any remote MCP server                                 | Yes: connect, sign in, reconnect, disconnect, per-project selection |
| **Provider plugin / provider MCP server** | A provider instance (Codex, Claude, …)   | Codex marketplace plugins, Claude plugins, servers in `~/.codex/config.toml`        | Only where the provider exposes a verified mutation API             |
| **Scient plugin**                         | Scient (built-in) or an installed bundle | Sources, Documents, Compute; a declarative bundle of skills + connector definitions | Built-ins: read-only description; bundles: install, enable, remove  |

The library is a **projection**, never a new owner. Each entry is read from its
owning system, and every change is dispatched back to that owner and re-read
before the UI updates. The UI never predicts success.

## Product surface

**Settings → Extensions** (`/settings/extensions`). "Connections" already means
environments and "Integrations" means browser and devices, so neither name is
reused.

- **Installed** — every entry the current environment knows about, grouped by kind.
- **Discover** — remote MCP servers from the official MCP Registry plus Scient
  plugin bundles. Installing a remote server creates a connector.
- **Filters** — kind, owner, and **Works with** (provider instance). "Works with
  Codex" is a filter over each entry's per-instance compatibility, not a separate page.
- **Entry detail** — what it adds (tools, skills, panels), who manages it,
  compatibility per provider instance with a reason, health, project selection,
  and the owner's actions.

External skills (`/settings/skills/external`) remain where they are; the
provider-plugins section links each provider's skills page.

In a thread, a compact **extensions receipt** shows what the current provider
session actually received: delivered connectors and skipped ones with reasons
("needs sign-in", "transport unsupported by this agent", "disabled for this
project", "name collides with native server").

## Connected services

### Model

A connector is a remote MCP server reached over Streamable HTTP. Scient owns the
vendor credential; agents never receive it.

```text
agent (native MCP client)
  │  Authorization: Bearer <Scient MCP session token>
  ▼
Scient server  /mcp/connectors/<connectorId>
  │  1. resolve session token → thread, provider instance, delivered connector set
  │  2. live grant check (connector connected + enabled for user + allowed for project)
  │  3. swap credential (OAuth access token or bound secret header)
  ▼
vendor MCP endpoint (https)
```

- One endpoint per connector, so each provider shows the vendor's own server name
  and tool names, and provider-native approval applies per server. Connector tools
  never inherit the pre-approval Scient grants to its own server.
- The same per-session bearer that authenticates `/mcp` authenticates connector
  endpoints. No new agent-facing secret exists.
- Vendor tokens never cross the agent boundary: requests forward only
  allow-listed MCP headers; responses never carry upstream `WWW-Authenticate`.
  A lost upstream grant is reported to the agent as a JSON-RPC error that says
  to reconnect in Settings, never as HTTP 401 (which would make the provider
  start OAuth against Scient).

### Persistent state

`<stateDir>/scient-extensions.json` (versioned schema, atomic write, unreadable
entries preserved and written back, a failed load never overwrites the file):

```ts
ConnectorRecord {
  connectorId: string;            // stable random id
  serverName: string;             // unique MCP server name delivered to agents
  displayName: string;
  url: string;                    // canonical https endpoint (RFC 8707 resource)
  source: { type: "registry"; name: string; version: string } | { type: "url" } | { type: "plugin"; pluginId: string };
  auth:
    | { type: "none" }
    | { type: "oauth"; credentialRef: SecretRef }       // tokens + client registration
    | { type: "header"; headerName: string; secretRef: SecretRef; scheme?: "Bearer" };
  status: "connected" | "needs-auth";
  enabled: boolean;               // user-level on/off
  projectPolicy: "all-projects" | "selected-projects";
  createdAt; updatedAt;
}
ProjectConnectorSelection { projectId; connectorId; enabled: boolean }   // app-private, keyed by durable project id
```

Credential material (OAuth tokens, client registration, PKCE verifier for
pending flows lives only in memory) is stored through the credential port
described in [Secrets integration](#secrets-integration).

### OAuth

Implemented with `@modelcontextprotocol/sdk` `auth()` and an `OAuthClientProvider`
backed by the credential port, following MCP authorization 2025-11-25:

1. Unauthenticated `initialize` probe. 2xx with a valid result → `auth: none`.
   401 → parse `WWW-Authenticate` (`resource_metadata`, `scope`).
2. RFC 9728 protected-resource metadata → RFC 8414/OIDC AS discovery.
3. Client registration priority: pre-registered client (user-supplied client id,
   optional secret bound from Secrets) → DCR. CIMD is supported by the SDK and
   is enabled only once a Scient-controlled HTTPS client metadata document is
   deployed (`scientfactory.com`); until then it is not advertised.
4. PKCE S256 and RFC 8707 `resource` on authorization and token requests.
5. Pending authorization keyed by a 32-byte `state`, single-claim, 10-minute TTL,
   at most 16 pending.
6. Refresh: single-flight per connector, 60 s leeway, one forced refresh after an
   upstream 401, `invalid_grant`/`invalid_client`/`unauthorized_client` mark
   `needs-auth`; transient failures keep the connection. Rotated refresh tokens
   are kept in memory if persisting fails.
7. Disconnect commits removal first, then best-effort RFC 7009 revocation.

**Redirect URI (local and remote).** The callback is served by the Scient server
at `<origin>/oauth/connectors/callback`, where `<origin>` is the server origin
_as reached by the client that started the flow_ (loopback for a local desktop,
the forwarded loopback port for desktop-over-SSH, the Tailscale/relay HTTPS
origin otherwise). The client passes its origin when starting sign-in; the
server accepts only `http://127.0.0.1|localhost|[::1]:<port>` or `https://…`
origins. The browser that completes sign-in is on the same machine as the
client, so the callback is always reachable without a desktop-side relay. The
`state` is the only authority on the callback; the PKCE verifier never leaves
the server, so a leaked code is useless. DCR registrations are stored per
`(issuer, redirect_uri)` and re-registered when the origin changes (this avoids
Synara's port-change breakage).

### Outbound safety

All connector egress (probe, discovery, token, proxy) uses one policy: `https`
only (plain `http` only to a loopback host the user typed explicitly, never from
the registry), no redirects on proxied MCP traffic, a public-address check
against DNS rebinding for non-loopback hosts, request ≤ 4 MiB, response ≤ 32 MiB,
5-minute proxy timeout, per-connector concurrency bound.

### Proxy

`POST|GET|DELETE /mcp/connectors/:connectorId`, mounted beside `/mcp` and outside
environment auth (the MCP session token is the authority, as for `/mcp`).

- Forwards `content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`,
  `last-event-id`; drops everything else including `authorization`, `cookie`.
- Buffers the request body (POST bodies are single JSON-RPC messages, ≤ 4 MiB)
  so it can be replayed once after a refresh; streams response bodies without
  buffering (SSE progress, `retry`, ids preserved). `GET` event streams are
  passed through; upstream 405 is passed through.
- 202 and 204 pass through. Upstream 404 for a session passes through (agent
  re-initializes).
- On upstream 401 with OAuth: one forced refresh, then the buffered request is
  replayed once.
- Each completed `tools/call` is recorded as a use of the connector's credential
  (thread, provider session, tool name, outcome).

### Grants and delivery

At MCP credential issuance (`ProviderSessionManager.prepareMcpSession`) the server
computes the **delivered connector set** for the session:

```
connected ∧ enabled
∧ (projectPolicy = all-projects ∨ selection(projectId, connectorId) = enabled)
∧ adapter supports remote HTTP MCP for this session
```

The set is stored on the registry scope (`connectorIds`) and in
`McpProviderSessionConfig.connectors: { connectorId, serverName, url }[]`.
Credential reuse requires an equal connector set; a changed set re-issues, which
matches the existing behavior for capability changes.

At request time the proxy re-checks the same predicate, so disconnecting,
disabling, or deselecting takes effect on the next call. Adding a connector
reaches sessions issued afterwards.

Adapters map the list into their native formats:

| Adapter                                         | Delivery                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Claude                                          | additional `mcpServers` record entries (`type: "http"`)                                                              |
| Codex                                           | additional `config.mcp_servers.<name>` entries with `http_headers`                                                   |
| Cursor                                          | additional `mcpServers` record entries                                                                               |
| OpenCode                                        | one `mcp.add` remote entry per connector                                                                             |
| ACP (Grok, Droid, Antigravity, registry agents) | `mcpServers` http entries when the agent advertises `mcpCapabilities.http`; otherwise one stdio bridge per connector |
| Pi                                              | JSON list in the extension bootstrap; extension registers each server's tools with a `<server>__` prefix             |
| OMP                                             | bootstrap list                                                                                                       |

Reserved server names: `scient`, `t3-code`, `t3_code`, `t3code`. Connector names
are `[a-z0-9_-]{1,48}`, unique, and suffixed `_2`, `_3` on collision. Before
delivery, adapters that know the provider's native server names (Codex
`mcpServerStatus/list`, Claude init `mcp_servers`) skip a connector whose name
collides and record the reason in the receipt.

### Receipts

```ts
ExtensionDeliveryReceipt {
  threadId; providerInstanceId; providerSessionId; issuedAt;
  delivered: { connectorId; serverName }[];
  skipped: { connectorId; serverName; reason: "needs-auth" | "disabled" | "project-deselected"
             | "transport-unsupported" | "name-collision" }[];
}
```

Published per thread over the existing environment RPC stream and shown in the
thread header.

## Provider plugins and provider MCP servers

Published inside provider snapshots exactly like `ServerProviderSkill`:

```ts
ServerProviderPlugin { id; name; displayName?; description?; version?; marketplace?;
                       source: "local" | "remote"; installed; enabled;
                       canUninstall?; components?: string[] }
ServerProviderMcpServer { name; status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "unknown";
                          authStatus?; pluginId?; toolCount?; scope?; error? }
```

- **Codex**: `plugin/installed {cwds:[cwd]}` (workspace snapshot) and
  `mcpServerStatus/list {detail:"toolsAndAuthOnly"}`, folded into the existing
  app-server probe client. Mutations: `plugin/uninstall`, `mcpServer/oauth/login`
  (opens the provider's own sign-in), validated against the latest snapshot and
  followed by a refresh.
- **Claude**: plugins and MCP status from the live session (`system/init`
  `plugins`/`mcp_servers`, and `mcpServerStatus()` at turn end). The capabilities
  probe stays isolated (`strictMcpConfig`, hooks off). Read-only.
- **Others**: read-only, only where a verified listing API exists.

## Scient plugins

Manifest `scient.plugin.json` (`apiVersion: "scient.plugins/v1alpha1"`):

```ts
ScientPluginManifest {
  id; version; displayName; description; publisher;
  contributes: {
    skills?: string[];                        // directories inside the bundle (Agent Skills format)
    connectors?: RegistryServerRef[] | RemoteConnectorDefinition[];
    capabilities?: McpCapability[];           // built-ins only
    settingsPage?: string;                    // built-ins only
  };
}
```

- **Built-in plugins** describe existing Scient features (Sources, Documents,
  Compute, Browser and devices, Pull requests, Skills). They appear in the
  library with their contributed tools and settings links. Their on/off controls
  are the existing settings (for example agent browser/device access); no
  parallel toggle is introduced.
- **Declarative bundles** contain only data: Agent Skills directories and
  connector definitions. They are installed from a local directory or archive,
  snapshotted immutably with a SHA-256 digest (reusing the Scient skill release
  loader and the `addon` skill origin), and removed atomically. A bundle's
  connectors are created in `needs-auth`/disconnected state; installing never
  signs in or grants anything. A bundle cannot declare itself active, consistent
  with the skills authority model.
- **Code-bearing plugins are not supported.** Nothing from a bundle is executed:
  no local MCP server processes, no scripts, no UI code. Supporting third-party
  code requires a separate decision (see Open decisions).

## Discover: MCP Registry

Server-side client for `https://registry.modelcontextprotocol.io/v0.1/servers`
(search, cursor pagination, `version=latest`), cached 10 minutes, with bounded
retries. Entries are filtered to `status: active` and normalized into
`DiscoverEntry` with `installable` = has a `streamable-http` remote without
unresolved required variables. Package-only (local) entries are listed with
"runs locally — not supported" and are not installable.

## Secrets integration

The Secrets feature (separate owner, branch `claude/scient-secrets`) provides the
encrypted vault, Settings → Secrets, brokered service profiles and the secret
audit log. Extensions consumes the vault through one port,
`ConnectorCredentialStore`, whose shape mirrors the agreed vault API:

```ts
type SecretOwner = { type: "user" } | { type: "connector"; connectorId: string };
type SecretKind = "oauth-connection" | "bearer" | "header" | "basic";

put(owner, kind, material: Uint8Array, opts: { label: string }): Effect<VaultSecretRef>
readOwned(ref, owner): Effect<Option<{ material; version }>>   // connector-owned (OAuth, entered keys)
resolveBound(ref, consumer: { type: "connector"; connectorId; origin }): Effect<Option<{ material; version }>>
bind(ref, connectorId, origin): Effect<void>                    // user action only; agents never bind
listBindable({ strategy, origin }): Effect<ReadonlyArray<{ ref; name; last4? }>>
replace(ref, material, expectedVersion): Effect<number, SecretVersionConflict> // compare-and-swap
remove(ref): Effect<void>
recordUse({ scope, target: "<connector>/<tool>", decision, outcome?, correlationId }): Effect<void> // non-blocking
```

- `VaultSecretRef` lives in `packages/contracts/src/scient/secrets.ts` (owned by
  Secrets). It is distinct from the one-use `SecretRef` of `request_secret`.
- Connector-owned entries carry a label and appear in Settings → Secrets as
  "Managed by <connector>"; they are removed only by disconnecting.
- Header-style connectors either own an entered key or bind a user secret.
  Binding is checked inside the vault against the connector and its origin, so
  a user's token cannot be replayed to another connector URL.
- `recordUse` receives the server-derived `McpInvocationScope`, never
  request-supplied ids, and carries no arguments, headers or bodies.
- Both features resolve grants from the project per session, so delegated
  children in the same project inherit them; writes keep the provider's own
  per-call approval.
- Until the vault lands, the port is implemented over `ServerSecretStore` with
  entries named `connector-<uuid>.bin` and a versioned material envelope; the
  vault migration moves them by that prefix. Binding user secrets is offered
  only once the vault exists, because user secrets exist only there.
- A future egress proxy must never intercept a Scient server origin.

## Phases

1. Contracts, seams manifest, this document.
2. Connector runtime: store, probe, OAuth, refresh, callback route.
3. Proxy route and live grants.
4. Session delivery for every adapter, collision checks, receipts.
5. Provider plugin and MCP inventory (Codex, Claude).
6. MCP Registry Discover.
7. Scient plugin model: built-ins and declarative bundles.
8. Settings → Extensions and the thread receipt.

## Acceptance

- A real tool call through a connector from Claude and Codex sessions, before
  and after switching providers in one thread.
- Concurrent calls during token refresh share one refresh; expired and revoked
  sign-in mark `needs-auth`; disconnect during a call fails the next call.
- Corrupt `scient-extensions.json` is preserved and never overwritten.
- Native server name collision is skipped and reported.
- An agent without HTTP MCP support receives a stdio bridge or a recorded skip.
- Remote environment: sign-in started from a desktop connected over SSH or
  Tailscale completes against the server callback.
- Vendor tokens never appear in provider config, environment, logs, or
  transcripts; the agent-facing credential is only the existing session token.

## Open decisions

- **Code-bearing third-party plugins** (local MCP server processes from the
  registry, plugin UI): not supported until approved; requires consent,
  pinned versions and a process lifecycle on the server host.
- **Writing provider-native config** (export a connector into
  `~/.codex/config.toml` for use outside Scient): not built; the proxy covers
  every in-Scient session. Revisit only for standalone CLI use.
- **CIMD**: requires deploying the client metadata document on `scientfactory.com`.
