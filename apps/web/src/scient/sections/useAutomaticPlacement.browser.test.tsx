import {
  render as _fixtureRender,
  type Screen,
  stubGlobal as _fixtureStubGlobal,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import { useLayoutEffect } from "react";

import { expect, it, vi } from "vite-plus/test";
import { useAutomaticPlacement } from "./useAutomaticPlacement";
import { useAutomaticPlacementPreference } from "./automaticPlacementPreference";

let storage: Map<string, string>;
const group = (eligible: string[]) => [
  {
    id: "general",
    rows: ["x", "a", "b"].map((key) => ({ key, orderKey: key, eligible: eligible.includes(key) })),
  },
];
function Probe({ _fixture }: { _fixture: _Fixture }) {
  const next = useAutomaticPlacement(_fixture.input);
  useLayoutEffect(() => {
    _fixture.publishValue(next);
  });
  return null;
}
const render = async (_fixture: _Fixture) =>
  await act(async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} />));
const order = (_fixture: _Fixture) => _fixture.value.state.groups[0]?.order;
async function _setupFixture0(_fixture: _Fixture) {
  _fixture.stack.use(_fixtureFakeTimers());
  vi.setSystemTime(0);

  storage = new Map();
  _fixture.stack.use(
    _fixtureStubGlobal("localStorage", {
      get length() {
        return storage.size;
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
      removeItem: (key: string) => storage.delete(key),
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, val: string) => storage.set(key, val),
    }),
  );
  useAutomaticPlacementPreference.setState({ enabled: true });
  _fixture.input = { scope: "test", groups: group(["a", "b"]), openKey: null, ready: true };
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
}
it("handles the actual navigation timer, reopening, pause, and expiry without input polling", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  _fixture.input = { ..._fixture.input, groups: group(["b"]), openKey: "a" };
  await render(_fixture);
  _fixture.input = { ..._fixture.input, openKey: null };
  await render(_fixture);
  await act(() => vi.advanceTimersByTimeAsync(2999));
  expect(order(_fixture)).toEqual(["a", "b", "x"]);
  await act(() => _fixture.value.onInteractionChange(true));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(order(_fixture)).toEqual(["a", "b", "x"]);
  await act(() => _fixture.value.onInteractionChange(false));
  expect(order(_fixture)).toEqual(["b", "a", "x"]);
});
it("disabling cancels pending review and re-enabling starts from current saved order", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  _fixture.input = { ..._fixture.input, groups: group(["b"]), openKey: "a" };
  await render(_fixture);
  _fixture.input = { ..._fixture.input, openKey: null };
  await render(_fixture);
  await act(() => useAutomaticPlacementPreference.getState().setEnabled(false));
  expect(_fixture.value.state.groups).toEqual([]);
  await act(() => vi.advanceTimersByTimeAsync(4000));
  await act(() => useAutomaticPlacementPreference.getState().setEnabled(true));
  expect(order(_fixture)).toEqual(["b", "x", "a"]);
});
it("discards saved manual exceptions when toggled from settings with the sidebar unmounted", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(() => _fixture.value.onManualPlacement("general", ["x", "a", "b"], "x", new Map()));
  await act(() => vi.advanceTimersByTimeAsync(300));
  await act(async () => await _fixture.root0.unmount());
  useAutomaticPlacementPreference.getState().setEnabled(false);
  useAutomaticPlacementPreference.getState().setEnabled(true);
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
  expect(order(_fixture)).toEqual(["a", "b", "x"]);
});
it("does not prune a disconnected snapshot, and persists/reloads placement without credentials", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(() => vi.advanceTimersByTimeAsync(300));
  _fixture.input = { ..._fixture.input, groups: [], ready: false };
  await render(_fixture);
  expect(order(_fixture)).toEqual(["a", "b", "x"]);
  await act(async () => await _fixture.root0.unmount());
  _fixture.input = { ..._fixture.input, groups: group(["a", "b"]), ready: true };
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
  expect(order(_fixture)).toEqual(["a", "b", "x"]);
  expect(JSON.parse(storage.get("scient:sidebar:placement-order:test")!).groups).toHaveLength(1);
});
it("commits a manual cross-section drop with fresh membership and honours its position", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  _fixture.input = {
    ..._fixture.input,
    groups: [
      ...group(["a"]),
      { id: "other", rows: [{ key: "c", eligible: false, orderKey: "c" }] },
    ],
  };
  await render(_fixture);
  await act(() => _fixture.value.onInteractionChange(true));
  await act(() =>
    _fixture.value.onManualPlacement("other", ["c", "a"], "a", new Map([["a", "z"]])),
  );
  _fixture.input = {
    ..._fixture.input,
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
  await render(_fixture);
  await act(() => _fixture.value.onInteractionChange(false));
  expect(_fixture.value.state.groups[1]!.order).toEqual(["c", "a"]);
});
it("sets aside an active thread dropped from another section without re-forming the destination", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const row = (key: string, eligible: boolean) => ({ key, eligible, orderKey: key });
  _fixture.input = {
    ..._fixture.input,
    groups: [
      { id: "general", rows: [row("x", false), row("a", true), row("y", false)] },
      { id: "other", rows: [row("d", true)] },
    ],
  };
  await render(_fixture);
  // x is deliberately held above active a.
  await act(() => _fixture.value.onManualPlacement("general", ["x", "a", "y"], "x", new Map()));
  expect(order(_fixture)).toEqual(["x", "a", "y"]);
  await act(() =>
    _fixture.value.onManualPlacement("general", ["x", "a", "y", "d"], "d", new Map()),
  );
  expect(order(_fixture)).toEqual(["x", "a", "y", "d"]);
  expect(_fixture.value.state.groups[0]!.aside).toEqual(["d"]);
});
it("places a dropped thread from an offline machine by its last known activity", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const row = (key: string, eligible: boolean, orderKey = key) => ({ key, eligible, orderKey });
  const groups = (r: ReturnType<typeof row>) => [
    { id: "general", rows: [row("local:x", false), r] },
  ];
  _fixture.input = { ..._fixture.input, groups: groups(row("remote:r", true)) };
  await render(_fixture);
  expect(order(_fixture)).toEqual(["remote:r", "local:x"]);
  // Offline: its stale copy says inactive, which is not believed.
  _fixture.input = {
    ..._fixture.input,
    groups: groups(row("remote:r", false)),
    frozenEnvironmentIds: ["remote"],
  };
  await render(_fixture);
  await act(() =>
    _fixture.value.onManualPlacement(
      "general",
      ["local:x", "remote:r"],
      "remote:r",
      new Map([["remote:r", "z"]]),
    ),
  );
  expect(_fixture.value.state.groups[0]!.aside).toEqual(["remote:r"]);
  // Back online and still active, it stays where it was dropped.
  _fixture.input = {
    ..._fixture.input,
    groups: groups(row("remote:r", true, "z")),
    frozenEnvironmentIds: [],
  };
  await render(_fixture);
  expect(order(_fixture)).toEqual(["local:x", "remote:r"]);
});
it("keeps live review deadlines running while an offline machine's deadline waits", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

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
  _fixture.input = { ..._fixture.input, groups: groups(["remote:r", "local:l"]) };
  await render(_fixture);
  // Read r, then leave: its deadline is 3000.
  _fixture.input = { ..._fixture.input, groups: groups(["local:l"]), openKey: "remote:r" };
  await render(_fixture);
  _fixture.input = { ..._fixture.input, openKey: null };
  await render(_fixture);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  // Read l, then leave: its deadline is 4000.
  _fixture.input = { ..._fixture.input, groups: groups([]), openKey: "local:l" };
  await render(_fixture);
  _fixture.input = { ..._fixture.input, openKey: null };
  await render(_fixture);
  // r's machine goes offline before its deadline.
  _fixture.input = { ..._fixture.input, frozenEnvironmentIds: ["remote"] };
  await render(_fixture);
  // Past r's deadline, l's must still be armed.
  await act(() => vi.advanceTimersByTimeAsync(2100));
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(_fixture.value.state.groups[0]!.upper).toEqual(["remote:r"]);
});
it("continues working with corrupt or unavailable local storage", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(async () => await _fixture.root0.unmount());
  storage.set("scient:sidebar:placement-order:test", "{broken");
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
  expect(order(_fixture)).toEqual(["a", "b", "x"]);
  window.localStorage.setItem = () => {
    throw Error("quota");
  };
  await act(() => _fixture.value.onManualPlacement("general", ["x", "a", "b"], "x", new Map()));
  expect(order(_fixture)).toEqual(["x", "a", "b"]);
});

