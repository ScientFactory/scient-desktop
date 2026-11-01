import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
} from "@t3tools/contracts";

import type { ComposerFileAttachment } from "../../composerDraftStore";
import { composerFileDedupKey, composerImageDedupKey } from "../../composerDraftStore";
import {
  inheritComposerImageThumbnail,
  isHeicImageFile,
  prepareImageForAttachment,
} from "../../lib/imageCompression";

interface StagedComposerImage {
  readonly id: string;
  readonly file: File;
}

type AttachmentFacts = Pick<ChatAttachment, "type" | "mimeType" | "sizeBytes"> & {
  /** Only the target draft grants deduplication; other question drafts still count. */
  readonly dedupKey?: string;
};

function uniqueBatch(
  existing: ReadonlyArray<AttachmentFacts>,
  images: ReadonlyArray<StagedComposerImage>,
  files: ReadonlyArray<ComposerFileAttachment>,
) {
  const imageKeys = new Set(
    existing.filter((item) => item.type === "image").map((item) => item.dedupKey),
  );
  const fileKeys = new Set(
    existing.filter((item) => item.type === "file").map((item) => item.dedupKey),
  );
  return {
    images: images.filter(({ file }) => {
      const key = composerImageDedupKey({
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      });
      if (imageKeys.has(key)) return false;
      imageKeys.add(key);
      return true;
    }),
    files: files.filter((file) => {
      const key = composerFileDedupKey(file);
      if (fileKeys.has(key)) return false;
      fileKeys.add(key);
      return true;
    }),
  };
}

/** Convert locally, then admit and commit the entire batch against the current draft. */
export async function stageComposerAttachmentBatch(input: {
  readonly images: ReadonlyArray<StagedComposerImage>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly readExisting: () => ReadonlyArray<AttachmentFacts>;
  readonly stillWanted: () => boolean;
  readonly isImageWanted: (id: string) => boolean;
  readonly commit: (input: {
    readonly images: ReadonlyArray<StagedComposerImage>;
    readonly files: ReadonlyArray<ComposerFileAttachment>;
  }) => boolean;
}): Promise<{ readonly inserted: boolean; readonly error: string | null }> {
  // These images take the byte-for-byte passthrough path. HEIC and oversized
  // rasters have unknown output sizes until local conversion completes.
  const unchangedImages = input.images.filter(
    ({ id, file }) =>
      input.isImageWanted(id) &&
      !isHeicImageFile(file) &&
      file.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  );
  const initialExisting = input.readExisting();
  const unchanged = uniqueBatch(initialExisting, unchangedImages, input.files);
  const earlyError = getProviderAttachmentLimitError([
    ...initialExisting,
    ...unchanged.files,
    ...unchanged.images.map(({ file }) => ({
      type: "image" as const,
      mimeType: file.type,
      sizeBytes: file.size,
    })),
  ]);
  if (earlyError) return { inserted: false, error: earlyError };

  const images: StagedComposerImage[] = [];
  const errors = new Map<string, string>();
  for (const { id, file } of input.images) {
    if (!input.isImageWanted(id)) continue;
    const prepared = await prepareImageForAttachment(
      file,
      PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    ).catch(() => ({ ok: false, reason: "unreadable" }) as const);
    if (!input.isImageWanted(id)) continue;
    if (!prepared.ok) {
      errors.set(
        id,
        prepared.reason === "unreadable"
          ? `'${file.name}' could not be read as an image.`
          : `'${file.name}' is too large to attach, even after compression.`,
      );
      continue;
    }
    inheritComposerImageThumbnail(file, prepared.file);
    images.push({ id, file: prepared.file });
  }
  if (!input.stillWanted()) return { inserted: false, error: null };
  const error = [...errors].filter(([id]) => input.isImageWanted(id)).at(-1)?.[1] ?? null;
  if (images.length === 0 && input.files.length === 0) return { inserted: false, error };

  const existing = input.readExisting();
  const batch = uniqueBatch(
    existing,
    images.filter(({ id }) => input.isImageWanted(id)),
    input.files,
  );
  const limitError = getProviderAttachmentLimitError([
    ...existing,
    ...batch.files,
    ...batch.images.map(({ file }) => ({
      type: "image" as const,
      mimeType: file.type,
      sizeBytes: file.size,
    })),
  ]);
  if (limitError) return { inserted: false, error: limitError };
  // No await between the fresh read above and this commit: overlapping pastes
  // see each other's actual stored bytes rather than a stale render snapshot.
  if (batch.images.length === 0 && batch.files.length === 0) return { inserted: false, error };
  return { inserted: input.commit(batch), error };
}
