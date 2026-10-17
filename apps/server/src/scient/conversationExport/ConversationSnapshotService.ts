import * as Hex from "effect/encoding/Hex";
/**
 * Captures a `ConversationSnapshotV1` from the durable projections: the thread
 * detail with its complete history, the projection sequence, and the thread's
 * latest event sequence are read in one SQL transaction, so the snapshot
 * reflects exactly one point in the event log. The transaction is released
 * before attachments are inspected or anything is rendered. The client's
 * timeline is never consulted.
 */
import {
  type ChatAttachment,
  type ConversationSnapshotSelection,
  type ConversationSnapshotV1,
  type ThreadId,
  MessageId,
  TurnId,
  ScientConversationExportError,
} from "@t3tools/contracts";
import {
  SnapshotRangeError,
  buildConversationSnapshot,
  canonicalSnapshotContent,
  selectConversationContent,
  selectedConversationAttachments,
} from "@scientfactory/conversation";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Semaphore from "effect/Semaphore";

import { resolveAttachmentPath, resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  ProjectionStoreV2,
  ProjectionStoreThreadNotFoundError,
} from "../../orchestration-v2/ProjectionStore.ts";
import { EventStoreV2 } from "../../orchestration-v2/EventStore.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { LegacyV1ThreadImporter } from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Option from "effect/Option";
import { conversationSnapshotProjection } from "./conversationSnapshotProjection.ts";
import { turnItemMetadataSql } from "../../orchestration-v2/scient-fork/ContextHistorySql.ts";

/** A portable snapshot is assembled in memory for its digest and document writers.
 * Refuse beyond this capture allowance before hydration; retained sources remain
 * available through bounded detail pages. Attachment packaging has its own cap. */
const CONVERSATION_SNAPSHOT_CAPTURE_BYTES = 32 * 1024 * 1024;

export class ConversationThreadNotFoundError extends Schema.TaggedError<ConversationThreadNotFoundError>()(
  "ConversationThreadNotFoundError",
  { threadId: Schema.String },
) {}

export class ConversationRangeError extends Schema.TaggedError<ConversationRangeError>()(
  "ConversationRangeError",
  { messageId: Schema.String },
) {}

export class ConversationSnapshotReadError extends Schema.TaggedError<ConversationSnapshotReadError>()(
  "ConversationSnapshotReadError",
  { cause: Schema.Defect() },
) {}
const isConversationSnapshotReadError = Schema.is(ConversationSnapshotReadError);

export type ConversationSnapshotError =
  | ConversationThreadNotFoundError
  | ConversationRangeError
  | ScientConversationExportError
  | ConversationSnapshotReadError;

export interface CapturedConversation {
  readonly snapshot: ConversationSnapshotV1;
  /** Files of the attachments that were present at capture, by local attachment id. */
  readonly attachmentFiles: ReadonlyMap<string, string>;
}

export class ConversationSnapshotService extends Context.Service<
  ConversationSnapshotService,
  {
    readonly capture: (input: {
      readonly threadId: ThreadId;
      readonly selection: ConversationSnapshotSelection;
    }) => Effect.Effect<CapturedConversation, ConversationSnapshotError>;
  }
>()("t3/scient/conversationExport/ConversationSnapshotService") {}

