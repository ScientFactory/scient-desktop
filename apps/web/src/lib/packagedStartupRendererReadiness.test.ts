import { describe, expect, it, vi } from "vitest";

import { markPackagedStartupRendererReadyAfterShellHydration } from "./packagedStartupRendererReadiness";

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
});
