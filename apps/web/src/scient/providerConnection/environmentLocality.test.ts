import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../localEnvironment", () => ({ isLocalEnvironmentDisabled: () => false }));

import { isConnectionTargetOnThisDevice } from "./environmentLocality";

const primary = { _tag: "PrimaryConnectionTarget" } as never;
const desktopLocal = { _tag: "BearerConnectionTarget", connectionId: "local:wsl:Ubuntu" } as never;
const remote = { _tag: "BearerConnectionTarget", connectionId: "ssh:lab-server" } as never;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("environment locality", () => {
  it("counts only the desktop app's own backends as on this device", () => {
    vi.stubGlobal("window", { desktopBridge: {}, location: { hostname: "localhost" } });
    expect(isConnectionTargetOnThisDevice(primary)).toBe(true);
    expect(isConnectionTargetOnThisDevice(desktopLocal)).toBe(true);
    expect(isConnectionTargetOnThisDevice(remote)).toBe(false);
  });

  it("does not trust localhost in a browser tab, which can be an SSH tunnel to a remote server", () => {
    vi.stubGlobal("window", { location: { hostname: "localhost" } });
    expect(isConnectionTargetOnThisDevice(primary)).toBe(false);
    vi.stubGlobal("window", { location: { hostname: "127.0.0.1" } });
    expect(isConnectionTargetOnThisDevice(primary)).toBe(false);
  });
});
