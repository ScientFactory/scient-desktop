import { CommandId, MessageId, PlanId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { persistChatAttachments } from "../../AttachmentPersistence.ts";
import { ServerConfig } from "../../config.ts";
import { QueueError, readableQueueDocument, readQueue, writeQueue } from "./LegacyQueueLedger.ts";
import { importLegacyQueue } from "../../scient/threadQueue/migration.ts";
import { discoverLegacyQueueThreads } from "../../scient/threadQueue/Store.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { claimPendingAttachments, releaseClaimedAttachments } from "../AttachmentClaims.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { reconcileReservationsBestEffort } from "../AttachmentReservationReconciliation.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { LegacyV1ThreadImporter } from "./LegacyV1ThreadImporter.ts";

const retireAcceptedSource = Effect.fn("LegacyQueueCutover.retireAcceptedSource")(function* (
  threadId: ThreadId,
  queueItemId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* reconcileReservationsBestEffort();
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const current = yield* readQueue(threadId);
      yield* writeQueue(threadId, {
        ...current,
        items: current.items.filter((entry) => entry.queueItemId !== queueItemId),
        blocked: false,
        turnId: null,
        awaitingCompletion: true,
        paused: null,
      });
    }),
  );
});

/** Only original committed event references authorize retaining this attempt's copies. */
const reconcileClaims = Effect.fn("LegacyQueueCutover.reconcileClaims")(function* (
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  claimedPaths: ReadonlyArray<string>,
) {
  if (claimedPaths.length === 0) return;
  const receipts = yield* CommandReceiptStoreV2;
  const receipt = yield* receipts.getByCommandId(commandId);
  if (Option.isNone(receipt)) return yield* releaseClaimedAttachments(claimedPaths);
  if (receipt.value.threadId !== threadId || receipt.value.commandType !== "legacy-queue.import")
    return;
  if (receipt.value.status !== "accepted") return yield* releaseClaimedAttachments(claimedPaths);
  const sink = yield* EventSinkV2;
  const events = yield* sink.readByCommandId({ commandId }).pipe(Stream.runCollect);
  const messages = Array.from(events).flatMap(({ event }) =>
    event.type === "message.updated" &&
    event.payload.threadId === threadId &&
    event.payload.id === messageId
      ? [event.payload]
      : [],
  );
  // Missing/mismatched evidence is ambiguous. Later edits must never decide
  // ownership of the attachment bytes originally accepted by this command.
  if (messages.length !== 1) return;
  const config = yield* ServerConfig;
  const retained = new Set(
    messages[0]!.attachments.map((attachment) =>
      resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
    ),
  );
  yield* releaseClaimedAttachments(claimedPaths.filter((path) => !retained.has(path)));
});

