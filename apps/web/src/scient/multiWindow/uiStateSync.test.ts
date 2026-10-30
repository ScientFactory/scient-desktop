import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { PERSISTED_STATE_KEY, type PersistedUiState } from "../../uiStateStore";

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
  const { useUiStateStore } = await import("../../uiStateStore");
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return {
    store: useUiStateStore,
    save: () => appWindow.dispatchEvent(new Event("beforeunload")),
    receiveStorageEvent: () =>
      appWindow.dispatchEvent(Object.assign(new Event("storage"), { key: PERSISTED_STATE_KEY })),
  };
}

function stored(storage: ReturnType<typeof sharedLocalStorage>): PersistedUiState {
  return JSON.parse(storage.getItem(PERSISTED_STATE_KEY) ?? "{}") as PersistedUiState;
}

describe("UI state across app windows", () => {
  it("keeps another window's sidebar order when a stale window saves, then adopts it", async () => {
    const storage = sharedLocalStorage();
    storage.setItem(PERSISTED_STATE_KEY, JSON.stringify({ projectOrder: ["a", "b", "c"] }));
    const first = await openAppWindow(storage);
    const second = await openAppWindow(storage);

    first.store.getState().reorderProjects(["a", "b", "c"], ["c"], ["a"]);
    first.save();
    second.store.getState().setPullRequestMergeMethod("squash");
    second.save();
    expect(stored(storage)).toMatchObject({
      projectOrder: ["c", "a", "b"],
      pullRequestMergeMethod: "squash",
    });

    second.receiveStorageEvent();
    expect(second.store.getState().projectOrder).toEqual(["c", "a", "b"]);
  });

  it("adopts another window's save except a field this window has not saved yet", async () => {
    const storage = sharedLocalStorage();
    const first = await openAppWindow(storage);
    const second = await openAppWindow(storage);

    second.store.getState().setSidebarProjectScopeKeys(["unsaved-here"]);
    first.store.getState().setSidebarProjectScopeKeys(["from-first"]);
    first.store.getState().setProjectExpanded("project", false);
    first.save();
    second.receiveStorageEvent();
    expect(second.store.getState().projectExpandedById).toEqual({ project: false });
    expect(second.store.getState().sidebarProjectScopeKeys).toEqual(["unsaved-here"]);

    second.save();
    expect(stored(storage)).toMatchObject({
      projectExpandedById: { project: false },
      sidebarProjectScopeKeys: ["unsaved-here"],
    });
  });

  it("saves the later visit of either window, and an unread mark made here", async () => {
    const storage = sharedLocalStorage();
    storage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        threadLastVisitedAtById: {
          visited: "2026-10-30T10:00:00.000Z",
          unread: "2026-10-30T12:00:00.000Z",
        },
      }),
    );
    const first = await openAppWindow(storage);
    const second = await openAppWindow(storage);

    first.store.getState().markThreadVisited("visited", "2026-10-30T12:00:00.000Z");
    first.store.getState().markThreadVisited("unread", "2026-10-30T13:00:00.000Z");
    first.save();
    second.store.getState().markThreadVisited("visited", "2026-10-30T11:00:00.000Z");
    second.store.getState().markThreadUnread("unread", "2026-10-30T11:00:00.000Z");
    second.save();

    expect(stored(storage).threadLastVisitedAtById).toEqual({
      visited: "2026-10-30T12:00:00.000Z",
      unread: "2026-10-30T10:59:59.999Z",
    });
  });
});
