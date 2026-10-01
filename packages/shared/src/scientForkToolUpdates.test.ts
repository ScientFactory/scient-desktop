import { describe, expect, it } from "vite-plus/test";

import { type ForkToolRow, withoutRepeatedToolUpdates } from "./scientForkToolUpdates.ts";

const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const row = (
  id: string,
  kind: string,
  second: number,
  payload: Record<string, unknown> = {},
  turnId = "turn-1",
): ForkToolRow => ({
  id,
  kind,
  tone: "tool",
  summary: "Ran command",
  turnId,
  createdAt: at(second),
  payload: { toolCallId: "call-1", ...payload },
});
const keptIds = (rows: ReadonlyArray<ForkToolRow>) =>
  withoutRepeatedToolUpdates(rows).map((kept) => kept.id);

describe("withoutRepeatedToolUpdates", () => {
  it("drops the rows between the first and last of identical progress rows", () => {
    expect(
      keptIds([
        row("u1", "tool.updated", 1, { data: { command: "ls" } }),
        row("u2", "tool.updated", 2, { data: { command: "ls" } }),
        row("u3", "tool.updated", 3, { data: { command: "ls" } }),
        row("u4", "tool.updated", 4, { data: { command: "ls" } }),
        row("done", "tool.completed", 5, { data: { command: "ls", output: "a" } }),
      ]),
    ).toEqual(["u1", "u4", "done"]);
  });

  it("keeps every row that differs from a neighbour", () => {
    expect(
      keptIds([
        row("u1", "tool.updated", 1, { title: "" }),
        row("u2", "tool.updated", 2, { title: "Inspect dataset" }),
        row("u3", "tool.updated", 3, { title: "" }),
        row("u4", "tool.updated", 4, { title: "" }),
        row("done", "tool.completed", 5, { title: "" }),
      ]),
    ).toEqual(["u1", "u2", "u3", "u4", "done"]);
  });

  it("compares the summary and tone, not only the payload", () => {
    expect(
      keptIds([
        row("u1", "tool.updated", 1),
        { ...row("u2", "tool.updated", 2), summary: "Running tests" },
        row("u3", "tool.updated", 3),
        { ...row("u4", "tool.updated", 4), tone: "error" },
        row("u5", "tool.updated", 5),
      ]),
    ).toEqual(["u1", "u2", "u3", "u4", "u5"]);
  });

  it("keeps the last row of a call that never finished", () => {
    expect(
      keptIds([
        row("u1", "tool.updated", 1),
        row("u2", "tool.updated", 2),
        row("u3", "tool.updated", 3),
      ]),
    ).toEqual(["u1", "u3"]);
  });

  it("keeps the progress row before a result or a denial", () => {
    expect(
      keptIds([
        row("u1", "tool.updated", 1),
        row("u2", "tool.updated", 2),
        row("u3", "tool.updated", 3),
        row("denied", "tool.denied", 4),
      ]),
    ).toEqual(["u1", "u3", "denied"]);
  });

  it("starts again after a result", () => {
    expect(
      keptIds([
        row("u1", "tool.updated", 1),
        row("done", "tool.completed", 2),
        row("late1", "tool.updated", 3),
        row("late2", "tool.updated", 4),
        row("late3", "tool.updated", 5),
      ]),
    ).toEqual(["u1", "done", "late1", "late3"]);
  });

  it("keeps rows whose order in the fork is not fixed by their time", () => {
    // Same instant as a neighbour: the fork may show them in either order.
    expect(
      keptIds([
        row("u1", "tool.updated", 1),
        row("u2", "tool.updated", 2),
        row("u3", "tool.updated", 2),
        row("u4", "tool.updated", 3),
      ]),
    ).toEqual(["u1", "u2", "u3", "u4"]);
    // A neighbour shares its instant with a different row.
    expect(
      keptIds([
        row("other", "tool.updated", 1, { detail: "starting" }),
        row("u1", "tool.updated", 1),
        row("u2", "tool.updated", 2),
        row("u3", "tool.updated", 3),
        row("u4", "tool.updated", 4),
        row("done", "tool.completed", 4),
      ]),
    ).toEqual(["other", "u1", "u2", "u3", "u4", "done"]);
  });

  it("orders a call by time, whatever order its rows arrive in", () => {
    expect(
      keptIds([
        row("done", "tool.completed", 4),
        row("u3", "tool.updated", 3),
        row("u1", "tool.updated", 1),
        row("u2", "tool.updated", 2),
      ]),
    ).toEqual(["done", "u3", "u1"]);
  });

  it("treats the same tool call id in another turn as another call", () => {
    expect(
      keptIds([
        row("a1", "tool.updated", 1, {}, "turn-1"),
        row("b1", "tool.updated", 2, {}, "turn-2"),
        row("a2", "tool.updated", 3, {}, "turn-1"),
      ]),
    ).toEqual(["a1", "b1", "a2"]);
  });

  it("leaves rows that name no tool call, and other kinds, untouched", () => {
    const plain = (id: string, kind: string, second: number, payload: unknown): ForkToolRow => ({
      ...row(id, kind, second),
      payload,
    });
    const rows = [
      plain("plain1", "tool.updated", 1, {}),
      plain("plain2", "tool.updated", 2, {}),
      plain("plain3", "tool.updated", 3, {}),
      plain("text1", "tool.updated", 4, "not an object"),
      plain("text2", "tool.updated", 5, "not an object"),
      plain("text3", "tool.updated", 6, null),
      row("task1", "task.progress", 7),
      row("task2", "task.progress", 8),
      row("task3", "task.progress", 9),
    ];
    expect(withoutRepeatedToolUpdates(rows)).toBe(rows);
  });

  it("changes nothing when applied again, as a fork of a fork does", () => {
    const once = withoutRepeatedToolUpdates([
      row("u1", "tool.updated", 1),
      row("u2", "tool.updated", 2),
      row("u3", "tool.updated", 3),
      row("u4", "tool.updated", 4),
      row("done", "tool.completed", 5),
    ]);
    expect(once.map((kept) => kept.id)).toEqual(["u1", "u4", "done"]);
    expect(withoutRepeatedToolUpdates(once)).toBe(once);
  });
});
