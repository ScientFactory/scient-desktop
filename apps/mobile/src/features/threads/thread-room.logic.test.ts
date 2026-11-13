import {
  MessageId,
  RoomParticipantId,
  TurnItemId,
  ROOM_MESSAGE_MAX_ATTACHMENTS,
  ROOM_MESSAGE_MAX_ATTACHMENT_BYTES,
  ROOM_MESSAGE_MAX_LENGTH,
  ROOM_REPLY_EXCERPT_MAX_LENGTH,
  type RoomDelivery,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  roomAuthorLabel,
  roomDeliveryLabel,
  roomPostError,
  roomReplyTarget,
} from "./thread-room.logic";

const guest = {
  kind: "guest",
  participantId: RoomParticipantId.make("person"),
  name: "Ada",
} as const;
const delivery = (status: RoomDelivery["status"], by: RoomDelivery["by"]): RoomDelivery => ({
  messageId: MessageId.make("message"),
  by,
  at: "2026-11-13T00:00:00.000Z",
  status,
});

describe("room message attribution", () => {
  it.each([
    [{ kind: "owner" } as const, "You"],
    [{ kind: "agent" } as const, "Agent"],
    [guest, "Ada"],
  ])("labels the owner, agent and named guest", (author, label) => {
    expect(roomAuthorLabel(author)).toBe(label);
  });

  it("uses the last successful delivery even after a cancelled resend", () => {
    expect(
      roomDeliveryLabel({
        deliveries: [
          delivery("sent", guest),
          delivery("sent", { kind: "owner" }),
          delivery("cancelled", guest),
        ],
      }),
    ).toBe("Sent to the agent by You");
    expect(roomDeliveryLabel({ deliveries: [delivery("cancelled", guest)] })).toBe(
      "Send to the agent cancelled",
    );
    expect(roomDeliveryLabel({})).toBeNull();
  });

  it("keeps a bounded reply snapshot and the source item identity", () => {
    const id = TurnItemId.make("original");
    expect(
      roomReplyTarget({ id, author: guest, text: "x".repeat(ROOM_REPLY_EXCERPT_MAX_LENGTH + 10) }),
    ).toEqual({
      itemId: id,
      author: guest,
      excerpt: "x".repeat(ROOM_REPLY_EXCERPT_MAX_LENGTH),
    });
  });
});

describe("posting to people", () => {
  it("rejects agent context and empty posts but accepts text or files", () => {
    expect(roomPostError({ text: "hello", attachments: [], context: { records: [{}] } })).toContain(
      "context only goes to the agent",
    );
    expect(roomPostError({ text: "  ", attachments: [] })).not.toBeNull();
    expect(roomPostError({ text: "hello", attachments: [] })).toBeNull();
    expect(roomPostError({ text: "", attachments: [{ sizeBytes: 1 }] })).toBeNull();
  });

  it("enforces the room text, count and combined file size limits before uploading", () => {
    expect(
      roomPostError({ text: "x".repeat(ROOM_MESSAGE_MAX_LENGTH + 1), attachments: [] }),
    ).not.toBeNull();
    expect(
      roomPostError({
        text: "",
        attachments: Array.from({ length: ROOM_MESSAGE_MAX_ATTACHMENTS + 1 }, () => ({
          sizeBytes: 1,
        })),
      }),
    ).not.toBeNull();
    expect(
      roomPostError({
        text: "",
        attachments: [{ sizeBytes: ROOM_MESSAGE_MAX_ATTACHMENT_BYTES }, { sizeBytes: 1 }],
      }),
    ).not.toBeNull();
    expect(
      roomPostError({
        text: "x".repeat(ROOM_MESSAGE_MAX_LENGTH),
        attachments: [{ sizeBytes: ROOM_MESSAGE_MAX_ATTACHMENT_BYTES }],
      }),
    ).toBeNull();
  });
});
