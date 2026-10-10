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

it.each(
  (["retained", "removed", "legacy", "malformed", "mismatched", "added"] as const).map(
    (scenario) => {
      const removed = scenario === "removed";

      return {
        caseTitle: `recovers only selected image bytes after reload before encoding (${scenario})`,
        scenario,
        removed,
      };
    },
  ),
)("$caseTitle", async ({ scenario, removed }) => {
  vi.resetModules();
  const drafts = await import("../../composerDraftStore");
  const journal = await import("./editJournal");
  const recovery = await import("./editSession");
  const target = {
    environmentId: EnvironmentId.make("image-reload-environment"),
    threadId: ThreadId.make(`image-reload-${scenario}`),
  };
  const intentId = `d2d7a045-82b7-4916-9c20-f39695fbf4d${["retained", "removed", "legacy", "malformed", "mismatched", "added"].indexOf(scenario)}`;
  const journalKey = `image-reload-${scenario}`;
  const bytes = new File(["durable image bytes"], "evidence.png", { type: "image/png" });
  const image = {
    type: "image" as const,
    id: "image-before-encoding",
    name: bytes.name,
    mimeType: bytes.type,
    sizeBytes: bytes.size,
    file: bytes,
    previewUrl: URL.createObjectURL(bytes),
  };
  const edited = {
    ...drafts.createEmptyThreadDraft(),
    extractedIntent: { intentId, journalKey },
    prompt: "original extracted prompt",
    images: [image],
  };
  await journal.initializeExtractedIntent(intentId);
  await journal.writeQueueEditJournal({
    key: drafts.composerTargetKey(target),
    journalKey,
    originalTarget: target,
    editTarget: target,
    queueItemId: `image-run-${scenario}`,
    editToken: intentId,
    intentId,
    transferred: true,
    ordinary: drafts.createEmptyThreadDraft(),
    edited,
  });
  drafts.useComposerDraftStore.setState({
    draftsByThreadKey: {
      [drafts.composerTargetKey(target)]: { ...edited, prompt: "newer user prompt" },
    },
  });
  if (removed) drafts.useComposerDraftStore.getState().removeImage(target, image.id);
  drafts.flushComposerDraftPersistence();
  if (scenario === "legacy" || scenario === "malformed" || scenario === "mismatched") {
    const stored = JSON.parse(localStorage.getItem(drafts.COMPOSER_DRAFT_STORAGE_KEY)!);
    const persisted = stored.state.draftsByThreadKey[drafts.composerTargetKey(target)];
    if (scenario === "legacy") delete persisted.imageSelection;
    else if (scenario === "malformed") persisted.imageSelection = [{}];
    else persisted.imageSelection[0].sizeBytes += 1;
    localStorage.setItem(drafts.COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(stored));
  }
  await drafts.useComposerDraftStore.persist.rehydrate();
  expect(drafts.useComposerDraftStore.getState().getComposerDraft(target)?.images).toEqual([]);
  if (scenario === "added") {
    const added = new File(["new image bytes"], "new.png", { type: "image/png" });
    drafts.useComposerDraftStore.getState().addImages(target, [
      {
        ...image,
        id: "added-after-reload",
        name: added.name,
        sizeBytes: added.size,
        file: added,
        previewUrl: URL.createObjectURL(added),
      },
    ]);
  }
  await recovery.loadQueueEdits();
  const recovered = drafts.useComposerDraftStore.getState().getComposerDraft(target)!;
  expect(recovered.prompt).toBe("newer user prompt");
  if (scenario === "legacy" || scenario === "malformed" || scenario === "mismatched") {
    expect(recovery.useQueueEditSessions.getState().error?.message).toMatch(
      /ambiguous|could not be recovered/,
    );
    expect(
      recovery.useQueueEditSessions.getState().sessions[drafts.composerTargetKey(target)],
    ).toBeUndefined();
    await expect(recovery.resolveExtractedDraftIntent(recovered)).rejects.toThrow(
      "not been recovered",
    );
    drafts.useComposerDraftStore.getState().setPrompt(target, "typing after failed recovery");
    expect(
      await (await journal.readQueueEditJournal(journalKey))?.edited.images[0]?.file.text(),
    ).toBe("durable image bytes");
    expect(() =>
      drafts.useComposerDraftStore.getState().moveComposerPromptAndImages(target, {
        ...target,
        threadId: ThreadId.make("unsafe-image-destination"),
      }),
    ).toThrow("Recover the extracted images");
    const stash = await import("../../promptStashStore");
    const entry = stash.usePromptStashStore
      .getState()
      .entries.find(
        (entry) => entry.queueEditKey === journalKey && entry.queueEditSide === "edited",
      );
    expect(entry).toBeDefined();
    await recovery.restoreQueueEditStash(entry!, target, target.environmentId);
    const restored = drafts.useComposerDraftStore.getState().getComposerDraft(target)!;
    expect(restored.prompt).toContain("typing after failed recovery");
    expect(await restored.images[0]?.file.text()).toBe("durable image bytes");
    expect((await recovery.resolveExtractedDraftIntent(restored))?.intentId).toBe(intentId);
    return;
  }
  expect(recovered.images.map((image) => image.id)).toEqual(
    removed ? [] : scenario === "added" ? [image.id, "added-after-reload"] : [image.id],
  );
  if (!removed) expect(await recovered.images[0]?.file.text()).toBe("durable image bytes");
  expect(recovery.useQueueEditSessions.getState().error).toBeNull();
});

