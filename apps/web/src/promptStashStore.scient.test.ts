import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

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

function sharedLocalStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

async function openAppWindow(storage: ReturnType<typeof sharedLocalStorage>) {
  const eventTarget = new EventTarget();
  vi.resetModules();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", eventTarget);
  const { usePromptStashStore } = await import("./promptStashStore");
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return {
    store: usePromptStashStore,
    receiveStorageEvent: () =>
      eventTarget.dispatchEvent(
        Object.assign(new Event("storage"), { key: PROMPT_STASH_STORAGE_KEY }),
      ),
  };
}

describe("prompt stash across app windows", () => {
  it("keeps an entry another window stashed when this window stashes or takes", async () => {
    const storage = sharedLocalStorage();
    const first = await openAppWindow(storage);
    const second = await openAppWindow(storage);

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
