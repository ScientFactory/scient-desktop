import "fake-indexeddb/auto";
import { expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createEmptyThreadDraft, DraftId } from "../../composerDraftStore";
import { readQueueEditJournal, writeQueueEditJournal } from "./editJournal";

it("migrates existing recovery journals before restoring either draft, without rewriting the saved source", async () => {
  const target = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  };
  const edited = {
    ...createEmptyThreadDraft(),
    prompt: "Inspect",
    elementContexts: [
      {
        id: "plot",
        pickedAt: "2026-09-14T00:00:00.000Z",
        pageUrl: "https://example.test",
        pageTitle: "Figure",
        tagName: "figure",
        selector: "#plot",
        htmlPreview: "measured plot",
        componentName: null,
        source: null,
        styles: "",
      },
    ],
  };
  const key = "legacy-context-journal";
  await writeQueueEditJournal({
    key: "thread",
    journalKey: key,
    originalTarget: target,
    editTarget: DraftId.make("edit"),
    queueItemId: "qitem_A",
    editToken: "edit",
    ordinary: edited,
    edited,
  });
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("scient-queue-edit-journal", 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    // Simulate the durable bytes written before contextVersion existed.
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("edits", "readwrite");
      const entries = transaction.objectStore("edits");
      const request = entries.get(key);
      request.onsuccess = () => {
        const { contextVersion: _version, ...legacy } = request.result;
        entries.put(legacy);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    const restored = await readQueueEditJournal(key);
    expect(restored?.edited.previewAnnotations[0]?.elements[0]?.element.htmlPreview).toBe(
      "measured plot",
    );
    expect(restored?.ordinary.previewAnnotations).toEqual(restored?.edited.previewAnnotations);
    expect(restored?.edited.prompt).toContain("t3-context://");
    expect((await readQueueEditJournal(key))?.edited).toEqual(restored?.edited);
    const saved = await new Promise<{ contextVersion?: number; edited: typeof edited }>(
      (resolve, reject) => {
        const request = database.transaction("edits", "readonly").objectStore("edits").get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    expect(saved.contextVersion).toBeUndefined();
    expect(saved.edited.elementContexts).toEqual(edited.elementContexts);
    await writeQueueEditJournal(key);
  } finally {
    database.close();
  }
});
