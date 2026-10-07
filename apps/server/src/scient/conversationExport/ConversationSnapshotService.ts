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
  type MessageId,
  type ThreadId,
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
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
          return {
            thread,
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
            : isConversationSnapshotReadError(cause)
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
      snapshot: { ...snapshotContent, contentDigest: `sha256:${Encoding.encodeHex(digest)}` },
      attachmentFiles,
    };
  });

  return ConversationSnapshotService.of({ capture });
});

export const layer = Layer.effect(ConversationSnapshotService, make);
