import { describe, expect, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";

import {
  deriveTerminalAssistantMessageIds,
  deriveTurnFolds,
  deriveUnsettledTurnId,
  shouldPreserveAssistantLineBreaks,
  workEntryStandsAlone,
  type GroupingTimelineEntry,
} from "./workLogGrouping.ts";

const turn = TurnId.make("t1");
const at = (second: number) => `2026-09-27T14:00:${String(second).padStart(2, "0")}.000Z`;

const entries: GroupingTimelineEntry[] = [
  {
    id: "u1",
    kind: "message",
    createdAt: at(0),
    message: { id: "u1", role: "user", streaming: false, createdAt: at(0), updatedAt: at(0) },
  },
  { id: "w1", kind: "work", createdAt: at(5), entry: { turnId: turn, tone: "tool" } },
  {
    id: "a1",
    kind: "message",
    createdAt: at(8),
    message: {
      id: "a1",
      role: "assistant",
      turnId: turn,
      streaming: false,
      createdAt: at(8),
      updatedAt: at(8),
    },
  },
  {
    id: "a2",
    kind: "message",
    createdAt: at(20),
    message: {
      id: "a2",
      role: "assistant",
      turnId: turn,
      streaming: false,
      createdAt: at(20),
      updatedAt: at(20),
    },
  },
];

describe("work-log grouping", () => {
  it("finds the terminal assistant message of each response", () => {
    expect([...deriveTerminalAssistantMessageIds(entries)]).toEqual(["a2"]);
  });

  it("folds a settled turn's work behind a timed label", () => {
    const folds = deriveTurnFolds({
      timelineEntries: entries,
      terminalAssistantMessageIds: new Set(["a2"]),
      latestTurn: null,
      unfoldedTurnIds: new Set(),
      workIndicatesFailure: () => false,
    });
    expect([...folds.values()]).toEqual([
      {
        turnId: turn,
        anchorEntryId: "w1",
        createdAt: at(5),
        hiddenEntryIds: new Set(["w1", "a1"]),
        label: "Worked for 20s",
      },
    ]);
  });

  it("treats a running turn as unsettled", () => {
    expect(deriveUnsettledTurnId({ turnId: turn, state: "running", completedAt: null }, null)).toBe(
      turn,
    );
    expect(
      deriveUnsettledTurnId({ turnId: turn, state: "completed", completedAt: at(9) }, null),
    ).toBeNull();
  });

  it("keeps standalone work out of groups", () => {
    expect(workEntryStandsAlone({ tone: "error" })).toBe(true);
    expect(workEntryStandsAlone({ tone: "tool", sourceActivityKind: "context-compaction" })).toBe(
      true,
    );
    expect(workEntryStandsAlone({ tone: "tool" })).toBe(false);
  });

  it("preserves assistant line breaks only in Insight blocks", () => {
    expect(shouldPreserveAssistantLineBreaks("★ Insight ─────\nText")).toBe(true);
    expect(shouldPreserveAssistantLineBreaks("Plain\ntext")).toBe(false);
  });
});
