import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

const RIGHT_PANEL_STORAGE_KEY = "t3code:right-panel-state:v2";
const threadA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const threadB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

function sharedLocalStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

async function openAppWindow(storage: ReturnType<typeof sharedLocalStorage>) {
  const appWindow = Object.assign(new EventTarget(), { localStorage: storage });
  vi.resetModules();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", appWindow);
  const { useRightPanelStore } = await import("../../rightPanelStore");
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return {
    store: useRightPanelStore,
    surfaceIds: (ref: typeof threadA) =>
      useRightPanelStore
        .getState()
        .byThreadKey[scopedThreadKey(ref)]?.surfaces.map((surface) => surface.id) ?? [],
    receiveStorageEvent: () =>
      appWindow.dispatchEvent(
        Object.assign(new Event("storage"), { key: RIGHT_PANEL_STORAGE_KEY }),
      ),
  };
}

function storedThreadKeys(storage: ReturnType<typeof sharedLocalStorage>) {
  const persisted = JSON.parse(storage.getItem(RIGHT_PANEL_STORAGE_KEY) ?? "{}") as {
    state?: { byThreadKey?: Record<string, unknown> };
  };
  return Object.keys(persisted.state?.byThreadKey ?? {}).toSorted();
}

describe("side panel state across app windows", () => {
  it("keeps another window's thread when a stale window saves, then shows its tabs", async () => {
    const storage = sharedLocalStorage();
    const first = await openAppWindow(storage);
    const second = await openAppWindow(storage);

    first.store.getState().openBrowser(threadA, "tab-1");
    second.store.getState().open(threadB, "diff");
    expect(storedThreadKeys(storage)).toEqual(
      [scopedThreadKey(threadA), scopedThreadKey(threadB)].toSorted(),
    );

    expect(second.surfaceIds(threadA)).toEqual([]);
    second.receiveStorageEvent();
    expect(second.surfaceIds(threadA)).toEqual(first.surfaceIds(threadA));
    expect(second.surfaceIds(threadB)).toEqual(["diff"]);
  });

  it("adopts a tab closed and a panel hidden in another window", async () => {
    const storage = sharedLocalStorage();
    const first = await openAppWindow(storage);
    first.store.getState().open(threadA, "diff");
    first.store.getState().open(threadA, "files");
    const second = await openAppWindow(storage);

    first.store.getState().closeSurface(threadA, "diff");
    first.store.getState().setThreadPanelOpen(threadA, "inline", false);
    second.receiveStorageEvent();

    expect(second.surfaceIds(threadA)).toEqual(["files"]);
    expect(
      second.store.getState().threadPanelVisibilityByThreadKey[scopedThreadKey(threadA)],
    ).toEqual({ inlineOpen: false, popoverOpen: false });
  });
});
