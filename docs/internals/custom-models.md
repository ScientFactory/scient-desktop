# Custom model connections

Status: implemented on the Pi, Droid, and Oh My Pi provider surfaces. Hosted-account,
platform-process, and visual acceptance remain separate from the automated fixtures.

## Ownership and boundaries

Scient owns environment-scoped connections, server-side credentials and model-specific agent
attachments. Pi, Droid, and Oh My Pi own inference, conversation construction and compaction. Other
agents need their own adapters and must not add another credential store.

The UI calls these **Custom models**. This catalog is distinct from the inherited
`providerInstances[id].config.customModels` slug list. Preserve that list and native Factory
`custom:` models. `ServerProviderModel.isCustom` identifies inherited slug entries, not BYOK
ownership: clients rebuild those entries, so runtime-discovered models must not use that flag.

Scient never imports or edits Pi's `auth.json`/`models.json` or Factory's
`~/.factory/settings.json`. Native profiles remain independently owned. Keys entered in Scient
use the existing restricted-file secret store, not OS-keychain encryption. Only a last-four-character
hint leaves that store; keys of four characters or fewer stay fully hidden. Pi and Oh My Pi receive
full keys in their processes (OMP through its bootstrap file, below); Droid is never given one (see
the key broker below). Full-access code running as the same OS user is not a separate security
boundary.

## Mutation and runtime lifetime

Operate-scoped RPCs use compare-and-swap revisions. New keys receive immutable references;
metadata commits atomically before the old key is removed. Resolution holds the same semaphore,
so rotation cannot delete a key halfway through a read. Metadata network requests run outside
that lock and never on settings-read or turn-start paths. Failed commits clean up the new key;
cleanup failures may leave unreferenced secret files, which are not served to agents. There is
no automatic orphan collector.

A credential cannot move to another origin without explicit re-entry/removal. Keys are literals, not
shell expressions. Surrounding whitespace is trimmed on save and on use, and a key with a line break
or NUL is not a valid key, for every agent. Only Droid needs more: an endpoint echoing a key with a
space or control character inside would JSON-escape it past the broker's withholding check, so
saving such a key for a connection attached to a Droid is refused with a message naming Droid, and
one already stored (saved for Pi or Oh My Pi, which use it as it is) becomes a credential error on
that connection in the Droid process only (`droidConnections`, like Oh My Pi's rule for a key
starting with `!`). Adding a model to an existing connection does not copy or rotate its key.

Discovery freshness, current-turn configuration and authority revocation are different. Adding a
model to a connection whose credential was already published, or changing non-revoking metadata,
leaves the current turn on its coherent configuration. Droid resumes into a fresh overlay at the
next idle boundary, also after a model's default reasoning level changed (the overlay carries it);
Pi refreshes its signature-cached registration before selection. OMP's
extension long-polls Scient for a newer model generation and acknowledges each generation it
registers; model listing and model selection wait (up to 5 seconds) until OMP has acknowledged the
generation current when they started, so a model added in Settings is selectable on the next turn
without an explicit refresh. A newly attached keyed connection, or a connection that becomes
publishable after starting without its key, is withheld until the next OMP process rather than
interrupting the current turn. Removing or rotating a loaded key, detaching a loaded model, or changing its endpoint
retires that process. Names and next-turn preferences do not interrupt work. Explicit
conversation reasoning choices still win.

Partial output is preserved and settlement is exactly once; the next request uses a fresh
generation and existing resume state. A pending non-revoking update must not make an active session
appear absent. Local retirement cannot undo submitted requests or revoke a key at its upstream
service.

## Agent bridges

Pi uses a scoped authenticated loopback bootstrap and a credential-free extension. Only the owning
process receives the random bootstrap capability, scrubbed before child tools spawn. The endpoint
closes with the process scope. Connection-namespaced native bindings preserve Pi's native transport,
model definitions and credentials of unrelated models. A global built-in key override is incorrect:
native stored credentials take precedence over legacy extension keys, and multiple Scient
connections must keep their selected keys. Keyless endpoints receive Pi's harmless placeholder.

