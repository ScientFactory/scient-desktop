import {
  RoomMessageId,
  RunId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadFeed,
  createThreadFeedCache,
  deriveThreadFeedPresentation,
} from "./threadActivity";

const threadId = ThreadId.make("room-thread");
const time = DateTime.makeUnsafe("2026-11-13T00:00:00.000Z");
function roomRow(deleted = false) {
  const id = TurnItemId.make("room-item");
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: id,
    item: {
      id,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: time,
      completedAt: time,
      updatedAt: time,
      type: "room_message",
      roomMessageId: RoomMessageId.make("room-message"),
      author: { kind: "owner" },
      text: deleted ? "" : "A message to people",
      anchorRunOrdinal: null,
      ...(deleted ? { deletedAt: "2026-11-13T00:01:00.000Z" } : {}),
    },
  } satisfies OrchestrationV2ProjectedTurnItem;
}

describe("room timeline projection", () => {
  it.each([false, true])(
    "keeps room rows visible without treating them as agent messages or work",
    (deleted) => {
      const row = roomRow(deleted);
      const feed = buildThreadFeed([row]);
      expect(feed).toEqual([
        expect.objectContaining({ type: "room-message", runId: null, item: row.item }),
      ]);
      for (const toolCallVisibility of ["showAll", "hideAll", "zen"] as const) {
        const presented = deriveThreadFeedPresentation(
          feed,
          null,
          new Set(),
          new Set(),
          null,
          false,
          undefined,
          { toolCallVisibility, revealedMessageId: null },
        );
        expect(presented).toEqual(feed);
      }
    },
  );

  it("keeps a room message between collapsed work and the agent answer", () => {
    const room = roomRow();
    const runId = RunId.make("run");
    const work: OrchestrationV2ProjectedTurnItem = {
      ...room,
      sourceItemId: TurnItemId.make("work"),
      item: {
        ...room.item,
        id: TurnItemId.make("work"),
        runId,
        type: "command_execution",
        input: "check",
        output: "ok",
        exitCode: 0,
      },
    };
    const answer: OrchestrationV2ProjectedTurnItem = {
      ...room,
      position: 2,
      sourceItemId: TurnItemId.make("answer"),
      item: {
        ...room.item,
        id: TurnItemId.make("answer"),
        runId,
        type: "assistant_message",
        messageId: MessageId.make("answer"),
        text: "Done",
        streaming: false,
      },
    };
    const feed = buildThreadFeed([work, { ...room, position: 1 }, answer]);
    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.type)).toEqual(["run-fold", "room-message", "message"]);
    expect(collapsed[1]).toMatchObject({ item: room.item });
  });

  it("refreshes a cached row when a message is deleted", () => {
    const cache = createThreadFeedCache();
    const before = buildThreadFeed([roomRow()], { cache });
    const after = buildThreadFeed([roomRow(true)], { cache });
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]).toMatchObject({
      type: "room-message",
      item: { text: "", deletedAt: expect.any(String) },
    });
  });
});
