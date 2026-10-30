import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  openAppWindow,
  sharedLocalStorage,
  type SharedLocalStorage,
} from "../../../test/scientAppWindows";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  DraftId,
  type ComposerFileAttachment,
} from "../../composerDraftStore";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

async function openDraftWindow(storage: SharedLocalStorage) {
  const appWindow = await openAppWindow(storage, () => import("../../composerDraftStore"));
  const store = appWindow.module.useComposerDraftStore;
  return {
    store,
    setPrompt: (thread: string, prompt: string) =>
      store.getState().setPrompt(threadRef(thread), prompt),
    prompt: (thread: string) => store.getState().draftsByThreadKey[threadKey(thread)]?.prompt,
    flush: appWindow.module.flushComposerDraftPersistence,
    receiveStorageEvent: () => appWindow.receiveStorageEvent(COMPOSER_DRAFT_STORAGE_KEY),
    [Symbol.dispose]: appWindow[Symbol.dispose],
  };
}

function threadRef(thread: string) {
  return scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(thread));
}

function threadKey(thread: string): string {
  return scopedThreadKey(threadRef(thread));
}

interface StoredDrafts {
  state: {
    draftsByThreadKey: Record<string, { prompt: string }>;
    draftThreadsByThreadKey: Record<string, { projectId: string | null; branch: string | null }>;
    logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
    stickyActiveProvider?: string | null;
  };
  version: number;
}

function readStored(storage: SharedLocalStorage): StoredDrafts {
  return JSON.parse(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "null") as StoredDrafts;
}

function editStored(storage: SharedLocalStorage, edit: (stored: StoredDrafts) => void): void {
  const stored = readStored(storage);
  edit(stored);
  storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(stored));
}

function storedPrompts(storage: SharedLocalStorage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readStored(storage)?.state.draftsByThreadKey ?? {}).map(([key, draft]) => [
      key,
      draft.prompt,
    ]),
  );
}

describe("composer drafts across app windows", () => {
  it("keeps drafts another window wrote, including when this window deletes its own", async () => {
    const storage = sharedLocalStorage();
    using first = await openDraftWindow(storage);
    using second = await openDraftWindow(storage);

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
    using first = await openDraftWindow(storage);
    using second = await openDraftWindow(storage);

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

  it("keeps this window's file bytes when another window edits the same draft", async () => {
    const storage = sharedLocalStorage();
    using first = await openDraftWindow(storage);
    using second = await openDraftWindow(storage);
    const bytes = new File(["data"], "notes.txt", { type: "text/plain" });
    const attachment: ComposerFileAttachment = {
      type: "file",
      id: "file-1",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      file: bytes,
    };

    first.setPrompt("shared", "with a file");
    first.store.getState().addFiles(threadRef("shared"), [attachment]);
    first.flush();
    second.receiveStorageEvent();
    second.setPrompt("shared", "edited in the second window");
    second.flush();
    first.receiveStorageEvent();

    const draft = first.store.getState().draftsByThreadKey[threadKey("shared")];
    expect(draft?.prompt).toMatch(/^edited in the second window/);
    expect(draft?.files[0]?.file).toBe(bytes);
  });

  it("keeps sticky model choices another window saved while this one writes drafts", async () => {
    const storage = sharedLocalStorage();
    using first = await openDraftWindow(storage);
    using second = await openDraftWindow(storage);
    const instanceId = ProviderInstanceId.make("codex");

    first.store.getState().setStickyModelSelection(createModelSelection(instanceId, "gpt-5"));
    first.flush();
    second.setPrompt("thread-b", "written in the second window");
    second.flush();
    expect(readStored(storage).state.stickyActiveProvider).toBe(instanceId);

    second.receiveStorageEvent();
    expect(second.store.getState().stickyActiveProvider).toBe(instanceId);
  });

  it("writes every draft this window holds when storage was cleared", async () => {
    const storage = sharedLocalStorage();
    using appWindow = await openDraftWindow(storage);

    appWindow.setPrompt("thread-a", "saved before the clear");
    appWindow.flush();
    storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    appWindow.setPrompt("thread-b", "written after the clear");
    appWindow.flush();

    expect(storedPrompts(storage)).toEqual({
      [threadKey("thread-a")]: "saved before the clear",
      [threadKey("thread-b")]: "written after the clear",
    });
  });

  it.each([
    { editedElsewhere: false, expected: undefined },
    { editedElsewhere: true, expected: "feature" },
  ])(
    "deletes a draft session hydration dropped unless another window edits it first (edited elsewhere: $editedElsewhere)",
    async ({ editedElsewhere, expected }) => {
      const storage = sharedLocalStorage();
      const draftId = DraftId.make("draft-without-project");
      {
        using writer = await openDraftWindow(storage);
        writer.store
          .getState()
          .setProjectDraftThreadId(
            scopeProjectRef(ENVIRONMENT_ID, ProjectId.make("project-1")),
            draftId,
          );
        writer.flush();
      }
      editStored(storage, (stored) => {
        stored.state.draftThreadsByThreadKey[draftId]!.projectId = null;
        stored.state.logicalProjectDraftThreadKeyByLogicalProjectKey = {};
      });
      using appWindow = await openDraftWindow(storage);
      expect(appWindow.store.getState().draftThreadsByThreadKey[draftId]).toBeUndefined();

      if (editedElsewhere) {
        editStored(storage, (stored) => {
          stored.state.draftThreadsByThreadKey[draftId]!.branch = "feature";
        });
        appWindow.receiveStorageEvent();
      }
      appWindow.setPrompt("thread-b", "written in this window");
      appWindow.flush();

      expect(readStored(storage).state.draftThreadsByThreadKey[draftId]?.branch).toBe(expected);
    },
  );
});
