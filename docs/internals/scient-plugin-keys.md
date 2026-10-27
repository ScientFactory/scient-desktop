# Plugin keys from Accounts

## Delivery capability check (2026-10-27)

Inspected at base `322c0b6c492d5c37f8067b505647f6d9a3e965f4`, using the
installed Claude Code `2.1.311`, Codex CLI `0.164.0`, and Claude Agent SDK
`0.3.276` declarations. Only `--version` and `--help` were run. No live provider
configuration, credential store, sign-in, or live plugin was inspected or changed.
These are interface/code findings, not live collision or tool-call qualification.

### Claude Code

`ClaudeAdapterV2.claudeMcpQueryOverrides` generates HTTP definitions. Its query
runner removes those definitions from the initial SDK options and calls
`setMcpServers` after checking native inventory. Ordinary connector collisions
are deliberately withheld. Consequently the current connector path cannot be
used unchanged to take over a plugin server, or prevent its initial startup.

The installed SDK's `Query.setMcpServers` declaration explicitly says naming a
plugin server replaces it while preserving plugin ownership; omission does not
remove it. `SdkPluginConfig.skipMcpDiscovery` suppresses discovery for an
SDK-loaded local plugin while retaining its other components. These are useful
capabilities, but startup suppression for an already installed plugin must still
be demonstrated; replacement after initialization alone is too late.

