/**
 * SCIENT-OWNED. A fork does not copy tool progress rows that repeat the row
 * before them; its work log must still render exactly as the full copy would.
 */
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { withoutRepeatedToolUpdates } from "@t3tools/shared/scientForkToolUpdates";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "../../session-logic";

const at = (tick: number) => new Date(Date.UTC(2026, 0, 1) + tick * 1000).toISOString();

// A copied row has no origin sequence: the fork's timeline orders it by time, then id.
function toolRow(
  id: string,
  kind: "tool.updated" | "tool.completed" | "tool.denied",
  tick: number,
  toolCallId: string,
  payload: Record<string, unknown> = {},
  turnId = "turn-1",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    tone: "tool",
    summary: "Ran command",
    turnId: TurnId.make(turnId),
    createdAt: at(tick),
    payload: { itemType: "command_execution", toolCallId, title: "Ran command", ...payload },
  };
}

const progress = (id: string, tick: number, call: string, payload = {}) =>
  toolRow(id, "tool.updated", tick, call, { status: "inProgress", data: {}, ...payload });

function expectSameWorkLog(rows: ReadonlyArray<OrchestrationThreadActivity>, keptCount?: number) {
  const kept = withoutRepeatedToolUpdates(rows);
  if (keptCount !== undefined) expect(kept).toHaveLength(keptCount);
  expect(deriveWorkLogEntries(kept)).toEqual(deriveWorkLogEntries(rows));
}

describe("fork work log without repeated tool updates", () => {
  it("keeps parallel calls in the order they started", () => {
    const run = { data: { command: "sleep 5" } };
    const list = { data: { command: "ls" } };
    expectSameWorkLog(
      [
        progress("a1", 1, "call-a", run),
        progress("b1", 2, "call-b", list),
        progress("a2", 3, "call-a", run),
        progress("b2", 4, "call-b", list),
        progress("a3", 5, "call-a", run),
        toolRow("b-done", "tool.completed", 6, "call-b", { status: "completed", ...list }),
        toolRow("a-done", "tool.completed", 7, "call-a", { status: "completed", ...run }),
      ],
      6,
    );
  });

  it("keeps a title, a file and their order that only an earlier row reported", () => {
    expectSameWorkLog([
      progress("u1", 1, "call-edit", { title: "" }),
      progress("u2", 2, "call-edit", { title: "Inspect dataset", data: { filePath: "a.ts" } }),
      progress("u3", 3, "call-edit", { title: "" }),
      toolRow("done", "tool.completed", 4, "call-edit", {
        title: "",
        status: "completed",
        data: { path: "b.ts", filePath: "a.ts" },
      }),
    ]);
  });

  it("keeps the only visible row of a call", () => {
    expectSameWorkLog([
      progress("u1", 1, "call-hidden", { timelineBypass: true }),
      progress("u2", 2, "call-hidden", { timelineBypass: false }),
      progress("u3", 3, "call-hidden", { timelineBypass: true }),
    ]);
  });

  it("keeps the latest row of a call that never finished", () => {
    expectSameWorkLog(
      [
        progress("u1", 1, "call-long", { detail: "running" }),
        progress("u2", 2, "call-long", { detail: "running" }),
        progress("u3", 3, "call-long", { detail: "running" }),
        progress("u4", 4, "call-long", { detail: "running" }),
      ],
      2,
    );
  });

  it("keeps progress reported after a result and before a denial", () => {
    expectSameWorkLog(
      [
        progress("u1", 1, "call-x"),
        progress("u2", 2, "call-x"),
        toolRow("done", "tool.completed", 3, "call-x", { status: "completed", data: {} }),
        progress("late1", 4, "call-x"),
        progress("late2", 5, "call-x"),
        progress("late3", 6, "call-x"),
        toolRow("denied", "tool.denied", 7, "call-x", { status: "declined", data: {} }),
      ],
      6,
    );
  });

  it("renders the same for generated runs, including rows at the same instant", () => {
    // Deterministic generator: small pools so repeats and equal times are common.
    let seed = 20261001;
    const next = (bound: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      // The low bits of this generator cycle quickly; use the high ones.
      return Math.floor((seed / 2147483648) * bound);
    };
    const payloads: ReadonlyArray<Record<string, unknown>> = [
      {},
      { detail: "running" },
      { title: "" },
      { title: "Inspect dataset" },
      { data: { command: "ls" } },
      { data: { filePath: "a.ts" } },
      { data: { path: "b.ts", filePath: "a.ts" } },
      { data: { files: [{ path: "c.ts" }] } },
      { timelineBypass: true },
      { timelineBypass: false },
    ];
    let dropped = 0;
    for (let round = 0; round < 400; round++) {
      const rows: OrchestrationThreadActivity[] = [];
      let tick = 0;
      let repeat = { call: 0, payload: 0, turn: 0 };
      const total = 4 + next(40);
      for (let index = 0; index < total; index++) {
        // Often the same instant as the row before, as real providers report.
        tick += next(4) === 0 ? 0 : 1;
        const roll = next(16);
        const kind = roll === 0 ? "tool.completed" : roll === 1 ? "tool.denied" : "tool.updated";
        // Mostly repeat the previous row's call and payload, as real progress does.
        if (next(4) !== 0)
          repeat = { call: repeat.call, payload: repeat.payload, turn: repeat.turn };
        else repeat = { call: next(3), payload: next(payloads.length), turn: next(2) };
        rows.push(
          toolRow(
            // Fresh ids in no particular order, as a fork assigns them.
            `row-${next(1_000_000)}-${index}`,
            kind,
            tick,
            `call-${repeat.call}`,
            {
              status: kind === "tool.updated" ? "inProgress" : "completed",
              ...payloads[repeat.payload],
            },
            `turn-${repeat.turn}`,
          ),
        );
      }
      dropped += rows.length - withoutRepeatedToolUpdates(rows).length;
      expectSameWorkLog(rows);
    }
    // The generator must actually exercise the rule.
    expect(dropped).toBeGreaterThan(500);
  });
});