const isThreadNotFound = Schema.is(ProjectionStoreThreadNotFoundError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = yield* ProjectionStoreV2;
  const events = yield* EventStoreV2;
  const projects = yield* ProjectStoreV2;
  const importer = yield* LegacyV1ThreadImporter;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const captureLock = yield* Semaphore.make(1);

  const locate = (attachment: ChatAttachment): string | null =>
    resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }) ??
    resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: attachment.id,
    });

  const read = (threadId: ThreadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const sizes = yield* sql<{ readonly bytes: number }>`
            WITH shown AS (
              SELECT ${turnItemMetadataSql(sql, sql`COALESCE(frozen.item_json, item.payload_json)`)} AS body
              FROM scient_fork_history AS history
              LEFT JOIN scient_fork_frozen_items AS frozen ON frozen.thread_id = history.thread_id AND frozen.position = history.position
              LEFT JOIN orchestration_v2_projection_turn_items AS item ON item.turn_item_id = history.source_item_id
              WHERE history.thread_id = ${threadId}
              UNION ALL
              SELECT ${turnItemMetadataSql(sql, sql`payload_json`)} FROM orchestration_v2_projection_turn_items AS item
              WHERE item.thread_id = ${threadId} AND NOT EXISTS (
                SELECT 1 FROM scient_fork_history WHERE thread_id = ${threadId} AND source_item_id = item.turn_item_id)
              UNION ALL SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}
              UNION ALL SELECT payload_json FROM orchestration_v2_projection_plans WHERE thread_id = ${threadId}
            ) SELECT COALESCE(SUM(octet_length(body)), 0) AS bytes FROM shown
          `;
          let remaining = CONVERSATION_SNAPSHOT_CAPTURE_BYTES - sizes[0]!.bytes;
          if (remaining < 0)
            return yield* new ScientConversationExportError({
              reason: "too-large",
              message:
                "This conversation exceeds the export capture allowance. Its retained history is still available through paged reads.",
            });
          const snapshot = yield* query.getThreadSnapshot(threadId);
          const project = yield* projects.get(snapshot.projection.thread.projectId);
          const thread = yield* Effect.try({
            try: () =>
              conversationSnapshotProjection(
                snapshot.projection,
                Option.getOrNull(project)?.workspaceRoot ?? null,
              ),
            catch: (cause) => new ConversationSnapshotReadError({ cause }),
          });
          const summaries: (typeof thread.messages)[number][] = [];
          for (const { item } of snapshot.projection.visibleTurnItems) {
            if (item.type !== "handoff") continue;
            const first = yield* query.getContextHandoffSummaryPage(
              threadId,
              item.contextHandoffId,
              0,
              0,
            );
            if (first?.handoff.historySource?.summaryOnly !== true) continue;
            if (first.textBytes > remaining)
              return yield* new ScientConversationExportError({
                reason: "too-large",
                message:
                  "The retained handoff summary exceeds the export capture allowance. It remains available through paged reads.",
              });
            remaining -= first.textBytes;
            const parts: string[] = [];
            yield* query.getContextHandoffSummaryPage(
              threadId,
              item.contextHandoffId,
              0,
              65536,
              (text) =>
                Effect.sync(() => {
                  parts.push(text);
                }),
            );
            summaries.push({
              id: MessageId.make(`handoff-summary:${item.id}`),
              role: "system",
              text: parts.join(""),
              turnId: item.runId === null ? (item.historyTurnId ?? null) : TurnId.make(item.runId),
              streaming: false,
              attachments: [],
              createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
              updatedAt: DateTime.formatIso(item.updatedAt),
            });
          }
          return {
            thread:
              summaries.length === 0
                ? thread
                : {
                    ...thread,
                    messages: [...thread.messages, ...summaries].toSorted((a, b) =>
                      a.createdAt.localeCompare(b.createdAt),
                    ),
                  },
            deletedAt: snapshot.projection.thread.deletedAt,
            sequence: snapshot.snapshotSequence,
            threadSequence: yield* events.latestSequence({ threadId }),
          };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isThreadNotFound(cause)
            ? new ConversationThreadNotFoundError({ threadId })
            : Schema.is(ScientConversationExportError)(cause) ||
                isConversationSnapshotReadError(cause)
              ? cause
              : new ConversationSnapshotReadError({ cause }),
        ),
      );

  const capture: ConversationSnapshotService["Service"]["capture"] = Effect.fn(
    "ConversationSnapshotService.capture",
  )(function* (input) {
    yield* importer
      .ensureTranscript(input.threadId)
      .pipe(Effect.mapError((cause) => new ConversationSnapshotReadError({ cause })));
    const { thread, deletedAt, sequence, threadSequence } = yield* read(input.threadId);
    if (deletedAt !== null) {
      return yield* new ConversationThreadNotFoundError({ threadId: input.threadId });
    }
    const rangeError = (cause: unknown) =>
      cause instanceof SnapshotRangeError
        ? new ConversationRangeError({ messageId: cause.messageId as MessageId })
        : new ConversationSnapshotReadError({ cause });
    const content = yield* Effect.try({
      try: () => selectConversationContent(thread, input.selection.throughMessageId),
      catch: rangeError,
    });
    // Outside the transaction: attachment files are immutable once recorded.
    // Only the selection's attachments are looked up.
    const attachmentFiles = new Map<string, string>();
    for (const attachment of selectedConversationAttachments(content)) {
      const path = locate(attachment);
      if (path === null || attachmentFiles.has(attachment.id)) continue;
      const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
      if (exists) attachmentFiles.set(attachment.id, path);
    }
    const capturedAt = DateTime.formatIso(yield* DateTime.now);
    const snapshotContent = yield* Effect.try({
      try: () =>
        buildConversationSnapshot({
          thread,
          snapshotSequence: sequence,
          threadSequence,
          capturedAt,
          selection: input.selection,
          content,
          isAttachmentAvailable: (attachment) => attachmentFiles.has(attachment.id),
        }),
      catch: rangeError,
    });
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(canonicalSnapshotContent(snapshotContent)))
      .pipe(Effect.mapError((cause) => new ConversationSnapshotReadError({ cause })));
    return {
      snapshot: { ...snapshotContent, contentDigest: `sha256:${Hex.encode(digest)}` },
      attachmentFiles,
    };
  }, captureLock.withPermits(1));

  return ConversationSnapshotService.of({ capture });
});

export const layer = Layer.effect(ConversationSnapshotService, make);
