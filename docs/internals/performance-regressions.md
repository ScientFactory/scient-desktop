# Performance regression checks

## Chat input takes priority

The pinned PDF.js 6.4.299 patch makes text-selection resets idempotent and skips
PDF-only selection geometry when no PDF text layer intersects the selection.
Typing or selecting in another editor must not move PDF selection-marker DOM
nodes, even when the PDF has never been selected. Leaving a PDF selection still
clears its transient selection state. `pdfSelectionIsolation.browser.test.ts`
checks these behaviors with the real PDF.js text-layer builder.

Permission-mode options retain their identity for the same supported modes and
managed policy. Composer controls should not render for ordinary draft edits;
permission ceilings and their explanations must still update when policy changes.
Workspace-scan subscriptions select only the scanning indicator, so refresh metadata
from one composer does not rerender another composer using the same workspace.

Chat responsiveness takes precedence over document work. The composer registers
typing, composition, and selection activity with `writing/inputPriority.ts`.
The Ask in chat comment textarea registers through the same native input observer;
moving focus into a citation popover must not release document work during typing.
Closing or blurring the comment editor releases its registration. Its browser
regression covers deferred work, IME composition, selection and saving the draft.
Nonessential work resumes after 500 ms without chat activity, or when focus leaves
the composer. This is cooperative scheduling within the renderer: it cannot
interrupt JavaScript already running or prevent operating-system paging stalls.

Opening a document pane also waits for quiet input before changing the chat's
width. The store's requested panel state stays authoritative; only presentation
waits. Closing is immediate, an opened pane remains open while typing resumes,
thread changes cannot release another thread's pending pane, and other panel
types retain immediate presentation.

New file-preview mounts yield through `ChatPriorityMount`, including the preview's
headers, metadata subscriptions and lazy module load. A lightweight loading surface
stays visible until chat input is quiet. The boundary cancels on closure and passes
the latest props when released; it does not re-key mounted editors on file renames.

File previews coalesce scroll notifications to the latest native scroll position.
PDF.js viewer updates and rendering continuations yield during chat activity;
document setup, progress notifications, and speculative search warmup also wait.
PDF pages retain their explicit PDF.js dimensions while `content-visibility: auto`
keeps offscreen page contents out of ordinary rendering. Native scrolling remains
available; pages and position indicators may catch up after the typing pause.
Render-clock labels also wait, while action deadlines retain their original timing.
The composer builds its initial document once rather than parsing the draft on
every React render; external replacements still use the controlled update path.

Qualify changes with both idle chat and concurrent large-PDF/text-file scrolling,
including multi-sentence drafts, composition, selection, blur, document closure,
and catch-up after input stops. Record memory pressure alongside the workload.
Input-to-next-frame callbacks are a latency proxy, not direct screen-paint or
operating-system key latency. Unit tests establish scheduling and cancellation;
they do not establish a performance improvement. Keep real-browser timing and
production-build qualification separate from those tests.

The v2 transport has a focused regression command:

```bash
vp run test:perf:v2-wire
```

It exercises the real v2 projection and client reducers. This matters because the older
built-app benchmark fixtures seed v1 orchestration events; running those fixtures against a v2
client can produce reassuring timings while missing the active transport path.

The v2 checks pin these invariants:

- Cold opens and history pages stop at about 1 MiB of encoded rows. A window that holds a user
  turn also stops at 10 user turns (20 on older pages) or 500 rows, so ordinary turns stay whole.
  Any other window, including the inside of one turn longer than 500 rows, stops at 75 rows. The
  snapshot query applies the same rule before it decodes payloads. Clients can opt into deferring
  large work groups until expansion. Messages and items outside those groups remain in normal
  history paging. Required control records and
  the at-least-one-row rule can exceed the byte target; it is not a hard cap.
- The bounded snapshot does not retain the full duplicate conversation-message table.
- Older activity is fetched in bounded HTTP pages and merged without disturbing the live scroll
  window.
- Clients with confirmed history paging opt into socket snapshot fallbacks that use the same
  bounded recent-history window and carry the cursor needed to fetch older history. Older clients
  and WebSocket-only starts retain the compatible full-snapshot fallback.
- Snapshot queries bound timeline reads per fork ancestor, not total rows: dependency and
  control records still accompany the window. Smaller socket frames alone do not establish a
  whole-server memory reduction.
- Resume catch-up checks the original 1 MiB persisted-payload budget before decoding, then
  replays at most 128 thread events and 1 MiB of projected event JSON before falling back to a
  snapshot. Raw JSON bytes are not a heap-memory cap. Raising this budget merely because output
  projects small can increase server allocations on repeated large tool updates.
- Raw command output, dynamic-tool result bodies, and inline file-change bodies are omitted at
  the wire boundary, including small outputs. Explicit failure flags and bounded result IDs
  preserve status and grouped action counts without shipping those bodies. Reasoning text,
  command lines, and search results ship when their work group loads. Subagent prompts and results
  and checkpoint control records still accompany the initial window.
  Persisted events remain complete; the existing diff endpoints still provide file content when
  requested.
  Explicit cross-environment transcript exports preserve full tool bodies so the destination
  agent can read the context. The export rejects timeline JSON above the file attachment limit
  before sending it; the client still applies its attachment limit to the complete file.
- Live command output reaches a client only through `orchestration.subscribeCommandOutput`, which
  an expanded command row opens and closes with itself. Raw output deltas are never orchestration
  events: adapters send them to the
  [command output hub](../../apps/server/src/orchestration-v2/CommandOutputHub.ts) ahead of
  ingestion, which keeps one bounded tail per running command and throttles each subscriber. Do not
  route output deltas through `turn_item.updated`: a busy command would flood the event store and
  block ingestion for every other thread.
