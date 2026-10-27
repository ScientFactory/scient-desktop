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
Add key opens the existing Accounts dialog directly as an API-key account and
binds only the id returned by a successful save. A failed binding leaves the
newly created account in Accounts for retry. The web never resolves a key value.

Plugin cards and pages show Needs a key from server eligibility. A workspace
plugin uses its environment/project identity for the status query; a global
page has no project and cannot claim a project-restricted account is ready.
Scient Agent shows its explicit unavailable message for detected key requirements.
Write controls obey both environment grants and the binding store's availability.
Browser tests cover binding, revocation, unbinding, account creation and read-only
access; visual acceptance in a desktop candidate remains unperformed.

## Remaining implementation and qualification

This foundation is not the complete plugin-key feature, including the smaller
HTTP delivery milestone from the plan of record. Remaining work:

3. Live qualification of generated native startup suppression. The adapter
   policy is implemented, with the unverified-live limits recorded below.
4. HTTP template validation and account-bound proxy injection through
   `resolveBound({ kind: "plugin-key", ... })`, retaining the original origin
   and project checks, plus provider-specific registration under original names.
5. Scoped stdio launcher files, 0600 enforcement, cleanup on all session exits,
   safe command substitution and provider configuration tests.
6. Synthetic startup/collision witnesses for each provider and browser coverage
   of binding, missing-key, unavailable-agent and revocation states.
7. Authorized real-provider tool calls and visual acceptance. No live tokens
   are needed or permitted in fixtures or qualification logs.

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
remain outside this detected-key policy. HTTP replacement and stdio delivery are
still pending; bound credential eligibility alone does not deliver a server.
