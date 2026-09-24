// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { requestDesktopReload, useDesktopReloadGuard } from "./desktopReload";

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(() => "reload-toast"),
  closeToast: vi.fn(),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: mocks.addToast, close: mocks.closeToast },
}));

const mountedRoots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  while (mountedRoots.length) {
    const root = mountedRoots.pop();
    if (root) await act(() => root.unmount());
  }
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "desktopBridge");
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop reload", () => {
  it("waits for live pending files to save before reloading the main window", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const reloadMainWindow = vi.fn(async () => true);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { reloadMainWindow },
    });
    const onFlush = vi.fn();
    const pending = new Set(["file:notes.md"]);
    let livePending: ReadonlySet<string> = pending;
    const options = { getPendingSurfaceIds: () => livePending, onFlush };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    function Harness(props: { pending: ReadonlySet<string> }) {
      useDesktopReloadGuard(props.pending, options, () => undefined);
      return null;
    }

    await act(() => root.render(<Harness pending={pending} />));
    await act(() => requestDesktopReload(true));
    expect(onFlush).toHaveBeenCalledExactlyOnceWith(["file:notes.md"]);
    expect(reloadMainWindow).not.toHaveBeenCalled();

    livePending = new Set();
    await act(() => root.render(<Harness pending={livePending} />));
    expect(reloadMainWindow).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("cancels a blocked reload and requires another request after save attention", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const reloadMainWindow = vi.fn(async () => true);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { reloadMainWindow },
    });
    const pending = new Set(["file:notes.md"]);
    let attention: ReadonlySet<string> = new Set();
    const onAttention = vi.fn();
    const options = {
      getPendingSurfaceIds: () => pending,
      getAttentionSurfaceIds: () => attention,
      onAttention,
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    function Harness(props: { attention: ReadonlySet<string> }) {
      useDesktopReloadGuard(
        pending,
        { ...options, attentionSurfaceIds: props.attention },
        () => undefined,
      );
      return null;
    }

    await act(() => root.render(<Harness attention={attention} />));
    await act(() => requestDesktopReload(false));
    attention = pending;
    await act(() => root.render(<Harness attention={attention} />));
    expect(onAttention).toHaveBeenCalledExactlyOnceWith("file:notes.md");
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Reload paused" }),
    );
    expect(reloadMainWindow).not.toHaveBeenCalled();
  });
});
