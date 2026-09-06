# Custom-model reasoning: evidence, selection, and runtime state

Custom-model reasoning capabilities are server-resolved evidence saved separately from user intent. A model ID or the old `reasoning` boolean does not establish an effort ladder.

## Sources

- OpenRouter: exact entries from its models API; missing and null fields have different semantics. Gateway effort acceptance is not proof of distinct native compute levels.
- Anthropic: authenticated model capabilities, including thinking mode. Effort controls are exposed only when the Pi transport can apply the reported mode. Budget-only controls remain explicitly unknown rather than being recast as invented effort levels.
- OpenAI and SpaceXAI: a small exact-ID, dated catalog reviewed against official documentation. Unreviewed aliases, snapshots, and custom/proxy endpoints stay unknown.
- Manual override: explicitly user-configured, unverified support, levels, and an optional documented default. It declares standard API effort controls (adaptive thinking for Anthropic), not arbitrary server-specific thinking switches. Server-produced metadata submitted by a client is discarded on save.

`modelReasoning.ts` resolves evidence only during explicit model saves. Its bounded cache scopes evidence by endpoint, protocol, model, and credential identity. Requests reject redirects, cap response size, and have deadlines; there is no paid generation probe. `customModelReasoning.ts` caps the whole setup lookup at four seconds and falls back to cached evidence. A failed lookup may retain previous evidence, marked stale, only for an unchanged endpoint, protocol, model and credential. User limits and overrides remain separate and are not rewritten by discovery.

Setup snapshots the selected credential under the existing settings lock, releases that lock during discovery, then revalidates the revision before the atomic save. Server-produced facts are committed with that save and published through the existing settings change event. `getSettings`, runtime connection resolution, and turn startup do not perform metadata lookup. There is no startup, periodic or background refresh service. Pi's native hosted definitions remain authoritative where available; Droid's fallback evidence does not require Pi to be installed.

## Selection and application

For Pi, manual token limits do not opt out of native reasoning: an exact hosted endpoint/protocol/model match inherits the native reasoning definition unless the user explicitly overrides it. Overrides are applied directly from saved intent even when older settings have no derived metadata. Missing metadata must not erase either source, and stale metadata must not mask native controls. Unknown custom endpoints still require capability evidence or an explicit override; no model-name guessing or read-time network lookup is used.

Droid adopts changed capability values at the next idle boundary, keeping the active turn's overlay and metadata coherent. Loaded credential or model revocations retire the process promptly. Evidence timestamps, display names, and saved next-turn preferences do not interrupt work. Discovery snapshots are scoped to attached models rather than the global catalog revision.

`CustomModel.defaultReasoningLevel` is a saved Scient preference, separate from capability overrides and provider metadata. An enabled supported preference takes priority over the reported default; unsupported preferences fall back to the existing supported-default policy. Explicit conversation selections still win. Droid keeps its transport configuration independent of this preference so changing a default cannot change its available effort ladder. Its every-send validation is read-only: it cannot reapply a default over the selected effort, and an omitted selection retains the conversation's explicit effort. Both adapters use the same pure override-before-evidence projection; neither requires a derived snapshot to honor an explicit override.

- A concrete choice means that exact effort was requested for the next turn.
- The Pi and managed Droid composer resolve a concrete supported next-turn effort and dispatch that same value. Prefer the supported documented default; otherwise prefer Medium, then another available enabled effort.
- Off/None and legacy Default/Inherited are not menu choices. Existing sentinel selections resolve to the concrete next-turn default; backend compatibility for older callers remains intact.
- A stale saved effort outside the concrete reasoning menu resolves to the supported next-turn default in both display and dispatch. If no reasoning choices exist, no effort is dispatched. Other strict selectors retain their existing unavailable-value behavior.
- The reasoning menu contains levels and a selection checkmark only, without source/timestamp text, default rows, or inheritance actions.
- Discovery-session state is not conversation state and is not presented as the active reasoning setting.

Pi's shared application routine selects the model, reads its live controls, validates the requested effort, applies it, and reads back the state before prompting. Custom-model registration passes an explicit map, with unsupported levels set to null. Known Chat Completions effort controls explicitly enable serialization, overriding Pi's host heuristics (notably xAI); exact OpenRouter connections use its nested reasoning format. Unknown capability means omit reasoning controls, not assert that reasoning is disabled. The same verification applies to chat and background generation.

For older callers that omit effort, a model switch may clamp the inherited value to another supported level. Scient accepts and reports that effective value; an explicit request still must match the runtime readback. Queue items retain their captured selection, while steering does not reconfigure a running turn.

If an implicit inherited value is outside a nonempty qualified ladder, Scient applies one supported
default and verifies once. It does not retry transport errors, replace explicit choices, or invent
controls for unknown models.

The Scient Desktop provider maintainers own the small fallback catalog. Each entry's official
source is linked beside the table and the review date remains fixed until requalified; a recheck
cannot make a checked-in entry younger. Staleness is visible evidence, not a calendar-triggered
failure of unrelated builds. Pi's pricing/compaction policy is not evidence of another agent's defaults.

Droid 0.213.0 advertises an incomplete generic ACP ladder for custom Chat Completions models even when its request accepts and serializes Max. For exact Scient-managed models with known effort metadata, the runtime reads and validates the corrected provider ladder. Other protocols, native models, and unknown models retain live ACP controls. The correction is verified through the public ACP request path and a local HTTP wire fixture, not by changing the Droid binary.

## User-visible truth

The composer describes the concrete next-turn selection, not a measurement of model internals. Provenance remains internal metadata rather than routine UI copy. Pi's native setting readback stays internal: no confirmation banner or chat/tool activity is emitted. Older persisted reasoning notices are hidden without modifying history. Runtime confirmation proves configuration acceptance, not the model's internal compute or a proxy's faithful implementation.

These selection changes belong to Scient's Pi/custom-model integration. Native Codex and OpenCode behavior is unchanged. In particular, T3's OpenCode fallback ladder (upstream commit `dbc7bfa3f36`, #9287) is not evidence of model support and is not reused here. Pi refreshes custom configuration before selection but preserves unchanged registrations; it does not fetch an additional inventory before each turn.

## Qualification

Droid's gated live suites use `SCIENT_DROID_TEST_BINARY` and require its reported version to match the bundled managed catalog before exercising version-specific wire assertions. An unset variable skips these suites. Qualify a checksum-verified managed artifact; an older system installation is not evidence about the bundled release. On macOS arm64, Droid 0.213.0 passed the four live cases on 2026-09-06: image forwarding and length recovery with explicit/native limits, protocol switching, and Chat Completions reasoning serialization. These local endpoint fixtures do not establish hosted-account or cross-platform compatibility.

Focused tests cover provider payload parsing, missing/null fields, cache isolation and refresh failure, manual overrides, credential boundaries, explicit and inherited application, runtime mismatches, saved invalid values, and UI labels. The gated Pi reasoning live fixture uses a temporary profile and a local synthetic HTTP endpoint to inspect outgoing request parameters without accessing real provider credentials. Automated qualification does not replace visual/product acceptance.