Droid receives a disposable private settings overlay (directory 0700, file 0600). Its
[BYOK API formats](https://docs.factory.ai/model-independence/byok) map Chat Completions to
`generic-chat-completion-api`, Responses to `openai`, and Messages to `anthropic`. A model's
`reasoningEffort` is its default level (the user's choice when Droid sends it for the model, else
the metadata default) and is set only for known reasoning: without it Droid (0.213.0 to 0.230.0) reports `none`
for every level and sends no reasoning parameter, so such a model has no reasoning control. Droid
advertises off/low/medium/high for custom models. For effort APIs it sends the configured level
when selected, also one beyond that ladder (any other unlisted level is sent as the configured
one), and for Off only omits the parameter; Scient's ladder correction offers exactly the model's
levels among those, without Off. A model ID Droid knows from its own catalog is the exception:
Droid keeps its own ladder for it and applies its nearest level to a configured one outside it
(`gpt-5.2` with Minimal or Max runs at Low). Only Droid's answer to the write says so, which makes
the configured default best-effort: `applyDroidModelAndEffort` returns the replacement instead of
failing (thread start, model switch, text generation), the thread says it once, and the probe's
model walk writes each Scient model's default to offer Droid's level instead of the replaced one.
Any other requested level is a choice made in the conversation and fails when Droid applies
another. For Messages, Droid picks the request from its own model table by
model ID, whatever the overlay configures: Claude models it knows as adaptive get an effort level
(Max from Opus and Sonnet 4.6, Extra-high from Opus 4.7) and no thinking for Off; any other ID gets
budget thinking for low/medium/high, nothing for another level, and no thinking for the rest of a
thread that started without it. `droidAdaptiveClaudeLevels` mirrors the entries verified on both
versions, so those models are offered Off and their extra levels and every other Messages model
only low/medium/high; a model Droid adds later stays on those three until it is added there. A changed
default resumes into a new overlay at the next idle boundary.

OMP receives a generated, credential-free extension through its explicit `--extension` path. The
extension reads model definitions from an authenticated loopback endpoint. The endpoint token and
the keys of connections that are publishable when that process starts are in a private (0600)
per-process bootstrap file, which the extension reads and deletes while OMP loads
(`provider/omp/OmpExtensionBootstrap.ts`); nothing Scient generates is in OMP's environment,
because OMP's shell tools copy the process's real environment. Keys are registered as literal
values, never as environment-variable names; a key that starts with `!` (which OMP would run as a
command) is reported as a credential error. A newly attached key is not published to the old
process; the next OMP process receives it in its own bootstrap. The extension supports Chat
Completions, Responses, and Messages, and is used by discovery, conversations, and structured
background generation. Model removal, endpoint/protocol changes, and credential rotation retire
the OMP process rather than allowing a stale provider registration to continue.

These bridges are shared by discovery, conversations, structured background generation and **Test**.

### Droid key broker

Droid's agent can read anything its process can: its environment (inherited by the Execute tool)
and its overlay (Droid exports `FACTORY_RUNTIME_SETTINGS_PATH` to the shell). Droid's output masking
does not survive a transform such as `rev`. So Scient never gives Droid a real key: not in its
environment, overlay, argv or anything else Scient sends it. This is not a boundary against the OS
user's own files: like any program running as that user, Droid could read the secret store in
Scient's state directory (`secrets/`), and its Read tool opens any path without asking. Each Droid
runtime with at least one loaded connection owns a key broker in its scope: a listener on
`127.0.0.1` with one random route and one random 256-bit capability per loaded connection, keyless
ones included. A runtime with no connection to broker (no custom model attached, or none whose key
can be used) opens no listener. The overlay's `baseUrl` is the route and its
`apiKey` the capability. The broker:

- accepts only `POST` to the API path Droid appends for the connection's format (`/chat/completions`,
  `/responses`, `/v1/messages` and its token count) for a model configured on that connection, with
  the capability in the format's header (Bearer; `x-api-key` for Messages), compared in constant time;
  it refuses a request with `Origin`, a foreign `Host`, other routes or paths, or a body over 64 MiB;
