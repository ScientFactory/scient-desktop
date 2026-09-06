# Custom model connections

Status: implemented on the Pi feature branch; not merged. Earlier manual reviews do not qualify
the latest lifecycle, automatic-settings and readiness changes. Hosted-account and visual acceptance
of this pass remain separate from automated fixtures.

## Ownership and boundaries

Scient owns environment-scoped connections, server-side credentials and model-specific agent
attachments. Pi and Droid own inference, conversation construction and compaction. Other agents
need their own adapters; neither another credential store nor a mandatory inference proxy is needed.

The UI calls these **Custom models**. This catalog is distinct from the inherited
`providerInstances[id].config.customModels` slug list. Preserve that list and native Factory
`custom:` models. `ServerProviderModel.isCustom` identifies inherited slug entries, not BYOK
ownership: clients rebuild those entries, so runtime-discovered models must not use that flag.

Scient never imports or edits Pi's `auth.json`/`models.json` or Factory's
`~/.factory/settings.json`. Native profiles remain independently owned. Keys entered in Scient
use the existing restricted-file secret store, not OS-keychain encryption. Only a last-four-character
hint leaves that store; keys of four characters or fewer stay fully hidden. Full keys necessarily
reach the selected execution environment and model endpoint. Full-access code running as the same
OS user is not a separate security boundary.

## Mutation and runtime lifetime

Operate-scoped RPCs use compare-and-swap revisions. New keys receive immutable references;
metadata commits atomically before the old key is removed. Resolution holds the same semaphore,
so rotation cannot delete a key halfway through a read. Metadata network requests run outside
that lock and never on settings-read or turn-start paths. Failed commits clean up the new key;
cleanup failures may leave unreferenced secret files, which are not served to agents. There is
no automatic orphan collector.

A credential cannot move to another origin without explicit re-entry/removal. Keys are literals,
not shell expressions. Adding a model to an existing connection does not copy or rotate its key.

Discovery freshness, current-turn configuration and authority revocation are different:
adding a model or changing non-revoking capabilities leaves the current turn on its coherent
configuration. Droid resumes into a fresh overlay at the next idle boundary; Pi refreshes its
signature-cached registration before selection. Names and next-turn preferences do not interrupt
work. Explicit conversation reasoning choices still win.

Removing/rotating a loaded key, detaching a loaded model, or changing its endpoint retires that
process. This includes a loaded but unselected credential. Partial output is preserved and settlement
is exactly once; the next request uses a fresh generation and existing resume state. A pending
non-revoking update must not make an active session appear absent. Local retirement cannot undo
submitted requests or revoke a key at its upstream service.

## Agent bridges

Pi uses a scoped authenticated loopback bootstrap and a credential-free extension. Only the owning
process receives the random bootstrap capability, scrubbed before child tools spawn. The endpoint
closes with the process scope. Connection-namespaced native bindings preserve Pi's native transport,
model definitions and credentials of unrelated models. A global built-in key override is incorrect:
native stored credentials take precedence over legacy extension keys, and multiple Scient
connections must keep their selected keys. Keyless endpoints receive Pi's harmless placeholder.

Droid receives a disposable private settings overlay (directory 0700, file 0600). It contains
randomized environment references, not raw keys; only the owning child receives those variables.
Its [BYOK API formats](https://docs.factory.ai/model-independence/byok) map Chat Completions to
`generic-chat-completion-api`, Responses to `openai`, and Messages to `anthropic`.
Both bridges are shared by discovery, conversations and structured background generation.

## Automatic limits and availability

Endpoint capacity and an agent's request/compaction policy are not interchangeable. For example,
Pi 0.84.4 deliberately budgets some direct OpenAI models at 272k for pricing, below their advertised
capacity. Automatic Pi entries preserve exact native endpoint/protocol/model definitions; independently
verified service metadata can supply missing definitions. Unknown extension models need manual
configuration: defaults documented for Pi's separate `models.json` path are not silently injected.

Automatic Droid entries use complete verified limits when available; otherwise the optional fields
are omitted and Droid owns its defaults. This does not mean unlimited or endpoint-aware budgeting.
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
chosen agent; charges may apply. A concurrent catalog edit invalidates its result.
**Check again** explicitly rechecks the selected model's metadata, preserving IDs, keys and manual
intent, then refreshes agent discovery. Failed lookups retain applicable prior evidence as stale.
Public OpenRouter catalog bytes are shared across keys; authenticated evidence stays scoped.
There is no startup, periodic or per-turn metadata fetch.

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
