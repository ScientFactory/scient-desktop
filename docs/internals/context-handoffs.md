# Context handoffs

V2 supports switching provider instances inside an existing conversation. When the target cannot
reuse native context, the server prepares a portable handoff from durable app history. The model
picker remains unlocked when the environment supports provider switching through handoff. Its
**Continue in a new chat** footer is a separate Fork action: it opens Scient's fork dialog while
preserving the composer draft. An empty conversation, including one with only held queued future
messages, has no footer. Provider switches still show the **Context handoff** timeline row.

Fork initialization is represented by the fork boundary, so its separate context-handoff row is
hidden. Its inert causal proof names the original fork transfer, handoff, thread and run; copying
frozen history preserves that proof through later forks without restoring execution ownership.
A later provider switch, recovery or merge-back keeps its own row. Older local initialization rows
can be qualified from their exact transfer when first copied. Already-copied rows that lost that
cause remain visible; clients neither guess from the title nor query a live ancestor. Older clients
ignore the optional proof and can still show the additional historical row.

Portable provider delivery keeps eligible history items whole. It prioritizes the latest request and
answer, then the original request, and fills the remaining budget from newest to oldest. Selected
items are delivered in their original order. Oversized items are omitted rather than shortened.
The default cap is 16,000 tokens with a 64,000-byte ceiling; delivery reduces the budget for the
selected model's context window, native occupancy, current input, attachments and reserved headroom.
The implementation conservatively charges one UTF-8 byte per estimated token rather than using
a provider tokenizer; the default token allowance can therefore constrain bytes below the ceiling.

The complete current request has its own refusal gate in
[`AttachmentPrompt`](../../apps/server/src/orchestration-v2/AttachmentPrompt.ts), including expanded
composer citations, projected typed context, selected-skill instructions (including their trusted
runtime-instruction suffix where used), attachment descriptors and captured-window data.
`ProviderTurnStartService` validates that prepared material before allocating inherited history.
It is not truncated to make inherited history fit; inherited history uses the separate receiving budget.

Native model capacity is distinct from current context occupancy. The
[`NativeModelContextWindow`](../../apps/server/src/orchestration-v2/scient-fork/NativeModelContextWindow.ts)
owner scopes capacity to the exact provider instance, complete model selection and runtime/launch
configuration. Codex launch reports must be positive and finite and belong to the current accepted,
running root attempt; the sink rechecks its session/thread/turn ownership inside the transaction.
Stale owners do not commit. When an eligible report is present, its durable capacity write shares
the transaction with the canonical events and projections; not every transaction has a usage update.
Handoff budgeting separately subtracts native occupancy, current input and headroom. Missing
occupancy telemetry uses a conservative history/attachment estimate, not a newly reported capacity.

Historical messages retain item/run/thread/provider attribution. The handoff records omitted item
IDs and counts and tells the agent that history is context, not a new request or execution authority.
Its recovery pointer uses `scient_thread_read({threadId, view:"activity", limit:20,
maxCharsPerItem:4000})`; paginate using `afterPosition=nextPosition`, or fetch an individual `itemId`
with `textOffset=nextTextOffset`. Native tool/reasoning state and attachment bytes are not replayed
by this textual history delivery. Submitted callback answers are inert historical facts; copied
answer-file references do not by themselves reattach the original bytes.

Fork merge-back delivery uses the same whole-item selection and budget. New
`ContextHandoffServiceV2.prepareForkDelta` records contain intact historical messages as well as a
compact display summary. `ContextHandoffDelivery` delivers the history, so the former
240-character per-item summary rule is not the provider-delivery rule. Old records without a
`history` payload remain readable: their preformatted summary is included whole only when it fits,
otherwise the recovery pointer remains. Neither path claims native session parity.

Selection considers newer items first after the latest-request/latest-answer/original-request
anchors; delivery restores chronological order. `ContextHandoffBudget.ts` counts the larger of the
encoded native-history and inline-text representations, including attribution, escaping, and
wrappers. `ContextHandoffDelivery.ts` deduplicates previously delivered item IDs and persists
`pending` before injection or inline send, then `injected` or `inline` after acceptance. Ambiguous
pending delivery requires replacing the native thread before retry; insufficient allowance fails
without truncating the current request. See
[ContextHandoffBudget](../../apps/server/src/orchestration-v2/ContextHandoffBudget.ts) and
[ContextHandoffDelivery](../../apps/server/src/orchestration-v2/ContextHandoffDelivery.ts).

Legacy V1 data is hydrated into V2 app history before continuation or boundary inspection. Imported queued
future messages remain app-owned native held runs until explicitly released. Migrated transcripts
use the V2 portable delivery budget; the older V1 transcript-suffix algorithm is not the current
native authority or provider handoff rule.
