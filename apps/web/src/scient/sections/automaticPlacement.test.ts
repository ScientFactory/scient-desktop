import { expect, it } from "vitest";
import {
  EMPTY_PLACEMENT,
  displayedPlacementOrder,
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
const drop = (state: PlacementState, displayed: string[], key: string, eligible: string[]) =>
  manuallyPlaceThread(state, "general", displayed, key, rows(["x", "a", "b", "c"], eligible));
it("holds an inactive thread dropped above active work until the next arrival", () => {
  let state = drop(update(EMPTY_PLACEMENT, ["a"]), ["x", "a", "b", "c"], "x", ["a"]);
  expect(order(update(state, ["a"]))).toEqual(["x", "a", "b", "c"]);
  // b becoming active re-forms the block above x.
  state = update(state, ["a", "b"]);
  expect(order(state)).toEqual(["a", "b", "x", "c"]);
  // x's own activation joins the bottom of the block.
  expect(order(update(state, ["x", "a", "b"]))).toEqual(["a", "b", "x", "c"]);
});
it("puts a new arrival above an inactive thread dropped at the top when nothing is active", () => {
  const state = drop(update(EMPTY_PLACEMENT, []), ["c", "x", "a", "b"], "c", []);
  expect(order(state)).toEqual(["c", "x", "a", "b"]);
  expect(order(update(state, ["b"]))).toEqual(["b", "c", "x", "a"]);
});
it("sets aside an active thread dropped below inactive ones; arrivals still take the top", () => {
  let state = drop(update(EMPTY_PLACEMENT, ["a"]), ["x", "b", "c", "a"], "a", ["a"]);
  expect(state.groups[0]!.aside).toEqual(["a"]);
  state = update(state, ["a", "b"]);
  expect(order(state)).toEqual(["b", "x", "c", "a"]);
  // Going inactive ends the set-aside in place; the next activation rejoins the block.
  state = update(state, ["b"]);
  expect(order(state)).toEqual(["b", "x", "c", "a"]);
  expect(state.groups[0]!.aside).toEqual([]);
  expect(order(update(state, ["a", "b"]))).toEqual(["b", "a", "x", "c"]);
});
it("classifies a drop made on another device like a local one", () => {
  // `a` carries the order key another window wrote; `keys` is the resulting canonical order.
  const moved = (keys: string[], eligible: string[], aKey: string) =>
    reconcileWith(keys, eligible, (key) => (key === "a" ? aKey : key));
  let reconcileState = update(EMPTY_PLACEMENT, ["a"]);
  function reconcileWith(keys: string[], eligible: string[], orderKey: (key: string) => string) {
    reconcileState = reconcilePlacement(
      reconcileState,
      [
        {
          id: "general",
          rows: keys.map((key) => ({
            key,
            eligible: eligible.includes(key),
            orderKey: orderKey(key),
          })),
        },
      ],
      null,
      0,
    );
    return reconcileState;
  }
  // Another window drags working a below inactive x, b and c: it is set aside here too.
  expect(moved(["x", "b", "c", "a"], ["a"], "z").groups[0]!.aside).toEqual(["a"]);
  expect(order(moved(["x", "b", "c", "a"], ["a", "b"], "z"))).toEqual(["b", "x", "c", "a"]);
  // Dragged back to the top elsewhere, it rejoins the block.
  const back = moved(["a", "b", "x", "c"], ["a", "b"], "0").groups[0]!;
  expect(back.upper).toEqual(["a", "b"]);
  expect(back.aside).toEqual([]);
});
it("does not re-form the block for a thread that both arrives and is dropped elsewhere", () => {
  const snapshot = (eligible: string[], bKey = "b") => [
    {
      id: "general",
      rows: ["x", "a", "y", "b"].map((key) => ({
        key,
        eligible: eligible.includes(key),
        orderKey: key === "b" ? bKey : key,
      })),
    },
  ];
  let state = reconcilePlacement(EMPTY_PLACEMENT, snapshot(["a"]), null, 0);
  // x is deliberately held above active a.
  state = manuallyPlaceThread(state, "general", ["x", "a", "y", "b"], "x", snapshot(["a"]));
  // Another window drops b, now active, below y.
  state = reconcilePlacement(state, snapshot(["a", "b"], "z"), null, 0);
  expect(order(state)).toEqual(["x", "a", "y", "b"]);
  expect(state.groups[0]!.aside).toEqual(["b"]);
});
it("keeps an active thread reordered within the block in it", () => {
  let state = drop(update(EMPTY_PLACEMENT, ["a", "b"]), ["b", "a", "x", "c"], "b", ["a", "b"]);
  expect(state.groups[0]!.aside).toEqual([]);
  state = update(state, ["a", "b", "c"]);
  expect(order(state)).toEqual(["b", "a", "c", "x"]);
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
it("shows rows reconciliation has not seen where it will place them", () => {
  const state = update(EMPTY_PLACEMENT, ["a"]);
  const next = rows(["n", "x", "a", "b", "c", "m"], ["a", "n"]);
  expect(displayedPlacementOrder(state.groups[0], next[0]!.rows)).toEqual(
    order(reconcilePlacement(state, next, null, 0)),
  );
  expect(displayedPlacementOrder(state.groups[0], next[0]!.rows)).toEqual([
    "a",
    "n",
    "x",
    "b",
    "c",
    "m",
  ]);
  const seed = rows(["x", "a", "b", "c"], ["b", "c"]);
  expect(displayedPlacementOrder(undefined, seed[0]!.rows)).toEqual(
    order(reconcilePlacement(EMPTY_PLACEMENT, seed, null, 0)),
  );
});
it("judges a drop by the rows the user saw, not rows a filter hides", () => {
  const current = rows(["h", "x", "a"], ["a"]);
  const state: PlacementState = {
    groups: [
      { id: "general", rows: current[0]!.rows, order: ["h", "x", "a"], upper: [], aside: ["a"] },
    ],
    pending: [],
  };
  const dropped = manuallyPlaceThread(state, "general", ["a", "x"], "a", current);
  expect(order(dropped)).toEqual(["h", "a", "x"]);
  expect(dropped.groups[0]!.upper).toEqual(["a"]);
  expect(dropped.groups[0]!.aside).toEqual([]);
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
  // Placement saved before set-aside existed still loads.
  const legacy = { groups: [{ id: "g", rows: [{ key: "a", eligible: true, orderKey: null }] }] };
  expect(
    readPlacement({ groups: [{ ...legacy.groups[0], order: ["a"], upper: ["a"] }] }).groups[0],
  ).toMatchObject({ order: ["a"], upper: ["a"], aside: [] });
});
it("holds an unsynchronized environment's rows at their last known state", () => {
  const general = (eligible: string[], keys = ["local:a", "remote:r", "local:b", "remote:s"]) =>
    [
      {
        id: "general",
        rows: keys.map((key) => ({ key, eligible: eligible.includes(key), orderKey: null })),
      },
    ] satisfies PlacementInput[];
  const remoteFrozen = (key: string) => key.startsWith("remote:");
  let state = reconcilePlacement(EMPTY_PLACEMENT, general(["remote:r"]), null, 0);
  expect(order(state)).toEqual(["remote:r", "local:a", "local:b", "remote:s"]);
  // A stale copy says r stopped and s started; neither is believed while remote is frozen.
  // Local work still rises, below r's last known activity.
  state = reconcilePlacement(state, general(["remote:s", "local:b"]), null, 10, remoteFrozen);
  expect(order(state)).toEqual(["remote:r", "local:b", "local:a", "remote:s"]);
  // A frozen environment whose threads are missing keeps them in place.
  const missing = reconcilePlacement(
    state,
    general(["local:b"], ["local:a", "local:b"]),
    null,
    20,
    remoteFrozen,
  );
  expect(order(missing)).toEqual(order(state));
  // A local drop meanwhile keeps them too.
  const dropped = manuallyPlaceThread(
    missing,
    "general",
    ["local:a", "local:b"],
    "local:a",
    general(["local:b"], ["local:a", "local:b"]),
    remoteFrozen,
  );
  expect(dropped.groups[0]!.rows.map((row) => row.key)).toEqual([
    "local:a",
    "local:b",
    "remote:r",
    "remote:s",
  ]);
  expect(dropped.groups[0]!.upper).toContain("remote:r");
  // So does a frozen environment's own section that is missing entirely.
  const remoteSection = { id: "section@remote", rows: rows(["remote:t"], ["remote:t"])[0]!.rows };
  const withSection = reconcilePlacement(EMPTY_PLACEMENT, [remoteSection], null, 0);
  expect(reconcilePlacement(withSection, [], null, 5, remoteFrozen).groups).toEqual(
    withSection.groups,
  );
  expect(reconcilePlacement(withSection, [], null, 5).groups).toEqual([]);
  // ...unless its thread is now listed elsewhere: it is never held in two places.
  const listedElsewhere = reconcilePlacement(
    withSection,
    [{ id: "general", rows: [{ key: "remote:t", eligible: true, orderKey: null }] }],
    null,
    5,
    remoteFrozen,
  );
  expect(listedElsewhere.groups.map((group) => group.id)).toEqual(["general"]);
  // A carried section keeps its threads' review deadlines.
  const remoteRead = { ...remoteSection, rows: [{ ...remoteSection.rows[0]!, eligible: false }] };
  let reading = reconcilePlacement(withSection, [remoteRead], "remote:t", 1);
  reading = reconcilePlacement(reading, [remoteRead], null, 2);
  expect(reconcilePlacement(reading, [], null, 10, remoteFrozen).pending).toEqual([
    { key: "remote:t", dueAt: 3002 },
  ]);
  // A frozen thread's review deadline waits: it does not depart while its machine is away.
  let held = reconcilePlacement(EMPTY_PLACEMENT, general(["remote:r"]), null, 0);
  held = reconcilePlacement(held, general([]), "remote:r", 1);
  held = reconcilePlacement(held, general([]), null, 2);
  expect(held.pending).toEqual([{ key: "remote:r", dueAt: 3002 }]);
  const away = reconcilePlacement(held, general(["local:b"]), null, 9000, remoteFrozen);
  expect(away.groups[0]!.upper).toContain("remote:r");
  expect(away.pending).toEqual([{ key: "remote:r", dueAt: 3002 }]);
  // Back online, the elapsed deadline applies.
  expect(reconcilePlacement(away, general(["local:b"]), null, 9001).groups[0]!.upper).toEqual([
    "local:b",
  ]);
  // Once live again its rows are judged from current data.
  expect(order(reconcilePlacement(missing, general(["local:b"]), null, 30))).toEqual([
    "local:b",
    "remote:r",
    "local:a",
    "remote:s",
  ]);
});
it("stays stable on large streaming snapshots", () => {
  const input = rows(
    Array.from({ length: 10_000 }, (_, i) => `t${i}`),
    ["t100"],
  );
  const state = reconcilePlacement(EMPTY_PLACEMENT, input, null, 0);
  for (let i = 0; i < 20; i++) expect(reconcilePlacement(state, input, null, i)).toBe(state);
});
