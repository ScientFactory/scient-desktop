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
Ordinary provider switches keep T3's 16,000-token preparation allowance, one UTF-8 byte per
estimated token and 64,000-byte delivery ceiling. Scient fork, import and recovery history uses
`scientFork.contextHandoffSize`, estimates three UTF-8 bytes per token, and has no inherited 64 KB
ceiling. The environment override remains supported. Maximum spends the receiving model's
available context, after native occupancy, the complete current input, attachments and reserved
headroom; it never means unlimited transcript staging. Neither estimate is a provider tokenizer.

Scient handoffs capture immutable item membership by source identity. The creation event carries
that membership; the projection and delivery updates retain its source ID. Canonical items and
already-frozen fork versions own the bodies. Before a referenced item changes, its old body is
stored once for the rewrite and shared by every affected handoff. This source remains available
through ancestor edits, rollback, deletion and projection rebuild. Timeline rows carry coverage and
causal identity rather than another transcript.

The first command result and a repeated command's receipt use the same bounded event-read
representation. Projection and publication still commit from the original events; lossless event
payloads stay in the journal. Retrying a command does not change its returned history metadata.

Rebuild resets only the derived set of capture events already replayed. Kept bodies and membership
remain intact, and copy-before-write begins for each source when its capture event is reached.
Earlier streamed updates cannot replace a later captured version during replay.

Delivery resolves all pending sources under one receiving allowance, using the same whole-item
priority, attribution and serialized-cost functions as generic delivery. Only admissible individual
bodies cross the SQLite boundary; selected bodies remain live and omitted bodies are released.
Membership indexes are small metadata rather than rendered history. Private source membership
and delivery state do not appear on the client wire.

Existing embedded histories retain an immutable SQL source. Legacy messages are indexed once
inside the source reader's transaction, with small validation metadata indexed alongside each body,
then selected individually; startup validation does not rescan the archive for every page. Each delivery does not parse
and hydrate the complete JSON snapshot again. Malformed legacy JSON stays untouched for
verification/recovery to reject; it cannot abort source migration. Old summary-only handoffs retain their text and
include it whole when it fits. Their JSON string is decoded in bounded byte chunks, preserving
UTF-16 offsets and escapes. `scient_thread_read({threadId, contextHandoffId, textOffset,
maxCharsPerItem})` reads retained legacy summary text deliberately, under the same project/read
grant as the timeline. Continue with `textOffset=nextTextOffset` until null. Inherited summaries
come from the fork's frozen version, including after a parent changes its summary. Routine startup,
projection, single-item detail, inherited timeline and replay reads strip
handoff bodies in SQL before the driver creates JavaScript strings. These compatibility sources
and frozen versions survive rebuild; conversation deletion is not a prerequisite for the repair.

Portable export adds unique summary-only handoffs as inert system messages. It traverses their
source in 64 KB byte reads and bounded text pages, preserving escapes and surrogate halves without
rescanning the source for every page. The existing snapshot/digest writers assemble their final
snapshot in memory: capture therefore has a separate 32 MiB stored-payload allowance and one
capture at a time. Oversized captures return `too-large` before body hydration; they never silently
omit retained text. This capture allowance is independent of provider context and attachment
packaging. The history remains retained and available through paged reads.

The independent Scient migration ledger owns this representation. Generic provider accounting,
selection and formatting stay in provider-core; Scient owns presets, provenance, eligible inert
history and immutable membership. Reservation recovery queries the event log's publication facts
without collecting conversation events, and retains receipt ownership and locked token rechecks.

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
Its reader measures large scalar text in SQLite and formats one stripped item at a time, capped
at 128,000 bytes per read. Ordinary items retain their exact existing formatted cost; oversized
structured activity uses a conservative stored-byte estimate. It never collects the native transcript.

Historical messages retain item/run/thread/provider attribution. The handoff records omitted item
IDs and counts and tells the agent that history is context, not a new request or execution authority.
Its recovery pointer uses `scient_thread_read({threadId, view:"activity", limit:20,
maxCharsPerItem:4000})`; paginate using `afterPosition=nextPosition`, or fetch an individual `itemId`
with `textOffset=nextTextOffset`. Native tool/reasoning state and attachment bytes are not replayed
by this textual history delivery. Submitted callback answers are inert historical facts; copied
answer-file references do not by themselves reattach the original bytes.

Fork merge-back delivery uses the same whole-item selection and budget. New
`ContextHandoffServiceV2.prepareForkDelta` records retain an immutable history source as well as a
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
