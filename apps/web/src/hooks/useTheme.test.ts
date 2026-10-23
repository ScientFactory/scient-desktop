import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme failure handling", () => {
  it("preserves exact storage causes and operation context", async () => {
    const readCause = new Error("storage read blocked");
    const writeCause = new Error("storage quota exceeded");
    const storage = createStorage();
    const getItem = vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw readCause;
    });
    const setItem = storage.setItem;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (key === "scient-next:theme") throw writeCause;
      setItem(key, value);
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", {
      localStorage: storage,
    });
    vi.doMock("react", () => ({
      useEffect: vi.fn(),
      useSyncExternalStore: (
        _subscribe: unknown,
        _getSnapshot: unknown,
        getServerSnapshot: () => unknown,
      ) => getServerSnapshot(),
    }));

    const { readThemePreference, ThemeStorageError, useTheme } = await import("./useTheme");

    try {
      readThemePreference();
      expect.unreachable("expected the theme read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "scient-next:theme",
        cause: readCause,
      });
    }

    getItem.mockRestore();
    expect(useTheme().setTheme("dark")).toBe(false);
    expect(storage.getItem("scient-next:theme")).toBeNull();
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to write theme preference for scient-next:theme.",
      expect.objectContaining({
        operation: "write",
        storageKey: "scient-next:theme",
        theme: "dark",
        errorTag: "ThemeStorageError",
      }),
    );
    const attributes = errorLog.mock.calls.at(-1)?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(writeCause.message);
  });

  it("falls back during initial theme application and logs only safe attributes", async () => {
    const cause = new Error("private browsing storage failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw cause;
        },
      }),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
      },
    });

    await expect(import("./useTheme")).resolves.toBeDefined();

    expect(errorLog).toHaveBeenCalledWith(
      "Failed to read theme preference for scient-next:theme.",
      expect.objectContaining({
        operation: "read",
        storageKey: "scient-next:theme",
        errorTag: "ThemeStorageError",
      }),
    );
    const attributes = errorLog.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);
  });
});
