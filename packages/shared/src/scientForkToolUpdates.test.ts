import { describe, expect, it } from "vite-plus/test";

import { type ForkToolRow, withoutSupersededToolUpdates } from "./scientForkToolUpdates.ts";

let tick = 0;
const row = (
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  options: { readonly turnId?: string; readonly createdAt?: string } = {},
): ForkToolRow => ({
  id,
  kind,
  turnId: options.turnId ?? "turn-1",
  createdAt: options.createdAt ?? `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  payload: { toolCallId: "call-1", ...payload },
});
const keptIds = (rows: ReadonlyArray<ForkToolRow>) =>
  withoutSupersededToolUpdates(rows).map((kept) => kept.id);

describe("withoutSupersededToolUpdates", () => {
  it("keeps the first progress row and the result of a finished call", () => {
    expect(
      keptIds([
        row("u1", "tool.updated", { status: "inProgress", data: { command: "ls" } }),
        row("u2", "tool.updated", { status: "inProgress", data: { command: "ls" } }),
        row("u3", "tool.updated", { status: "inProgress", data: { command: "ls" } }),
        row("done", "tool.completed", {
          status: "completed",
          data: { command: "ls", output: "a" },
        }),
      ]),
    ).toEqual(["u1", "done"]);
  });

  it("keeps a progress row whose field no later row carries", () => {
    expect(
      keptIds([
        row("u1", "tool.updated", { data: {} }),
        row("u2", "tool.updated", { data: { changes: ["a.ts"] } }),
        row("u3", "tool.updated", { data: {} }),
        row("done", "tool.completed", { data: { result: "ok" } }),
      ]),
    ).toEqual(["u1", "u2", "done"]);
  });

  it("lets a later value replace an earlier one, but not a changed list", () => {
    expect(
      keptIds([
        row("u1", "tool.updated", { detail: "1s", data: { files: ["a"] } }),
        row("u2", "tool.updated", { detail: "2s", data: { files: ["a"] } }),
        row("u3", "tool.updated", { detail: "3s", data: { files: ["a", "b"] } }),
        row("u4", "tool.updated", { detail: "4s", data: { files: ["a", "b"] } }),
      ]),
    ).toEqual(["u1", "u2", "u4"]);
  });

  it("keeps the latest progress row of a call that never finished", () => {
    expect(
      keptIds([
        row("u1", "tool.updated", { status: "inProgress" }),
        row("u2", "tool.updated", { status: "inProgress" }),
        row("u3", "tool.updated", { status: "inProgress" }),
      ]),
    ).toEqual(["u1", "u3"]);
  });

  it("does not fold progress into a denial", () => {
    expect(
      keptIds([
        row("u1", "tool.updated", { status: "inProgress" }),
        row("u2", "tool.updated", { status: "inProgress" }),
        row("denied", "tool.denied", { status: "inProgress" }),
      ]),
    ).toEqual(["u1", "u2", "denied"]);
  });

  it("starts a new run after a result", () => {
    expect(
      keptIds([
        row("u1", "tool.updated", {}),
        row("done", "tool.completed", {}),
        row("late1", "tool.updated", {}),
        row("late2", "tool.updated", {}),
        row("late3", "tool.updated", {}),
      ]),
    ).toEqual(["u1", "done", "late1", "late3"]);
  });

  it("orders a call as the fork timeline does: by time, progress before a result", () => {
    const at = "2026-01-01T01:00:00.000Z";
    expect(
      keptIds([
        row("u1", "tool.updated", {}, { createdAt: "2026-01-01T00:59:00.000Z" }),
        row("done", "tool.completed", {}, { createdAt: at }),
        // Stored after the result but shown before it: still part of the first run.
        row("u2", "tool.updated", {}, { createdAt: at }),
        row("late", "tool.updated", {}, { createdAt: "2026-01-01T01:01:00.000Z" }),
      ]),
    ).toEqual(["u1", "done", "late"]);
  });

  it("treats the same tool call id in another turn as another call", () => {
    expect(
      keptIds([
        row("a1", "tool.updated", {}, { turnId: "turn-1" }),
        row("b1", "tool.updated", {}, { turnId: "turn-2" }),
        row("a2", "tool.completed", {}, { turnId: "turn-1" }),
        row("b2", "tool.completed", {}, { turnId: "turn-2" }),
      ]),
    ).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("leaves rows that name no tool call, and other kinds, untouched", () => {
    const rows: ReadonlyArray<ForkToolRow> = [
      { id: "plain1", kind: "tool.updated", turnId: "turn-1", createdAt: "t1", payload: {} },
      { id: "plain2", kind: "tool.updated", turnId: "turn-1", createdAt: "t2", payload: {} },
      { id: "task", kind: "task.progress", turnId: "turn-1", createdAt: "t3", payload: null },
    ];
    expect(withoutSupersededToolUpdates(rows)).toBe(rows);
  });

  it("is stable when applied again, as a fork of a fork does", () => {
    const once = withoutSupersededToolUpdates([
      row("u1", "tool.updated", { detail: "1s" }),
      row("u2", "tool.updated", { detail: "2s" }),
      row("u3", "tool.updated", { detail: "3s" }),
      row("done", "tool.completed", { result: "ok" }),
    ]);
    expect(withoutSupersededToolUpdates(once)).toBe(once);
  });
});
