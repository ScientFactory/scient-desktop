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
  it.each([300, 400, 500] as const)("reloads interface weight %s", async (fontWeightInterface) => {
    getTestWindow();
    const { writeBrowserClientSettings } = await import("./clientPersistenceStorage");
    writeBrowserClientSettings({ ...DEFAULT_CLIENT_SETTINGS, fontWeightInterface });
    vi.resetModules();
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");
    expect(readBrowserClientSettings()?.fontWeightInterface).toBe(fontWeightInterface);
  });

  it.each(["not-json", '{"wordWrap":"invalid"}'])(
    "does not treat invalid saved settings as absent: %s",
    async (value) => {
      const testWindow = getTestWindow();
      testWindow.localStorage.setItem("scient-next:client-settings:v1", value);
      const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

      expect(() => readBrowserClientSettings()).toThrow(
        expect.objectContaining({
          _tag: "LocalStorageOperationError",
          operation: "decode",
          storageKey: "scient-next:client-settings:v1",
        }),
      );
      expect(testWindow.localStorage.getItem("scient-next:client-settings:v1")).toBe(value);
    },
  );

  it("preserves saved settings across a transient read failure", async () => {
    const testWindow = getTestWindow();
    const settings = { ...DEFAULT_CLIENT_SETTINGS, timestampFormat: "12-hour" as const };
    testWindow.localStorage.setItem("scient-next:client-settings:v1", JSON.stringify(settings));
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
        storageKey: "scient-next:client-settings:v1",
        cause: failure,
      }),
    );
    expect(readBrowserClientSettings()).toEqual(settings);
    expect(write).not.toHaveBeenCalled();
  });

  it("uses new defaults only for preferences missing from browser storage", async () => {
    const testWindow = getTestWindow();
    testWindow.localStorage.setItem(
      "scient-next:client-settings:v1",
      JSON.stringify({
        appearanceContrast: 100,
        fontSizeInterface: 18,
        showSkillsInSlashMenu: true,
        sidebarAutoSettleAfterDays: 3,
        sidebarAutoSettleOnMerge: true,
      }),
    );
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

    expect(readBrowserClientSettings()).toEqual(
      expect.objectContaining({
        appearanceContrast: 100,
        fontSizeInterface: 18,
        showSkillsInSlashMenu: true,
      }),
    );
    expect(readBrowserClientSettings()).not.toHaveProperty("sidebarAutoSettleAfterDays");
    expect(readBrowserClientSettings()).not.toHaveProperty("sidebarAutoSettleOnMerge");

    testWindow.localStorage.setItem("scient-next:client-settings:v1", "{}");
    expect(readBrowserClientSettings()).toEqual(
      expect.objectContaining({
        appearanceContrast: 120,
        fontSizeInterface: 17,
        showSkillsInSlashMenu: false,
      }),
    );
  });
});
