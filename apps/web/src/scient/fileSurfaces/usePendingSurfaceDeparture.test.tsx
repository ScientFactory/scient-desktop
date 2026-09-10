// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("@tanstack/react-router", () => ({ useBlocker: mocks.useBlocker }));

const mountedRoots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.useBlocker.mockReturnValue({ status: "idle" });
});

afterEach(async () => {
  while (mountedRoots.length > 0) {
    const root = mountedRoots.pop();
    if (root) await act(() => root.unmount());
  }
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mountHost() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.push(root);
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

  it("blocks leaving an active pending file but allows staying or entering it", () => {
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

  it("blocks only close operations whose target set contains a pending file", () => {
    expect(pendingSurfaceBlocksClose(["file:notes.md"], pending)).toBe(true);
    expect(pendingSurfaceBlocksClose(["browser:tab-1"], pending)).toBe(false);
    expect(pendingSurfaceBlocksClose([], pending)).toBe(false);
  });

  it("runs the latest requested departure after the pending file confirms", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mountedRoots.push(root);
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

    await act(() => root.render(<Harness pendingSurfaceIds={pending} />));
    await act(() => {
      requestDeparture?.(["file:notes.md"], superseded);
      requestDeparture?.(["file:notes.md"], departed);
    });
    expect(superseded).not.toHaveBeenCalled();
    expect(departed).not.toHaveBeenCalled();

    await act(() => root.render(<Harness pendingSurfaceIds={new Set()} />));
    expect(superseded).not.toHaveBeenCalled();
    expect(departed).toHaveBeenCalledOnce();
  });

  it("adapts active-surface switches without blocking unrelated actions", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mountedRoots.push(root);
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

    await act(() => root.render(<Harness />));
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
    vi.useFakeTimers();
    const root = mountHost();
    const { Harness, request } = createDepartureHarness();
    const onFlush = vi.fn();
    const departed = vi.fn();
    const options = { quietSurfaceIds: pending, onFlush };
    await act(() => root.render(<Harness pending={pending} options={options} />));
    await act(() => {
      request(departed);
    });
    expect(onFlush).toHaveBeenCalledExactlyOnceWith(["file:notes.md"]);
    await act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(mocks.addToast).not.toHaveBeenCalled();
    await act(() => root.render(<Harness pending={new Set()} options={options} />));
    await act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(departed).toHaveBeenCalledOnce();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it("shows only one delayed requested-departure message and clears it on success", async () => {
    vi.useFakeTimers();
    const root = mountHost();
    const { Harness, request } = createDepartureHarness();
    const options = { quietSurfaceIds: pending };
    const departed = vi.fn();
    await act(() => root.render(<Harness pending={pending} options={options} />));
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
    await act(() => root.render(<Harness pending={new Set()} options={options} />));
    expect(mocks.closeToast).toHaveBeenCalledWith("departure-toast");
    expect(departed).toHaveBeenCalledOnce();
  });

  it("cancels a requested departure on attention and does not resume after recovery", async () => {
    vi.useFakeTimers();
    const root = mountHost();
    const { Harness, request } = createDepartureHarness();
    const onAttention = vi.fn();
    const departed = vi.fn();
    const options = { quietSurfaceIds: pending, onAttention };
    await act(() => root.render(<Harness pending={pending} options={options} />));
    await act(() => {
      request(departed);
      vi.advanceTimersByTime(1_000);
    });
    await act(() =>
      root.render(
        <Harness pending={pending} options={{ ...options, attentionSurfaceIds: pending }} />,
      ),
    );
    expect(onAttention).toHaveBeenCalledExactlyOnceWith("file:notes.md");
    expect(mocks.closeToast).toHaveBeenCalledWith("departure-toast");
    await act(() => root.render(<Harness pending={new Set()} options={options} />));
    expect(departed).not.toHaveBeenCalled();
    await act(() => {
      request(departed);
    });
    expect(departed).toHaveBeenCalledOnce();
  });

  it("reads synchronous pending and attention truth before React rerenders", async () => {
    const root = mountHost();
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
    await act(() => root.render(<Harness pending={new Set()} options={options} />));
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
    const root = mountHost();
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
    await act(() => root.render(<Harness pending={pending} options={options} />));
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
    vi.useFakeTimers();
    const root = mountHost();
    const { Harness, request } = createDepartureHarness();
    const departed = vi.fn();
    await act(() =>
      root.render(<Harness pending={pending} options={{ quietSurfaceIds: pending }} />),
    );
    await act(() => {
      request(departed);
    });
    await act(() => root.render(null));
    await act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(departed).not.toHaveBeenCalled();
  });

  it("preserves immediate non-Markdown departure feedback", async () => {
    const root = mountHost();
    const { Harness, request } = createDepartureHarness();
    await act(() => root.render(<Harness pending={pending} />));
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
    vi.useFakeTimers();
    const root = mountHost();
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
    await act(() => root.render(<Harness pending={pending} attention={new Set()} />));
    expect(onFlush).toHaveBeenCalledOnce();
    expect(mocks.addToast).not.toHaveBeenCalled();
    await act(() => root.render(<Harness pending={pending} attention={pending} />));
    expect(reset).toHaveBeenCalledOnce();
    expect(onAttention).toHaveBeenCalledExactlyOnceWith("file:notes.md");
    await act(() => root.render(<Harness pending={new Set()} attention={new Set()} />));
    await act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(proceed).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it("uses live global persistence truth for route and before-unload guards", async () => {
    const root = mountHost();
    let livePending: ReadonlySet<string> = new Set();
    function Harness() {
      usePendingSurfaceNavigationBlocker(new Set(), { getPendingSurfaceIds: () => livePending });
      return null;
    }
    await act(() => root.render(<Harness />));
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
    const root = mountHost();
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
    await act(() => root.render(<Harness pending={pending} attention={new Set()} />));
    expect(proceed).not.toHaveBeenCalled();
    await act(() => root.render(<Harness pending={new Set()} attention={pending} />));
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
