# Context handoffs

V2 supports switching provider instances inside an existing conversation. When the target cannot
reuse native context, the server prepares a portable handoff from durable app history. The model
picker remains unlocked when the environment supports provider switching through handoff. Its
**Continue in a new chat** footer is a separate Fork action: it opens Scient's fork dialog while
preserving the composer draft. An empty conversation, including one with only held queued future
messages, has no footer. Provider switches still show the **Context handoff** timeline row.

Portable provider delivery keeps eligible history items whole. It prioritizes the latest request and
answer, then the original request, and fills the remaining budget from newest to oldest. Selected
items are delivered in their original order. Oversized items are omitted rather than shortened.
The default cap is 16,000 tokens with a 64,000-byte ceiling; delivery reduces the budget for the
selected model's context window, native occupancy, current input, attachments and reserved headroom.
The implementation conservatively charges one UTF-8 byte per estimated token rather than using
a provider tokenizer; the default token allowance can therefore constrain bytes below the ceiling.

Historical messages retain item/run/thread/provider attribution. The handoff records omitted item
IDs and counts and tells the agent that history is context, not a new request or execution authority.
Its recovery pointer uses `scient_thread_read({threadId, view:"activity", limit:20,
maxCharsPerItem:4000})`; paginate using `afterPosition=nextPosition`, or fetch an individual `itemId`
with `textOffset=nextTextOffset`. Native tool/reasoning state and attachment bytes are not replayed
by this textual history delivery. Submitted callback answers are inert historical facts.

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
