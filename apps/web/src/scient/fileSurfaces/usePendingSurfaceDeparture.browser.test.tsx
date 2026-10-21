import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";

import { useEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  pendingSurfaceBlocksActivation,
  pendingSurfaceBlocksClose,
  useActivePendingSurfaceDeparture,
  usePendingSurfaceDeparture,
  usePendingSurfaceNavigationBlocker,
  type PendingSurfaceDepartureOptions,
} from "./usePendingSurfaceDeparture";

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(() => "departure-toast"),
  closeToast: vi.fn(),
  useBlocker: vi.fn(),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: mocks.addToast, close: mocks.closeToast },
}));
vi.mock("@tanstack/react-router", async (_actualRouter) => ({
  ...(await _actualRouter<typeof import("@tanstack/react-router")>()),
  useBlocker: mocks.useBlocker,
}));

async function _setupFixture0(_fixture: _Fixture) {
  mocks.useBlocker.mockReturnValue({ status: "idle" });
}

async function _cleanupFixture1(_fixture: _Fixture) {
  while (_fixture.root0.length > 0) {
    const root = _fixture.root0.pop();
    if (root) await act(async () => await root.unmount());
  }
  _clearOwnedDOM(_fixture);
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

async function mountHost(_fixture: _Fixture) {
  const host = document.createElement("div");
  document.body.append(_ownDOM(_fixture, host));
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  _fixture.root0.push(root);
  return root;
}

function createDepartureHarness() {
  let request: ReturnType<typeof usePendingSurfaceDeparture> = () => false;
  function Harness(props: {
    pending: ReadonlySet<string>;
    options?: PendingSurfaceDepartureOptions;
  }) {
    const depart = usePendingSurfaceDeparture(props.pending, props.options);
    useEffect(() => {
      request = depart;
    }, [depart]);
    return null;
  }
  return { Harness, request: (run: () => void) => request(["file:notes.md"], run) };
}

describe("pending file surface departures", () => {
  const pending = new Set(["file:notes.md"]);

  it("blocks leaving an active pending file but allows staying or entering it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(
      pendingSurfaceBlocksActivation({
        activeSurfaceId: "file:notes.md",
        targetSurfaceId: "browser:tab-1",
        pendingSurfaceIds: pending,
      }),
    ).toBe(true);
    expect(
      pendingSurfaceBlocksActivation({
        activeSurfaceId: "file:notes.md",
        targetSurfaceId: "file:notes.md",
        pendingSurfaceIds: pending,
      }),
    ).toBe(false);
    expect(
      pendingSurfaceBlocksActivation({
        activeSurfaceId: "browser:tab-1",
        targetSurfaceId: "file:notes.md",
        pendingSurfaceIds: pending,
      }),
    ).toBe(false);
  });

  it("blocks only close operations whose target set contains a pending file", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(pendingSurfaceBlocksClose(["file:notes.md"], pending)).toBe(true);
    expect(pendingSurfaceBlocksClose(["browser:tab-1"], pending)).toBe(false);
    expect(pendingSurfaceBlocksClose([], pending)).toBe(false);
  });

  it("runs the latest requested departure after the pending file confirms", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.root0.push(root);
    let requestDeparture: ((surfaceIds: ReadonlyArray<string>, run: () => void) => boolean) | null =
      null;
    const superseded = vi.fn();
    const departed = vi.fn();

    function Harness(props: { readonly pendingSurfaceIds: ReadonlySet<string> }) {
      const request = usePendingSurfaceDeparture(props.pendingSurfaceIds);
      useEffect(() => {
        requestDeparture = request;
      }, [request]);
      return null;
    }

    await act(async () => await root.rerender(<Harness pendingSurfaceIds={pending} />));
    await act(() => {
      requestDeparture?.(["file:notes.md"], superseded);
      requestDeparture?.(["file:notes.md"], departed);
    });
    expect(superseded).not.toHaveBeenCalled();
    expect(departed).not.toHaveBeenCalled();

    await act(async () => await root.rerender(<Harness pendingSurfaceIds={new Set()} />));
    expect(superseded).not.toHaveBeenCalled();
    expect(departed).toHaveBeenCalledOnce();
  });

  it("adapts active-surface switches without blocking unrelated actions", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.root0.push(root);
    let requestDeparture: ((targetSurfaceId: string | null, run: () => void) => boolean) | null =
      null;

    function Harness() {
      const request = useActivePendingSurfaceDeparture({
        activeSurfaceId: "file:notes.md",
        pendingSurfaceIds: pending,
      });
      useEffect(() => {
        requestDeparture = request;
      }, [request]);
      return null;
    }

    await act(async () => await root.rerender(<Harness />));
    const stay = vi.fn();
    const leave = vi.fn();
    let stayed: boolean | undefined;
    let departed: boolean | undefined;
    await act(() => {
      stayed = requestDeparture?.("file:notes.md", stay);
      departed = requestDeparture?.("browser:tab-1", leave);
    });
    expect(stayed).toBe(true);
    expect(stay).toHaveBeenCalledOnce();
    expect(departed).toBe(false);
    expect(leave).not.toHaveBeenCalled();
  });

  it("flushes a quiet departure and finishes a quick save without a toast", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.stack.use(_fixtureFakeTimers());
    const root = await mountHost(_fixture);
    const { Harness, request } = createDepartureHarness();
    const onFlush = vi.fn();
    const departed = vi.fn();
    const options = { quietSurfaceIds: pending, onFlush };
    await act(async () => await root.rerender(<Harness pending={pending} options={options} />));
    await act(() => {
      request(departed);
    });
    expect(onFlush).toHaveBeenCalledExactlyOnceWith(["file:notes.md"]);
    await act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(mocks.addToast).not.toHaveBeenCalled();
    await act(async () => await root.rerender(<Harness pending={new Set()} options={options} />));
    await act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(departed).toHaveBeenCalledOnce();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it("shows only one delayed requested-departure message and clears it on success", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.stack.use(_fixtureFakeTimers());
    const root = await mountHost(_fixture);
    const { Harness, request } = createDepartureHarness();
    const options = { quietSurfaceIds: pending };
    const departed = vi.fn();
    await act(async () => await root.rerender(<Harness pending={pending} options={options} />));
    await act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mocks.addToast).not.toHaveBeenCalled();
    await act(() => {
      request(departed);
      vi.advanceTimersByTime(1_000);
    });
    expect(mocks.addToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "Finishing your changes",
      }),
    );
    await act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mocks.addToast).toHaveBeenCalledOnce();
    await act(async () => await root.rerender(<Harness pending={new Set()} options={options} />));
    expect(mocks.closeToast).toHaveBeenCalledWith("departure-toast");
    expect(departed).toHaveBeenCalledOnce();
  });

  it("cancels a requested departure on attention and does not resume after recovery", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.stack.use(_fixtureFakeTimers());
    const root = await mountHost(_fixture);
    const { Harness, request } = createDepartureHarness();
    const onAttention = vi.fn();
    const departed = vi.fn();
    const options = { quietSurfaceIds: pending, onAttention };
    await act(async () => await root.rerender(<Harness pending={pending} options={options} />));
    await act(() => {
      request(departed);
      vi.advanceTimersByTime(1_000);
    });
    await act(
      async () =>
        await root.rerender(
          <Harness pending={pending} options={{ ...options, attentionSurfaceIds: pending }} />,
        ),
    );
    expect(onAttention).toHaveBeenCalledExactlyOnceWith("file:notes.md");
    expect(mocks.closeToast).toHaveBeenCalledWith("departure-toast");
    await act(async () => await root.rerender(<Harness pending={new Set()} options={options} />));
    expect(departed).not.toHaveBeenCalled();
    await act(() => {
      request(departed);
    });
    expect(departed).toHaveBeenCalledOnce();
  });

  it("reads synchronous pending and attention truth before React rerenders", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const root = await mountHost(_fixture);
    const { Harness, request } = createDepartureHarness();
    let livePending: ReadonlySet<string> = new Set();
    let liveAttention: ReadonlySet<string> = new Set();
    const onAttention = vi.fn();
    const onFlush = vi.fn();
    const departed = vi.fn();
    const options = {
      quietSurfaceIds: pending,
      getPendingSurfaceIds: () => livePending,
      getAttentionSurfaceIds: () => liveAttention,
      onAttention,
      onFlush,
    };
    await act(async () => await root.rerender(<Harness pending={new Set()} options={options} />));
    livePending = pending;
    await act(() => {
      expect(request(departed)).toBe(false);
    });
    expect(departed).not.toHaveBeenCalled();
    expect(onFlush).toHaveBeenCalledOnce();
    liveAttention = pending;
    await act(() => {
      expect(request(departed)).toBe(false);
    });
    expect(onAttention).toHaveBeenCalledExactlyOnceWith("file:notes.md");
    expect(onFlush).toHaveBeenCalledOnce();
  });

  it("allows closing a saved file whose refresh notice still needs attention", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const root = await mountHost(_fixture);
    const { Harness, request } = createDepartureHarness();
    const onAttention = vi.fn();
    const onFlush = vi.fn();
    const departed = vi.fn();
    // The live lane is already clean even if React still holds the last dirty snapshot.
    const options = {
      attentionSurfaceIds: pending,
      getPendingSurfaceIds: () => new Set<string>(),
      getAttentionSurfaceIds: () => pending,
      onAttention,
      onFlush,
    };
    await act(async () => await root.rerender(<Harness pending={pending} options={options} />));
    await act(() => {
      expect(request(departed)).toBe(true);
    });
    expect(departed).toHaveBeenCalledOnce();
    expect(onAttention).not.toHaveBeenCalled();
    expect(onFlush).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(options.attentionSurfaceIds).toEqual(pending);
  });

  it("cleans up a quiet departure timer on unmount", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.stack.use(_fixtureFakeTimers());
    const root = await mountHost(_fixture);
    const { Harness, request } = createDepartureHarness();
    const departed = vi.fn();
    await act(
      async () =>
        await root.rerender(<Harness pending={pending} options={{ quietSurfaceIds: pending }} />),
    );
    await act(() => {
      request(departed);
    });
    await act(async () => await root.rerender(null));
    await act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(departed).not.toHaveBeenCalled();
  });

  it("preserves immediate non-Markdown departure feedback", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const root = await mountHost(_fixture);
    const { Harness, request } = createDepartureHarness();
    await act(async () => await root.rerender(<Harness pending={pending} />));
    await act(() => {
      request(vi.fn());
    });
    expect(mocks.addToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "Finishing the file save",
      }),
    );
  });

  it("cancels blocked route navigation when persistence needs attention", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.stack.use(_fixtureFakeTimers());
    const root = await mountHost(_fixture);
    const proceed = vi.fn();
    const reset = vi.fn();
    const onAttention = vi.fn();
    const onFlush = vi.fn();
    mocks.useBlocker.mockReturnValue({ status: "blocked", proceed, reset });
    function Harness(props: { pending: ReadonlySet<string>; attention: ReadonlySet<string> }) {
      usePendingSurfaceNavigationBlocker(props.pending, {
        quietSurfaceIds: pending,
        attentionSurfaceIds: props.attention,
        onAttention,
        onFlush,
      });
      return null;
    }
    await act(async () => await root.rerender(<Harness pending={pending} attention={new Set()} />));
    expect(onFlush).toHaveBeenCalledOnce();
    expect(mocks.addToast).not.toHaveBeenCalled();
    await act(async () => await root.rerender(<Harness pending={pending} attention={pending} />));
    expect(reset).toHaveBeenCalledOnce();
    expect(onAttention).toHaveBeenCalledExactlyOnceWith("file:notes.md");
    await act(
      async () => await root.rerender(<Harness pending={new Set()} attention={new Set()} />),
    );
    await act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(proceed).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it("uses live global persistence truth for route and before-unload guards", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const root = await mountHost(_fixture);
    let livePending: ReadonlySet<string> = new Set();
    function Harness() {
      usePendingSurfaceNavigationBlocker(new Set(), { getPendingSurfaceIds: () => livePending });
      return null;
    }
    await act(async () => await root.rerender(<Harness />));
    const config = mocks.useBlocker.mock.calls[0]?.[0];
    expect(config.enableBeforeUnload()).toBe(false);
    livePending = pending;
    expect(config.enableBeforeUnload()).toBe(true);
    expect(
      config.shouldBlockFn({ current: { pathname: "/one" }, next: { pathname: "/two" } }),
    ).toBe(true);
    expect(
      config.shouldBlockFn({ current: { pathname: "/one" }, next: { pathname: "/one" } }),
    ).toBe(false);
  });

  it("finishes a blocked route once writes settle even if a clean refresh notice remains", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const root = await mountHost(_fixture);
    const proceed = vi.fn();
    const reset = vi.fn();
    const onAttention = vi.fn();
    mocks.useBlocker.mockReturnValue({ status: "blocked", proceed, reset });
    function Harness(props: { pending: ReadonlySet<string>; attention: ReadonlySet<string> }) {
      usePendingSurfaceNavigationBlocker(props.pending, {
        quietSurfaceIds: pending,
        attentionSurfaceIds: props.attention,
        onAttention,
      });
      return null;
    }
    await act(async () => await root.rerender(<Harness pending={pending} attention={new Set()} />));
    expect(proceed).not.toHaveBeenCalled();
    await act(async () => await root.rerender(<Harness pending={new Set()} attention={pending} />));
    expect(proceed).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
    expect(onAttention).not.toHaveBeenCalled();
    const config = mocks.useBlocker.mock.calls.at(-1)?.[0];
    expect(config.enableBeforeUnload()).toBe(false);
    expect(
      config.shouldBlockFn({ current: { pathname: "/one" }, next: { pathname: "/two" } }),
    ).toBe(false);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    root0: [] as Screen[],
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

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
