// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  pendingSurfaceBlocksActivation,
  pendingSurfaceBlocksClose,
  useActivePendingSurfaceDeparture,
  usePendingSurfaceDeparture,
} from "./usePendingSurfaceDeparture";

const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  while (mountedRoots.length > 0) {
    const root = mountedRoots.pop();
    if (root) await act(() => root.unmount());
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

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
});
