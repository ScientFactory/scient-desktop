import {
  DEFAULT_CLIENT_SETTINGS,
  type ConfirmDialogOptions,
  type ContextMenuItem,
  type DesktopBridge,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
const dismissContextMenuMock = vi.fn<() => void>();

const requestConfirmDialogMock =
  vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>();

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
  dismissContextMenu: dismissContextMenuMock,
}));

vi.mock("./confirmDialog", () => ({
  requestConfirmDialog: requestConfirmDialogMock,
}));

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function testWindow(): Window & typeof globalThis {
  return globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (globalThis.window === undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
  Reflect.deleteProperty(testWindow(), "desktopBridge");
  Object.defineProperty(testWindow(), "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LocalApi", () => {
  // regression: e95b57dc26 [codex] Rewrite client connection architecture (#2978)
  it("delegates host capabilities and persistence to the desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    const pickFolder = vi.fn().mockResolvedValue("/tmp/project");
    const getClientSettings = vi.fn().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    const setClientSettings = vi.fn().mockResolvedValue(undefined);
    const saveAssetCopy = vi.fn().mockResolvedValue({ _tag: "saved", path: "/tmp/report.pdf" });
    const revealSavedAsset = vi.fn().mockResolvedValue(undefined);
    testWindow().desktopBridge = {
      showContextMenu,
      pickFolder,
      getClientSettings,
      setClientSettings,
      saveAssetCopy,
      revealSavedAsset,
    } as unknown as DesktopBridge;

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();
    const items = [{ id: "delete", label: "Delete" }] as const;

    await expect(api.contextMenu.show(items)).resolves.toBe("delete");
    requestConfirmDialogMock.mockReturnValue(undefined);
    await expect(api.dialogs.confirm("Install update?")).resolves.toBe(false);
    await expect(api.dialogs.pickFolder({ initialPath: "/tmp" })).resolves.toBe("/tmp/project");
    await expect(api.persistence.getClientSettings()).resolves.toEqual(DEFAULT_CLIENT_SETTINGS);
    await api.persistence.setClientSettings(DEFAULT_CLIENT_SETTINGS);
    await expect(
      api.documents.saveAssetCopy({
        url: "https://assets.scient.test/report.pdf",
        suggestedFileName: "report.pdf",
      }),
    ).resolves.toEqual({ _tag: "saved", path: "/tmp/report.pdf" });
    const revealSavedCopy = api.documents.revealSavedAsset;
    expect(revealSavedCopy).toBeDefined();
    if (!revealSavedCopy) throw new Error("Expected the desktop reveal capability.");
    await expect(revealSavedCopy("/tmp/report.pdf")).resolves.toBeUndefined();

    expect(showContextMenu).toHaveBeenCalledWith(items, undefined);
    expect(pickFolder).toHaveBeenCalledWith({ initialPath: "/tmp" });
    expect(getClientSettings).toHaveBeenCalledTimes(1);
    expect(setClientSettings).toHaveBeenCalledWith(DEFAULT_CLIENT_SETTINGS);
    expect(saveAssetCopy).toHaveBeenCalledWith({
      url: "https://assets.scient.test/report.pdf",
      suggestedFileName: "report.pdf",
    });
    expect(revealSavedAsset).toHaveBeenCalledWith("/tmp/report.pdf");
  });
});
