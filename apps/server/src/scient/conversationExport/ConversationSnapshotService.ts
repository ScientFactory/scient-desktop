/**
 * Captures a `ConversationSnapshotV1` from the durable projections: the thread
 * detail with its complete history, the projection sequence, and the thread's
 * latest event sequence are read in one SQL transaction, so the snapshot
 * reflects exactly one point in the event log. The transaction is released
 * before attachments are inspected or anything is rendered. The client's
 * timeline is never consulted.
 */
import {
  ChatAttachment,
  type ConversationSnapshotSelection,
  type ConversationSnapshotV1,
  type MessageId,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";
import {
  SnapshotRangeError,
  buildConversationSnapshot,
  canonicalSnapshotContent,
} from "@scientfactory/conversation";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resolveAttachmentPath, resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

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

export type ConversationSnapshotError =
  | ConversationThreadNotFoundError
  | ConversationRangeError
  | ConversationSnapshotReadError;

const isChatAttachment = Schema.is(ChatAttachment);

/** Every attachment a snapshot can reference: message attachments and answer attachments. */
function recordedAttachments(thread: OrchestrationThread): ReadonlyArray<ChatAttachment> {
  const answerAttachments = thread.activities.flatMap((activity) => {
    if (activity.kind !== "user-input.answer-submitted") return [];
    const byQuestion =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as { readonly attachmentsByQuestionId?: unknown })
            .attachmentsByQuestionId
        : undefined;
    if (typeof byQuestion !== "object" || byQuestion === null) return [];
    return Object.values(byQuestion).flatMap((value: unknown) =>
      Array.isArray(value) ? value.filter(isChatAttachment) : [],
    );
  });
  return [...thread.messages.flatMap((message) => message.attachments ?? []), ...answerAttachments];
}

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

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = yield* ProjectionSnapshotQuery;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;

  const locate = (attachment: ChatAttachment): string | null =>
    resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }) ??
    resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: attachment.id,
    });

  const read = (threadId: ThreadId) =>
    sql
      .withTransaction(
        Effect.all([
          query.getThreadDetailById(threadId, { fullHistory: true }),
          query.getSnapshotSequence(),
          sql<{ readonly threadSequence: number | null }>`
            SELECT MAX(sequence) AS "threadSequence"
            FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          `,
        ]),
      )
      .pipe(Effect.mapError((cause) => new ConversationSnapshotReadError({ cause })));

  const capture: ConversationSnapshotService["Service"]["capture"] = Effect.fn(
    "ConversationSnapshotService.capture",
  )(function* (input) {
    const [thread, sequence, watermark] = yield* read(input.threadId);
    if (Option.isNone(thread) || thread.value.deletedAt !== null) {
      return yield* new ConversationThreadNotFoundError({ threadId: input.threadId });
    }
    // Outside the transaction: attachment files are immutable once recorded.
    const attachmentFiles = new Map<string, string>();
    for (const attachment of recordedAttachments(thread.value)) {
      const path = locate(attachment);
      if (path === null || attachmentFiles.has(attachment.id)) continue;
      const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
      if (exists) attachmentFiles.set(attachment.id, path);
    }
    const capturedAt = DateTime.formatIso(yield* DateTime.now);
    const content = yield* Effect.try({
      try: () =>
        buildConversationSnapshot({
          thread: thread.value,
          snapshotSequence: sequence.snapshotSequence,
          threadSequence: watermark[0]?.threadSequence ?? 0,
          capturedAt,
          selection: input.selection,
          isAttachmentAvailable: (attachment) => attachmentFiles.has(attachment.id),
        }),
      catch: (cause) =>
        cause instanceof SnapshotRangeError
          ? new ConversationRangeError({ messageId: cause.messageId as MessageId })
          : new ConversationSnapshotReadError({ cause }),
    });
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(canonicalSnapshotContent(content)))
      .pipe(Effect.mapError((cause) => new ConversationSnapshotReadError({ cause })));
    return {
      snapshot: { ...content, contentDigest: `sha256:${Encoding.encodeHex(digest)}` },
      attachmentFiles,
    };
  });

  return ConversationSnapshotService.of({ capture });
});

export const layer = Layer.effect(ConversationSnapshotService, make);
