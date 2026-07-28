import { describe, expect, it, vi } from "vitest";

import {
  browserWebviewHandoffKey,
  createBrowserWebviewHandoffRegistry,
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
    expect(fixture.registry.has("surface")).toBe(false);
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

  it("allows explicit final closure without waiting for the lease", () => {
    const fixture = createFixture();
    const finalize = vi.fn();
    fixture.registry.park("surface", "webcontents", finalize);

    expect(fixture.registry.finalize("surface")).toBe(true);
    expect(fixture.registry.finalize("surface")).toBe(false);
    expect(finalize).toHaveBeenCalledOnce();
    expect(fixture.callbacks.size).toBe(0);
  });
});
