import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import type { ThreadRightPanelState } from "../../rightPanelStore";

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

function storedState(storage: ReturnType<typeof sharedLocalStorage>) {
  const persisted = JSON.parse(storage.getItem(RIGHT_PANEL_STORAGE_KEY) ?? "{}") as {
    state?: { byThreadKey?: Record<string, ThreadRightPanelState> };
  };
  return persisted.state?.byThreadKey ?? {};
}

function storedThreadKeys(storage: ReturnType<typeof sharedLocalStorage>) {
  return Object.keys(storedState(storage)).toSorted();
}

function panelView(window: Awaited<ReturnType<typeof openAppWindow>>, ref: typeof threadA) {
  const state = window.store.getState().byThreadKey[scopedThreadKey(ref)];
  return {
    isOpen: state?.isOpen,
    activeSurfaceId: state?.activeSurfaceId,
    maximized: state?.maximized ?? false,
  };
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

  it("adopts a tab closed in another window but keeps its own thread details panel", async () => {
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
    ).toBeUndefined();
  });

  it("keeps each window's selected tab, open panel and maximized panel", async () => {
    const storage = sharedLocalStorage();
    const first = await openAppWindow(storage);
    first.store.getState().open(threadA, "diff");
    first.store.getState().open(threadA, "files");
    const second = await openAppWindow(storage);

    second.store.getState().activateSurface(threadA, "diff");
    second.store.getState().setMaximized(threadA, true);
    first.receiveStorageEvent();
    expect(panelView(first, threadA)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      maximized: false,
    });

    first.store.getState().close(threadA);
    first.store.getState().open(threadA, "pull-requests");
    first.store.getState().close(threadA);
    second.receiveStorageEvent();
    expect(second.surfaceIds(threadA)).toEqual(["diff", "files", "pull-requests"]);
    expect(panelView(second, threadA)).toEqual({
      isOpen: true,
      activeSurfaceId: "diff",
      maximized: true,
    });
  });

  it("shows the neighbouring tab when another window closes the one this window shows", async () => {
    const storage = sharedLocalStorage();
    const first = await openAppWindow(storage);
    first.store.getState().open(threadA, "diff");
    first.store.getState().open(threadA, "files");
    first.store.getState().open(threadA, "pull-requests");
    const second = await openAppWindow(storage);
    second.store.getState().activateSurface(threadA, "files");
    first.store.getState().activateSurface(threadA, "diff");

    first.store.getState().closeSurface(threadA, "files");
    second.receiveStorageEvent();

    expect(panelView(second, threadA)).toMatchObject({ activeSurfaceId: "pull-requests" });
    expect(panelView(first, threadA)).toMatchObject({ activeSurfaceId: "diff" });
  });

  it("keeps a tab another window added when a window that only switched tabs saves", async () => {
    const storage = sharedLocalStorage();
    const first = await openAppWindow(storage);
    first.store.getState().open(threadA, "diff");
    first.store.getState().open(threadA, "files");
    const second = await openAppWindow(storage);

    first.store.getState().open(threadA, "pull-requests");
    second.store.getState().activateSurface(threadA, "diff");

    const stored = storedState(storage)[scopedThreadKey(threadA)];
    expect(stored?.surfaces.map((surface) => surface.id)).toEqual([
      "diff",
      "files",
      "pull-requests",
    ]);
    expect(stored?.activeSurfaceId).toBe("diff");
    first.receiveStorageEvent();
    expect(panelView(first, threadA)).toMatchObject({ activeSurfaceId: "pull-requests" });
  });
});
