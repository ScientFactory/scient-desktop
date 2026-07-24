// FILE: browserRuntimeLoad.test.ts
// Purpose: Guards browser navigation against stale and destroyed Electron runtimes.
// Layer: Desktop unit test
// Depends on: browserRuntimeLoad

import { describe, expect, it, vi } from "vitest";

import { loadBrowserRuntimeUrl } from "./browserRuntimeLoad";

function runtime(
  overrides: {
    currentUrl?: string;
    isDestroyed?: () => boolean;
    getURL?: () => string;
    loadURL?: (url: string) => Promise<void>;
    isCurrent?: () => boolean;
  } = {},
) {
  const onLoadStart = vi.fn();
  const loadURL = vi.fn(overrides.loadURL ?? (async () => undefined));
  const webContents = {
    isDestroyed: overrides.isDestroyed ?? (() => false),
    getURL: overrides.getURL ?? (() => overrides.currentUrl ?? "about:blank"),
    loadURL,
  };

  return {
    input: {
      webContents,
      nextUrl: "https://example.com/",
      force: false,
      isCurrent: overrides.isCurrent ?? (() => true),
      onLoadStart,
    },
    loadURL,
    onLoadStart,
  };
}

describe("loadBrowserRuntimeUrl", () => {
  it("skips an unchanged live runtime", async () => {
    const testRuntime = runtime({ currentUrl: "https://example.com/" });

    await expect(loadBrowserRuntimeUrl(testRuntime.input)).resolves.toBe("unchanged");
    expect(testRuntime.onLoadStart).not.toHaveBeenCalled();
    expect(testRuntime.loadURL).not.toHaveBeenCalled();
  });

  it("loads a changed URL and reports the loading transition", async () => {
    const testRuntime = runtime();

    await expect(loadBrowserRuntimeUrl(testRuntime.input)).resolves.toBe("loaded");
    expect(testRuntime.onLoadStart).toHaveBeenCalledOnce();
    expect(testRuntime.loadURL).toHaveBeenCalledWith("https://example.com/");
  });

  it("treats a destroyed getURL race as stale instead of rejecting", async () => {
    let destroyed = false;
    const testRuntime = runtime({
      isDestroyed: () => destroyed,
      getURL: () => {
        destroyed = true;
        throw new Error("Object has been destroyed");
      },
    });

    await expect(loadBrowserRuntimeUrl(testRuntime.input)).resolves.toBe("stale");
    expect(testRuntime.onLoadStart).not.toHaveBeenCalled();
  });

  it("ignores a runtime invalidated while loadURL is pending", async () => {
    let current = true;
    const testRuntime = runtime({
      isCurrent: () => current,
      loadURL: async () => {
        current = false;
        throw new Error("Object has been destroyed");
      },
    });

    await expect(loadBrowserRuntimeUrl(testRuntime.input)).resolves.toBe("stale");
    expect(testRuntime.onLoadStart).toHaveBeenCalledOnce();
  });

  it("distinguishes aborted navigation from a current-runtime load failure", async () => {
    const aborted = runtime({
      loadURL: async () => {
        throw new Error("net::ERR_ABORTED (-3)");
      },
    });
    const failed = runtime({
      loadURL: async () => {
        throw new Error("net::ERR_CONNECTION_RESET");
      },
    });

    await expect(loadBrowserRuntimeUrl(aborted.input)).resolves.toBe("aborted");
    await expect(loadBrowserRuntimeUrl(failed.input)).resolves.toBe("failed");
  });
});
