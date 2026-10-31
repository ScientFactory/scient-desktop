import { describe, expect, it } from "vite-plus/test";

import {
  openAppWindow,
  sharedLocalStorage,
  type SharedLocalStorage,
} from "../test/scientAppWindows";
import {
  MAX_STASH_ENTRIES,
  PROMPT_STASH_STORAGE_KEY,
  type PromptStashEntry,
} from "./promptStashStore";

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
    expect(first.store.getState().takeEntry("from-first").entry).toBeNull();
    first.store.getState().stashEntry(entry("from-first-again", "2026-10-30T12:02:00.000Z"));
    expect(storedIds(storage)).toEqual(["from-first-again", "from-second"]);

    first.receiveStorageEvent();
    expect(first.ids()).toEqual(["from-first-again", "from-second"]);
  });

  it("does not bring back an entry another window took while this window saved its images", async () => {
    const storage = sharedLocalStorage();
    using first = await openStashWindow(storage);
    using second = await openStashWindow(storage);

    first.store.getState().stashEntry({
      ...entry("with-image", "2026-10-30T12:00:00.000Z"),
      pendingImageCount: 1,
    });
    second.receiveStorageEvent();
    expect(second.store.getState().takeEntry("with-image").entry).not.toBeNull();
    const finished = first.store.getState().finalizeEntryImages("with-image", {
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: ["photo.png"],
    });

    expect(finished.attached).toBe(false);
    expect(storedIds(storage)).toEqual([]);
  });

  it("evicts the oldest stored entry when two windows stash into a full stash", async () => {
    const storage = sharedLocalStorage();
    using first = await openStashWindow(storage);
    for (let minute = 0; minute < MAX_STASH_ENTRIES; minute++) {
      const createdAt = `2026-10-30T11:${String(minute).padStart(2, "0")}:00.000Z`;
      first.store.getState().stashEntry(entry(`older-${minute}`, createdAt));
    }
    using second = await openStashWindow(storage);

    const fromFirst = entry("from-first", "2026-10-30T12:00:00.000Z");
    expect(first.store.getState().stashEntry(fromFirst).evicted?.id).toBe("older-0");
    const fromSecond = entry("from-second", "2026-10-30T12:01:00.000Z");
    expect(second.store.getState().stashEntry(fromSecond).evicted?.id).toBe("older-1");

    expect(storedIds(storage)).toHaveLength(MAX_STASH_ENTRIES);
    expect(storedIds(storage).slice(0, 2)).toEqual(["from-second", "from-first"]);
  });
});
