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
The implementation uses a conservative byte-based token estimate rather than a provider tokenizer.

Historical messages retain item/run/thread/provider attribution. The handoff records omitted item
IDs and counts and tells the agent that history is context, not a new request or execution authority.
Its recovery pointer uses `scient_thread_read({threadId, view:"activity", limit:20,
maxCharsPerItem:4000})`; paginate using `afterPosition=nextPosition`, or fetch an individual `itemId`
with `textOffset=nextTextOffset`. Native tool/reasoning state and attachment bytes are not replayed
by this textual history delivery. Submitted callback answers are inert historical facts.

Fork merge-back summaries remain a separate path. `ContextHandoffServiceV2.prepareForkDelta`
summarizes user/assistant text, commands and prior handoffs with whitespace normalization and a
240-character maximum per text-bearing item; file changes carry filenames and checkpoints carry
file counts. This rule does not apply to portable provider history selection or exact fork-prefix
preservation. Neither a portable handoff nor a merge-back summary claims native session parity.

Legacy V1 data is hydrated into V2 app history before continuation or boundary inspection. Imported queued
future messages remain app-owned native held runs until explicitly released. Migrated transcripts
use the V2 portable delivery budget; the older V1 transcript-suffix algorithm is not the current
native authority or provider handoff rule.
