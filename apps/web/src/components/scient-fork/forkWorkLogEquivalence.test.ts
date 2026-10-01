/**
 * SCIENT-OWNED. A fork leaves superseded tool progress rows behind; its work
 * log must still render exactly as the copied prefix would with every row.
 */
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { withoutSupersededToolUpdates } from "@t3tools/shared/scientForkToolUpdates";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "../../session-logic";

const TURN = TurnId.make("turn-1");
const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;

// A copied row has no origin sequence: the fork's timeline orders it by time.
function toolRow(
  id: string,
  kind: "tool.updated" | "tool.completed" | "tool.denied",
  second: number,
  toolCallId: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    tone: "tool",
    summary: "Ran command",
    turnId: TURN,
    createdAt: at(second),
    payload: { itemType: "command_execution", toolCallId, title: "Ran command", ...payload },
  };
}

const progress = (id: string, second: number, call: string, payload = {}) =>
  toolRow(id, "tool.updated", second, call, { status: "inProgress", data: {}, ...payload });

function expectSameWorkLog(rows: ReadonlyArray<OrchestrationThreadActivity>, keptCount: number) {
  const kept = withoutSupersededToolUpdates(rows);
  expect(kept).toHaveLength(keptCount);
  expect(deriveWorkLogEntries(kept)).toEqual(deriveWorkLogEntries(rows));
}

describe("fork work log without superseded tool updates", () => {
  it("keeps parallel calls in the order they started", () => {
    expectSameWorkLog(
      [
        progress("a1", 1, "call-a", { data: { command: "sleep 5" } }),
        progress("b1", 2, "call-b", { data: { command: "ls" } }),
        progress("a2", 3, "call-a", { data: { command: "sleep 5" } }),
        progress("b2", 4, "call-b", { data: { command: "ls" } }),
        progress("a3", 5, "call-a", { data: { command: "sleep 5" } }),
        toolRow("b-done", "tool.completed", 6, "call-b", {
          status: "completed",
          data: { command: "ls" },
        }),
        toolRow("a-done", "tool.completed", 7, "call-a", {
          status: "completed",
          data: { command: "sleep 5" },
        }),
      ],
      4,
    );
  });

  it("keeps what only a progress row reported", () => {
    expectSameWorkLog(
      [
        progress("u1", 1, "call-edit", { data: { command: "apply" } }),
        progress("u2", 2, "call-edit", { data: { command: "apply", path: "src/a.ts" } }),
        progress("u3", 3, "call-edit", { data: { command: "apply" } }),
        progress("u4", 4, "call-edit", { data: { command: "apply" } }),
        // The result names neither the command nor the file.
        toolRow("done", "tool.completed", 5, "call-edit", {
          status: "completed",
          data: { result: "ok" },
        }),
      ],
      4,
    );
  });

  it("keeps the latest detail of a call that never finished", () => {
    expectSameWorkLog(
      [
        progress("u1", 1, "call-long", { detail: "1s" }),
        progress("u2", 2, "call-long", { detail: "2s" }),
        progress("u3", 3, "call-long", { detail: "3s" }),
      ],
      2,
    );
  });

  it("keeps progress reported after and at the same instant as a result", () => {
    expectSameWorkLog(
      [
        progress("u1", 1, "call-x"),
        progress("u2", 2, "call-x"),
        toolRow("done", "tool.completed", 3, "call-x", { status: "completed", data: {} }),
        // Stored after the result, shown before it.
        progress("tie", 3, "call-x"),
        progress("late1", 4, "call-x"),
        progress("late2", 5, "call-x"),
        progress("late3", 6, "call-x"),
      ],
      4,
    );
  });

  it("keeps the progress before a denial", () => {
    expectSameWorkLog(
      [
        progress("u1", 1, "call-denied"),
        progress("u2", 2, "call-denied"),
        progress("u3", 3, "call-denied"),
        toolRow("denied", "tool.denied", 4, "call-denied", { status: "declined", data: {} }),
      ],
      3,
    );
  });
});
