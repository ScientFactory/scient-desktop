# Scient thread queue: design, seams, and retirement plan

This document is the maintenance contract for Scient's message-queue and steer
feature. It records what the feature promises, which parts Scient owns, the
exact T3-owned seams an upstream merge may touch, and how to delete the whole
feature when upstream T3 ships a native queue.

## Product behavior

- **Enter while a turn is running queues.** The composer clears and the
  message appears in a strip directly above the composer. It is _not_ sent.
- **Cmd/Ctrl+Enter steers.** The message dispatches immediately, even while a
  turn is running. Steering is provider-native today: the Claude adapter
  injects into the live SDK turn loop and Grok tracks in-flight prompts, so a
  steer is an ordinary `thread.turn.start` issued while `phase === "running"`.
- **Nothing auto-sends.** When a turn completes, queued items stay queued.
  Sending one queued item never dispatches the next.
- **Each queued item is individually actionable:** send (Steer while busy,
  Send while idle), edit (the item stays safely in the queue while its text
  and images are loaded into the composer), cancel an edit, and delete. Saving
  an edit updates the same queue item in place, so it keeps its position and
  cannot disappear if the user abandons the draft.
- **Drag to reorder.** Reorder is optimistic in the UI and validated
  server-side as an exact permutation.
- Queues are per thread, persist across app restarts, and are capped at 20
  items and 64 MiB per thread.

## Architecture: the queue is not an orchestration concept

A queued item is a _pending composer payload_, not a thread event. Therefore:

- No new orchestration command or event types. No decider, projector, or
  read-model changes. No SQLite migrations.
- Queue state lives in its own file store:
  `<stateDir>/scient/thread-queue/<threadId>.json`.
- Dispatch reuses the existing `thread.turn.start` command end to end. The
  queue disappears the moment an item is sent; nothing in the projection ever
  knew it existed.

This is deliberate. Orchestration involvement would create durable state that
a future T3 queue migration would have to reconcile; a file store makes
retirement a deletion, not a migration.

## Scient-owned implementation

New files only; none of these touch T3 internals:

- `packages/contracts/src/scientThreadQueue.ts` — item, snapshot, and
  request schemas. Reuses `UploadChatAttachment` and the existing provider
  send-size bounds.
- `apps/server/src/scient/threadQueue/Store.ts` (+ `Store.test.ts`) — the
  file store. Atomic temp-file + rename writes (mode `0600`), per-file
  promise lanes serialize mutations, thread IDs are SHA-256 hashed into safe
  filenames, the item and disk caps are enforced here (the real authority),
  removing the last item deletes the file, and a corrupt or oversized file is
  quarantined to `.corrupt-<uuid>` before the read fails closed to an empty
  queue. The old safe-filename format is migrated on first access.
- `apps/server/src/scient/threadQueue/http.ts` — thin auth (read/operate
  scopes) and error-mapping layer over the store.
- `packages/client-runtime/src/state/scientThreadQueueHttp.ts` — HTTP client
  functions (list/enqueue/update/remove/reorder).
- `apps/web/src/scient/threadQueue/` — all web logic:
  - `disposition.ts` (+ tests) — `resolveComposerSendDisposition`
    (steer-requested or idle → send; busy → queue) and `isSteerShortcut`
    (Cmd/Ctrl, not Shift).
  - `client.ts` — `runtime.runPromise` wrappers.
  - `queueImageRestore.ts` (+ tests) — rebuilds composer image attachments
    from stored data URLs when editing a queued item.
  - `useThreadQueue.ts` — authoritative snapshot state with generation and
    thread-context guards, refetch on mount/thread change/running→idle
    transition, optimistic reorder with rollback-refetch.
  - `ThreadQueueStrip.tsx` — the UI panel (dnd-kit sortable rows, explicit
    Send/Steer/Edit/Cancel/Delete actions, attachment counts, and a bounded
    scroll area). Renders only when items exist or the server reports an error.

## Narrow T3-owned seams

Every seam is marked with `SCIENT-FORK:START` / `SCIENT-FORK:END` comments and
is small enough to revert by deleting the marked block.

