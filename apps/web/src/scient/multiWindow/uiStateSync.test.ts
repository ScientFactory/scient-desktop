import { describe, expect, it, vi } from "vite-plus/test";

import {
  openAppWindow,
  sharedLocalStorage,
  type SharedLocalStorage,
} from "../../../test/scientAppWindows";
import { PERSISTED_STATE_KEY, type PersistedUiState } from "../../uiStateStore";

async function openUiStateWindow(storage: SharedLocalStorage) {
  const appWindow = await openAppWindow(storage, () => import("../../uiStateStore"));
  return {
    store: appWindow.module.useUiStateStore,
    save: appWindow.unload,
    receiveStorageEvent: () => appWindow.receiveStorageEvent(PERSISTED_STATE_KEY),
    [Symbol.dispose]: appWindow[Symbol.dispose],
  };
}

function stored(storage: SharedLocalStorage): PersistedUiState {
  return JSON.parse(storage.getItem(PERSISTED_STATE_KEY) ?? "{}") as PersistedUiState;
}

describe("UI state across app windows", () => {
  it("keeps another window's sidebar order when a stale window saves, then adopts it", async () => {
    const storage = sharedLocalStorage();
    storage.setItem(PERSISTED_STATE_KEY, JSON.stringify({ projectOrder: ["a", "b", "c"] }));
    using first = await openUiStateWindow(storage);
    using second = await openUiStateWindow(storage);

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
    using first = await openUiStateWindow(storage);
    using second = await openUiStateWindow(storage);

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
    using first = await openUiStateWindow(storage);
    using second = await openUiStateWindow(storage);

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

  it("saves a change on the next write after a failed one", async () => {
    const storage = sharedLocalStorage();
    storage.setItem(PERSISTED_STATE_KEY, JSON.stringify({ projectOrder: ["a", "b", "c"] }));
    using appWindow = await openUiStateWindow(storage);

    appWindow.store.getState().reorderProjects(["a", "b", "c"], ["c"], ["a"]);
    vi.spyOn(storage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    appWindow.save();
    expect(stored(storage).projectOrder).toEqual(["a", "b", "c"]);

    appWindow.store.getState().setPullRequestMergeMethod("squash");
    appWindow.save();
    expect(stored(storage)).toMatchObject({
      projectOrder: ["c", "a", "b"],
      pullRequestMergeMethod: "squash",
    });
  });
});
