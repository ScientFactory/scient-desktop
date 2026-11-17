import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function getTestWindow(): Window & typeof globalThis {
  const localStorage = createLocalStorageStub();
  const testWindow = {
    localStorage,
  } as Window & typeof globalThis;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  return testWindow;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clientPersistenceStorage", () => {
  // SCIENT-FORK:START
  it("reloads the interface weight", async () => {
    getTestWindow();
    const { writeBrowserClientSettings } = await import("./clientPersistenceStorage");
    writeBrowserClientSettings({ ...DEFAULT_CLIENT_SETTINGS, fontWeightInterface: 500 });
    vi.resetModules();
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");
    expect(readBrowserClientSettings()?.fontWeightInterface).toBe(500);
  });

  // SCIENT-FORK:END
  it.each(["not-json", '{"wordWrap":"invalid"}'])(
    "does not treat invalid saved settings as absent: %s",
    async (value) => {
      const testWindow = getTestWindow();
      // SCIENT-FORK:START
      testWindow.localStorage.setItem("scient-next:client-settings:v1", value);
      // SCIENT-FORK:END
      const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

      expect(() => readBrowserClientSettings()).toThrow(
        expect.objectContaining({
          _tag: "LocalStorageOperationError",
          operation: "decode",
          // SCIENT-FORK:START
          storageKey: "scient-next:client-settings:v1",
          // SCIENT-FORK:END
        }),
      );
      // SCIENT-FORK:START
      expect(testWindow.localStorage.getItem("scient-next:client-settings:v1")).toBe(value);
      // SCIENT-FORK:END
    },
  );

  it("preserves saved settings across a transient read failure", async () => {
    const testWindow = getTestWindow();
    const settings = { ...DEFAULT_CLIENT_SETTINGS, timestampFormat: "12-hour" as const };
    // SCIENT-FORK:START
    testWindow.localStorage.setItem("scient-next:client-settings:v1", JSON.stringify(settings));
    // SCIENT-FORK:END
    const write = vi.spyOn(testWindow.localStorage, "setItem");
    const failure = new Error("storage unavailable");
    vi.spyOn(testWindow.localStorage, "getItem").mockImplementationOnce(() => {
      throw failure;
    });
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

    expect(() => readBrowserClientSettings()).toThrow(
      expect.objectContaining({
        _tag: "LocalStorageOperationError",
        operation: "read",
        // SCIENT-FORK:START
        storageKey: "scient-next:client-settings:v1",
        // SCIENT-FORK:END
        cause: failure,
      }),
    );
    expect(readBrowserClientSettings()).toEqual(settings);
    expect(write).not.toHaveBeenCalled();
  });
  // SCIENT-FORK:START

  it("uses new defaults only for preferences missing from browser storage", async () => {
    const testWindow = getTestWindow();
    testWindow.localStorage.setItem(
      "scient-next:client-settings:v1",
      JSON.stringify({
        fontSizeInterface: 18,
        showSkillsInSlashMenu: true,
        sidebarAutoSettleAfterDays: 3,
        sidebarAutoSettleOnMerge: true,
      }),
    );
    // Saved after every one-time reset, so only missing keys take defaults.
    testWindow.localStorage.setItem("scient-next:client-settings:v1:resets", "3");
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

    expect(readBrowserClientSettings()).toEqual(
      expect.objectContaining({
        fontSizeInterface: 18,
        showSkillsInSlashMenu: true,
      }),
    );
    expect(readBrowserClientSettings()).not.toHaveProperty("sidebarAutoSettleAfterDays");
    expect(readBrowserClientSettings()).not.toHaveProperty("sidebarAutoSettleOnMerge");

    testWindow.localStorage.setItem("scient-next:client-settings:v1", "{}");
    expect(readBrowserClientSettings()).toEqual(
      expect.objectContaining({
        fontSizeInterface: 15,
        showSkillsInSlashMenu: false,
      }),
    );
  });

  it("returns font sizes saved before the size reset to the defaults once, then keeps a later choice", async () => {
    const testWindow = getTestWindow();
    testWindow.localStorage.setItem(
      "scient-next:client-settings:v1",
      JSON.stringify({ fontSizeInterface: 17, fontSizePrompt: 18, fontSizeCode: 15 }),
    );
    testWindow.localStorage.setItem("scient-next:client-settings:v1:resets", "2");
    const { readBrowserClientSettings, writeBrowserClientSettings } =
      await import("./clientPersistenceStorage");

    const reset = readBrowserClientSettings();
    expect(reset).toEqual(
      expect.objectContaining({
        fontSizeInterface: 15,
        fontSizePrompt: 16,
        fontSizeCode: 14,
        fontSizeTerminal: 14,
      }),
    );

    writeBrowserClientSettings({ ...DEFAULT_CLIENT_SETTINGS, fontSizeInterface: 17 });
    expect(readBrowserClientSettings()?.fontSizeInterface).toBe(17);
  });
  // SCIENT-FORK:END
});
