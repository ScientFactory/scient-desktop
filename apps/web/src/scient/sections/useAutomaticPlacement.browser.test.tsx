import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useAutomaticPlacement } from "./useAutomaticPlacement";
import { useAutomaticPlacementPreference } from "./automaticPlacementPreference";

let input: Parameters<typeof useAutomaticPlacement>[0];
let value: ReturnType<typeof useAutomaticPlacement>;
let renderer: Root;
let storage: Map<string, string>;
const group = (eligible: string[]) => [
  {
    id: "general",
    rows: ["x", "a", "b"].map((key) => ({ key, orderKey: key, eligible: eligible.includes(key) })),
  },
];
function Probe() {
  const next = useAutomaticPlacement(input);
  useLayoutEffect(() => {
    value = next;
  });
  return null;
}
const render = () => act(() => renderer.render(<Probe />));
const order = () => value.state.groups[0]?.order;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  storage = new Map();
  vi.stubGlobal("localStorage", {
    get length() {
      return storage.size;
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    removeItem: (key: string) => storage.delete(key),
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, val: string) => storage.set(key, val),
  });
  useAutomaticPlacementPreference.setState({ enabled: true });
  input = { scope: "test", groups: group(["a", "b"]), openKey: null, ready: true };
  act(() => {
    renderer = createRoot(document.createElement("div"));
    renderer.render(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("handles the actual navigation timer, reopening, pause, and expiry without input polling", async () => {
  input = { ...input, groups: group(["b"]), openKey: "a" };
  render();
  input = { ...input, openKey: null };
  render();
  await act(() => vi.advanceTimersByTimeAsync(2999));
  expect(order()).toEqual(["a", "b", "x"]);
  act(() => value.onInteractionChange(true));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(order()).toEqual(["a", "b", "x"]);
  act(() => value.onInteractionChange(false));
  expect(order()).toEqual(["b", "a", "x"]);
});
it("disabling cancels pending review and re-enabling starts from current saved order", async () => {
  input = { ...input, groups: group(["b"]), openKey: "a" };
  render();
  input = { ...input, openKey: null };
  render();
  act(() => useAutomaticPlacementPreference.getState().setEnabled(false));
  expect(value.state.groups).toEqual([]);
  await act(() => vi.advanceTimersByTimeAsync(4000));
  act(() => useAutomaticPlacementPreference.getState().setEnabled(true));
  expect(order()).toEqual(["b", "x", "a"]);
});
it("discards saved manual exceptions when toggled from settings with the sidebar unmounted", async () => {
  act(() => value.onManualPlacement("general", ["x", "a", "b"], "x", new Map()));
  await act(() => vi.advanceTimersByTimeAsync(300));
  act(() => renderer.unmount());
  useAutomaticPlacementPreference.getState().setEnabled(false);
  useAutomaticPlacementPreference.getState().setEnabled(true);
  act(() => {
    renderer = createRoot(document.createElement("div"));
    renderer.render(<Probe />);
  });
  expect(order()).toEqual(["a", "b", "x"]);
});
it("does not prune a disconnected snapshot, and persists/reloads placement without credentials", async () => {
  await act(() => vi.advanceTimersByTimeAsync(300));
  input = { ...input, groups: [], ready: false };
  render();
  expect(order()).toEqual(["a", "b", "x"]);
  act(() => renderer.unmount());
  input = { ...input, groups: group(["a", "b"]), ready: true };
  act(() => {
    renderer = createRoot(document.createElement("div"));
    renderer.render(<Probe />);
  });
  expect(order()).toEqual(["a", "b", "x"]);
  expect(JSON.parse(storage.get("scient:sidebar:placement-order:test")!).groups).toHaveLength(1);
});
it("commits a manual cross-section drop with fresh membership and honours its position", () => {
  input = {
    ...input,
    groups: [
      ...group(["a"]),
      { id: "other", rows: [{ key: "c", eligible: false, orderKey: "c" }] },
    ],
  };
  render();
  act(() => value.onInteractionChange(true));
  act(() => value.onManualPlacement("other", ["c", "a"], "a", new Map([["a", "z"]])));
  input = {
    ...input,
    groups: [
      { id: "general", rows: group([])[0]!.rows.filter((row) => row.key !== "a") },
      {
        id: "other",
        rows: [
          { key: "c", eligible: false, orderKey: "c" },
          { key: "a", eligible: true, orderKey: "z" },
        ],
      },
    ],
  };
  render();
  act(() => value.onInteractionChange(false));
  expect(value.state.groups[1]!.order).toEqual(["c", "a"]);
});
it("sets aside an active thread dropped from another section without re-forming the destination", () => {
  const row = (key: string, eligible: boolean) => ({ key, eligible, orderKey: key });
  input = {
    ...input,
    groups: [
      { id: "general", rows: [row("x", false), row("a", true), row("y", false)] },
      { id: "other", rows: [row("d", true)] },
    ],
  };
  render();
  // x is deliberately held above active a.
  act(() => value.onManualPlacement("general", ["x", "a", "y"], "x", new Map()));
  expect(order()).toEqual(["x", "a", "y"]);
  act(() => value.onManualPlacement("general", ["x", "a", "y", "d"], "d", new Map()));
  expect(order()).toEqual(["x", "a", "y", "d"]);
  expect(value.state.groups[0]!.aside).toEqual(["d"]);
});
it("places a dropped thread from an offline machine by its last known activity", () => {
  const row = (key: string, eligible: boolean, orderKey = key) => ({ key, eligible, orderKey });
  const groups = (r: ReturnType<typeof row>) => [
    { id: "general", rows: [row("local:x", false), r] },
  ];
  input = { ...input, groups: groups(row("remote:r", true)) };
  render();
  expect(order()).toEqual(["remote:r", "local:x"]);
  // Offline: its stale copy says inactive, which is not believed.
  input = { ...input, groups: groups(row("remote:r", false)), frozenEnvironmentIds: ["remote"] };
  render();
  act(() =>
    value.onManualPlacement(
      "general",
      ["local:x", "remote:r"],
      "remote:r",
      new Map([["remote:r", "z"]]),
    ),
  );
  expect(value.state.groups[0]!.aside).toEqual(["remote:r"]);
  // Back online and still active, it stays where it was dropped.
  input = { ...input, groups: groups(row("remote:r", true, "z")), frozenEnvironmentIds: [] };
  render();
  expect(order()).toEqual(["local:x", "remote:r"]);
});
it("keeps live review deadlines running while an offline machine's deadline waits", async () => {
  const groups = (active: string[]) => [
    {
      id: "general",
      rows: ["remote:r", "local:l", "local:x"].map((key) => ({
        key,
        orderKey: key,
        eligible: active.includes(key),
      })),
    },
  ];
  input = { ...input, groups: groups(["remote:r", "local:l"]) };
  render();
  // Read r, then leave: its deadline is 3000.
  input = { ...input, groups: groups(["local:l"]), openKey: "remote:r" };
  render();
  input = { ...input, openKey: null };
  render();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  // Read l, then leave: its deadline is 4000.
  input = { ...input, groups: groups([]), openKey: "local:l" };
  render();
  input = { ...input, openKey: null };
  render();
  // r's machine goes offline before its deadline.
  input = { ...input, frozenEnvironmentIds: ["remote"] };
  render();
  // Past r's deadline, l's must still be armed.
  await act(() => vi.advanceTimersByTimeAsync(2100));
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(value.state.groups[0]!.upper).toEqual(["remote:r"]);
});
it("continues working with corrupt or unavailable local storage", () => {
  act(() => renderer.unmount());
  storage.set("scient:sidebar:placement-order:test", "{broken");
  act(() => {
    renderer = createRoot(document.createElement("div"));
    renderer.render(<Probe />);
  });
  expect(order()).toEqual(["a", "b", "x"]);
  window.localStorage.setItem = () => {
    throw Error("quota");
  };
  act(() => value.onManualPlacement("general", ["x", "a", "b"], "x", new Map()));
  expect(order()).toEqual(["x", "a", "b"]);
});

it("turning off while disconnected and paused still discards old review deadlines", () => {
  input = { ...input, groups: group(["b"]), openKey: "a" };
  render();
  input = { ...input, openKey: null };
  render();
  act(() => value.onInteractionChange(true));
  input = { ...input, ready: false };
  render();
  act(() => useAutomaticPlacementPreference.getState().setEnabled(false));
  act(() => useAutomaticPlacementPreference.getState().setEnabled(true));
  input = { ...input, ready: true };
  render();
  act(() => value.onInteractionChange(false));
  expect(order()).toEqual(["b", "x", "a"]);
});

it("preserves an acknowledged manual drop while its old shell value is still rendered", () => {
  act(() => value.onInteractionChange(true));
  act(() => value.onManualPlacement("general", ["b", "a", "x"], "b", new Map([["b", "0"]])));
  act(() => value.onInteractionChange(false));
  expect(order()).toEqual(["b", "a", "x"]);
  input = {
    ...input,
    groups: [
      {
        id: "general",
        rows: group(["a", "b"])[0]!.rows.map((row) =>
          row.key === "b" ? { ...row, orderKey: "0" } : row,
        ),
      },
    ],
  };
  render();
  expect(order()).toEqual(["b", "a", "x"]);
});
it("bridges cross-section membership until its acknowledged shell echo arrives", () => {
  input = {
    ...input,
    groups: [
      ...group(["a"]),
      { id: "other", rows: [{ key: "c", eligible: false, orderKey: "c" }] },
    ],
  };
  render();
  act(() => value.onInteractionChange(true));
  act(() => value.onManualPlacement("other", ["c", "a"], "a", new Map([["a", "z"]])));
  act(() => value.onInteractionChange(false));
  expect(value.state.groups[1]!.order).toEqual(["c", "a"]);
  expect(order()).not.toContain("a");
  input = {
    ...input,
    groups: [
      { id: "general", rows: group([])[0]!.rows.filter((row) => row.key !== "a") },
      {
        id: "other",
        rows: [
          { key: "c", eligible: false, orderKey: "c" },
          { key: "a", eligible: true, orderKey: "z" },
        ],
      },
    ],
  };
  render();
  expect(value.state.groups[1]!.order).toEqual(["c", "a"]);
});

it("keeps a newly woken shelf row in its chosen slot until it appears, and prunes a deletion", () => {
  input = { ...input, knownKeys: ["x", "a", "b", "shelf"] };
  render();
  act(() => value.onInteractionChange(true));
  act(() =>
    value.onManualPlacement("general", ["a", "shelf", "b", "x"], "shelf", new Map(), {
      key: "shelf",
      eligible: false,
      orderKey: null,
    }),
  );
  act(() => value.onInteractionChange(false));
  expect(order()).toEqual(["a", "shelf", "b", "x"]);
  input = {
    ...input,
    groups: [
      {
        id: "general",
        rows: [...group(["a", "b"])[0]!.rows, { key: "shelf", eligible: false, orderKey: null }],
      },
    ],
  };
  render();
  expect(order()).toEqual(["a", "shelf", "b", "x"]);
  input = { ...input, knownKeys: ["x", "a", "b"], groups: group(["a", "b"]) };
  render();
  expect(order()).not.toContain("shelf");
});
