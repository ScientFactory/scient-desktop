import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const persistenceMocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: persistenceMocks }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  ensureClientSettingsHydrated,
  getClientSettings,
  isClientSettingsHydrated,
  persistClientSettingsPatch,
} from "./useSettings";

const otherWindow = vi.hoisted(() => ({
  listener: null as ((settings: ClientSettings) => void) | null,
}));

function stubDesktopWindow(locks?: Pick<LockManager, "request">) {
  vi.stubGlobal("window", {
    desktopBridge: {
      onClientSettingsChanged: (listener: (settings: ClientSettings) => void) => {
        otherWindow.listener = listener;
        return () => {
          otherWindow.listener = null;
        };
      },
    },
  });
  vi.stubGlobal("navigator", locks === undefined ? {} : { locks });
}

function blockedWrite() {
  let finish!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  persistenceMocks.setClientSettings.mockImplementationOnce(() => {
    markStarted();
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  return { started, finish: () => finish() };
}

beforeEach(() => {
  persistenceMocks.getClientSettings.mockReset().mockResolvedValue(null);
  persistenceMocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
});

afterEach(() => {
  __resetClientSettingsPersistenceForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client settings saved by another desktop window", () => {
  it("are adopted without a write and keep this window's unsaved patches", async () => {
    stubDesktopWindow();
    persistenceMocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await ensureClientSettingsHydrated();
    const first = blockedWrite();
    const firstPatch = persistClientSettingsPatch({ wordWrap: false });
    await first.started;
    const secondPatch = persistClientSettingsPatch({ timestampFormat: "12-hour" });

    otherWindow.listener!({ ...DEFAULT_CLIENT_SETTINGS, diffLayout: "split" });
    expect(getClientSettings()).toMatchObject({
      diffLayout: "split",
      wordWrap: false,
      timestampFormat: "12-hour",
    });
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledOnce();

    first.finish();
    await Promise.all([firstPatch, secondPatch]);
    expect(persistenceMocks.setClientSettings.mock.lastCall?.[0]).toMatchObject({
      diffLayout: "split",
      wordWrap: false,
      timestampFormat: "12-hour",
    });

    otherWindow.listener!({ ...DEFAULT_CLIENT_SETTINGS, wordWrap: true });
    expect(getClientSettings()).toMatchObject({
      wordWrap: true,
      timestampFormat: DEFAULT_CLIENT_SETTINGS.timestampFormat,
    });
  });

  it("stand in for a pending read, whose older result is discarded", async () => {
    stubDesktopWindow();
    let finishRead!: (settings: ClientSettings) => void;
    persistenceMocks.getClientSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const hydration = ensureClientSettingsHydrated();
    otherWindow.listener!({ ...DEFAULT_CLIENT_SETTINGS, diffLayout: "split" });
    expect(isClientSettingsHydrated()).toBe(true);

    finishRead(DEFAULT_CLIENT_SETTINGS);
    await hydration;
    expect(getClientSettings().diffLayout).toBe("split");
  });

  it("are read again under the cross-window lock before a write", async () => {
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => callback());
    stubDesktopWindow({ request } as unknown as Pick<LockManager, "request">);
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    // The other window's change notice has not arrived yet.
    persistenceMocks.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      diffLayout: "split",
    });

    await persistClientSettingsPatch({ wordWrap: false });

    expect(request).toHaveBeenCalledOnce();
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledExactlyOnceWith({
      ...DEFAULT_CLIENT_SETTINGS,
      diffLayout: "split",
      wordWrap: false,
    });
  });
});
