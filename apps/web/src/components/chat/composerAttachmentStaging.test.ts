import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DraftId,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
  useComposerDraftStore,
  type ComposerFileAttachment,
} from "../../composerDraftStore";
import * as imageCompression from "../../lib/imageCompression";
import { composerDraftAttachmentFacts } from "./composerAttachmentFiles";
import { stageComposerAttachmentBatch } from "./composerAttachmentStaging";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const MiB = 1024 * 1024;
const draftId = DraftId.make("aggregate-attachment-preflight");
const tenMiB = new Uint8Array(10 * MiB);
const image = (index: number, bytes = tenMiB) =>
  new File([bytes], `photo-${index}.png`, { type: "image/png" });

function stage(images: ReadonlyArray<File>, files: ReadonlyArray<ComposerFileAttachment> = []) {
  return stageComposerAttachmentBatch({
    images,
    files,
    readExisting: () => {
      const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
      if (!draft) return [];
      const replacements = new Set(
        draft.files
          .filter(
            (marker) =>
              composerFileNeedsReattach(marker) &&
              files.some((file) => composerFileMatchesReattachMarker(marker, file)),
          )
          .map((marker) => marker.id),
      );
      return composerDraftAttachmentFacts(draft).filter((item) => !replacements.has(item.id));
    },
    stillWanted: () => true,
    commit: ({ images, files }) => {
      const store = useComposerDraftStore.getState();
      store.addFiles(draftId, [...files]);
      store.addImages(
        draftId,
        images.map((file) => ({
          type: "image",
          id: file.name,
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: `blob:${file.name}`,
          file,
        })),
      );
      return images.length + files.length > 0;
    },
  });
}