it("reports consumed image intent before unresolved-image recovery and takes no new lease", async () => {
  vi.resetModules();
  const drafts = await import("../../composerDraftStore");
  const journal = await import("./editJournal");
  const recovery = await import("./editSession");
  const submission = await import("./submission");
  const { CommandId, MessageId } = await import("@t3tools/contracts");
  const target = {
    environmentId: EnvironmentId.make("consumed-image-environment"),
    threadId: ThreadId.make("consumed-image-thread"),
  };
  const intentId = "d2d7a045-82b7-4916-9c20-f39695fbf4e0";
  const journalKey = "consumed-image-journal";
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf5kAAAAASUVORK5CYII=";
  const file = new File(
    [Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))],
    "consumed.png",
    { type: "image/png" },
  );
  const image = {
    type: "image" as const,
    id: "consumed-image",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
    previewUrl: URL.createObjectURL(file),
  };
  const edited = {
    ...drafts.createEmptyThreadDraft(),
    extractedIntent: { intentId, journalKey },
    prompt: "consumed image prompt",
    images: [image],
  };
  const record = await journal.initializeExtractedIntent(intentId);
  await journal.writeQueueEditJournal({
    key: drafts.composerTargetKey(target),
    journalKey,
    originalTarget: target,
    editTarget: target,
    queueItemId: "consumed-image-run",
    editToken: intentId,
    intentId,
    transferred: true,
    ordinary: drafts.createEmptyThreadDraft(),
    edited,
  });
  drafts.useComposerDraftStore.setState({
    draftsByThreadKey: {
      [drafts.composerTargetKey(target)]: edited,
    },
  });
  drafts.flushComposerDraftPersistence();
  await drafts.useComposerDraftStore.persist.rehydrate();
  const stale = drafts.useComposerDraftStore.getState().getComposerDraft(target)!;
  expect(stale.images).toEqual([]);
  expect(stale.pendingImageSelection).toEqual([
    { id: image.id, name: image.name, mimeType: image.mimeType, sizeBytes: image.sizeBytes },
  ]);
  const bound = await submission.bindExtractedSubmission(
    record,
    {
      environmentId: target.environmentId,
      input: {
        commandId: CommandId.make(`extracted-intent:${intentId}`),
        threadId: target.threadId,
        createdAt: "2026-10-06T00:00:00.000Z",
        runtimeMode: "full-access",
        interactionMode: "default",
        message: {
          messageId: MessageId.make("consumed-image-message"),
          role: "user",
          text: edited.prompt,
          attachments: [
            {
              type: "image",
              name: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              dataUrl: `data:image/png;base64,${base64}`,
            },
          ],
        },
      },
    },
    await submission.extractedDraftFingerprint(edited),
    journalKey,
  );
  await submission.consumeExtractedSubmission(bound);
  const locks = vi.spyOn(navigator.locks, "request");
  try {
    await expect(recovery.resolveExtractedDraftIntent(stale)).rejects.toThrow("already submitted");
    expect(locks).not.toHaveBeenCalled();
    expect(await journal.readExtractedIntent(intentId)).toMatchObject({ phase: "consumed" });
    expect((await journal.readQueueEditJournal(journalKey))?.edited.images[0]?.file.size).toBe(
      file.size,
    );
  } finally {
    locks.mockRestore();
  }
});
