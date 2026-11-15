import { RoomParticipantId, ThreadRoomId, type ThreadRoom } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { composerSendIsForPeople, roomHasPeople } from "./roomComposerRouting";

const plain = {
  steer: false,
  alternate: false,
  directPrompt: false,
  annotation: false,
  queueEdit: false,
  answering: false,
  prompt: "What do you think of figure 2?",
};

describe("composerSendIsForPeople", () => {
  it("posts a plain new message for people", () => {
    expect(composerSendIsForPeople(plain)).toBe(true);
  });

  it.each([
    ["a steer", { steer: true }],
    ["the alternate send", { alternate: true }],
    ["a direct prompt", { directPrompt: true }],
    ["a preview annotation", { annotation: true }],
    ["an edit of a queued message", { queueEdit: true }],
    ["an answer to the agent", { answering: true }],
    ["a command", { prompt: "  /plan the analysis" }],
  ])("sends %s to the agent", (_name, change) => {
    expect(composerSendIsForPeople({ ...plain, ...change })).toBe(false);
  });
});

describe("roomHasPeople", () => {
  const now = Date.parse("2026-11-15T12:00:00.000Z");
  const room = (name: string | null, expiresAt: string): ThreadRoom => ({
    id: ThreadRoomId.make("room"),
    host: "env.scient.test",
    createdAt: "2026-11-01T00:00:00.000Z",
    participants: [
      {
        id: RoomParticipantId.make("a"),
        name,
        role: "discuss",
        invitedAt: "2026-11-01T00:00:00.000Z",
        expiresAt,
        joinedAt: name === null ? null : "2026-11-01T00:00:00.000Z",
      },
    ],
  });

  it("counts someone who joined and can still use the room", () => {
    expect(roomHasPeople(room("Ann", "2026-11-16T00:00:00.000Z"), now)).toBe(true);
  });

  it("ignores an unopened link and a person whose access ended", () => {
    expect(roomHasPeople(null, now)).toBe(false);
    expect(roomHasPeople(room(null, "2026-11-16T00:00:00.000Z"), now)).toBe(false);
    expect(roomHasPeople(room("Ann", "2026-11-15T00:00:00.000Z"), now)).toBe(false);
  });
});