/** Per-entry receipts let restart finish a partially admitted queue without replaying delivery. */
export const cutOverLegacyQueue = Effect.fn("LegacyQueueCutover.thread")(function* (
  threadId: ThreadId,
) {
  const orchestrator = yield* OrchestratorV2;
  const importer = yield* LegacyV1ThreadImporter;
  const receipts = yield* CommandReceiptStoreV2;
  const sql = yield* SqlClient.SqlClient;
  // Hydrate before rebinding any pending message identity to its native V2 run.
  yield* importer.ensureTranscript(threadId);
  const document = yield* importLegacyQueue(threadId, yield* readQueue(threadId));
  let imported = 0;
  for (const item of document.items) {
    const [owner] = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM scient_queue_receipts WHERE queue_item_id = ${item.queueItemId}`;
    if (owner !== undefined && owner.thread_id !== threadId)
      return yield* new QueueError({
        message: "The legacy queue identity belongs to another thread. Its source remains intact.",
      });
    if (item.threadId !== undefined && item.threadId !== threadId)
      return yield* new QueueError({
        message: "The legacy queue item belongs to another thread. Its source remains intact.",
      });
    const messageId =
      item.messageId ?? MessageId.make(`legacy-queue:${threadId}:${item.queueItemId}`);
    const commandId = CommandId.make(`legacy-queue:${threadId}:${item.queueItemId}`);
    const receipt = yield* receipts.getByCommandId(commandId);
    if (Option.isSome(receipt)) {
      if (
        receipt.value.status !== "accepted" ||
        receipt.value.threadId !== threadId ||
        receipt.value.commandType !== "legacy-queue.import"
      )
        return yield* new QueueError({
          message:
            "The legacy queue receipt does not confirm its admission. Its source remains intact.",
        });
      // Accepted V2 work owns its files and edits. Pending upload sources may
      // have expired; replay only the source retirement after a crash.
      yield* retireAcceptedSource(threadId, item.queueItemId);
      imported += 1;
      continue;
    }
    const [messageOwner] = yield* sql<{ thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_messages WHERE message_id = ${messageId}
    `;
    if (messageOwner !== undefined)
      return yield* new QueueError({
        message:
          "The legacy queue message identity already belongs to conversation history. Its source remains intact.",
      });
    const uploads = item.attachments.filter((attachment) => "dataUrl" in attachment);
    const saved = yield* persistChatAttachments({ threadId, messageId, attachments: uploads });
    const attachments = item.attachments.map((attachment) =>
      "dataUrl" in attachment ? saved[uploads.indexOf(attachment)]! : attachment,
    );
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claimed = yield* claimPendingAttachments({ threadId, attachments });
        yield* claimed.bindReceipt({
          kind: "command",
          threadId,
          commandId,
          commandType: "legacy-queue.import",
          target: { type: "message", messageId },
        });
        yield* restore(
          orchestrator.dispatch({
            type: "legacy-queue.import",
            commandId,
            threadId,
            queueItemId: item.queueItemId,
            messageId,
            text: item.text,
            attachments: claimed.attachments,
            ...(item.context === undefined
              ? {}
              : {
                  context: remapComposerContextAttachments(
                    item.context,
                    attachments,
                    claimed.attachments,
                  ),
                }),
            ...(item.composerSnapshot === undefined
              ? {}
              : { composerSnapshot: item.composerSnapshot }),
            ...(item.selectedScientSkillNames === undefined
              ? {}
              : { selectedScientSkillNames: item.selectedScientSkillNames }),
            ...(item.modelSelection === undefined ? {} : { modelSelection: item.modelSelection }),
            ...(item.runtimeMode === undefined ? {} : { runtimeMode: item.runtimeMode }),
            ...(item.interactionMode === undefined
              ? {}
              : { interactionMode: item.interactionMode }),
            ...(item.titleSeed === undefined ? {} : { titleSeed: item.titleSeed }),
            ...(item.sourceProposedPlan === undefined
              ? {}
              : {
                  sourceProposedPlan: {
                    ...item.sourceProposedPlan,
                    planId: PlanId.make(item.sourceProposedPlan.planId),
                  },
                }),
            createdAt: DateTime.makeUnsafe(item.createdAt),
          }),
        ).pipe(
          Effect.onExit(() =>
            reconcileClaims(threadId, messageId, commandId, claimed.claimedPaths)
              // Failed receipt/event reads cannot establish nonacceptance. Retain copies.
              .pipe(
                Effect.catch(() => Effect.void),
                Effect.andThen(
                  reconcileReservationsBestEffort(claimed.attachments.map((a) => a.id)),
                ),
              ),
          ),
        );
      }),
    );
    // Source retirement follows acceptance. A crash here replays the accepted
    // command receipt, even after the V2 message has been edited or delivered.
    yield* retireAcceptedSource(threadId, item.queueItemId);
    imported += 1;
  }
  return imported;
});

/**
 * Scan both copied SQL documents and read-only JSON compatibility sources.
 * A migrated document never reads its JSON source again, and one with no
 * items has nothing left to admit, so a finished cutover is skipped without
 * hydrating transcripts or parsing source files on every boot.
 */
export const cutOverLegacyQueues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const rows = yield* sql<{
    thread_id: string;
    document: string;
  }>`SELECT thread_id, document FROM scient_thread_queue ORDER BY thread_id`;
  // Only a schema-valid migrated document is evidence. Anything unreadable
  // stays on the retry path and reports its warning, as before.
  const migrated = new Set<ThreadId>();
  const pending: ThreadId[] = [];
  for (const row of rows) {
    const threadId = ThreadId.make(row.thread_id);
    const document = readableQueueDocument(row.document);
    if (Option.isSome(document) && document.value.migrated) {
      migrated.add(threadId);
      if (document.value.items.length === 0) continue;
    }
    pending.push(threadId);
  }
  const files = yield* Effect.tryPromise(() =>
    discoverLegacyQueueThreads(config.stateDir, migrated),
  );
  const threadIds = new Set([...pending, ...files]);
  let imported = 0;
  for (const threadId of threadIds) {
    imported += yield* cutOverLegacyQueue(threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "A legacy queue requires recovery; its remaining pending work is retained.",
          {
            threadId,
            errorTag: error._tag,
          },
        ).pipe(Effect.as(0)),
      ),
    );
  }
  return imported;
});
