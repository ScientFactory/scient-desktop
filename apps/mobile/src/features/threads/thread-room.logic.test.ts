import {
  RoomParticipantId,
  ROOM_MESSAGE_MAX_ATTACHMENTS,
  ROOM_MESSAGE_MAX_ATTACHMENT_BYTES,
  ROOM_MESSAGE_MAX_LENGTH,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { roomAuthorLabel, roomPostError } from "./thread-room.logic";

const guest = {
  kind: "guest",
  participantId: RoomParticipantId.make("person"),
  name: "Ada",
} as const;
describe("room message attribution", () => {
  it.each([
    [{ kind: "owner" } as const, "You"],
    [guest, "Ada"],
  ])("labels the owner and a named guest", (author, label) => {
    expect(roomAuthorLabel(author)).toBe(label);
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