| Surface                                         | Deliberate change                                                                                                                                                                                                                                                                                                                         | Retirement condition                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/contracts/src/orchestration.ts`       | Export the already-existing `UploadChatAttachment` schema (was module-private).                                                                                                                                                                                                                                                           | T3 exports it natively or the queue is gone.        |
| `packages/contracts/src/index.ts`               | `export * from "./scientThreadQueue"`.                                                                                                                                                                                                                                                                                                    | Delete with the feature.                            |
| `packages/contracts/src/environmentHttp.ts`     | `EnvironmentScientThreadQueueHttpApi` group (`/api/scient/thread-queue/*`), its registration in `EnvironmentHttpApi`, and the `scient_thread_queue_operation_failed` error-reason literal.                                                                                                                                                | T3 ships a queue API; delete the group.             |
| `apps/server/src/server.ts`                     | Import and `Layer.provide` of the Scient queue HTTP layer.                                                                                                                                                                                                                                                                                | Delete with the feature.                            |
| `packages/client-runtime/package.json`          | `./state/scient-thread-queue` subpath export.                                                                                                                                                                                                                                                                                             | Delete with the feature.                            |
| `apps/web/src/components/chat/ChatComposer.tsx` | `onSend` gains an optional `{ steer?: boolean }` third parameter; `submitComposer` forwards it; the Enter handler treats Cmd/Ctrl+Enter as steer.                                                                                                                                                                                         | Map the shortcut onto T3's native steer affordance. |
| `apps/web/src/components/ChatView.tsx`          | Marked import block; `useThreadQueue` instantiation after `phase`; the queue branch inside `onSend` (after the final payload is computed, before optimistic-message handling); `dispatchQueuedItem` / `editQueuedItem` / `deleteQueuedItem` handlers after `onInterrupt`; the `<ThreadQueueStrip>` mount directly above `<ChatComposer>`. | Delete the blocks; mount T3's queue UI instead.     |

## Safety and bounded compromises

- The server is the authority for the 20-item cap and item validation; the UI
  never decides validity.
- Queued dispatch uses the thread's current model, runtime, and interaction
  settings; it does not silently inherit a different composer selection.
- Editing a queued item refuses to clobber a non-empty composer; the item
  remains persisted until the user saves or cancels the edit.
- A message is removed from the queue only after `thread.turn.start`
  succeeds. If the remove call fails after a successful send, the user gets a
  warning toast rather than a silent stale copy.
- The strip does not optimistic-render enqueues; the enqueue response is the
  snapshot. Local-first latency is accepted in exchange for one source of
  truth.
- Local draft threads (no server thread yet) have no queue surface.

## Upstream update procedure and retirement

Before each T3 merge, search the marked seams above and keep them minimal.

When T3 ships a native thread queue:

1. Check the native behavior against the product section. Adopt T3's
   disposition (what queues, what steers) even if it differs from this one.
2. Delete the Scient-owned files listed above.
3. Delete every marked seam block in the table above. With the feature gone,
   `UploadChatAttachment` may stay exported if something else uses it;
   otherwise restore module privacy.
4. Migrate data: queued items are JSON at
   `<stateDir>/scient/thread-queue/<sha256(threadId)>.json` with
   `{ formatVersion: 1, threadId, items: [{ queueItemId, text, attachments,
createdAt, updatedAt }] }`. The previous `<threadId>.json` safe-filename
   format is migrated on first access. Either enqueue them into T3's store on
   first run or leave the files (they are inert once nothing reads them).
5. Delete this document last.

## Verification checklist

- Store: enqueue/list/remove/reorder, cap enforcement, exact-permutation
  reorder, corrupt-file quarantine, path-unsafe thread IDs, atomic write
  recovery (`apps/server/src/scient/threadQueue/Store.test.ts`).
- Web units: disposition matrix and steer shortcut; image restore including
  malformed data URLs (`apps/web/src/scient/threadQueue/*.test.ts`).
- Typechecks for `packages/contracts`, `packages/client-runtime`,
  `apps/server`, and `apps/web`; targeted lint; `pnpm exec vp fmt --check`;
  `git diff --check`.
- Manual smoke when touching seams: Enter while running queues; Cmd/Ctrl+Enter
  steers; drag reorder persists across reload; edit restores text and images;
  delete removes; nothing auto-sends after a turn completes.