- in the same synchronous step that starts each upstream request, checks the connection's
  credential, endpoint and format against the settings service's committed catalog, an in-memory
  snapshot replaced when a save commits or settings reload (never loaded on demand, no keys, no
  lock); a save removes an old key only after that commit. A rotation or removal therefore commits
  either before the check (the request is refused and the runtime retired) or after the request
  started (it is in flight, like any request already sent);
  the listener and every in-flight upstream request end with the runtime;
- sends the real key in the format's header to the real `baseUrl` plus the same path, never the
  capability, cookies or redirects; streams successful responses unbuffered and with their content
  unchanged; stops the upstream request when Droid hangs up; and withholds error responses that contain a key
  (below). Of the response headers it forwards only content type, caching, retry, request-id,
  rate-limit and `openai-*`/`anthropic-*` metadata, and drops any of those whose value contains a
  key or capability in any of the spellings below, on every status;
- routes upstream requests with the Droid instance's `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (Node's
  agent `proxyEnv`), the route Droid's own requests took. Droid's requests to the broker are loopback
  and exempt from any proxy (below);
- trusts, for HTTPS, the default roots plus the CA files the Droid instance's environment names in
  `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`, which Droid reads for its own requests (verified live:
  both on 0.213.0, `NODE_EXTRA_CA_CERTS` on 0.231.0). An unreadable file adds nothing, as in Node,
  and a certificate failure that follows names it. Verification is forced on the agent
  (`rejectUnauthorized: true`): `NODE_TLS_REJECT_UNAUTHORIZED` switches it off neither from the
  instance's environment (which Droid itself honours) nor from the server's own, where Node would
  otherwise take the default. That is the endpoint connection; a TLS connection to an `https://`
  proxy follows the server process's own TLS settings, because Node's proxy support takes no
  per-connection override;
- asks for an uncompressed response and, when an endpoint compresses anyway, decodes a successful
  one (gzip, deflate, br, zstd) so Droid receives plain content without `content-encoding` and the
  truncation rule still reads it; an encoding it cannot undo is answered with a 400 saying so;
- answers a request it could not get an answer for (connection refused, unknown host, TLS failure, a
  connection not established within 15 s, no response within the idle bound) with a 400 and the
  cause, "Scient could not connect to `<host>`: connection refused.", taken from the error's code,
  never its text. Droid retries a 5xx about 21 times over 200 s without a word and ends the turn on
  a 4xx with its message (verified against Droid 0.213.0 and 0.231.0), so the turn and **Test** fail
  with the reason. The 15 s bound covers only establishing the connection (TCP, and TLS for HTTPS,
  including a proxy's CONNECT and the handshake through its tunnel), so a stalled one is reported
  well inside what **Test** (45 s) and background generation (180 s) wait; an established connection
  keeps the idle bound, because a slow model is legitimate.

The broker is the only Droid code that unwraps a real key, and it sends the key only upstream. So
a real key can reach Droid only inside an upstream response:

- A successful response can hold a key only if the model already had it in context from elsewhere
  (a file Droid read, say), where Droid holds it anyway. Its content is relayed unchanged.
- An error response is where services echo keys. The broker reads it bounded to 64 KiB of UTF-8,
  plus a margin of sixteen times the longest key so a key the bound would cut is seen whole. If any
  of the runtime's keys or capabilities occurs in it raw, with every backslash removed (JSON
  escaping at any depth), percent-decoded or `\uXXXX`-decoded (each applied to both sides, decoding
  repeated until stable), the whole body is **withheld**: Droid gets the same status and a Scient
  error in the format's shape (`{"error":{…}}` for Chat Completions and Responses, which Droid 0.229
  shows as `401 <message>`; `{"type":"error","error":{…}}` for Messages, which it shows as the status
  and body) saying the endpoint returned that status and Scient withheld its response because it
  contained the API key. A body that is compressed despite the broker asking for none, or that does
  not decode to a fixed point within eight passes, is withheld as unchecked. Otherwise the body
  passes unchanged, cut at a character boundary. Nothing is ever partially redacted.
