import { describe, expect, it, vi } from "vitest";

import {
  browserWebviewFocusGuardsShouldRemainActive,
  browserWebviewHandoffKey,
  browserWebviewRuntimeHostId,
  createStableBrowserWebviewRuntime,
  createBrowserWebviewHandoffRegistry,
  isStableBrowserWebviewRuntimeIntact,
  resolveBrowserWebviewRuntimeHostGeometry,
  resolveBrowserWebviewFocusGuardsAfterDocumentFocusIn,
  resolveBrowserWebviewFocusBridgeTarget,
  resolveBrowserWebviewLogicalOwnerId,
} from "./browserWebviewHandoff";

function createFixture() {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 0;
  const registry = createBrowserWebviewHandoffRegistry<string, number>({
    schedule: (callback) => {
      nextHandle += 1;
      callbacks.set(nextHandle, callback);
      return nextHandle;
    },
    cancel: (handle) => callbacks.delete(handle),
  });
  return {
    registry,
    run(handle: number) {
      callbacks.get(handle)?.();
    },
    callbacks,
  };
}

describe("browser webview handoff registry", () => {
  it("keys ownership by thread, tab, and session partition", () => {
    expect(
      browserWebviewHandoffKey({
        threadId: "thread-1",
        tabId: "tab-1",
        partition: "persist:scient-browser",
      }),
    ).toBe("thread-1\u0000tab-1\u0000persist:scient-browser");
  });

  it("adopts the exact parked value and cancels bounded finalization", () => {
    const fixture = createFixture();
    const finalize = vi.fn();
    fixture.registry.park("surface", "same-webcontents", finalize);

    expect(fixture.registry.adopt("surface")).toBe("same-webcontents");
    expect(fixture.callbacks.size).toBe(0);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("finalizes an unclaimed surface exactly once when its lease expires", () => {
    const fixture = createFixture();
    const finalize = vi.fn();
    fixture.registry.park("surface", "webcontents", finalize);
    const handle = [...fixture.callbacks.keys()][0]!;

    fixture.run(handle);
    fixture.run(handle);

    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith("webcontents");
  });

  it("finalizes a displaced owner and prevents its stale timer from finalizing the successor", () => {
    const fixture = createFixture();
    const finalizeFirst = vi.fn();
    const finalizeSecond = vi.fn();
    fixture.registry.park("surface", "first", finalizeFirst);
    const firstHandle = [...fixture.callbacks.keys()][0]!;
    fixture.registry.park("surface", "second", finalizeSecond);

    fixture.run(firstHandle);

    expect(finalizeFirst).toHaveBeenCalledOnce();
    expect(finalizeSecond).not.toHaveBeenCalled();
    expect(fixture.registry.adopt("surface")).toBe("second");
  });

  it("hands off a stable runtime reference without reparenting its connected guest", () => {
    const callbacks = new Map<number, () => void>();
    let nextHandle = 0;
    const host = {
      isConnected: true,
      append: vi.fn<(node: { isConnected: boolean; parentNode: unknown }) => void>(),
    };
    const node = { isConnected: false, parentNode: null as unknown };
    host.append.mockImplementation((nextNode) => {
      nextNode.isConnected = true;
      nextNode.parentNode = host;
    });
    const runtime = createStableBrowserWebviewRuntime(host, node);
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const registry = createBrowserWebviewHandoffRegistry<typeof runtime, number>({
      schedule: (callback) => {
        nextHandle += 1;
        callbacks.set(nextHandle, callback);
        return nextHandle;
      },
      cancel: (handle) => callbacks.delete(handle),
    });

    registry.park("stable-surface", runtime, vi.fn());
    const adopted = registry.adopt("stable-surface");
    expect(adopted).toBe(runtime);
    expect(adopted && isStableBrowserWebviewRuntimeIntact(adopted)).toBe(true);
    expect(host.append).toHaveBeenCalledOnce();
    expect(node.parentNode).toBe(host);
  });
});

describe("browser webview stable runtime host", () => {
  it("rejects creating a second runtime connection for an existing guest", () => {
    const host = { isConnected: true, append: vi.fn() };
    const node = { isConnected: true, parentNode: {} };

    expect(createStableBrowserWebviewRuntime(host, node)).toBeNull();
    expect(host.append).not.toHaveBeenCalled();
  });

  it("creates a deterministic owner id for the live thread and tab", () => {
    expect(browserWebviewRuntimeHostId("thread/a", "tab 1")).toBe(
      "scient-browser-runtime-10-thread%2Fa-7-tab%201",
    );
    expect(browserWebviewRuntimeHostId("thread/a", "tab 1")).toBe(
      browserWebviewRuntimeHostId("thread/a", "tab 1"),
    );
  });

  it("exposes logical ownership only while the stable host is visible", () => {
    expect(resolveBrowserWebviewLogicalOwnerId("runtime-host", true)).toBe("runtime-host");
    expect(resolveBrowserWebviewLogicalOwnerId("runtime-host", false)).toBeNull();
  });

  it("resolves fixed host geometry and hides non-interactive parked ownership", () => {
    expect(
      resolveBrowserWebviewRuntimeHostGeometry({
        rect: { left: 12.5, top: 28, width: 640, height: 360 },
        visible: true,
      }),
    ).toEqual({
      left: "12.5px",
      top: "28px",
      width: "640px",
      height: "360px",
      visibility: "visible",
      pointerEvents: "auto",
      ariaHidden: false,
      inert: false,
    });
    expect(
      resolveBrowserWebviewRuntimeHostGeometry({
        rect: { left: -10, top: -20, width: -1, height: -2 },
        visible: false,
      }),
    ).toEqual({
      left: "-10px",
      top: "-20px",
      width: "0px",
      height: "0px",
      visibility: "hidden",
      pointerEvents: "none",
      ariaHidden: true,
      inert: true,
    });
  });
});

describe("browser webview focus bridge", () => {
  const resolve = (
    direction: "logical-entry" | "before-exit" | "after-exit",
    overrides: Partial<Parameters<typeof resolveBrowserWebviewFocusBridgeTarget>[0]> = {},
  ) =>
    resolveBrowserWebviewFocusBridgeTarget({
      active: true,
      redirectInProgress: false,
      direction,
      primaryAvailable: true,
      fallbackAvailable: true,
      ...overrides,
    });

  it("gates logical entry on active ownership", () => {
    expect(resolve("logical-entry")).toBe("guest");
    expect(resolve("logical-entry", { active: false })).toBe("none");
  });

  it("routes guest exit in both physical directions", () => {
    expect(resolve("before-exit")).toBe("logical-before");
    expect(resolve("after-exit")).toBe("logical-after");
  });

  it("prevents duplicate redirect stops", () => {
    expect(resolve("after-exit", { redirectInProgress: true })).toBe("none");
  });

  it("drops physical guards when programmatic guest focus does not take", () => {
    expect(
      browserWebviewFocusGuardsShouldRemainActive({
        target: "guest",
        guestReceivedFocus: false,
      }),
    ).toBe(false);
    expect(
      browserWebviewFocusGuardsShouldRemainActive({
        target: "guest",
        guestReceivedFocus: true,
      }),
    ).toBe(true);
    expect(
      browserWebviewFocusGuardsShouldRemainActive({
        target: "logical-after",
        guestReceivedFocus: true,
      }),
    ).toBe(false);
  });

  it("drops active guards when document focus moves outside the guest runtime", () => {
    expect(
      resolveBrowserWebviewFocusGuardsAfterDocumentFocusIn({
        currentlyActive: true,
        target: "outside",
      }),
    ).toBe(false);
    expect(
      resolveBrowserWebviewFocusGuardsAfterDocumentFocusIn({
        currentlyActive: false,
        target: "outside",
      }),
    ).toBe(false);
  });

  it("preserves guards through capture so a true guest Tab exit can route synchronously", () => {
    expect(
      resolveBrowserWebviewFocusGuardsAfterDocumentFocusIn({
        currentlyActive: true,
        target: "before-guard",
      }),
    ).toBe(true);
    expect(
      resolveBrowserWebviewFocusGuardsAfterDocumentFocusIn({
        currentlyActive: true,
        target: "after-guard",
      }),
    ).toBe(true);
    expect(
      resolveBrowserWebviewFocusGuardsAfterDocumentFocusIn({
        currentlyActive: false,
        target: "guest",
      }),
    ).toBe(false);
  });

  it("uses a mounted fallback when a logical target is stale", () => {
    expect(resolve("before-exit", { primaryAvailable: false })).toBe("fallback");
    expect(resolve("before-exit", { primaryAvailable: false, fallbackAvailable: false })).toBe(
      "none",
    );
  });

  it("does nothing while ownership is parked", () => {
    expect(resolve("before-exit", { active: false })).toBe("none");
    expect(resolve("after-exit", { active: false })).toBe("none");
  });
});