it("turning off while disconnected and paused still discards old review deadlines", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  _fixture.input = { ..._fixture.input, groups: group(["b"]), openKey: "a" };
  await render(_fixture);
  _fixture.input = { ..._fixture.input, openKey: null };
  await render(_fixture);
  await act(() => _fixture.value.onInteractionChange(true));
  _fixture.input = { ..._fixture.input, ready: false };
  await render(_fixture);
  await act(() => useAutomaticPlacementPreference.getState().setEnabled(false));
  await act(() => useAutomaticPlacementPreference.getState().setEnabled(true));
  _fixture.input = { ..._fixture.input, ready: true };
  await render(_fixture);
  await act(() => _fixture.value.onInteractionChange(false));
  expect(order(_fixture)).toEqual(["b", "x", "a"]);
});

it("preserves an acknowledged manual drop while its old shell value is still rendered", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(() => _fixture.value.onInteractionChange(true));
  await act(() =>
    _fixture.value.onManualPlacement("general", ["b", "a", "x"], "b", new Map([["b", "0"]])),
  );
  await act(() => _fixture.value.onInteractionChange(false));
  expect(order(_fixture)).toEqual(["b", "a", "x"]);
  _fixture.input = {
    ..._fixture.input,
    groups: [
      {
        id: "general",
        rows: group(["a", "b"])[0]!.rows.map((row) =>
          row.key === "b" ? { ...row, orderKey: "0" } : row,
        ),
      },
    ],
  };
  await render(_fixture);
  expect(order(_fixture)).toEqual(["b", "a", "x"]);
});
it("bridges cross-section membership until its acknowledged shell echo arrives", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  _fixture.input = {
    ..._fixture.input,
    groups: [
      ...group(["a"]),
      { id: "other", rows: [{ key: "c", eligible: false, orderKey: "c" }] },
    ],
  };
  await render(_fixture);
  await act(() => _fixture.value.onInteractionChange(true));
  await act(() =>
    _fixture.value.onManualPlacement("other", ["c", "a"], "a", new Map([["a", "z"]])),
  );
  await act(() => _fixture.value.onInteractionChange(false));
  expect(_fixture.value.state.groups[1]!.order).toEqual(["c", "a"]);
  expect(order(_fixture)).not.toContain("a");
  _fixture.input = {
    ..._fixture.input,
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
  await render(_fixture);
  expect(_fixture.value.state.groups[1]!.order).toEqual(["c", "a"]);
});