- The initial shell contains active navigation rows only. Archived rows use the dedicated archive
  query, and transcript message bodies stay in thread detail regardless of message size.
- Shell resume sends deltas plus compact repository-enrichment metadata, not another full project
  and thread snapshot.
- Auto, steer, and restart sends resolve delivery from authoritative state inside the
  server's per-thread dispatch lock. Model selection and identified-checkpoint rollback also
  dispatch without first fetching a full thread projection when the server advertises support.
  Older servers retain projection-based validation. Explicit start sends already skipped that
  read, so this saving does not apply to every client send path.

When changing projection schemas, paging, shell synchronization, or thread state, run this command
alongside the focused package typechecks and a real-client pass on every affected surface. The
transport performance fixtures validate contract encoding and compare pre-compression RPC JSON
for the same synthetic workload, preserving historical application-object counts separately.
These are neither compressed WebSocket captures nor measurements of server RSS, and command
fixtures exclude unrelated settings calls and subscription events. Payload budgets belong in
these tests so regressions fail locally. The transfer budget integration test
(`apps/server/integration/transferBudgetV2.integration.test.ts`) sends the opt-ins current clients
send and caps the decoded bytes and rows of the bounded snapshot and one older page for a 900-row
agent turn, and of the cold-connect shell for a sidebar of settled threads and idle subagents. When
clients gain an opt-in, add it to the test's client queries and give a fixture the data it saves.

## Event store and startup

Sequence cursors must seek an index rather than scan retained history. The application sequence
index contains project events and v2 thread events; the per-thread sequence index contains only v2
thread events. Legacy-only and unknown threads must return zero without scanning other threads.
Catch-up queries keep sequence ranges and optional thread or command predicates indexable.

Startup selects recovery candidates from current projection state before reading full thread
projections. Candidate selection includes queued runs, pending runtime requests, live provider
sessions, background work, and unfinished delegated deliveries. Archived threads still participate
where recovery requires them. Completed thread history is not loaded merely to discover that no
work remains.

Projection verification decodes canonical rows in bounded pages, including shared provider records
and fork ancestry. Rebuild replays event pages through a fixed sequence within its transaction;
it must not collect the entire event log before projecting it.

The focused regression coverage lives in `OrchestrationEventStore.sequence.test.ts`,
`ProjectionRecovery.test.ts`, and the provider runtime recovery tests under `apps/server/src`.

## Background work and navigation

The settlement worker reads active, unpinned threads without explicit settlement overrides from
`ProjectionStore.getSettlementCandidates`. It reads the latest run and user-message timestamps,
rejects active runs and pending requests, and checks background work using the same derivation as
the shell. It does not load archived histories, fork ancestry, transcript counts, or provider
sessions. The orchestrator still validates the current thread before applying settlement.

Read receipts use `ProjectionStore.getThread` to load only canonical thread metadata. A visit
advances `lastVisitedAt` monotonically without changing `updatedAt` or decoding history. Shell
queries use a covering thread/run index for item counts and a partial index for nonterminal
background items, including idle items. Latest user-message reads use an index ordered by update
time.

Command palette results keep live VCS and linked pull-request queries leased to the visible
viewport, including a small overscan region. Cached badges remain available while leases are
released. Local Git status reads skip divergence calculations; callers that need ahead/behind
counts keep the full status path. Cached fetch failures share the existing backoff and log only
the actual failed attempt. Unchanged desktop environment bootstrap reads retain their array
identity so polling does not invalidate subscribers.

Local trace records and provider event logs use asynchronous, serialized file writes and rotation.
Batching synchronous appends still stalls the server event loop on slow storage, especially on
Windows. While a trace write is slow, producers keep up to one trace file of records, so the spans
that time a stall survive it; records drop only while the disk stays stuck. Provider logging
retains backpressure. Shutdown drains accepted writes before closing their scope.

Relay awareness queues one pending publication per thread and retains a follow-up when the thread
changes during a send. Transcript deltas and tool output do not enqueue awareness work. Run,
request, and relevant thread metadata events do. Configuration is checked before shell reads, and
connection changes invalidate published identities so relinking can publish unchanged state.
Failed publications retry the latest state up to five times with exponential delays. A new
relevant event resets the budget; successful publication, disabling, or unlinking cancels retries.
After the budget is exhausted, publication waits for another relevant event instead of generating
continuous traffic during an outage.

Focused coverage: `ProjectionSettlement.test.ts`, `ThreadSettlementService.test.ts`,
`runtimeLayer.test.ts`, `AgentAwarenessRelay.test.ts`, `GitVcsDriverCore.test.ts`, and
`desktopLocal.test.ts`.

## Mobile looping animations

`apps/mobile/package.json` sets Reanimated's `DISABLE_COMMIT_PAUSING_MECHANISM` so keyboard avoiding
animates on iOS. Reanimated documents that flag as safe only alongside React Native's
`preventShadowTreeCommitExhaustion`, which defaults to off and needs React Native built from source,
so our builds run without it. Reanimated commits each animation frame to the shadow tree, and
without commit pausing those commits can starve React's: the JS thread keeps retrying its commit,
the screen freezes, and back does nothing. Release builds retry forever; dev builds abort with
`ShadowTree.cpp: assertion failed (attempts < 1024)`. Looping animations that stay on screen while
heavy content renders should use React Native's `Animated` with `useNativeDriver: true`, which
updates views without commits, not Reanimated's `withRepeat`. The running-thread shimmer in
`thread-work-log.tsx` is the example.
