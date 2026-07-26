import { describe, expect, it, vi } from "vitest";

import {
  createPackagedStartupRendererReadinessState,
  hydrateShellForPackagedStartupRenderer,
  markPackagedStartupRendererReadyAfterShellHydration,
} from "./packagedStartupRendererReadiness";

describe("packaged startup renderer readiness", () => {
  it("marks readiness only after the authoritative shell snapshot hydrates", async () => {
    let resolveHydration!: () => void;
    const hydration = new Promise<void>((resolve) => {
      resolveHydration = resolve;
    });
    const element = { dataset: {} as DOMStringMap };
    const pending = markPackagedStartupRendererReadyAfterShellHydration({
      hydrateShell: () => hydration,
      element,
    });

    expect(element.dataset.scientRendererReady).toBeUndefined();
    resolveHydration();
    const clear = await pending;
    expect(element.dataset.scientRendererReady).toBe("true");

    clear();
    expect(element.dataset.scientRendererReady).toBeUndefined();
  });

  it("does not certify a renderer whose shell hydration fails", async () => {
    const element = { dataset: {} as DOMStringMap };
    const hydrateShell = vi.fn(async () => {
      throw new Error("preload bridge unavailable");
    });

    await expect(
      markPackagedStartupRendererReadyAfterShellHydration({ hydrateShell, element }),
    ).rejects.toThrow("preload bridge unavailable");
    expect(element.dataset.scientRendererReady).toBeUndefined();
  });

  it("does not mark a router disposed while hydration was pending", async () => {
    const element = { dataset: {} as DOMStringMap };

    await markPackagedStartupRendererReadyAfterShellHydration({
      hydrateShell: async () => undefined,
      element,
      shouldMark: () => false,
    });

    expect(element.dataset.scientRendererReady).toBeUndefined();
  });

  it("awaits shell hydration again on a later server welcome", async () => {
    const element = { dataset: {} as DOMStringMap };
    const state = createPackagedStartupRendererReadinessState();
    const firstHydration = vi.fn(async () => undefined);
    await hydrateShellForPackagedStartupRenderer({
      hydrateShell: firstHydration,
      state,
      element,
    });

    let resolveReconnect!: () => void;
    const reconnectHydration = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReconnect = resolve;
        }),
    );
    let reconnectSettled = false;
    const reconnect = hydrateShellForPackagedStartupRenderer({
      hydrateShell: reconnectHydration,
      state,
      element,
    }).then(() => {
      reconnectSettled = true;
    });

    await Promise.resolve();
    expect(firstHydration).toHaveBeenCalledTimes(1);
    expect(reconnectHydration).toHaveBeenCalledTimes(1);
    expect(reconnectSettled).toBe(false);
    resolveReconnect();
    await reconnect;
    expect(reconnectSettled).toBe(true);
    expect(element.dataset.scientRendererReady).toBe("true");
  });

  it("propagates a later server-welcome hydration failure to its awaiting caller", async () => {
    const element = { dataset: {} as DOMStringMap };
    const state = createPackagedStartupRendererReadinessState();
    await hydrateShellForPackagedStartupRenderer({
      hydrateShell: async () => undefined,
      state,
      element,
    });

    await expect(
      hydrateShellForPackagedStartupRenderer({
        hydrateShell: async () => {
          throw new Error("reconnect shell unavailable");
        },
        state,
        element,
      }),
    ).rejects.toThrow("reconnect shell unavailable");
    expect(state.inFlight).toBeNull();
    expect(element.dataset.scientRendererReady).toBe("true");
  });
});
