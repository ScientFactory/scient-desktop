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
  it("keeps a room message visible without treating it as an agent message or work", () => {
    const row = roomRow();
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
  });

  it("drops a room message once deleted or sent to the agent, and keeps it after a cancelled send", () => {
    const row = roomRow();
    const withDelivery = (status: "sent" | "cancelled") => ({
      ...row,
      item: {
        ...row.item,
        deliveries: [
          {
            messageId: MessageId.make("sent"),
            by: { kind: "owner" as const },
            at: "2026-11-13T00:00:00.000Z",
            status,
          },
        ],
      },
    });
    expect(buildThreadFeed([roomRow(true)])).toEqual([]);
    expect(buildThreadFeed([withDelivery("sent")])).toEqual([]);
    expect(buildThreadFeed([withDelivery("cancelled")])).toHaveLength(1);
  });

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

  it("drops a cached row when its message is deleted", () => {
    const cache = createThreadFeedCache();
    expect(buildThreadFeed([roomRow()], { cache })).toHaveLength(1);
    expect(buildThreadFeed([roomRow(true)], { cache })).toEqual([]);
  });
});
