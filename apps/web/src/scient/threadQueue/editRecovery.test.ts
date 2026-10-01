import "fake-indexeddb/auto";
import { EnvironmentId, ThreadId, ScientThreadQueueOperationError } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import {
  composerTargetKey,
  createEmptyThreadDraft,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { usePromptStashStore } from "../../promptStashStore";
import { writeQueueEditJournal, readQueueEditJournal } from "./editJournal";
import { loadQueueEdits, useQueueEditSessions } from "./editSession";
vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("navigator", {
    userAgent: "",
    platform: "",
    locks: {
      request: (_key: string, _options: unknown, callback: (lock: object) => Promise<void>) =>
        callback({}),
    },
  });
});
vi.mock("./client", () => ({
  controlThreadQueue: vi
    .fn()
    .mockRejectedValue(
      new ScientThreadQueueOperationError({ message: "This edit was already queued" }),
    ),
  readQueuedAttachmentFile: vi.fn(),
}));
it("keeps a legacy recovered edit and attachment bytes when extraction is definitely rejected", async () => {
  const target = {
    environmentId: EnvironmentId.make("recovery-environment"),
    threadId: ThreadId.make("recovery-thread"),
  };
  const ordinary = { ...createEmptyThreadDraft(), prompt: "original ordinary draft" };
  const edited = {
    ...createEmptyThreadDraft(),
    prompt: "later user changes",
    files: [
      {
        type: "file" as const,
        id: "local",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        file: new File(["notes"], "notes.txt", { type: "text/plain" }),
      },
    ],
  };
  await writeQueueEditJournal({
    key: composerTargetKey(target),
    journalKey: "legacy-late",
    originalTarget: target,
    editTarget: target,
    queueItemId: "qitem_legacy",
    editToken: "legacy-token",
    ordinary,
    edited,
  });
  useComposerDraftStore.getState().setPrompt(target, "current ordinary draft");
  await loadQueueEdits();
  expect(useQueueEditSessions.getState().sessions[composerTargetKey(target)]).toBeUndefined();
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
    "current ordinary draft",
  );
  const saved = await readQueueEditJournal("legacy-late");
  expect(saved?.stashed).toBe(true);
  expect(saved?.edited.prompt).toBe("later user changes");
  expect(await saved?.edited.files[0]?.file?.text()).toBe("notes");
  expect(
    usePromptStashStore
      .getState()
      .entries.some(
        (entry) => entry.queueEditKey === "legacy-late" && entry.queueEditSide === "edited",
      ),
  ).toBe(true);
});
