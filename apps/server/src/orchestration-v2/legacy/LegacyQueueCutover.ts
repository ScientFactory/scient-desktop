import { CommandId, MessageId, PlanId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { persistChatAttachments } from "../../AttachmentPersistence.ts";
import { ServerConfig } from "../../config.ts";
import { QueueError, readQueue, writeQueue } from "../../scient/threadQueue/Ledger.ts";
import { importLegacyQueue } from "../../scient/threadQueue/migration.ts";
import { discoverLegacyQueueThreads } from "../../scient/threadQueue/Store.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { claimPendingAttachments } from "../AttachmentClaims.ts";
import { LegacyV1ThreadImporter } from "./LegacyV1ThreadImporter.ts";

const retireAcceptedSource = Effect.fn("LegacyQueueCutover.retireAcceptedSource")(function* (
  threadId: ThreadId,
  queueItemId: string,
) {
  const sql = yield* SqlClient.SqlClient;
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
    const claimed = yield* claimPendingAttachments({ threadId, attachments });
    yield* orchestrator.dispatch({
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
      ...(item.composerSnapshot === undefined ? {} : { composerSnapshot: item.composerSnapshot }),
      ...(item.selectedScientSkillNames === undefined
        ? {}
        : { selectedScientSkillNames: item.selectedScientSkillNames }),
      ...(item.modelSelection === undefined ? {} : { modelSelection: item.modelSelection }),
      ...(item.runtimeMode === undefined ? {} : { runtimeMode: item.runtimeMode }),
      ...(item.interactionMode === undefined ? {} : { interactionMode: item.interactionMode }),
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
    });
    // Source retirement follows acceptance. A crash here replays the accepted
    // command receipt, even after the V2 message has been edited or delivered.
    yield* retireAcceptedSource(threadId, item.queueItemId);
    imported += 1;
  }
  return imported;
});

/** Scan both copied SQL documents and read-only JSON compatibility sources. */
export const cutOverLegacyQueues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const rows = yield* sql<{
    thread_id: string;
  }>`SELECT thread_id FROM scient_thread_queue ORDER BY thread_id`;
  const files = yield* Effect.tryPromise(() => discoverLegacyQueueThreads(config.stateDir));
  const threadIds = new Set([...rows.map((row) => ThreadId.make(row.thread_id)), ...files]);
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