- Any occurrence withholds, so a very short or placeholder key (such as `ll`) can withhold an
  unrelated error; the status survives, the message does not. A server that needs no key should be
  configured with none.
- Threat model: withholding catches an honest service's accidental echo of the key, raw,
  JSON-escaped, percent- or `\u`-encoded. An endpoint that deliberately obfuscates the key (mixed or
  nested encodings, spelling it past the checked window) already holds it, having just received it,
  and gains nothing by getting it to Droid; such adversarial encodings are out of scope.

Droid's own output (stdout, stderr, native logs) is not redacted. The only secret Droid holds is its
capability, which works only on loopback, only for its runtime's connections and only while its
process lives, so its appearance in a transcript or log grants nothing the agent does not already
have.

Residual: the capability is readable by the agent while its process lives and works against the
broker, for that connection's models only, until the runtime closes. The real key is in nothing
Droid is given; Scient's secret store stays readable to it as to any process of the same user.

Header and path mapping, key isolation (`env`, a reversed `env`, the overlay and `ps eww $PPID`
run by the agent) and the whole path were verified live against Droid 0.228.0 and 0.229.0, and a
withheld 401 for each format against 0.229.0.

### Factory conversation sync

Droid uploads a session's messages and title to Factory (`/api/sessions/<id>/message/create`,
`update-title`) for every model, custom ones included. The Droid setting **Sync conversations to
Factory** (`cloudSessionSync`, default on) writes nothing when on, so Droid's own setting applies
and sync the user turned off in Droid stays off; the switch is not an override to on. Off writes
`cloudSessionSync: false` into the process overlay, which stops those uploads for the whole
process; resume is unaffected (verified against Droid 0.213.0 and 0.230.0). Droid still posts
`/api/llm/custom/usage` for each custom-model request with the model ID, token counts, the session
and message IDs and the configured `baseUrl`, which is the broker's loopback route, never the real
endpoint or key.

### Droid process environment

Every Droid process (sessions, status and model probes, native skills, text generation, sign-in,
managed-runtime and maintenance probes) gets the provider-neutral agent environment contract in
`apps/server/src/provider/agentProcessEnvironment.ts`: the login environment minus Scient and T3
internals (`T3CODE_`, `T3_`, `SCIENT_`, `VITE_` prefixes and `ELECTRON_RUN_AS_NODE`,
`ELECTRON_RENDERER_PORT`, `PORT`, case-insensitively), then the instance environment exactly as
configured, then loopback appended to both `NO_PROXY` spellings (one variable on Windows). Spawners
that merge the server's own environment into the child's (the process runner, Factory's SDK
transport) receive the removed names masked, so the merge cannot bring them back. Known Windows
limitation: an instance variable whose name differs from an inherited one only in case (`path`
beside `Path`) is set beside it, and the process may get the inherited value. Oh My Pi's
processes use the same contract without that merge, plus OMP's own home, profile and
session-directory handling (`docs/internals/providers.md`). `FACTORY_API_KEY` from the login or
instance environment still reaches Droid; it is Droid's own documented authentication.

### Request limits

Besides the turn's own requests, Droid (0.213.0 to 0.230.0) sends one titling request per new
session to the selected model, with the first user message and a 32-token output limit (plus the
reasoning budget); for a custom model it passes the broker and counts toward the first turn's
budget.

When every response stops at the output limit, Droid asks the model to continue without bound. For
Scient custom models the broker counts requests per turn and ends the turn after five consecutive
truncated responses (Chat Completions `length`, Messages `max_tokens`, Responses `incomplete:
max_output_tokens`) or 1,000 requests. A few continuations are legitimate; the ceiling is far above
a long agentic turn and only bounds a loop the truncation rule cannot see. Both are request counts
that stop a runaway loop, not a spending limit: they bound neither tokens nor cost. The broker then
refuses further requests for that turn, including steers, and Scient cancels the Droid prompt and
ends the turn as a token-limit stop with a warning; partial output stays, and the Droid process is
not reused. Factory-hosted models are billed by Factory and never pass the broker, so their loops
are not limited by Scient.