describe("actual composer attachment batch staging", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    useComposerDraftStore.getState().setPrompt(draftId, "Keep this draft");
  });
  afterEach(() => vi.restoreAllMocks());

  it("stages eight 10MiB passthrough files and refuses the ninth without changing the draft", async () => {
    const files = Array.from({ length: 8 }, (_, index) => image(index));
    expect(await stage(files)).toEqual({ inserted: true, error: null });
    const before = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(before?.images.map((item) => item.file)).toEqual(files);
    expect(await stage([image(8)])).toMatchObject({
      inserted: false,
      error: expect.stringContaining("80 MiB"),
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toBe(before);
    expect(before?.prompt).toBe("Keep this draft");
  });

  it("rejects a nine-image batch before conversion and stages none of its generic files", async () => {
    const prepare = vi.spyOn(imageCompression, "prepareImageForAttachment");
    const pdf: ComposerFileAttachment = {
      type: "file",
      id: "paper",
      name: "paper.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: new File(["pdf"], "paper.pdf", { type: "application/pdf" }),
    };
    const before = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(
      await stage(
        Array.from({ length: 9 }, (_, index) => image(index)),
        [pdf],
      ),
    ).toMatchObject({ inserted: false, error: expect.stringContaining("80 MiB") });
    expect(prepare).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toBe(before);
  });

  it("keeps a duplicate image paste at the limit from reporting a false byte overflow", async () => {
    const images = Array.from({ length: 8 }, (_, index) => image(index));
    await stage(images);
    const before = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(await stage([new File([images[0]!], images[0]!.name, { type: "image/png" })])).toEqual({
      inserted: false,
      error: null,
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toBe(before);
  });

  it("replaces a needs-reattach marker while preserving its attachment count and prompt", async () => {
    const marker: ComposerFileAttachment = {
      type: "file",
      id: "reattach",
      name: "paper.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: null,
    };
    useComposerDraftStore.getState().addFiles(draftId, [marker]);
    const replacement: ComposerFileAttachment = {
      ...marker,
      id: "repicked",
      file: new File(["pdf"], "paper.pdf", { type: "application/pdf" }),
    };
    expect(await stage([], [replacement])).toEqual({ inserted: true, error: null });
    const after = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(after?.files).toEqual([replacement]);
    expect(after?.prompt).toContain("Keep this draft");
  });

  it("counts image-MIME retained files but deduplicates serialized live images", async () => {
    await stage(Array.from({ length: 7 }, (_, index) => image(index)));
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(draftId)!;
    const dataUrl = `data:image/png;base64,${Buffer.from(await image(0).arrayBuffer()).toString("base64")}`;
    // A recovered draft can contain serialized and live copies of the same image.
    // Seed that hydrated state; persistence itself has its own complete suite.
    useComposerDraftStore.setState((state) => ({
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [draftId]: {
          ...draft,
          persistedAttachments: draft.images.map((item) => ({
            id: item.id,
            name: item.name,
            mimeType: item.mimeType,
            sizeBytes: item.sizeBytes,
            dataUrl,
          })),
        },
      },
    }));
    expect(store.getComposerDraft(draftId)?.persistedAttachments).toHaveLength(7);
    const retained: ComposerFileAttachment = {
      type: "file",
      id: "queued-photo",
      name: "queued.png",
      mimeType: "image/png",
      sizeBytes: 10 * MiB,
      file: null,
      uploadedAttachmentId: "pending-queued-photo",
    };
    expect(await stage([], [retained])).toEqual({ inserted: true, error: null });
    const before = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(await stage([image(8)])).toMatchObject({
      inserted: false,
      error: expect.stringContaining("80 MiB"),
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toBe(before);
    expect(before?.files[0]).toBe(retained);
  });

  it("does not count non-image generic file bytes toward the image budget", async () => {
    const pdf: ComposerFileAttachment = {
      type: "file",
      id: "large-paper",
      name: "large.pdf",
      mimeType: "application/pdf",
      sizeBytes: 50 * MiB,
      file: new File([new Uint8Array(50 * MiB)], "large.pdf", { type: "application/pdf" }),
    };
    expect(
      await stage(
        Array.from({ length: 8 }, (_, index) => image(index)),
        [pdf],
      ),
    ).toEqual({ inserted: true, error: null });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files[0]?.file).toBe(
      pdf.file,
    );
  });

  it("uses actual converted sizes instead of refusing raw images that compression can shrink", async () => {
    const source = new Uint8Array(11 * MiB);
    vi.spyOn(imageCompression, "prepareImageForAttachment").mockImplementation(async (file) => ({
      ok: true,
      file: new File([new Uint8Array(MiB)], file.name, { type: "image/jpeg" }),
      recompressed: true,
    }));
    expect(await stage(Array.from({ length: 9 }, (_, index) => image(index, source)))).toEqual({
      inserted: true,
      error: null,
    });
    expect(
      useComposerDraftStore
        .getState()
        .getComposerDraft(draftId)
        ?.images.map((item) => item.sizeBytes),
    ).toEqual(Array(9).fill(MiB));
  });

  it("rechecks current stored bytes after a concurrent paste finishes conversion", async () => {
    await stage(Array.from({ length: 7 }, (_, index) => image(index)));
    const conversion = deferred<File>();
    const started = deferred<void>();
    const original = imageCompression.prepareImageForAttachment;
    vi.spyOn(imageCompression, "prepareImageForAttachment").mockImplementation(
      async (file, max) => {
        if (file.name === "photo-8.png") {
          started.resolve();
          return { ok: true, file: await conversion.promise, recompressed: true };
        }
        return original(file, max);
      },
    );
    const delayed = stage([image(8, new Uint8Array(11 * MiB))]);
    await started.promise;
    expect(await stage([image(7)])).toEqual({ inserted: true, error: null });
    const before = useComposerDraftStore.getState().getComposerDraft(draftId);
    conversion.resolve(image(8));
    expect(await delayed).toMatchObject({
      inserted: false,
      error: expect.stringContaining("80 MiB"),
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toBe(before);
  });

  it("retains the draft when one source is too large for the existing compressor", async () => {
    const before = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(await stage([image(0, new Uint8Array(51 * MiB))])).toMatchObject({
      inserted: false,
      error: expect.stringContaining("too large to attach"),
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toBe(before);
  });
});
