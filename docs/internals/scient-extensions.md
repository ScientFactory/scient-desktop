# Scient Extensions

Status: implemented. User guide: [Extensions and connected services](../user/extensions.md).
Companion feature: **Accounts** (see [Secrets integration](#secrets-integration)).

## Purpose

One place where a user sees and manages everything that extends what Scient and
its agents can do, regardless of who owns it:

| Layer                                                   | Owner                                | Who can use it                                     |
| ------------------------------------------------------- | ------------------------------------ | -------------------------------------------------- |
| Scient connectors and Scient plugins                    | Scient                               | All agents, subject to connector transport support |
| Claude Code-format shared plugins                       | The installing agent's plugin system | Claude Code and Scient Agent                       |
| Account apps: Codex store apps and claude.ai connectors | The provider account                 | Codex only or Claude only                          |

Discover prefers Scient's connector where the curated catalog's `agentStores`
mapping identifies the same service in an agent store. Google's account apps
remain in the account layer; Scient does not add Google's official MCP servers.

The library is a **projection**, never a new owner. Each entry is read from its
owning system, and every change is dispatched back to that owner and re-read
before the UI updates. The UI never predicts success.

## Product surface

**Settings → Extensions** (`/settings/extensions`). "Connections" already means
environments, and the browser and devices have their own pages, so none of those
names is reused. Every page reads one environment, chosen by the settings scope picker
("Tools on …"); actions go to that environment and are gated on settings write
access.

- **Discover** (`/settings/extensions`) — the curated catalog's sections, each
  showing a preview with its title linking to the category page, then the
  built-in Scient plugins, shared plugins, Codex store previews, and a link to the full registry. Store headings open searchable, paged store pages. Search replaces the
  sections with one grid: matching installed connectors and plugins first, then
  curated matches, then registry matches as they arrive (see
  [Discover](#discover-curated-catalog-and-mcp-registry)). A slow or failing
  registry never holds back the other rows.
- **Category** (`/settings/extensions/category/<category>`) — every curated
  entry in one category.
- **All MCP servers** (`/settings/extensions/all`) — the MCP Registry, paged,
  with its own search; curated servers appear here in their curated shape.
- **Installed** (`/settings/extensions/installed`) — Connected services (with
  **Add by URL**), Scient plugins (with **Install from folder**), then one
  **From <agent>** section per provider instance with its plugins and MCP
  servers. A **Works with** filter narrows every section to what one provider
  instance can use. Provider sections show six entries with a header toggle to
  show the rest.
- **Detail pages** (`/settings/extensions/item/…`) — one per connector, catalog
  or registry entry, Scient plugin, provider plugin and provider MCP server. The
  header carries the entry's identity and its primary action (Add, Remove,
  Uninstall, or who manages it). Below it, cards:
  - **Connection** (connectors) — status with Sign in or Reconnect, Test, the
    Use with agents switch, and Available in (all projects or selected
    projects).
  - **Tools** (connectors) — listed only on request ("See tools" runs Test);
    the result belongs to the connector's current sign-in generation and is
    discarded when it changes.
  - **Apps**, **MCP servers**, and **Skills** (plugins) — counted contents read on
    demand from the owning agent or local plugin. Skills show five rows before
    expanding; clicking one opens the same Markdown skill card as Settings → Skills.
    “Try now” opens a draft with the composer's skill token when that agent can use it.
    Remote plugins without a local copy show skill metadata until installation.
    Local documents stay within the resolved plugin root and are limited to 256 KB;
    listings include at most 200 skills. Commands, agents and hook events appear when present.
    Other contributed parts remain under **Includes**.
  - **About** — provenance and facts the entry actually has; rows without data
    are omitted.
- **Works with** — the existing line and popover express audience:
  “Works with all your agents”, “Works with Claude and Scient Agent”, “Codex
  only”, or “Claude only”. The popover includes unavailable agents and their
  reasons. A shared plugin installed directly in Scient Agent remains usable
  there when importing Claude Code's plugins is off. A standalone Claude MCP
  server stays with Claude unless it is identified as plugin-provided.

The extensions change feed also advances when provider instances are added,
removed or change driver or name (not on health refreshes), so compatibility
follows the live provider list.

External skills (`/settings/skills/external`) remain where they are; the
provider-plugins section links each provider's skills page.

In a thread, a compact **extensions receipt** shows what the current provider
session actually received: delivered connectors and skipped ones with reasons
("needs sign-in", "transport unsupported by this agent", "disabled for this
project", "name collides with native server").

Extension images share one bundled name-based resolver across shelves, stores,
Installed, details and avatars. An item's own inline icon takes precedence; a
missing image falls back to Scient's bundled brand pack, independently of any
provider installation, configuration or sign-in. Normalization removes a leading
`claude.ai ` and marketplace suffix, replaces hyphens and underscores with spaces,
and folds case and whitespace. Only exact names and explicit aliases match.
Images stay outside provider snapshots and reach clients through the read-only
`extensions.brandIcon` RPC (up to 50 names of 200 characters), cached for an hour
in the client. Non-Codex items never fetch images at runtime. Codex store images
use strict egress to `files.openai.com`, a 64 KiB limit and matching PNG, JPEG,
WebP or SVG signatures; SVG additionally requires `image/svg+xml`.

The checked-in source list is `scripts/scient-extension-brands.json`. Run
`pnpm --dir scripts extensions:icons:generate` to rebuild the pack and aliases
from its recorded sources and license notes. Both the brand pack and the existing
`discover/curatedIcons.json` keys are regenerated as opaque 256×256 WebP tiles
at quality 90, with a 25 KiB per-icon and 4 MB combined JSON budget. Raster inputs
below 128 pixels on either side are rejected; SVG inputs are rendered at high
resolution. Brand tiles retain their backgrounds; transparent marks are trimmed
and centred at 68% on an opaque brand background or white. Recorded sources are
pinned during regeneration; discovery only supplies uncatalogued brands.

The generator writes `.logs/extension-brand-icons.html` and
`.logs/extension-owner-examples.html` for visual review on light and dark
backgrounds at row, large and round avatar sizes. Review every icon before
committing; record rejected marks with `omitted` in the source list. Images fill
the frame without padding when opaque. Runtime inline images use one cached,
local canvas corner sample per URL; transparent marks retain white backing and
padding. Generic and personal
skills packs retain monograms; their inventory is `brandIcons/excluded.json`.
The official vendor marks identify third-party services without affiliation or
endorsement. The source URLs are development inputs only.

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

`<stateDir>/scient-extensions.json` (versioned schema, currently format 2;
atomic write; unreadable entries preserved and written back; a failed load
never overwrites the file). The reader refuses a file over 4 MiB, so every
write is checked first: a change whose complete encoded file (preserved
entries included) would exceed 4 MiB fails with `limit-reached` and nothing
changes, and a format-1 migration that would exceed it is kept in memory
without rewriting the file. Inputs are bounded too: names 200 characters,
descriptions 1000, URLs 2048.

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
  authRevision: number;           // credential generation; absent in older records = 0
  availability: GrantScope;       // which projects receive it (shared with Secrets)
  createdAt; updatedAt;
}
GrantScope = { type: "all-projects" } | { type: "projects"; projectIds: ProjectId[] }
```

`GrantScope` is the one availability model across Secrets and Extensions
(defined in `packages/contracts/src/scient/secrets.ts`). An empty `projectIds`
list means no project. Updates go through `extensions.connectors.update`
(`availability`); every project id must exist and not be deleted, and ids are
deduplicated (first occurrence kept) before saving.

Format 1 kept `projectPolicy: "all-projects" | "selected-projects"` per
connector plus separate `{ connectorId, projectId, enabled }` selection
records. It is migrated on load and saved as format 2 at once: `all-projects`
stays all projects; `selected-projects` becomes the projects whose selection
was enabled (deduplicated, in file order); the selection records are dropped.
If that first save fails, the migrated state is kept in memory and used, and
it is written by the next successful mutation; the format 1 file is left as
it was until then. A Scient that predates format 2 refuses the file rather
than overwriting it.

`authRevision` (also on `ConnectorSummary`) is a non-negative integer that only
increases. It advances whenever the credential behind the connector changes:
every successful sign-in (even to the same issuer, scopes and client, since it
may be another account), a sign-in probe that finds the server no longer needs
auth, and a loss of the grant (a move out of `connected` into needs-auth or
needs-credential, for example a refresh failure, revocation or an unusable
stored credential). Token refresh of the same grant, enable/disable, renames,
availability changes and Test leave it unchanged. Clients key anything derived
from the credential, such as a Test tool list, on `connectorId + authRevision`
and drop results captured under an older revision. Adding the field did not
change the file format: a record without it decodes as 0.

Credential material (OAuth tokens, client registration, PKCE verifier for
pending flows lives only in memory) is stored through the credential port
described in [Secrets integration](#secrets-integration).

### OAuth

Implemented with `@modelcontextprotocol/sdk` `auth()` and an `OAuthClientProvider`
backed by the credential port, following MCP authorization 2025-11-25:

1. Unauthenticated `initialize` probe. 2xx with a valid result → `auth: none`.
   401 → parse `WWW-Authenticate` (`resource_metadata`, `scope`). An SSE answer
   is read with the proxy's own SSE parser (same line endings and event bound).
   Only a response envelope answers the probe (its id, no `method`, and a
   `result` or `error`); a server request that reuses the id is skipped.
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

All connector egress (probe, discovery, token, registration, revocation, proxy)
uses one policy:

- `https` only. The one exception is the exact loopback origin the user typed as
  a connector address (never from the registry or a plugin); it never extends to
  metadata, authorization-server or redirect URLs, even on another loopback port.
- Every other host must resolve to globally routable unicast addresses, checked
  inside the socket's DNS lookup (no rebinding window). IPv6 is allow-listed to
  `2000::/3` minus special-use blocks; mapped and 6to4 addresses are judged by
  their embedded IPv4 address; NAT64, ULA, link/site-local, Teredo and
  documentation ranges are refused.
- Only unauthenticated metadata `GET`s follow redirects (each hop re-checked).
  Credentialed or body-carrying requests (probe, token, registration,
  revocation, proxied MCP) never follow one, so no credential, code, verifier,
  refresh token or client secret is replayed to another origin.
- Request ≤ 4 MiB, response ≤ 32 MiB, 5-minute proxy timeout, and at most 32
  upstream exchanges per connector, each held until its response body ends; a
  full connector answers busy instead of queueing.

### Proxy

`POST|GET|DELETE /mcp/connectors/:connectorId`, mounted beside `/mcp` and outside
environment auth (the MCP session token is the authority, as for `/mcp`).

- Forwards `content-type`, `accept`, `mcp-protocol-version`, `last-event-id`;
  drops everything else including `authorization`, `cookie`.
- `mcp-session-id` is proxy-owned: the agent receives an opaque id bound to the
  connector and to the Scient provider session that opened it, and only that
  session can use or terminate it. Vendor session ids never reach the agent.
- Buffers the request body (POST bodies are single JSON-RPC messages, ≤ 4 MiB)
  so it can be replayed once after a refresh. Responses are redacted by a
  token-level JSON rewriter that builds no objects: every token is copied byte
  for byte, and only a string (value or key) carrying a credential Scient
  applied becomes `"[redacted by Scient]"`. Strings are checked after JSON
  unescaping, tolerant percent decoding (up to three rounds, plain and form) and
  base64/base64url decoding at every alignment (runs found by a linear scan).
  A tainted number refuses the message rather than changing its type, and a
  message's top-level `id` is never altered: kept exactly when it equals an id
  the agent sent in this exchange, otherwise the message is refused. Refusals
  are Scient JSON-RPC errors carrying the agent's request id exactly as the
  agent wrote it (never a re-serialized number). Untainted JSON is
  unchanged, including exact numbers and any key name; nesting beyond 512
  levels is refused.
- SSE is parsed line by line per the specification (CRLF, CR, LF or mixed,
  across chunks) and re-rendered event by event, each complete event released at
  once and bounded by its own 4 MiB of raw upstream bytes (terminators
  included). Data is redacted as JSON; empty data (resumption priming) passes as
  is. A credential-bearing `event` or `id` is dropped, `retry` passes only as an
  integer up to 600 000 ms, and upstream comments are never echoed: they only
  let Scient send its own `: keepalive`, at most once per second and only when
  nothing else was sent in that second. A success body or event that is not
  verifiable JSON is replaced by a Scient JSON-RPC error (ending the stream).
  Response headers are rebuilt by Scient: content type, a protocol version only
  when it is a known MCP version (2024-11-05, 2025-03-26, 2025-06-18,
  2025-11-25), and the proxy session id; nothing else is forwarded.
- Every credential Scient holds or applies is at least 16 characters (entered
  keys, the Basic password half, issued access and refresh tokens, DCR and
  user client secrets). Shorter ones are refused at entry; issued ones are
  revoked and the connector marked needs-auth, whatever its previous status;
  stored legacy material is never applied (a short own client secret must be
  replaced; a successful sign-in retires short stored DCR registrations at
  every issuer and redirect URI). They could not be told apart from ordinary
  text.
- Only MCP results pass through. 202/204, `GET` 405 and session 404 keep their
  status with server-owned bodies; every other upstream status or content type
  becomes a server-owned error, so vendor error text never reaches the agent.
- On upstream 401 with OAuth: one forced refresh, then the buffered request is
  replayed once. A refused replay marks the connector needs-auth only if the
  refused grant still owns it (checked under the lifecycle lock), and every
  credential-loss status change applies only to the auth revision it was
  observed under, so a late failure of an old grant never touches a newer
  sign-in. A refresh reads the current record under the lifecycle lock and
  publishes any loss (session dropped from memory and storage, needs-auth) for
  that record, because the grant it refreshes is the current one even when the
  request started before the latest sign-in.
- Each `tools/call` is recorded as a use of the connector's credential (thread,
  provider session, tool name, outcome at response headers).
- Refusals: a missing or unknown bearer gets 401 without `resource_metadata`
  (as for `/mcp`); a connector not delivered to the session gets 403; a lost
  grant, a disabled connector, an ineligible plugin connector or a deselected
  project gets a JSON-RPC error (code `-32001`) for `POST` and 403 for
  `GET`/`DELETE`.

### Lifecycle fencing

Refresh, sign-in commit and disconnect for one connector run under one
lifecycle lock. Each sign-in mints a grant id that refreshes keep; a refresh
commits with compare-and-swap on the version it read and never overwrites a
different grant (its tokens are revoked instead). Disconnect tombstones the
connector and aborts its in-flight work before committing the removal; work
that finishes afterwards cannot send, persist or keep a grant, and anything it
obtained is revoked. A credential read outside the lock fills the in-memory
grant cache only if no sign-in, refresh or drop was published while it ran, so
a stale read never restores an older account. Connector state, secret
creation, replacement and removal are synced (data, then directory entry)
before they are acknowledged; a sync failure fails the operation, and only
platforms that cannot sync a directory (Windows) skip that step. A removal also
purges preserved duplicate entries with the same id so they never become live
after a restart.

### Grants and delivery

At MCP credential issuance (`ProviderSessionManager.prepareMcpSession`) the server
computes the **delivered connector set** for the session:

```
connected ∧ enabled
∧ (availability.type = all-projects ∨ projectId ∈ availability.projectIds)
∧ adapter supports remote HTTP MCP for this session
```

The set is stored on the registry scope (`connectorIds`) and in
`McpProviderSessionConfig.connectors: { connectorId, serverName, displayName, url }[]`.
Credential reuse requires an equal connector set (same ids, names and order); a
changed set re-issues, which matches the existing behavior for capability changes.
Drivers without a reviewed delivery path skip every connector as
`transport-unsupported` (`apps/server/src/scient/extensions/ConnectorProviderSupport.ts`).

At request time the proxy re-checks the same predicate, so disconnecting,
disabling, or narrowing availability takes effect on the next call. Adding a
connector reaches sessions issued afterwards.

Adapters map the list into their native formats:

| Adapter                                             | Delivery                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude                                              | additional `mcpServers` record entries (`type: "http"`)                                                                                                                                                                                                     |
| Codex                                               | additional `config.mcp_servers.<name>` entries with `http_headers`                                                                                                                                                                                          |
| Cursor                                              | additional `mcpServers` record entries                                                                                                                                                                                                                      |
| OpenCode                                            | one `mcp.add` remote entry per connector                                                                                                                                                                                                                    |
| ACP (Grok, Droid, Antigravity, fx, registry agents) | one stdio bridge entry per connector, exactly like Scient's own entry, even when the agent advertises `mcpCapabilities.http` (some ACP agents, e.g. codex-acp and pi-acp, silently drop http servers, and a receipt must never claim a delivery that fails) |
| Pi                                                  | JSON list in the extension bootstrap; extension registers each server's tools as `<server>__<tool>`                                                                                                                                                         |
| OMP                                                 | bootstrap list; extension registers each server's tools as `<server>__<tool>`                                                                                                                                                                               |

Pi and OMP register connector tools under names every supported model API
accepts (`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`): the tool name's other characters
become `_`, a leading digit gains a `_` prefix, and a name that is too long or
already taken becomes its first 55 characters plus `_` and 8 hex digits of
SHA-256(`<server>\0<tool>`). Calls use the original tool name.

Reserved server names: `scient`, `t3-code`, `t3_code`, `t3code`. Connector names
are `[a-z0-9_-]{1,48}`, unique, and suffixed `_2`, `_3` on collision. Planning
skips a connector whose name the provider instance last reported as one of its
native servers (a conservative check: the report may come from another
workspace). Claude's native servers depend on the workspace, so the Claude
adapter also asks the live CLI (`mcpServerStatus`) before it registers
anything; a connector whose name a configured server already uses is left
unregistered and the credential's receipt moves it to skipped with
`name-collision`, so a user's own server is never replaced. If the CLI cannot
list its servers within 10 s, every connector is withheld for that query and
skipped with `native-servers-unknown` (fail closed: naming a plugin's server
in `setMcpServers` would replace it). Each query starts through
`McpProviderSessionConfig.beginConnectorRegistration`, which the issuing server
runtime binds to its own receipt store and credential and which hands out a
per-credential sequence before anything is awaited. Once `setMcpServers`
returns, the query reports its settled outcome: connectors it withheld, plus
connectors the CLI listed errors for (or every connector when registration
rejected, timed out or was interrupted) as `registration-failed`. The receipt
keeps the report of the query that started last, across every session sharing
the credential, so a later query that registers a connector returns it to
delivered and an older query that settles late cannot overwrite it. The
sequence and the latest accepted outcome live in the credential's tracker,
created once when the credential is issued, so replacing or evicting the
thread's receipt never resets them: when the manager records a receipt for a
reused credential it applies that outcome in the same step, so the receipt
never shows a withheld connector as delivered.

A session without an MCP injection channel (for example an external OpenCode
server) records a receipt with no deliveries and every eligible connector
skipped as `transport-unsupported`, replacing any earlier session's receipt.

### Receipts

```ts
ExtensionDeliveryReceipt {
  threadId; providerInstanceId; providerSessionId; issuedAt;
  delivered: { connectorId; serverName }[];
  skipped: { connectorId; serverName; reason: "needs-auth" | "needs-credential" | "disabled"
             | "project-deselected" | "transport-unsupported" | "name-collision"
             | "native-servers-unknown" | "registration-failed" }[];
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

- **Codex**: `plugin/installed` and paged `mcpServerStatus/list`, enriched outside
  health checks. App summaries combine `app/installed` with targeted `app/read`
  requests. The store keeps one app-server lease for its provider scope, caches
  `plugin/read` for the catalog lifetime, and checks account identity on reads.
  Installed plugin pages can load without decoding the full marketplace catalog.
  Catalogs expire after an hour; installed membership refreshes after 30 seconds
  or an inventory refresh. Account changes and explicit store refresh discard
  plugin details. Icon downloads do not serialize plugin and skill reads.
  Local logos and skill documents stay inside the real plugin source directory
  and are capped at 256 KB. Skill reads fail visibly after 15 seconds.
  Discover previews show featured, uninstalled Codex plugins; shared previews
  rank Anthropic reviews, partner reviews, then other entries, preferring bundled
  brand icons within each tier. Uncloned shared plugins show inline declarations
  until installation makes their remaining contents available. Uninstall and
  MCP OAuth retain the existing admit/mutate/verify path.
- **Claude**: live session plugins/MCP status are combined with an on-demand,
  promptless account connector probe. The probe disables hooks and user settings,
  sets `ENABLE_CLAUDEAI_MCP_SERVERS=true`, and deliberately omits
  `strictMcpConfig`. It polls once per second until nonempty `claudeai` results
  repeat, with a 15-second deadline, then closes. No model call is made. The
  ordinary health probe keeps account connectors disabled. Extensions opening,
  Refresh, and return from sign-in trigger the account inventory; background
  refreshes are throttled to ten minutes. Sign-in opens claude.ai's connector
  settings. Local installed plugin metadata comes from the selected Claude home.
- **Scient Agent**: bounded `plugin list --json` through the exact configured
  executable and isolated root, plus `<root>/agent/mcp.json` and plugin MCP files.
  Configuration proves a server is configured, not connected. Enable, disable,
  and uninstall are re-read and verified. Foreign Claude installs are read-only
  from this section. No configuration, environment, or credentials from an MCP
  definition are projected into the UI.

### Shared plugins source

Scient Agent always uses Claude Code's plugins; there is no desktop switch. The
ordinary Scient Agent process factory and plugin commands inject
`SCIENT_AGENT_ENABLE_SOURCES=claude-plugins` once runtime identity proves
Scient Agent 0.1.3 or newer. Identity checks precede injection. The agent
unions this source with its own enabled sources for discovery; its
`disabledProviders` remains controlling. No settings overlay replaces arrays.
The desktop inventory checks that switch through `config get … --json` and
honors Claude's user/project/local plugin enablement layers.

The source home is `CLAUDE_CONFIG_DIR`, resolved on the server host, or the
server user's `.claude` directory. It is not a union of every configured Claude
profile. Existing sessions may need the agent's normal reload/restart procedure
before newly installed hooks or modules become active.

The shared shelf reads Claude's `plugins/known_marketplaces.json` and local
`.claude-plugin/marketplace.json` clones, together with Scient Agent's
`marketplaces.json` catalog paths. Reads are local, at most 4 MiB per metadata
file, 64 marketplaces per source, 10,000 entries per catalog, and 20,000 entries
in a combined listing. There is no per-entry discovery network request.
Includes comes from the cloned or installed plugin directory. Review metadata
is optional: only a completed `listings[].checks.review` matching the plugin's
repository and path in `plugin-directory-cache-v2.json` produces “Reviewed by
Anthropic” or “Reviewed by a partner”. Missing, unreadable, or unmatched review
metadata produces no review claim.

Installation uses an enabled Claude Code instance when available. For a store
configured only in Scient Agent, the action obtains that source from the live
owner, asks Claude Code to add it, re-reads Claude's marketplace registry, then
installs. Conflicting marketplace names are refused. Otherwise it uses Scient
Agent's own plugin CLI. Scient Agent's official Claude store is never added
implicitly: Discover offers “Add Claude Code's store”, backed by
`plugin marketplace add anthropics/claude-plugins-official` and a verifying read.
Hooks, local MCP servers, and extension modules are installable through their
native owner, as approved for this shared layer. Native installer restrictions
still apply, such as Scient Agent's unsupported npm marketplace source.

### Provider store RPCs and Codex cache

`extensions.providerStore.search { instanceId, query?, cursor?, limit?, preview?,
refresh? }` returns at most 50 entries. `extensions.providerStore.entry {
instanceId, entryId }` reads one detail page. Both are read-authorized. They
reuse the provider generation's optional store seam; they do not add store
contents to provider snapshots. Store and detail routes are
`/settings/extensions/store/<instanceId>` and
`/settings/extensions/item/store/<instanceId>/<entryId>`.

Each Codex instance owns one server-side `plugin/list` cache, refreshed after
one hour of use or on Refresh. The verified catalog is about 8,115 entries and
23 MB; only filtered pages cross the client boundary. Home previews contain
featured and installed entries, or search matches, with curated duplicates
removed before fetching icons. The full store page remains complete. An API
key or other non-ChatGPT account receives a sign-in explanation instead.
Account changes invalidate the catalog and pending app sign-ins. A partial
marketplace response is refused rather than cached as complete.

Signed `files.openai.com` logos are fetched only for visible entries, through
`ConnectorOutbound`'s strict outbound policy, without redirects. Images are
limited to 64 KiB, checked for PNG/JPEG/WebP signatures, converted to
`ExtensionIconDataUri`, and cached (256 entries, one hour). A page's icon work
has a five-second budget; a slow icon leaves the usual fallback tile. Signed
logo URLs never reach the renderer.

`providerPlugins.act` accepts `install` (entry id, with an optional source
instance for shared stores), `add-official-store`, and the existing lifecycle
operations. Codex installation calls `plugin/install { pluginName,
remoteMarketplaceName }` (or the local marketplace path), then verifies the
owner's installed listing before publishing. Results carry `appsNeedingAuth`
and `authPolicy`. Connection buttons use `openAuthorizationPage` with validated
ChatGPT app URLs. `ON_USE` says “Connects the first time Codex uses it”; plan,
admin, and installation-policy restrictions disable the action with a reason.

`app/list` is paged with cursor-cycle and page limits. `app/list/updated` causes
an authoritative re-read and invalidates active store queries; window focus
re-checks connection state. Installed snapshots carry only the installed apps'
connection summaries. The store app-server lease closes after 60 seconds once
in-flight bounded work settles, or immediately with its provider scope. A later
query opens a fresh lease and re-reads state. Commands have time/output bounds;
retirement interrupts mutations and only the same generation can verify them.
All client mutations use the destination environment's settings grant.

### Focused probes

Tests next to the extensions owners cover the source/version gate with a real
synthetic executable, promptless connector stabilization with a controlled
clock, native plugin mutation verification, standalone MCP privacy, project
source overrides, local catalog parsing and review provenance, preferred-owner
installation, the large paged Codex cache, app notifications, icon limits,
account changes, and policy refusals. The Extensions browser suite covers the
verified install → connect → connected transition and the audience popover.
Live provider installs, account sign-in, and desktop smoke remain separate
qualification steps; mocked protocol tests do not establish them.

## Scient plugins

Manifest `scient.plugin.json` (`apiVersion: "scient.plugins/v1alpha1"`):

```ts
ScientPluginManifest {
  apiVersion: "scient.plugins/v1alpha1";
  id; version /* exact SemVer */; displayName; description; publisher;
  contributes: {
    skills?: string[];                                            // directories inside the bundle (Agent Skills format)
    connectors?: { url /* https */; displayName; description? }[]; // remote MCP servers
  };
}
```

Unknown keys are rejected rather than ignored. `capabilities` and settings
pages exist only on built-in plugins; keys that would carry code (`main`,
`scripts`, `bin`, `hooks`, `commands`, `mcpServers`, `ui`, `panels`) are
rejected with a named reason.

- **Built-in plugins** describe existing Scient features (Sources, Documents,
  Compute, Browser and devices, Pull requests). They appear in the library with
  their contributed tools and settings links. Their on/off controls are the
  existing settings (for example agent browser/device access); no parallel
  toggle is introduced. Skills are not listed: they keep their own Settings →
  Skills page. The `scient.` id namespace is reserved for built-ins.
- **Declarative bundles** contain only data: Agent Skills directories and
  connector definitions. They are installed from an absolute directory path on
  the server host and read once into memory. The requested root is `lstat`ed
  and its device/inode is carried into the walk: its canonical path must name
  that same directory, and the requested path must still name it afterwards.
  Each directory must be a real directory whose `realpath` is its expected path
  and whose device/inode is unchanged before and after it is listed and after
  each of its files is read; each file is opened with `O_NOFOLLOW | O_NONBLOCK`,
  its descriptor must be the same singly linked regular inode that was listed,
  and it is read with a bounded loop. Symbolic links, hard links, FIFOs and
  other special files are rejected; `.git` and `.DS_Store` are skipped; at most
  2,000 entries, 1,000 files, 16 levels, 5 MiB per file and 20 MiB in total;
  the scan stops when the request is cancelled.

  **Accepted residual window (concurrent writer).** Node has no `openat`, so
  these are pathname checks around each read, not race-free containment. A
  process that can rename directories inside the selected bundle while Scient
  reads it can, after an intermediate directory's last check, replace that
  directory with a link to an outside directory, keep it replaced while one
  child is `lstat`ed, opened and read (the listed and opened inode then both
  belong to the same outside, singly linked file), and restore the original
  before the post-read directory check. Every check passes and the snapshot
  holds that outside file's bytes, which are then digested and installed like
  bundle bytes. The window is accepted because the bundle path is chosen by
  the user on the server host and exploiting it needs a writer that already
  has rename access inside that directory while the install runs, plus read
  access to the outside file; installing from a directory nobody else can
  modify removes it. Closing it requires descriptor-relative traversal
  (`openat` with `O_NOFOLLOW` on every component) or an equivalent platform
  mechanism. A swapped root, a persistent directory or file swap, a swapped
  final component, a FIFO, a replaced file and a growing file are all rejected.

  The snapshot is digested with SHA-256 over sorted paths and contents and
  copied to `<stateDir>/scient-plugins/<id>@<version>-<digest12>/`.
  Installed bundles are recorded in `<stateDir>/scient-plugins.json`
  (versioned, atomic write, unreadable entries preserved and written back; an
  unreadable file is never overwritten and pauses changes), including the
  connectors each plugin created. Ownership of a connector is dropped only when
  a complete connector inventory (no `state-unreadable` or
  `connector-record-unreadable` diagnostic) confirms it is gone; while the
  connector store is degraded ownership is kept, and changes to a plugin's own
  connectors fail with `state-unavailable`. Writing and reading share one 1 MiB
  budget: a change whose encoded state, preserved entries included, would
  exceed it fails with `limit-reached` and leaves the previous state in place,
  so every committed state is readable at the next start. An install sizes the
  complete candidate state (with the longest possible id for each connector it
  would create) before it copies files, creates connectors, or retires any.
  On restart each copy must still match its
  recorded digest, otherwise it is listed with a diagnostic and contributes
  nothing. Each contributed skill must carry `scient.skill.json` with origin
  `{ kind: "addon", addonId: <id>, addonVersion: <version> }` and is loaded with
  the Scient skill release loader (see
  [Scient skills](scient-skills.md#add-on-releases)); a skill that reuses a
  Scient or another plugin's skill id or name is refused, and personal
  activation is bound to the exact release digest. Connectors are created
  through the connector runtime and are never signed in by installing.

- **Lifecycle.** Every change is serialized and, once past read-only
  validation, runs uninterruptibly to completion. Reinstalling the same id
  keeps owned connectors whose declared URL is unchanged (with their sign-in),
  and adds new ones and removes dropped ones before the record commits; if any
  step fails, the change is reported as failed and added connectors are rolled
  back. Revoking (disabling a plugin, or reinstalling a disabled one) happens
  before the record commits; granting happens only after it: enabling a
  plugin, or repairing an unverified copy, re-enables retained connectors once
  the verified record is durably committed, and a failure there leaves them
  disabled with a diagnostic. Removing removes connectors first, then the
  record and files.
- **Grant-time eligibility.** After every commit the registry publishes to
  `PluginConnectorEligibility` the exact connector ids owned by enabled,
  verified plugins. The connector runtime consults it for every plugin-sourced
  connector in `resolveDelivery` (skipped as "disabled"), `isGranted`,
  `forward`, and `update` (enabling an ineligible one fails with `unsupported`).
  Until the registry has published, and while `scient-plugins.json` is
  unreadable, every plugin-sourced connector is denied. The service only reads
  a `Ref`, sits below both the runtime and the registry, and takes no lock, so
  revocation never depends on a successful connector or state write.
- **Reconciliation.** At startup and before every change, plugin-sourced
  connectors are converged on the committed records: connectors no record owns
  (left by a crash or a failed rollback) are removed; connectors of a disabled
  or unverified plugin are disabled; while the state file or any record is
  unreadable, ownership is unknown and plugin connectors are disabled rather
  than removed. Unreferenced copies and staging directories are deleted.
  Cleanup that cannot finish is reported as a diagnostic and retried on the
  next change; the connector stays denied meanwhile by grant-time eligibility.
  A bundle cannot declare itself active, consistent with the skills authority
  model.
- **Scient bundles do not carry code.** Nothing from a bundle is executed:
  no local MCP server processes, no scripts, no UI code. Shared native plugins
  use the separate agent-owned path above.

## Discover: curated catalog and MCP Registry

**Curated catalog.** `apps/server/src/scient/extensions/discover/curatedCatalog.ts`
lists remote MCP servers chosen for a research-focused audience, each with an
https Streamable HTTP URL, a display name, a plain tagline (≤ 60 characters),
a short description, categories (`featured`, `research`, `data`, `code`,
`writing`, `communication`, `design`), a website, the MCP Registry entry when
the registry publishes that exact remote, and a bundled icon. Every
URL is verified live before it is added (a POST `initialize` answered 200 with
an initialize result, or 401 with `WWW-Authenticate`); the verification date
is recorded in the file. Servers are never invented, and a category with no
verified entry has no section. A curated server that is not in the registry is
named `scient.curated/<id>` with the verification date as its version; clients
install it by URL.

`extensions.discover.catalog` returns the non-empty categories in that order,
each with up to 6 preview entries (entries whose first non-featured category is
the section come first, then the rest, in catalog order) and its `total`.
`extensions.discover.search` takes a required `scope`, so local results never
wait on the network:

- `curated` returns every entry of the complete curated catalog (previews or
  not, registry-listed or not) whose name, tagline and description contain every
  query term, in catalog order; with a `category`, that category's entries in
  section order. It is answered in memory without touching the registry and has
  no cursor. An empty query returns the whole catalog (or category).
- `registry` returns every MCP Registry result. A result that is a curated
  server's alias (by registry name or canonical remote URL) is returned as that
  curated entry, exactly as `curated` returns it (same `name`, title, tagline,
  categories, icon and `installedConnectorId`), at most once per page. The two
  lists can therefore overlap, and clients merging them (global search)
  deduplicate by `name`. Cursor paging and failures are the registry's: an
  unreachable registry fails this query and only this one. `registry` with a
  `category` is `invalid-input`.

`extensions.discover.entry` (`{ name }`) returns
one entry: from the complete curated catalog first, otherwise the registry's
latest active version of that exact
name (`/v0.1/servers/<name>/versions/latest`), otherwise `not-found`. Names
starting `scient.curated/` never reach the registry.
`installedConnectorId` is resolved live on every call, by registry name or by
canonical connector URL (parsed, trailing path slash ignored).

**Icons.** Clients never load remote images. Registry icons are not fetched at runtime;
Codex store logos use the bounded server-side path above. Every curated server ships with a bundled logo:
`apps/server/src/scient/extensions/discover/curatedIcons.json` maps each
catalog `id` to the vendor's official logo or app icon (a PNG of at most
256 px, usually 128 px, or an SVG), inlined as a `data:` URI. It is imported as
JSON, so the logos are part of the server bundle that the desktop app ships.
The logos were fetched once from official sources (the vendor's GitHub
organization avatar, apple-touch-icon or site icon) and checked by eye. A test
requires every curated entry to have its icon and the map to have no other
entry. Each icon must satisfy the shared `ExtensionIconDataUri` contract schema
(`data:image/(png|jpeg|webp|svg+xml);base64,` followed by base64, at most
90,000 characters), decode to at most 64 KiB, and contain bytes that match
their media type. Curated entries therefore always carry `iconUrl`, and
responses never wait on icons. Uncurated registry entries get none (the client
draws a letter tile). The logos only identify the third-party services they
belong to (nominative use).
To add or replace a logo, change `curatedIcons.json` under the same `id`.
A connector whose canonical URL is a curated server carries that server's icon
as `ConnectorSummary.iconUrl`, and adding a curated URL (from Discover or typed
by hand) keeps the curated name and description unless the client sends its
own `displayName` and `description`.

**MCP Registry.** Server-side client for
`https://registry.modelcontextprotocol.io/v0.1/servers` (search, cursor
pagination, `version=latest`, at most 100 per page), cached 10 minutes per
query, cursor and limit, with a 10-second deadline per attempt, two retries for
transport failures, timeouts, 429 and 5xx, and a 4 MiB response cap. Entries
are filtered to `status: active` and normalized into `DiscoverEntry`: `remotes`
lists the `streamable-http` remotes served over https, decided after URL
variables are substituted (fixed `value` first, then `default`), plus
unresolved templates whose scheme is not a literal non-https one; a remote
`requiresInput` when it has a required header or an unresolved URL variable;
`installable` = at least one such remote without required input. Otherwise
`unsupportedReason` explains why: package-only (local) servers "Runs locally —
local servers are not supported yet", required configuration, non-https
endpoints, or another transport (for example legacy SSE).

## Secrets integration

[Scient Accounts](./scient-accounts.md) provides the encrypted vault and Settings →
Accounts. Extensions owns connector records and consumes `ConnectorCredentialStore`
for owned credentials and OAuth. Bound API-key accounts use the narrow
`AccountsService.resolveBound(ref, { connectorId, origin })` and
`listBindable({ origin })` port. The saved connector record is the user's binding
approval; Accounts validates the ref and account on every request, reads its current
token as `Redacted`, enforces site matching and both Off switches, and records use.
Ask is approved by the binding, so agent calls never prompt. Connector project
availability governs this explicit delegation. Missing or ineligible accounts become
`needs-credential`, with no fallback. Disconnect never deletes a bound account.

The credential-store port keeps the owned-credential operations:

```ts
type SecretOwner = { type: "user" } | { type: "connector"; connectorId: string };
type SecretKind = "oauth-connection" | "bearer" | "header" | "basic";

put(owner, kind, material: Uint8Array, opts: { label: string }): Effect<VaultSecretRef>
readOwned(ref, owner): Effect<Option<{ material; version }>>   // connector-owned (OAuth, entered keys)
replace(ref, material, expectedVersion): Effect<number, SecretVersionConflict> // compare-and-swap
remove(ref): Effect<void>
recordUse({ scope, target: "<connector>/<tool>", decision, outcome?, correlationId }): Effect<void> // non-blocking
```

- `VaultSecretRef` lives in `packages/contracts/src/scient/secrets.ts` (owned by
  Accounts). It is distinct from the one-use `SecretRef` of `request_secret`.
- Connector-owned entries carry a label and appear in Settings → Accounts as
  managed connectors; they are removed only by disconnecting.
- Header-style connectors either own an entered key or bind an API-key account.
  Only the user's settings action can create a binding. The connector's saved URL
  supplies the origin checked against the account's sites on every request.
- `recordUse` receives the server-derived `McpInvocationScope`, never
  request-supplied ids, and carries no arguments, headers or bodies.
- Connector availability is checked against the project per session, so delegated
  children in the same project inherit bindings; writes keep the provider's own
  per-call approval.
- Both features express where a grant applies with the same `GrantScope`
  (`{ type: "all-projects" } | { type: "projects"; projectIds }`, defined in
  `packages/contracts/src/scient/secrets.ts`): a connector's `availability`
  and a secret's grant scope mean the same thing and are edited the same way.
- Accounts encrypts owned envelopes under `connector-<uuid>.bin`, migrating legacy
  plaintext envelopes when read. Bound credentials store only the validated
  `account:<accountId>:token` ref. The add dialog offers matching API-key accounts
  only when the environment's Accounts snapshot is available.
- A future egress proxy must never intercept a Scient server origin.

## Release requirements

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
- The product-analytics gateway accepts the `extensions` settings section
  before this ships: its event contract is regenerated from the wire contract
  and deployed as described in [product analytics](./product-analytics.md);
  otherwise batches that mention the section are rejected.

## Open decisions

- **Scient bundles and direct registry installs carrying code** remain outside
  the shared native plugin path: local registry processes and plugin UI are
  not supported. Shared plugins with hooks, MCP servers, or modules are approved
  for native installation with the store review state shown when available.
- **Writing provider-native config** (export a connector into
  `~/.codex/config.toml` for use outside Scient): not built; the proxy covers
  every in-Scient session. Revisit only for standalone CLI use.
- **CIMD**: requires deploying the client metadata document on `scientfactory.com`.
- **Multiple accounts per service**: one connector per canonical URL today;
  separate work and personal accounts would need distinct server names and an
  account label.
- **Other agents**: inventory still depends on each provider exposing a verified
  owner interface. Codex, Claude, and Scient Agent have the paths above.

GitHub uses a bearer personal access token by default, linked from its add dialog.
Build the web client with `VITE_SCIENT_GITHUB_OAUTH_CLIENT_ID` to offer
“Sign in with GitHub” through the existing connector OAuth/PKCE flow and callback.
It stays hidden when unset; registering the Scient OAuth app and configuring the
provider's callback/client requirements remain prerequisites for live sign-in.
Only user-added URLs expose custom OAuth client settings.

## Plugin key detection

Plugin contents can carry `requiredKeys`, a bounded list of variable or declared
sensitive-setting names detected from contained manifests. It never contains
values. Only installed local contents can establish this list; an unavailable
local root leaves it unknown. Installed plugin pages use Scient-owned account bindings and authoritative
eligibility for their Keys rows and Needs a key status. Native provider adapters
generate suppression policies; supported HTTP-header servers are served through
the existing connector proxy. Provider behavior remains unverified live, and
stdio key delivery is unsupported. The
[plugin-key implementation record](scient-plugin-keys.md) documents provider
capabilities, security boundaries and the remaining delivery work.

Settings → Accounts also displays connected Claude account connectors and
accessible Codex apps as read-only rows linking to that agent's Extensions page.
Installing a plugin or offering a sign-in does not create an Accounts row.

### Native plugin key delivery

Scient keeps key bindings separately from plugin-owned files. Keys rows reuse
Accounts' API-key picker and add dialog. The proxy resolves the current bound
account with the plugin-key consumer and original origin/project on each request;
no account key appears in the provider's environment or MCP config. Detected
key-bearing plugins receive provider-specific native-server suppression policies.
Supported HTTP-header servers use the original native name at the adapter and
Scient's existing connector proxy behind it. Stdio remains withheld. Claude and
Codex configuration is unit-tested but unverified live; Scient Agent has no
verified override and displays its unavailable message. See the
[implementation and qualification record](scient-plugin-keys.md).
