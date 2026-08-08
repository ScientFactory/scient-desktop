import { MessageId, TurnId, type OrchestrationForkBoundary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mapForkBoundariesBeforeUserMessages } from "./forkBoundaries";

const NOW = "2026-08-08T00:00:00.000Z";

function boundary(input: {
  readonly count: number;
  readonly turnId: string | null;
  readonly userMessageId: string | null;
}): OrchestrationForkBoundary {
  return {
    turnId: input.turnId === null ? null : TurnId.make(input.turnId),
    conversationTurnCount: input.count,
    userMessageId: input.userMessageId === null ? null : MessageId.make(input.userMessageId),
    assistantMessageId: null,
    completedAt: NOW,
    checkpointTurnCount: null,
    checkpointStatus: null,
  };
}

describe("Scient fork boundary presentation", () => {
  it("maps the first user message to turn zero and later messages to their predecessor", () => {
    const zero = boundary({ count: 0, turnId: null, userMessageId: null });
    const first = boundary({ count: 1, turnId: "turn-1", userMessageId: "user-1" });
    const second = boundary({ count: 2, turnId: "turn-2", userMessageId: "user-2" });

    const mapped = mapForkBoundariesBeforeUserMessages([zero, first, second]);

    expect(mapped.get(MessageId.make("user-1"))).toBe(zero);
    expect(mapped.get(MessageId.make("user-2"))).toBe(first);
  });

  it("treats an inherited fork baseline as one immutable predecessor", () => {
    const baseline = boundary({
      count: 0,
      turnId: "fork-baseline",
      userMessageId: "inherited-user",
    });
    const firstNewTurn = boundary({
      count: 1,
      turnId: "fork-turn-1",
      userMessageId: "new-user",
    });

    const mapped = mapForkBoundariesBeforeUserMessages([baseline, firstNewTurn]);

    expect(mapped.has(MessageId.make("inherited-user"))).toBe(false);
    expect(mapped.get(MessageId.make("new-user"))).toBe(baseline);
  });
});
