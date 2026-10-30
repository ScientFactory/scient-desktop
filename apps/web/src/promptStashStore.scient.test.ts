import { describe, expect, it } from "vite-plus/test";

import {
  openAppWindow,
  sharedLocalStorage,
  type SharedLocalStorage,
} from "../test/scientAppWindows";
import { PROMPT_STASH_STORAGE_KEY, type PromptStashEntry } from "./promptStashStore";

function entry(id: string): PromptStashEntry {
  return {
    id,
    createdAt: "2026-10-30T12:00:00.000Z",
    prompt: `prompt ${id}`,
    attachments: [],
    droppedImageNames: [],
  };
}

async function openStashWindow(storage: SharedLocalStorage) {
  const appWindow = await openAppWindow(storage, () => import("./promptStashStore"));
  return {
    store: appWindow.module.usePromptStashStore,
    receiveStorageEvent: () => appWindow.receiveStorageEvent(PROMPT_STASH_STORAGE_KEY),
    [Symbol.dispose]: appWindow[Symbol.dispose],
  };
}

describe("prompt stash across app windows", () => {
  it("keeps an entry another window stashed when this window stashes or takes", async () => {
    const storage = sharedLocalStorage();
    using first = await openStashWindow(storage);
    using second = await openStashWindow(storage);

    first.store.getState().stashEntry(entry("from-first"));
    second.receiveStorageEvent();
    second.store.getState().stashEntry(entry("from-second"));
    first.receiveStorageEvent();

    expect(first.store.getState().takeEntry("from-first").entry?.prompt).toBe("prompt from-first");
    second.receiveStorageEvent();
    expect(second.store.getState().takeEntry("from-first").entry).toBeNull();
    const stored = JSON.parse(storage.getItem(PROMPT_STASH_STORAGE_KEY) ?? "{}") as {
      state: { entries: PromptStashEntry[] };
    };
    expect(stored.state.entries.map((candidate) => candidate.id)).toEqual(["from-second"]);
  });
});
