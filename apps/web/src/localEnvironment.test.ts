import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("launch-stable local environment mode", () => {
  it.each([true, false])("reads the desktop flag once when enabled=%s", async (enabled) => {
    const getLocalEnvironmentEnabled = vi.fn(() => enabled);
    vi.stubGlobal("window", { desktopBridge: { getLocalEnvironmentEnabled } });
    const { isLocalEnvironmentDisabled } = await import("./localEnvironment");
    for (let index = 0; index < 100; index++) {
      expect(isLocalEnvironmentDisabled()).toBe(!enabled);
    }
    expect(getLocalEnvironmentEnabled).toHaveBeenCalledOnce();
  });

  it.each([undefined, {}])(
    "retains the browser/older bridge fallback: %s",
    async (desktopBridge) => {
      vi.stubGlobal("window", { desktopBridge });
      const { isLocalEnvironmentDisabled } = await import("./localEnvironment");
      expect(isLocalEnvironmentDisabled()).toBe(false);
    },
  );

  it("reads again for a new renderer window", async () => {
    const { isLocalEnvironmentDisabled } = await import("./localEnvironment");
    const firstRead = vi.fn(() => true);
    vi.stubGlobal("window", { desktopBridge: { getLocalEnvironmentEnabled: firstRead } });
    expect(isLocalEnvironmentDisabled()).toBe(false);
    expect(isLocalEnvironmentDisabled()).toBe(false);
    const nextRead = vi.fn(() => false);
    vi.stubGlobal("window", { desktopBridge: { getLocalEnvironmentEnabled: nextRead } });
    expect(isLocalEnvironmentDisabled()).toBe(true);
    expect(isLocalEnvironmentDisabled()).toBe(true);
    expect(firstRead).toHaveBeenCalledOnce();
    expect(nextRead).toHaveBeenCalledOnce();
  });

  it("does not cache a failed read", async () => {
    const getLocalEnvironmentEnabled = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("IPC unavailable");
      })
      .mockReturnValue(false);
    vi.stubGlobal("window", { desktopBridge: { getLocalEnvironmentEnabled } });
    const { isLocalEnvironmentDisabled } = await import("./localEnvironment");
    expect(() => isLocalEnvironmentDisabled()).toThrow("IPC unavailable");
    expect(isLocalEnvironmentDisabled()).toBe(true);
    expect(isLocalEnvironmentDisabled()).toBe(true);
    expect(getLocalEnvironmentEnabled).toHaveBeenCalledTimes(2);
  });
});