it("keeps a newly woken shelf row in its chosen slot until it appears, and prunes a deletion", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  _fixture.input = { ..._fixture.input, knownKeys: ["x", "a", "b", "shelf"] };
  await render(_fixture);
  await act(() => _fixture.value.onInteractionChange(true));
  await act(() =>
    _fixture.value.onManualPlacement("general", ["a", "shelf", "b", "x"], "shelf", new Map(), {
      key: "shelf",
      eligible: false,
      orderKey: null,
    }),
  );
  await act(() => _fixture.value.onInteractionChange(false));
  expect(order(_fixture)).toEqual(["a", "shelf", "b", "x"]);
  _fixture.input = {
    ..._fixture.input,
    groups: [
      {
        id: "general",
        rows: [...group(["a", "b"])[0]!.rows, { key: "shelf", eligible: false, orderKey: null }],
      },
    ],
  };
  await render(_fixture);
  expect(order(_fixture)).toEqual(["a", "shelf", "b", "x"]);
  _fixture.input = { ..._fixture.input, knownKeys: ["x", "a", "b"], groups: group(["a", "b"]) };
  await render(_fixture);
  expect(order(_fixture)).not.toContain("shelf");
});

function _createFixture() {
  let _published_value = undefined! as ReturnType<typeof useAutomaticPlacement>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    input: undefined! as Parameters<typeof useAutomaticPlacement>[0],
    get value() {
      return _published_value;
    },
    publishValue(next: typeof _published_value) {
      _published_value = next;
    },

    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