Droid retries a 429 or 5xx answer by itself (about 6 attempts over 20 seconds for 429, 21 over
about 200 seconds for 500, on 0.229.0) and shows nothing meanwhile. The broker reports a turn's
first such status and the adapter adds one notice to that turn saying the endpoint answered it and
Droid is retrying. A turn whose process a Custom models change retired ends cancelled with a notice
saying so.

### Background generation

Titles, commit messages, PR text, branch names and **Test** run without tools. Droid cannot withhold
its tools in ACP mode (its tool flags and tool-selection settings are ignored there), and its Read
tool needs no permission at any autonomy. So the process overlay adds a `PreToolUse` hook that exits
2, which makes Droid refuse every tool call before it runs, MCP tools included; for Scient custom
models the broker also removes tool definitions from requests, while Factory-hosted models are still
offered Droid's tools. Removing the definitions is not enough on its own: a custom endpoint can
answer with a tool call it was not offered, Droid dispatches it, and only the hook refuses it
(verified live on 0.213.0 and 0.230.0). Behind that, generation runs at Droid's `normal` autonomy, confirmed from
Droid's own `config_option_update` before the prompt (generation fails if it is not confirmed),
rejects every permission request and passes no MCP servers. The hook was verified on macOS only; on
Windows, where Droid runs hook commands through its Windows shell, it is unverified.

