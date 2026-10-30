import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { stubGlobals } from "../../test/scientAppWindows";

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

/** This window of the desktop app; `otherWindowSaved` delivers another window's save notice. */
function setup(locks?: Pick<LockManager, "request">) {
  persistenceMocks.getClientSettings.mockReset().mockResolvedValue(null);
  persistenceMocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
  let listener: ((settings: ClientSettings) => void) | null = null;
  const globals = stubGlobals({
    window: {
      desktopBridge: {
        onClientSettingsChanged: (next: (settings: ClientSettings) => void) => {
          listener = next;
          return () => {
            listener = null;
          };
        },
      },
    },
    navigator: locks === undefined ? {} : { locks },
  });
  return {
    otherWindowSaved: (settings: ClientSettings) => listener!(settings),
    [Symbol.dispose]: () => {
      __resetClientSettingsPersistenceForTests();
      globals[Symbol.dispose]();
    },
  };
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

describe("client settings saved by another desktop window", () => {
  it("are adopted without a write and keep this window's unsaved patches", async () => {
    using desktop = setup();
    persistenceMocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await ensureClientSettingsHydrated();
    const first = blockedWrite();
    const firstPatch = persistClientSettingsPatch({ wordWrap: false });
    await first.started;
    const secondPatch = persistClientSettingsPatch({ timestampFormat: "12-hour" });

    desktop.otherWindowSaved({ ...DEFAULT_CLIENT_SETTINGS, diffLayout: "split" });
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

    desktop.otherWindowSaved({ ...DEFAULT_CLIENT_SETTINGS, wordWrap: true });
    expect(getClientSettings()).toMatchObject({
      wordWrap: true,
      timestampFormat: DEFAULT_CLIENT_SETTINGS.timestampFormat,
    });
  });

  it("stand in for a pending read, whose older result is discarded", async () => {
    using desktop = setup();
    let finishRead!: (settings: ClientSettings) => void;
    persistenceMocks.getClientSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const hydration = ensureClientSettingsHydrated();
    desktop.otherWindowSaved({ ...DEFAULT_CLIENT_SETTINGS, diffLayout: "split" });
    expect(isClientSettingsHydrated()).toBe(true);

    finishRead(DEFAULT_CLIENT_SETTINGS);
    await hydration;
    expect(getClientSettings().diffLayout).toBe("split");
  });

  it.each([
    ["granted", (_name: string, callback: () => Promise<unknown>) => callback()],
    ["unavailable", () => Promise.reject(new DOMException("Locks are unavailable."))],
  ] as const)("are read again before a write when the lock is %s", async (_case, request) => {
    using _desktop = setup({ request } as unknown as Pick<LockManager, "request">);
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    // The other window's change notice has not arrived yet.
    persistenceMocks.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      diffLayout: "split",
    });

    await persistClientSettingsPatch({ wordWrap: false });

    expect(persistenceMocks.setClientSettings).toHaveBeenCalledExactlyOnceWith({
      ...DEFAULT_CLIENT_SETTINGS,
      diffLayout: "split",
      wordWrap: false,
    });
  });
});
