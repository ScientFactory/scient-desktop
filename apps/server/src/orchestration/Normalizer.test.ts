import { it as effectIt } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { readQueue, writeQueue } from "../scient/threadQueue/Ledger.ts";
import { normalizeDispatchCommand, cleanupUnusedAttachments } from "./Normalizer.ts";
import { describe, expect, it } from "vite-plus/test";
import {
  ChatAttachment,
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { canonicalizeClientCommandTimestamps } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

const encodeAttachments = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ChatAttachment)));
const attachmentTestLayer = Layer.mergeAll(WorkspacePaths.layer, SqlitePersistenceMemory).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "queue-attachment-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
effectIt.effect(
  "reuses owned queue bytes internally, rejects client claims, and reclaims only retired bytes",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("owned-queue");
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("attachment-start"),
        threadId,
        message: {
          messageId: MessageId.make("attachment-message"),
          role: "user",
          text: "image",
          attachments: [
            {
              type: "image",
              id: "upload",
              name: "plot.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,YWJj",
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: serverReceivedAt,
      };
      const normalized = yield* normalizeDispatchCommand(command);
      if (normalized.type !== "thread.turn.start") throw new Error("Expected turn start");
      expect(normalized.sendIntent).toBe("normal");
      const steering = yield* normalizeDispatchCommand({ ...command, sendIntent: "steer" });
      expect(steering.type === "thread.turn.start" && steering.sendIntent).toBe("steer");
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const filePath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: normalized.message.attachments[0]!,
      })!;
      expect(yield* fs.readFileString(filePath)).toBe("abc");
      const denied = yield* Effect.result(normalizeDispatchCommand(normalized));
      expect(denied._tag).toBe("Failure");
      const internal = yield* normalizeDispatchCommand(normalized, {
        durableQueueAttachments: true,
      });
      expect(internal.type === "thread.turn.start" && internal.message.attachments).toEqual(
        normalized.message.attachments,
      );
      expect(
        (yield* Effect.result(
          normalizeDispatchCommand(
            { ...normalized, threadId: ThreadId.make("other") },
            { durableQueueAttachments: true },
          ),
        ))._tag,
      ).toBe("Failure");
      const doc = yield* readQueue(threadId);
      yield* writeQueue(threadId, {
        ...doc,
        items: [
          {
            queueItemId: "qitem_image",
            threadId,
            text: "image",
            attachments: normalized.message.attachments,
            state: "waiting",
            createdAt: serverReceivedAt,
            updatedAt: serverReceivedAt,
          },
        ],
      });
      yield* cleanupUnusedAttachments(normalized.message.attachments);
      expect(yield* fs.exists(filePath)).toBe(true);
      yield* writeQueue(threadId, { ...(yield* readQueue(threadId)), items: [] });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json) VALUES ('owned-message', ${threadId}, 'user', 'image', 0, ${serverReceivedAt}, ${serverReceivedAt}, ${yield* encodeAttachments(normalized.message.attachments)})`;
      yield* cleanupUnusedAttachments(normalized.message.attachments);
      expect(yield* fs.exists(filePath)).toBe(true);
      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'owned-message'`;
      yield* cleanupUnusedAttachments(normalized.message.attachments);
      expect(yield* fs.exists(filePath)).toBe(false);
    }).pipe(Effect.provide(attachmentTestLayer)),
);
