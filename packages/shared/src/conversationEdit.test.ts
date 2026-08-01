import { describe, expect, it } from "vitest";

import {
  collectTailTurnIds,
  interruptedTurnEditContext,
  resolveLatestTailUserMessageEditTarget,
  resolveTailUserMessageEditTarget,
} from "./conversationEdit";

describe("conversationEdit", () => {
  it("identifies only settled interrupted sessions as unanswered edit candidates", () => {
    const latestTurn = {
      turnId: "turn-interrupted",
      requestMessageId: "user-interrupted",
      state: "interrupted",
    };

    expect(interruptedTurnEditContext({ latestTurn, sessionStatus: "stopped" })).toEqual({
      messageId: "user-interrupted",
      turnId: "turn-interrupted",
    });
    expect(interruptedTurnEditContext({ latestTurn, sessionStatus: "interrupted" })).toEqual({
      messageId: "user-interrupted",
      turnId: "turn-interrupted",
    });
    expect(interruptedTurnEditContext({ latestTurn, sessionStatus: "ready" })).toBeNull();
    expect(
      interruptedTurnEditContext({
        latestTurn,
        sessionStatus: "interrupted",
        sessionActiveTurnId: "turn-interrupted",
      }),
    ).toBeNull();
    expect(
      interruptedTurnEditContext({
        latestTurn: { ...latestTurn, assistantMessageId: "assistant-output" },
        sessionStatus: "stopped",
      }),
    ).toBeNull();
    expect(
      interruptedTurnEditContext({
        latestTurn: { ...latestTurn, state: "completed" },
        sessionStatus: "stopped",
      }),
    ).toBeNull();
  });

  it("collects unique turn ids from a target message through the tail", () => {
    expect(
      collectTailTurnIds({
        messages: [
          { id: "m1", turnId: "turn-1" },
          { id: "m2", turnId: null },
          { id: "m3", turnId: "turn-2" },
          { id: "m4", turnId: "turn-2" },
        ],
        messageId: "m2",
      }),
    ).toEqual(["turn-2"]);
  });

  it("allows editing the native user message for the latest concrete turn", () => {
    expect(
      resolveLatestTailUserMessageEditTarget({
        messages: [
          { id: "user-1", role: "user", source: "native", turnId: null },
          { id: "assistant-1", role: "assistant", source: "native", turnId: "turn-1" },
        ],
      }),
    ).toEqual({
      editable: true,
      messageId: "user-1",
      messageIndex: 0,
      mode: "rollback",
      rollbackTurnCount: 1,
      removedTurnIds: ["turn-1"],
    });
  });

  it("allows editing the active tail prompt before assistant output exists", () => {
    expect(
      resolveTailUserMessageEditTarget({
        messages: [{ id: "user-active", role: "user", source: "native", turnId: null }],
        messageId: "user-active",
        activeTurnId: "turn-active",
      }),
    ).toMatchObject({
      editable: true,
      mode: "active-tail",
      rollbackTurnCount: 0,
      removedTurnIds: [],
    });
  });

  it("allows editing an interrupted tail prompt that never received assistant output", () => {
    expect(
      resolveTailUserMessageEditTarget({
        messages: [
          {
            id: "user-interrupted",
            role: "user",
            source: "native",
            turnId: null,
            createdAt: "2026-08-01T08:00:00.000Z",
          },
        ],
        messageId: "user-interrupted",
        interruptedTurn: {
          messageId: "user-interrupted",
          turnId: "turn-interrupted",
        },
      }),
    ).toMatchObject({
      editable: true,
      mode: "interrupted-tail",
      rollbackTurnCount: 1,
      removedTurnIds: ["turn-interrupted"],
    });
  });

  it("does not treat an unrelated metadata-free tail message as the interrupted prompt", () => {
    expect(
      resolveTailUserMessageEditTarget({
        messages: [
          {
            id: "user-imported",
            role: "user",
            source: "native",
            turnId: null,
            createdAt: "2026-07-31T08:00:00.000Z",
          },
        ],
        messageId: "user-imported",
        interruptedTurn: {
          messageId: "different-message",
          turnId: "turn-interrupted",
        },
      }),
    ).toEqual({ editable: false, reason: "missing-turn-metadata" });
  });

  it("rejects older native user messages", () => {
    expect(
      resolveTailUserMessageEditTarget({
        messages: [
          { id: "user-1", role: "user", source: "native", turnId: null },
          { id: "assistant-1", role: "assistant", source: "native", turnId: "turn-1" },
          { id: "user-2", role: "user", source: "native", turnId: null },
          { id: "assistant-2", role: "assistant", source: "native", turnId: "turn-2" },
        ],
        messageId: "user-1",
      }),
    ).toEqual({ editable: false, reason: "not-latest-native-user-message" });
  });

  it("rejects old tail messages that do not have turn metadata", () => {
    expect(
      resolveTailUserMessageEditTarget({
        messages: [
          { id: "user-old", role: "user", source: "native", turnId: null },
          { id: "assistant-old", role: "assistant", source: "native", turnId: null },
        ],
        messageId: "user-old",
      }),
    ).toEqual({ editable: false, reason: "missing-turn-metadata" });
  });
});
