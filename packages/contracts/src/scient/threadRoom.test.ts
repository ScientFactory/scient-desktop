import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { NonNegativeInt, ThreadId, TurnItemId } from "../baseSchemas.ts";
import { OrchestrationV2TurnItem, OrchestrationV2TurnItemJson } from "../orchestrationV2.ts";

const now = DateTime.makeUnsafe("2026-11-13T10:00:00.000Z");
// What a client from before rooms decodes a notice as.
const oldNotice = Schema.Struct({
  type: Schema.Literal("system_notice"),
  id: TurnItemId,
  threadId: ThreadId,
  runId: Schema.Null,
  nodeId: Schema.Null,
  ordinal: NonNegativeInt,
  message: Schema.String,
});
const decodeOld = Schema.decodeUnknownSync(oldNotice);
const typeJson = Schema.toCodecJson(OrchestrationV2TurnItem);
const encodeTypeJson = Schema.encodeSync(typeJson);
const decodeTypeJson = Schema.decodeUnknownSync(typeJson);
const encodeJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);

const roomMessage = (overrides: Record<string, unknown> = {}) =>
  decodeItem({
    id: "room-item-1",
    threadId: "thread-1",
    type: "room_message",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 2_000_004,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    roomMessageId: "room-message-1",
    author: { kind: "guest", participantId: "p-1", name: "Dana" },
    text: "Could we try a log scale?",
    replyTo: { itemId: "assistant-1", author: { kind: "agent" }, excerpt: "Here is figure 2" },
    suggested: true,
    deliveries: [
      { messageId: "m-9", by: { kind: "owner" }, at: "2026-11-13T10:05:00.000Z", status: "sent" },
    ],
    anchorRunOrdinal: 2,
    ...overrides,
  });

describe("room messages", () => {
  it("round-trip through the stored and wire codecs, and older clients read them as a notice", () => {
    const item = roomMessage();
    expect(item.type).toBe("room_message");
    for (const encoded of [encodeJson(item), encodeTypeJson(item)]) {
      expect(decodeOld(encoded)).toMatchObject({
        type: "system_notice",
        message: "Dana (to people): Could we try a log scale?",
      });
      expect(decodeJson(encoded)).toEqual(item);
      expect(decodeTypeJson(encoded)).toEqual(item);
    }
  });

  it("tells older clients a deleted message was deleted, without its text", () => {
    const item = roomMessage({ text: "", deletedAt: "2026-11-13T10:06:00.000Z" });
    expect(decodeOld(encodeJson(item)).message).toBe("Dana deleted a message");
  });

  it("refuses a room message that names a run", () => {
    expect(() => roomMessage({ runId: "run-1" })).toThrow();
  });
});
