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

it("preserves a newer hydrated same-intent draft when the asynchronous journal lags", async () => {
  vi.resetModules();
  const drafts = await import("../../composerDraftStore");
  const journal = await import("./editJournal");
  const recovery = await import("./editSession");
  const target = {
    environmentId: EnvironmentId.make("reload-environment"),
    threadId: ThreadId.make("reload-thread"),
  };
  const intentId = "d2d7a045-82b7-4916-9c20-f39695fbf4d0";
  const journalKey = "reload-journal";
  const bytes = new File(["recoverable original bytes"], "evidence.txt", { type: "text/plain" });
  const file = {
    type: "file" as const,
    id: "reload-file",
    name: bytes.name,
    mimeType: bytes.type,
    sizeBytes: bytes.size,
    file: bytes,
  };
  const marker = { intentId, journalKey };
  const edited = {
    ...drafts.createEmptyThreadDraft(),
    extractedIntent: marker,
    prompt: "ACP_AC",
    files: [file],
  };
  await journal.initializeExtractedIntent(intentId);
  await journal.writeQueueEditJournal({
    key: drafts.composerTargetKey(target),
    journalKey,
    originalTarget: target,
    editTarget: target,
    queueItemId: "reload-queued-run",
    editToken: intentId,
    intentId,
    transferred: true,
    ordinary: drafts.createEmptyThreadDraft(),
    edited,
  });
  drafts.useComposerDraftStore.setState({
    draftsByThreadKey: {
      [drafts.composerTargetKey(target)]: {
        ...edited,
        prompt: "ACP_ACCEPTANCE:ANSWER later-ordinary-draft",
        runtimeMode: "approval-required",
      },
    },
  });
  drafts.flushComposerDraftPersistence();
  // Actual composer persistence omits File bytes; the durable journal retains them.
  await drafts.useComposerDraftStore.persist.rehydrate();
  const hydrated = drafts.useComposerDraftStore.getState().getComposerDraft(target)!;
  expect(hydrated.prompt).toContain("later-ordinary-draft");
  expect(hydrated.files[0]?.file).toBeNull();
  await recovery.loadQueueEdits();
  const recovered = drafts.useComposerDraftStore.getState().getComposerDraft(target)!;
  expect(recovered.prompt).toBe(hydrated.prompt);
  expect(recovered.extractedIntent).toEqual(marker);
  expect(recovered.runtimeMode).toBe("approval-required");
  expect(await recovered.files[0]?.file?.text()).toBe("recoverable original bytes");
  expect(
    recovery.useQueueEditSessions.getState().sessions[drafts.composerTargetKey(target)]?.edited
      .prompt,
  ).toBe(hydrated.prompt);
});
