import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  createEmptyThreadDraft,
  type ComposerFileAttachment,
} from "../../composerDraftStore";
import { reconcileRemoteComposerDraft } from "./composerDraftSync";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function sharedLocalStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

type SharedStorage = ReturnType<typeof sharedLocalStorage>;

async function openAppWindow(storage: SharedStorage) {
  const eventTarget = new EventTarget();
  vi.resetModules();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", eventTarget);
  const module = await import("../../composerDraftStore");
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return {
    setPrompt: (thread: string, prompt: string) =>
      module.useComposerDraftStore
        .getState()
        .setPrompt(scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(thread)), prompt),
    prompt: (thread: string) =>
      module.useComposerDraftStore.getState().draftsByThreadKey[threadKey(thread)]?.prompt,
    flush: module.flushComposerDraftPersistence,
    receiveStorageEvent: () =>
      eventTarget.dispatchEvent(
        Object.assign(new Event("storage"), { key: COMPOSER_DRAFT_STORAGE_KEY }),
      ),
  };
}

function threadKey(thread: string): string {
  return scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(thread)));
}

function storedPrompts(storage: SharedStorage): Record<string, string> {
  const raw = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  const drafts = (
    JSON.parse(raw ?? "{}") as {
      state?: { draftsByThreadKey?: Record<string, { prompt: string }> };
    }
  ).state?.draftsByThreadKey;
  return Object.fromEntries(
    Object.entries(drafts ?? {}).map(([key, draft]) => [key, draft.prompt]),
  );
}

describe("composer drafts across app windows", () => {
  it("keeps drafts another window wrote, including when this window deletes its own", async () => {
    const storage = sharedLocalStorage();
    const first = await openAppWindow(storage);
    const second = await openAppWindow(storage);

    first.setPrompt("thread-a", "written in the first window");
    first.flush();
    second.setPrompt("thread-b", "written in the second window");
    second.flush();
    expect(storedPrompts(storage)).toEqual({
      [threadKey("thread-a")]: "written in the first window",
      [threadKey("thread-b")]: "written in the second window",
    });

    first.setPrompt("thread-a", "");
    first.flush();
    expect(storedPrompts(storage)).toEqual({
      [threadKey("thread-b")]: "written in the second window",
    });
  });

  it("applies another window's drafts except one this window has not yet saved", async () => {
    const storage = sharedLocalStorage();
    const first = await openAppWindow(storage);
    const second = await openAppWindow(storage);

    second.setPrompt("shared", "unsaved in the second window");
    first.setPrompt("other", "from the first window");
    first.setPrompt("shared", "from the first window");
    first.flush();
    second.receiveStorageEvent();
    expect(second.prompt("other")).toBe("from the first window");
    expect(second.prompt("shared")).toBe("unsaved in the second window");

    second.flush();
    first.receiveStorageEvent();
    expect(first.prompt("shared")).toBe("unsaved in the second window");
    expect(storedPrompts(storage)).toEqual({
      [threadKey("other")]: "from the first window",
      [threadKey("shared")]: "unsaved in the second window",
    });
  });
});

describe("reconcileRemoteComposerDraft", () => {
  it("keeps this window's file bytes for an attachment another window persisted without them", () => {
    const bytes = new File(["data"], "notes.txt", { type: "text/plain" });
    const attachment: ComposerFileAttachment = {
      type: "file",
      id: "file-1",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      file: bytes,
    };
    const merged = reconcileRemoteComposerDraft(
      { ...createEmptyThreadDraft(), files: [attachment] },
      {
        ...createEmptyThreadDraft(),
        prompt: "edited elsewhere",
        files: [{ ...attachment, file: null }],
      },
    );
    expect(merged?.prompt).toBe("edited elsewhere");
    expect(merged?.files[0]?.file).toBe(bytes);
  });
});
