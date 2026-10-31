import { describe, expect, it } from "vite-plus/test";

import {
  openAppWindow,
  sharedLocalStorage,
  type SharedLocalStorage,
} from "../test/scientAppWindows";
import { PROMPT_STASH_STORAGE_KEY, type PromptStashEntry } from "./promptStashStore";

function entry(id: string, createdAt: string): PromptStashEntry {
  return { id, createdAt, prompt: `prompt ${id}`, attachments: [], droppedImageNames: [] };
}

async function openStashWindow(storage: SharedLocalStorage) {
  const appWindow = await openAppWindow(storage, () => import("./promptStashStore"));
  return {
    store: appWindow.module.usePromptStashStore,
    ids: () => appWindow.module.usePromptStashStore.getState().entries.map(({ id }) => id),
    receiveStorageEvent: () => appWindow.receiveStorageEvent(PROMPT_STASH_STORAGE_KEY),
    [Symbol.dispose]: appWindow[Symbol.dispose],
  };
}

function storedIds(storage: SharedLocalStorage): string[] {
  const stored = JSON.parse(storage.getItem(PROMPT_STASH_STORAGE_KEY) ?? "{}") as {
    state: { entries: PromptStashEntry[] };
  };
  return stored.state.entries.map(({ id }) => id);
}

describe("prompt stash across app windows", () => {
  it("keeps what another window stashed, finished or took before this window heard of it", async () => {
    const storage = sharedLocalStorage();
    using first = await openStashWindow(storage);
    using second = await openStashWindow(storage);

    first.store.getState().stashEntry({
      ...entry("from-first", "2026-10-30T12:00:00.000Z"),
      pendingImageCount: 1,
    });
    second.store.getState().stashEntry(entry("from-second", "2026-10-30T12:01:00.000Z"));
    first.store.getState().finalizeEntryImages("from-first", {
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: ["photo.png"],
    });
    expect(storedIds(storage)).toEqual(["from-second", "from-first"]);

    second.receiveStorageEvent();
    expect(second.ids()).toEqual(["from-second", "from-first"]);
    const taken = second.store.getState().takeEntry("from-first").entry;
    expect(taken?.unreadableImageNames).toEqual(["photo.png"]);
    first.store.getState().stashEntry(entry("from-first-again", "2026-10-30T12:02:00.000Z"));
    expect(storedIds(storage)).toEqual(["from-first-again", "from-second"]);

    first.receiveStorageEvent();
    expect(first.ids()).toEqual(["from-first-again", "from-second"]);
  });
});