Claude's documented server identity is `plugin:<plugin-name>:<server-name>`;
a bare server key is insufficient. Callable names use
`mcp__plugin_<plugin-name>_<server-name>__<tool-name>`. Preserve this normalization
when generating replacements, or skills and permission rules will address the
wrong tool. CLI help advertises `--mcp-config` and `--strict-mcp-config`, but
strict mode changes all MCP configuration and is not a selective solution.
See [Claude MCP documentation](https://code.claude.com/docs/en/mcp).

**Outcome:** explicit scoped replacement is documented by the installed SDK;
selective pre-start suppression and unchanged skill calls remain unqualified.
Do not enable plugin-key delivery based on a bare-name collision assumption.

### Codex

`CodexAdapterV2.codexThreadRuntimeParams` emits one `mcp_servers.<name>` override
per connector, keeping other MCP entries. `codex mcp --help` confirms dotted
configuration overrides. Neither establishes that the same bare name replaces
a plugin-owned server: plugin transport definitions have a separate owner.

OpenAI documents `plugins.<plugin>.mcp_servers.<server>.enabled = false` for
selectively disabling a bundled server. This provides a possible suppression
path without disabling the plugin's skills. The installed app-server's effective
plugin id, server namespace, supported policy version, and tool names still need
a synthetic startup witness before registration can use it.
See [plugin server policy](https://developers.openai.com/plugins/build/plugins)
and [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

**Outcome:** separate native-server policy is documented; replacement precedence
and names are unqualified. Ordinary Scient connector collisions still skip.

### Scient Agent (OMP)

`OmpScientExtension` registers proxy tools separately and uses
`scientConnectorToolName` to avoid incompatible MCP aliases. It does not remove
plugin MCP configuration. `ScientAgentPluginInventory` combines standalone and
plugin server reports for display; that merge is not runtime precedence.
`setEnabled` delegates to whole-plugin enable/disable commands, not to an
individual server. No selective plugin-server suppression interface was verified
from the current adapter. No managed runtime was launched to infer one.

**Outcome:** unsupported by the current verified integration. A future Keys UI
must say “Needs a key — not available for Scient Agent yet” until pre-start
suppression and original tool names are qualified.

### Process environment and credential boundary

All three drivers pass a configured process environment to their provider
runtime (`ClaudeDriver`, `CodexDriver`, `ScientAgentDriver`). Claude plugin
servers have access to user environment variables, per its MCP documentation.
The Codex and OMP adapters do not establish a comprehensive secret scrub for
native plugin subprocesses. Treat inherited credentials as possible; no live
environment values were read to check this. In particular, never put a bound
Accounts key into a provider's process environment.

HTTP delivery must resolve the `plugin-key` consumer at each proxy request,
using the original remote origin and current project. Stdio delivery needs its
own scoped credential-file lifecycle. `accounts/agent/sessionFiles.ts` is the
existing 0600 file owner pattern. A file readable by the same operating-system
user is not isolation from arbitrary shell reads; the intended guarantee and
Accounts' agent tool authorization boundary need to be maintained explicitly.

## Implemented foundation

`ExtensionPluginContents.requiredKeys` is an optional, bounded list of names.
`LocalPluginContents` scans contained MCP manifests and inline/referenced server
records, including `.claude-plugin`, `.omp-plugin`, and `.codex-plugin`
manifests. It detects `${NAME}` references in env, args, headers and URL, empty
or placeholder env entries, and sensitive `userConfig` declarations. Built-in
path/session variables are ignored. Literal configured values, defaults and
credential-store values are never projected into this field. Runtime environment
expansion is never used. Claude's declared sensitive setting names can be
lowercase; they remain the declared identity rather than being renamed.

Codex local/git source contents are scanned only after installation and when an
absolute plugin root is available. Remote-only entries without local contents
omit the field; absence means unknown, not that no keys are needed. Invalid,
unreadable, escaped or truncated manifests also leave requirements unknown rather
than publishing an apparently complete empty or partial list. Discovery
does not install a plugin, run a server, create an account, or change delivery.

## Bindings and authoritative eligibility

`PluginKeyBindings` persists only `{ agent?, pluginId, envName, accountRef }` in
`scient-plugin-keys.json` (format 1). It uses Extensions' atomic 0600 write/rename
and directory-sync implementation, serialized updates, bounded no-follow reads,
and refuses mutations when state is corrupt, newer, duplicated or oversized.
The original unreadable file is preserved.

`extensions.plugins.keys` discovers requirements from the installed plugin on
the server and returns names, account references/labels, and computed eligibility.
Bind and unbind require the destination environment's settings-write grant;
read requires orchestration-read. Bind accepts only declared keys and API-key
account token references from `listBindable({})`. No value is returned or copied.

Every status read calls `resolveBound` with the plugin-key consumer and selected
project. Missing tokens, removed accounts, account Off, project-scope rejection,
and global Agent access Off become `needs-key`. Unknown manifest requirements
or unreadable binding state also fail closed. Changes notify Extensions; Accounts
activity/last-use-only events are excluded to prevent status refresh loops.
This is credential eligibility, not a claim that a native server is suppressed
or delivered; those adapter changes remain separate.

## Keys UI

Installed plugin pages show a Keys section. Each row uses the same API-key
account picker as Add connector, populated by the server's `listBindable({})`
projection. Choosing an account binds it; choosing the empty option unbinds it.
Add key opens the existing Accounts dialog directly as an API-key account, prefills
the plugin display name, and binds only the id returned by a successful save. A failed binding leaves the
newly created account in Accounts for retry. The web never resolves a key value.

The Keys heading carries its quiet status inline. Key rows use “Uses” without a
leading dash. A newly created account stays selected while binding and query
refresh settle; failures restore the server selection.

Plugin cards and pages show Needs a key from server eligibility. A workspace
plugin uses its environment/project identity for the status query; a global
page has no project and cannot claim a project-restricted account is ready.
Scient Agent shows its explicit unavailable message for detected key requirements.
Write controls obey both environment grants and the binding store's availability.
Browser tests cover binding, revocation, unbinding, account creation and read-only
access; visual acceptance in a desktop candidate remains unperformed.

## Remaining implementation and qualification

The binding, Keys UI, generated provider startup policies and HTTP-header proxy
path are implemented and tested offline. Remaining work:

1. Live qualification of Claude SDK loading/precedence and actual plugin tool
   names, and Codex's effective plugin id, policy acceptance and tool namespace.
2. Live stdio delivery qualification in Claude/Codex, packaged Electron, and Linux.
   Windows is withheld because Node's `execve` is unavailable there. Env-only
   stdio delivery is implemented below; secret-bearing arguments stay suppressed.
3. Local-root discovery for remote-only plugins without a verified cache path.
   Missing requirements remain unknown, rather than guessed from server names.
4. Authorized real-provider tool calls and visual acceptance in a desktop
   candidate. No live token is needed or permitted in fixtures or logs.

## Native startup suppression (unverified live)

Before issuing/reusing a provider credential, session preparation reads installed,
enabled plugins for that instance and workspace. Detected key requirements produce
only a names/paths policy on the provider session, never account values or env.
A changed policy replaces the credential; Claude's query reuse key includes it.
A shared-session attachment derives its workspace from the destination thread.

Claude's adapter disables the original `name@marketplace` entry in its inline
SDK settings and explicitly loads its local path with `skipMcpDiscovery: true`.
This retains the plugin's declared identity and non-MCP components while preventing
its original MCP discovery. All MCP servers in that key-bearing plugin are
withheld until Scient supplies supported replacements. A missing local path leaves
the original plugin disabled; SDK settings supplied as a filename are refused
rather than read or silently overriding that policy. No global strict-MCP flag
is used. Codex's adapter emits the quoted plugin-scoped
`plugins.<native-name>.mcp_servers.<server>.enabled = false` overrides for each
reported server; other plugins and ordinary configured MCP servers are retained.
Scient Agent receives no policy or process/configuration change.

**Unverified live:** Claude's precedence between a disabled installed marketplace
entry and the explicit local SDK load; preservation of actual skill/tool names;
Codex's acceptance of this policy and effective native plugin identity on the
installed CLI; shared-session handoffs. Unit tests qualify the generated config,
not those live claims. Plugins whose local key requirements cannot be inspected
remain outside this detected-key policy. HTTP and env-only stdio replacements are implemented below.
Bound credential eligibility alone is not live-provider qualification.

## HTTP-header delivery

Supported remote servers use fixed HTTPS URLs and headers containing `${NAME}`
or Claude `${user_config.NAME}` references. URL/args/env key delivery, unsupported
transports, credential-bearing URLs, unsafe header names, ambiguous duplicate
server definitions and unresolved templates are withheld. All declared plugin
keys must be eligible before any of its HTTP servers is delivered. Key status
checks each declared supported HTTP origin; Add key seeds those origins in the
Accounts form so an empty site list is not mistaken for remote authorization.

Session preparation registers an in-memory connector and grants its id to the
existing session credential. Only the Scient proxy URL and session bearer reach
the adapter. The proxy uses the existing request/body limits, egress checks,
redirect refusal, upstream MCP-session binding and response redaction. Its
credential callback rechecks the provider generation, installed/enabled plugin,
source path and template fingerprint, then calls `resolveBound` with the original
origin, project, agent instance, plugin id and each variable name. Rotation is
observed at the next request. Off, removal, missing bindings and source changes
refuse a request without falling back to any previously resolved value. A changed
account binding produces a new connector id and denies the previous registration;
resolution also pins the expected account ref across the authorization boundary,
so rebinding cannot reuse another account's upstream MCP session.

Internal connector aliases remain provider-safe for receipts; adapters map them
back to the native server name. Claude uses `plugin:<plugin-name>:<server-name>`
and bypasses ordinary native-collision withholding only for these explicit
replacements. Codex uses a quoted native server key beside its disabled
plugin-scoped transport. Reserved Scient names and unresolved Codex native
ownership collisions are withheld. There is no arbitrary name-collision override.

Codex supports local/git source roots and roots verified from skill paths inside
its configured plugin cache. The server-only root port is never exposed as an
RPC that reads arbitrary paths. Remote plugins without either source remain
unknown. Transient registrations store no credentials, are absent from the
user's connector file/list and are capped at 1,000 per runtime. Old session
bearers are still controlled by the existing MCP registry; a runtime restart
releases registration metadata. Unsupported stdio servers stay suppressed (see the launcher constraints below).

Tests exercise real Accounts rotation/revocation and origin checks, configuration
changes and agent ownership, adapter alias mapping, and the actual connector
forwarding/redaction pipeline with a synthetic reflected credential and a mocked
upstream fetch. They do not contact a real vendor or qualify provider behavior.

## Stdio launcher (unverified live in providers)

Claude and Codex replacements retain the same native server names as the HTTP
path. Only the Scient runtime executable, a generated launcher script path, and
one private envelope path enter provider configuration. Command, arguments and
resolved keys stay inside the envelope; no bound key enters the agent's env or
argv. The only launcher env setting is the non-secret Electron Node-mode flag.
Scient Agent remains unavailable.

The launcher uses the Accounts session writer under
`secrets/accounts-sessions/<sha256(threadId)>`: directories are 0700, files are
atomically written as 0600 using exclusive no-follow temporary opens. The JSON
envelope contains the command, unchanged literal arguments, and expanded env
settings. Known plugin-root placeholders are resolved by Scient; no shell is
used. Empty declared key env entries receive their bound values. Other unresolved
builtin templates are withheld rather than guessed.

Before writing, every required key must resolve through `resolveBound` with the
plugin-key consumer, agent, plugin id and project scope. No remote origin is
invented for a local process. Unbound, removed, Off, project-restricted or globally
disabled accounts withhold the server. Each preparation replaces an existing
stdio credential and snapshots current bindings, rather than reusing an old file.
An already running plugin retains its process env until that process ends; this
is startup authorization, unlike HTTP's per-request resolution.

The standalone launcher rejects missing files, symlinks, non-0600 permissions,
wrong ownership and oversized envelopes. It consumes the envelope before exec,
sets only the child process env, and uses POSIX `execve` with the original literal
argv. It removes Electron's Node-mode flag from that env. Plugin stderr is sent
to `/dev/null` so subprocess diagnostics cannot copy a bound key into provider
logs; launcher failures use one fixed message. MCP stdout remains the plugin's
protocol channel, so this does not sanitize a plugin's tool results.

Session credential release/replacement removes the exact files owned by that
credential, including unused envelopes; server scope shutdown removes leftovers.
Cancellation cannot leave partially issued file ownership. Startup uses Accounts'
existing 24-hour sweep for abandoned files, without deleting another active
session's recent files. Consumed envelopes cannot be reused to restart a process;
a fresh provider preparation supplies a new envelope.

Servers with `${NAME}` (or declared secret `${user_config.NAME}`) in their arguments
are withheld, even when the account is bound. The card and page say:
“Needs a key — this plugin passes its key on the command line, which Scient doesn't allow”.
Scient never expands a secret into the real server's argv. This guarantee covers
Scient's launch configuration; the plugin itself remains trusted code capable of
reading its env, producing tool results, or spawning other programs.

Tests execute the real wrapper on macOS with synthetic credentials, verify env,
literal argv, discarded stderr, 0600/0700 permissions, consumption, session/scope
cleanup, startup sweeping, unavailable bindings and generated provider config.
Claude SDK/Codex plugin replacement and packaged Electron execution remain
**unverified live**. Linux is unverified on this host; Windows fails closed. Node single-executable
(SEA) server deployments also withhold this path: their executable cannot run an
external launcher module; they need a separately qualified Node launcher runtime.

Remote-only discovery still requires a verified root. Codex can already derive a
contained cache root from a provider-reported skill path, even for a remote source.
A remote-only plugin with neither a local/git source path nor a verified cached
skill path remains unknown. The provider detail contract does not identify a
verified manifest root for this case; guessing cache paths from display names or
opaque ids would risk inspecting another plugin's files. No user plugin cache or
credential/config values were inspected to qualify this gap.

## HTTP response completion and rejected keys

Plugin-key HTTP delivery uses the existing bounded Undici transport and its
cached agent per egress policy. Connections are pooled by origin; Scient does
not deliberately repeat DNS/TLS setup on each request. DNS security checks still
apply when establishing a new connection. Claude plugin eligibility reads the
local installed-plugin index and contained manifest files; it does not spawn a
CLI. Accounts availability and `resolveBound` are checked before fetching, so a
slow external credential source or an account operation holding its lock can
still delay that phase. Authorization is not cached across requests.

A plugin-bound key is not an OAuth grant. An upstream 401, with or without
`WWW-Authenticate`, is never refreshed or replayed. The rejected exchange is
aborted and its body disposed of best-effort, without waiting for EOF or for a
body cancellation promise to settle. Transient plugin registrations do not
attempt to update a persisted connector status they do not own. The agent gets
a sanitized JSON-RPC auth error identifying Scient Accounts, with its request id
preserved. As with the other connector refusals, POST uses HTTP 200 plus a
JSON-RPC error rather than forwarding a vendor 401/OAuth challenge: the vendor's
resource metadata must not start an OAuth flow against Scient's proxy. No vendor
error body, credentials, or resource-metadata URL is forwarded. Scient-owned
OAuth connectors retain their existing single-refresh behavior.

`ConnectorRuntime.upstreamHeaders` measures only the outbound exchange until
headers arrive and records its HTTP method and response status. It records no
URL, header values or credentials. Compare it with the enclosing
`PluginKeyHttpDelivery.authorize`/Accounts spans to separate local eligibility
and credential-source latency from DNS, connection establishment and vendor
response time. An interrupted header span without a response status means the
client stopped waiting before upstream headers arrived. Rejected or cancelled
exchanges may discard their connection; a client-aborted DNS/TLS handshake cannot
leave a reusable socket. That cleanup is distinct from constructing a new agent
on every request.

The reported GitHub live trace had a first POST interrupted at the client's
five-second limit and later POSTs taking roughly three to five seconds, with no
GETs. That does not establish an SSE flush or OAuth-discovery failure. Local
real-TCP tests complete initialize and tools/list for JSON and open SSE, reuse
connections for sequential JSON calls, and reject synthetic keys after exactly
one upstream request, including a 401 whose body stays open. A controlled
cancellation test fails on the earlier implementation and passes when disposal
is independent of the auth response.

An isolated Claude Code 2.1.311 `--bare` probe used only temporary configuration,
synthetic keys and local fake MCP/model servers. JSON and SSE loaded tools;
401 with and without a metadata challenge made one `server/discover` and one
`initialize` request, without a retry loop. No login, keychain/OAuth reads or
live plugin profile were used. The GitHub five-second timeout was not reproduced
locally. Remote GitHub latency remains unqualified; the new header span is needed
to attribute a repeat precisely. Increasing Claude's timeout or retrying an
invalid key is not part of this change.

A single direct initialize probe on this host, using production `proxyFetch`
with the strict egress policy and a synthetic bearer (no Accounts or proxy route),
received HTTP 400 headers after 548 ms, with text/plain content and an auth
challenge present. The response body and challenge value were not inspected.
This single result neither reproduces the reported latency nor establishes a
remote 401 baseline; it is not a vendor latency guarantee.
