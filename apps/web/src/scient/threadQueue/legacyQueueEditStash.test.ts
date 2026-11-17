import "fake-indexeddb/auto";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { createEmptyThreadDraft, useComposerDraftStore } from "../../composerDraftStore";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import { usePromptStashStore } from "../../promptStashStore";
import { offerLegacyQueueEditJournals, restoreLegacyQueueEditStash } from "./legacyQueueEditStash";

vi.mock("../../lib/imageCompression", () => ({ readFileAsDataUrl: vi.fn() }));

// Older Scient builds wrote this journal; the test writes records in their exact shape.
function writeOldJournal(
  journalKey: string,
  options: { readonly stashed: boolean; readonly localFile?: boolean },
) {
  const image = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
  const notes = new File(["notes"], "notes.txt", { type: "text/plain" });
  return new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("scient-queue-edit-journal", 2);
    open.addEventListener("upgradeneeded", () => {
      open.result.createObjectStore("edits", { keyPath: "journalKey" });
      open.result.createObjectStore("files");
    });
    open.addEventListener("error", () => reject(open.error));
    open.addEventListener("success", () => {
      const database = open.result;
      const transaction = database.transaction(["edits", "files"], "readwrite");
      const draft = (prompt: string) => ({ ...createEmptyThreadDraft(), prompt });
      transaction.objectStore("files").put(image, `${journalKey}:edited:shot`);
      if (options.localFile)
        transaction.objectStore("files").put(notes, `${journalKey}:edited:notes`);
      transaction.objectStore("edits").put({
        key: "environment:thread",
        journalKey,
        contextVersion: 2,
        stashed: options.stashed,
        ordinary: draft("The draft before the edit"),
        edited: {
          ...draft("Queued message with a screenshot"),
          images: [
            {
              type: "image",
              id: "shot",
              name: image.name,
              mimeType: image.type,
              sizeBytes: image.size,
              previewUrl: "blob:gone",
              fileRef: `${journalKey}:edited:shot`,
            },
          ],
          files: options.localFile
            ? [
                {
                  type: "file",
                  id: "notes",
                  name: notes.name,
                  mimeType: notes.type,
                  sizeBytes: notes.size,
                  fileRef: `${journalKey}:edited:notes`,
                },
              ]
            : [],
          extractedIntent: { intentId: "11111111-1111-4111-8111-111111111111", journalKey },
        },
      });
      transaction.addEventListener("complete", () => {
        database.close();
        resolve();
      });
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  });
}

function journalHas(journalKey: string) {
  return new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open("scient-queue-edit-journal", 2);
    open.addEventListener("error", () => reject(open.error));
    open.addEventListener("success", () => {
      const request = open.result.transaction("edits").objectStore("edits").get(journalKey);
      request.addEventListener("success", () => {
        open.result.close();
        resolve(request.result !== undefined);
      });
    });
  });
}

const stashEntryFor = (journalKey: string) => ({
  id: `queue-stash-${journalKey}-edited`,
  queueEditKey: journalKey,
  queueEditSide: "edited" as const,
  createdAt: "2026-11-01T00:00:00.000Z",
  prompt: "Queued message with a screenshot",
  attachments: [],
  droppedImageNames: [],
  unreadableImageNames: [],
});

const target = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

beforeEach(() => {
  vi.mocked(readFileAsDataUrl).mockResolvedValue("data:image/png;base64,AQID");
});

afterEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  usePromptStashStore.setState({ entries: [] });
});

it("restores an older stash with its image stored in the draft, then removes it", async () => {
  await writeOldJournal("journal-1", { stashed: true });
  const entry = stashEntryFor("journal-1");
  usePromptStashStore.setState({ entries: [entry] });

  await restoreLegacyQueueEditStash(entry, target);

  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  expect(draft?.prompt).toBe("Queued message with a screenshot");
  expect(new Uint8Array(await draft!.images[0]!.file.arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  // Stored with the draft, so the image survives a reload once the journal is gone.
  expect(draft?.persistedAttachments.map(({ id, dataUrl }) => ({ id, dataUrl }))).toEqual([
    { id: "shot", dataUrl: "data:image/png;base64,AQID" },
  ]);
  expect(draft && "extractedIntent" in draft).toBe(false);
  expect(usePromptStashStore.getState().entries).toEqual([]);
  expect(await journalHas("journal-1")).toBe(false);
});

it("keeps the stash and journal while a file's bytes exist only in the journal", async () => {
  await writeOldJournal("journal-2", { stashed: true, localFile: true });
  const entry = stashEntryFor("journal-2");
  usePromptStashStore.setState({ entries: [entry] });

  await restoreLegacyQueueEditStash(entry, target);

  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  expect(draft?.files.map(({ id }) => id)).toEqual(["notes"]);
  expect(usePromptStashStore.getState().entries).toEqual([entry]);
  expect(await journalHas("journal-2")).toBe(true);
});

it("leaves newer typing alone when it arrives while the stash is read", async () => {
  await writeOldJournal("journal-3", { stashed: true });
  const entry = stashEntryFor("journal-3");
  usePromptStashStore.setState({ entries: [entry] });

  const restoring = restoreLegacyQueueEditStash(entry, target);
  useComposerDraftStore.getState().setPrompt(target, "Typed meanwhile");

  await expect(restoring).rejects.toThrow("current draft first");
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("Typed meanwhile");
  expect(usePromptStashStore.getState().entries).toEqual([entry]);
});

it("offers an edit left open by an older build once in Stash", async () => {
  await writeOldJournal("journal-open", { stashed: false });

  await offerLegacyQueueEditJournals();

  expect(usePromptStashStore.getState().entries).toEqual([
    expect.objectContaining({
      queueEditKey: "journal-open",
      queueEditSide: "edited",
      prompt: "Queued message with a screenshot",
    }),
  ]);
});
