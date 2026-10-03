import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { OrchestrationV2ThreadProjection } from "./orchestrationV2.ts";
import {
  COMPACT_THREAD_SNAPSHOT_FORMAT,
  OrchestrationV2HttpThreadBoundedSnapshot,
  OrchestrationV2HttpThreadDetailSnapshot,
} from "./orchestrationV2SnapshotWire.ts";

const now = "2026-10-04T10:00:00.000Z";
function projection() {
  const item = {
    id: "item-1",
    threadId: "thread-1",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
    type: "assistant_message",
    streaming: false,
    messageId: "message-1",
    text: "Exact preserved answer. ".repeat(200),
  };
  return Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadProjection))({
    thread: {
      id: "thread-1",
      projectId: "project-1",
      title: "Authored title",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, rootThreadId: "thread-1", relationshipToParent: null },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [
      {
        id: "message-1",
        threadId: "thread-1",
        role: "assistant",
        runId: null,
        nodeId: null,
        text: item.text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy: "agent",
        creationSource: "provider",
      },
    ],
    plans: [],
    turnItems: [item],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [
      { position: 0, visibility: "local", sourceThreadId: "thread-1", sourceItemId: item.id, item },
      {
        position: 1,
        visibility: "inherited",
        sourceThreadId: "origin",
        sourceItemId: "origin-item",
        item: { ...item, id: "inherited-item", text: "Preserved inherited record" },
      },
      {
        position: 2,
        visibility: "synthetic",
        sourceThreadId: "thread-1",
        sourceItemId: item.id,
        item: { ...item, text: "Same identity, divergent snapshot record" },
      },
    ],
    updatedAt: now,
  });
}

describe("negotiated native snapshot item references", () => {
  it("round-trips every array and visibility record, keeping divergent and inherited items inline", () => {
    const original = projection();
    const codec = Schema.toCodecJson(OrchestrationV2HttpThreadBoundedSnapshot);
    const snapshot = {
      snapshotFormat: COMPACT_THREAD_SNAPSHOT_FORMAT,
      projection: original,
      snapshotSequence: 10,
      historyCursor: "cursor",
      hasMoreHistory: true,
      latestLocalTurnOrdinal: null,
    };
    const encoded = Schema.encodeSync(codec)(snapshot);
    expect(encoded).toHaveProperty("snapshotFormat", COMPACT_THREAD_SNAPSHOT_FORMAT);
    expect(encoded).toHaveProperty("projection.visibleTurnItems.0.itemIndex", 0);
    expect(encoded).not.toHaveProperty("projection.visibleTurnItems.0.item");
    expect(encoded).toHaveProperty(
      "projection.visibleTurnItems.1.item.text",
      "Preserved inherited record",
    );
    expect(encoded).toHaveProperty(
      "projection.visibleTurnItems.2.item.text",
      "Same identity, divergent snapshot record",
    );
    const decoded = Schema.decodeSync(codec)(encoded);
    expect(decoded.projection).toEqual(original);
    expect(decoded.historyCursor).toBe("cursor");
    expect(decoded.hasMoreHistory).toBe(true);
  });
  it("keeps the full legacy response shape when the explicit compact marker is absent", () => {
    const original = projection();
    for (const codec of [
      Schema.toCodecJson(OrchestrationV2HttpThreadDetailSnapshot),
      Schema.toCodecJson(OrchestrationV2HttpThreadBoundedSnapshot),
    ]) {
      const encoded = Schema.encodeSync(codec)({
        projection: original,
        snapshotSequence: 10,
        historyCursor: null,
        hasMoreHistory: false,
        latestLocalTurnOrdinal: null,
      });
      expect(encoded).not.toHaveProperty("snapshotFormat");
      expect(encoded).toHaveProperty("projection.visibleTurnItems.0.item.text");
      expect(Schema.decodeSync(codec)(encoded).projection).toEqual(original);
    }
  });
  it("rejects out-of-snapshot references rather than silently losing a visible record", () => {
    const codec = Schema.toCodecJson(OrchestrationV2HttpThreadDetailSnapshot);
    const encoded = Schema.encodeSync(codec)({
      snapshotFormat: COMPACT_THREAD_SNAPSHOT_FORMAT,
      projection: projection(),
      snapshotSequence: 10,
    });
    const encodedObject = Schema.decodeUnknownSync(
      Schema.Struct({
        snapshotFormat: Schema.String,
        snapshotSequence: Schema.Number,
        projection: Schema.Record(Schema.String, Schema.Unknown),
      }),
    )(encoded);
    const invalid = {
      ...encodedObject,
      projection: {
        ...encodedObject.projection,
        visibleTurnItems: [
          {
            position: 0,
            visibility: "local",
            sourceThreadId: "thread-1",
            sourceItemId: "item-1",
            itemIndex: 99,
          },
        ],
      },
    };
    expect(() => Schema.decodeUnknownSync(codec)(invalid)).toThrow();
  });
});