Which model: a selection made in Settings is applied as it is. Without one the selection is the
`DROID_DEFAULT_MODEL` marker (Droid's catalog varies per account and build), and Scient chooses
after `session/new`: the model whose option description carries the lowest Factory token rate
("0.08x Factory token rate"), names marked `[Deprecated]` aside, then, once that model is selected
and its ladder known, the lowest level it offers (`off`, `none`, `minimal`, `low`, …). A catalog
without rates leaves Droid's own default model and level. Verified live: `gpt-5.6-luna` at `none` on
0.213.0, `glm-5.3-flash` at `low` on 0.231.0; the background-generation live suite checks the choice
against the catalog of the Droid under test.

An organization policy with `allowManagedHooksOnly` makes Droid drop every non-organization hook,
the refusal included; autonomy and permission rejection still stop commands and edits, but Read asks
no permission, so without the hook a Read returns the file to the model's endpoint. One rule
therefore covers every model, Scient custom models included: before a prompt Scient checks both ends
(`provider/droid/DroidOrgPolicy.ts`, from Droid 0.213.0 and 0.230.0), and sends nothing unless both
confirm the hook:

- the policy sources Droid reads, in its order: the system managed-settings file (macOS
  `/Library/Application Support/Factory/settings.json`, Linux `/etc/factory/settings.json`, Windows
  `C:\Program Files\Factory\settings.json`; when it exists it is the only source), then
  `FACTORY_ORG_MANAGED_SETTINGS_LOCAL_PATH`, then `FACTORY_ORG_MANAGED_SETTINGS_URL` (never fetched:
  its presence alone refuses), then Droid's cached answer from Factory's policy API in its settings
  folder (`org-managed-settings.cache.json`, or `cache/org-managed-settings.json` before 0.230, each
  with a `.backup`). A policy that allows only managed hooks, or a present source Scient cannot read
  or parse, refuses. On Windows these variables (and `FACTORY_HOME_OVERRIDE`, `USERPROFILE`) match
  in any letter case, as Droid sees them; spellings with different values refuse, because which one
  Droid gets is not defined;
- a `SessionStart` hook in the same overlay leaves a marker; Droid runs it before answering
  `session/new`, so no marker means it dropped the overlay's hooks, whatever the source.

A refusal says the organization's policy disables (or may disable) Scient's tool blocking, that
Scient won't run background generation with Droid, and to choose another provider for titles, commit
messages, PR text and branch names. **Test** runs through the same path and is refused the same
way, in its own words (`droidToolGuardTestRefusal`): the test was not run, and the model can be tried
in a Droid thread, where the user's own autonomy applies. Remaining gap: on a first start without Droid's cache, Droid waits 3 seconds for Factory's policy
API and then starts with no policy; if the API answers later, the marker was written under no
policy and the first turn runs under it, without the hook (verified live). A policy changed during a
generation is not seen either.

## Automatic limits and availability

Endpoint capacity and an agent's request/compaction policy are not interchangeable. For example,
Pi 0.84.4 deliberately budgets some direct OpenAI models at 272k for pricing, below their advertised
capacity. Automatic Pi entries preserve exact native endpoint/protocol/model definitions; independently
verified service metadata can supply missing definitions. Unknown extension models need manual
configuration: defaults documented for Pi's separate `models.json` path are not silently injected.

Automatic Droid entries use complete verified limits when available; otherwise the optional fields
are omitted and Droid owns its defaults. OMP entries likewise require explicit or independently
verified context/output limits before registration; unknown automatic models stay out of its
catalog. This does not mean unlimited or endpoint-aware budgeting.
The pinned fixture observes a 32k output ceiling for an unknown model and 1024 when explicitly
configured. For `z-ai/glm-5.3-flash`, Droid sends 131072 across all three API formats with limits
omitted. Defaults are model-dependent; these fixtures do not establish the native effective context size. Unreported defaults remain
labelled as unreported. Manual settings are preserved and never rewritten by a background migration.

New SpaceXAI connections use Responses, matching Pi's native xAI catalog. Saved Chat Completions
connections retain their format and key; their transport identity is not silently changed.

Image input is independent of token limits and reasoning overrides. Automatic uses the applicable
native Pi definition or existing service metadata; explicit image choices win. Absent `imageInput`
preserves the legacy mode/boolean interpretation. Droid's pre-prompt guard uses the same loaded
custom-model capability as its overlay, not newer settings awaiting next-turn adoption.

Saved rows remain visible even when an agent cannot discover them. Per-agent assessments come
from the actual discovery bridge and are tied to the saved non-secret configuration. Availability
does not prove authentication or model quality. **Test** sends a small real request through the
chosen agent (one of the enabled agents the model is attached to; the result names it, and no
answer within 45 seconds is reported as such); charges may apply. A concurrent catalog edit
invalidates its result. New models start attached to the enabled agents that support custom models,
or only to the agent whose **Connect models** opened the editor. An attachment to an agent instance
that was later deleted is kept (nothing loads it) and does not block saving the connection; the
editor lists it as removed so it can be detached. A built-in driver's default instance counts as
present without a settings entry (after **Reset default instance**).
**Check again** explicitly rechecks the selected model's metadata, preserving IDs, keys and manual
intent, then refreshes agent discovery. Failed lookups retain applicable prior evidence as stale.
Public OpenRouter catalog bytes are shared across keys; authenticated evidence stays scoped.
There is no startup, periodic, or per-turn **public catalog** metadata fetch. OMP's local
model-definition endpoint is read at process start, whenever the custom-model settings revision
changes (the extension's long-poll returns as soon as Scient publishes a newer generation), and on
the `scient-models-refresh` command, which the barrier makes unnecessary for Scient's own
selections. Connections, and therefore the secret store, are resolved again only when that revision
changes or a refresh is forced; guarded RPCs check the cached authority.

## Recovery and qualification

An unrecovered Pi `length` or Droid ACP `max_tokens` completes execution with a persisted
`turn.truncated` activity. Partial output and tool results survive; a quiet notice explains the stop,
including in mobile's generic work log. The normal queue advances. Scient does not replay billed
requests or increase budgets automatically. Actual provider errors still fail, and structured
background generation rejects truncated results even if partial JSON parses. Agents can recover
internally before producing their final stop reason.

Automated fixtures use synthetic profiles, keys and endpoints. Native Pi fixtures cover all three
API formats and exact xAI Responses routing; Droid fixtures cover native/custom switching, transmitted
efforts, output ceilings and recovery. They do not establish hosted-account access, internal reasoning
quality, or visual acceptance.

Desktop/web support setup and testing; mobile consumes the provider catalog without connection
management. Provider model-list fetching is a useful next slice to reduce mistyped IDs, not a
guarantee of account access or reliable limits. Assisted subscription login, inference-server management,
model downloads and editor redesign remain separate work.
