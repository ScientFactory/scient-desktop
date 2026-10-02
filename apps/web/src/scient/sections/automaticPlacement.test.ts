import { expect, it } from "vitest";
import {
  EMPTY_PLACEMENT,
  manuallyPlaceThread,
  manualOrderForPlacement,
  readPlacement,
  reconcilePlacement,
  type PlacementInput,
  type PlacementState,
} from "./automaticPlacement";
const rows = (order: string[], eligible: string[]): PlacementInput[] => [
  {
    id: "general",
    rows: order.map((key) => ({ key, eligible: eligible.includes(key), orderKey: key })),
  },
];
const update = (state: PlacementState, eligible: string[], open: string | null = null, now = 0) =>
  reconcilePlacement(state, rows(["x", "a", "b", "c"], eligible), open, now);
const order = (state: PlacementState) => state.groups[0]!.order;
it("seeds equal priority, appends arrivals, and leaves eligible transitions stable", () => {
  const first = update(EMPTY_PLACEMENT, ["a"]);
  expect(order(first)).toEqual(["a", "x", "b", "c"]);
  const second = update(first, ["a", "b"]);
  expect(order(second)).toEqual(["a", "b", "x", "c"]);
  expect(update(second, ["a", "b"])).toBe(second);
});
it("holds read completion while open, then demotes exactly three seconds after leaving", () => {
  let state = update(update(EMPTY_PLACEMENT, ["a", "b"]), ["b"], "a");
  expect(order(state)).toEqual(["a", "b", "x", "c"]);
  state = update(state, ["b"], null, 50);
  expect(state.pending).toEqual([{ key: "a", dueAt: 3050 }]);
  expect(order(update(state, ["b"], null, 3049))).toEqual(["a", "b", "x", "c"]);
  expect(order(update(state, ["b"], null, 3050))).toEqual(["b", "a", "x", "c"]);
});
it("reopening resets grace; new activity cancels it", () => {
  let state = update(update(EMPTY_PLACEMENT, ["a", "b"]), ["b"], "a");
  state = update(state, ["b"], null, 10);
  state = update(state, ["b"], "a", 2000);
  state = update(state, ["b"], null, 5000);
  expect(state.pending[0]!.dueAt).toBe(8000);
  state = update(state, ["a", "b"], null, 6000);
  expect(state.pending).toEqual([]);
  expect(order(update(state, ["a", "b"], null, 9000))).toEqual(["a", "b", "x", "c"]);
});
it("puts departures first among inactive and keeps batch order stable", () => {
  let state = update(EMPTY_PLACEMENT, ["a", "b", "c"]);
  state = update(state, ["c"]);
  expect(order(state)).toEqual(["c", "a", "b", "x"]);
  expect(order(update(state, []))).toEqual(["c", "a", "b", "x"]);
});
it("honours manual exceptions until their own next eligibility transition", () => {
  let state = update(EMPTY_PLACEMENT, ["a"]);
  state = manuallyPlaceThread(
    state,
    "general",
    ["x", "a", "b", "c"],
    "x",
    rows(["x", "a", "b", "c"], ["a"]),
  );
  state = update(state, ["a", "b"]);
  expect(order(state)).toEqual(["x", "a", "b", "c"]);
  state = update(state, ["x", "a", "b"]);
  expect(order(state)).toEqual(["a", "b", "x", "c"]);
});
it("manual movement cancels review grace and stays put on ordinary updates", () => {
  let state = update(update(EMPTY_PLACEMENT, ["a", "b"]), ["b"], "a");
  state = update(state, ["b"], null, 10);
  state = manuallyPlaceThread(
    state,
    "general",
    ["b", "x", "c", "a"],
    "a",
    rows(["x", "a", "b", "c"], ["b"]),
  );
  expect(state.pending).toEqual([]);
  expect(order(update(state, ["b"], null, 5000))).toEqual(["b", "x", "c", "a"]);
});
it("active manual movement is stable during continued work", () => {
  let state = update(EMPTY_PLACEMENT, ["a", "b"]);
  state = manuallyPlaceThread(
    state,
    "general",
    ["b", "x", "c", "a"],
    "a",
    rows(["x", "a", "b", "c"], ["a", "b"]),
  );
  expect(order(update(state, ["a", "b"]))).toEqual(["b", "x", "c", "a"]);
});
it("projects only the dragged row onto saved manual order", () => {
  expect(manualOrderForPlacement(["x", "a", "b", "c"], ["c", "a", "x", "b"], "b")).toEqual([
    "x",
    "b",
    "a",
    "c",
  ]);
});
it("honours remote order-key changes", () => {
  const state = update(EMPTY_PLACEMENT, ["a"]);
  const input = [
    {
      id: "general",
      rows: rows(["a", "b", "c", "x"], ["a"])[0]!.rows.map((row) =>
        row.key === "x" ? { ...row, orderKey: "z" } : row,
      ),
    },
  ];
  expect(order(reconcilePlacement(state, input, null, 0))).toEqual(["a", "b", "c", "x"]);
});
it("isolates sections/environments, prunes absent membership, and revalidates restart timers", () => {
  const input = [
    ...rows(["x", "a"], ["a"]),
    { id: "section", rows: rows(["remote:a", "local:a"], ["local:a"])[0]!.rows },
  ];
  const state = reconcilePlacement(EMPTY_PLACEMENT, input, null, 0);
  expect(state.groups[1]!.order).toEqual(["local:a", "remote:a"]);
  const loaded = readPlacement(
    JSON.parse(JSON.stringify({ ...state, pending: [{ key: "a", dueAt: 12 }] })),
  );
  expect(loaded.pending).toEqual([]);
  expect(loaded.groups).toEqual(state.groups);
  expect(reconcilePlacement(loaded, rows(["x"], []), null, 0).groups).toHaveLength(1);
  expect(readPlacement({ groups: [{ id: "bad", rows: [null], order: [4], upper: [4] }] })).toEqual(
    EMPTY_PLACEMENT,
  );
});
it("stays stable on large streaming snapshots", () => {
  const input = rows(
    Array.from({ length: 10_000 }, (_, i) => `t${i}`),
    ["t100"],
  );
  const state = reconcilePlacement(EMPTY_PLACEMENT, input, null, 0);
  for (let i = 0; i < 20; i++) expect(reconcilePlacement(state, input, null, i)).toBe(state);
});
