import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
} from "@t3tools/contracts";

import type { ComposerFileAttachment } from "../../composerDraftStore";
import { composerFileDedupKey, composerImageDedupKey } from "../../composerDraftStore";
import { isHeicImageFile, prepareImageForAttachment } from "../../lib/imageCompression";

type AttachmentFacts = Pick<ChatAttachment, "type" | "mimeType" | "sizeBytes"> & {
  /** Only the target draft grants deduplication; other question drafts still count. */
  readonly dedupKey?: string;
};

function uniqueBatch(
  existing: ReadonlyArray<AttachmentFacts>,
  images: ReadonlyArray<File>,
  files: ReadonlyArray<ComposerFileAttachment>,
) {
  const imageKeys = new Set(
    existing.filter((item) => item.type === "image").map((item) => item.dedupKey),
  );
  const fileKeys = new Set(
    existing.filter((item) => item.type === "file").map((item) => item.dedupKey),
  );
  return {
    images: images.filter((file) => {
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
  readonly images: ReadonlyArray<File>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly readExisting: () => ReadonlyArray<AttachmentFacts>;
  readonly stillWanted: () => boolean;
  readonly commit: (input: {
    readonly images: ReadonlyArray<File>;
    readonly files: ReadonlyArray<ComposerFileAttachment>;
  }) => boolean;
}): Promise<{ readonly inserted: boolean; readonly error: string | null }> {
  // These images take the byte-for-byte passthrough path. HEIC and oversized
  // rasters have unknown output sizes until local conversion completes.
  const unchangedImages = input.images.filter(
    (file) => !isHeicImageFile(file) && file.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  );
  const initialExisting = input.readExisting();
  const unchanged = uniqueBatch(initialExisting, unchangedImages, input.files);
  const earlyError = getProviderAttachmentLimitError([
    ...initialExisting,
    ...unchanged.files,
    ...unchanged.images.map((file) => ({
      type: "image" as const,
      mimeType: file.type,
      sizeBytes: file.size,
    })),
  ]);
  if (earlyError) return { inserted: false, error: earlyError };

  const images: File[] = [];
  let error: string | null = null;
  for (const file of input.images) {
    const prepared = await prepareImageForAttachment(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    if (!prepared.ok) {
      error =
        prepared.reason === "unreadable"
          ? `'${file.name}' could not be read as an image.`
          : `'${file.name}' is too large to attach, even after compression.`;
      continue;
    }
    images.push(prepared.file);
  }
  if (!input.stillWanted()) return { inserted: false, error: null };
  if (images.length === 0 && input.files.length === 0) return { inserted: false, error };

  const existing = input.readExisting();
  const batch = uniqueBatch(existing, images, input.files);
  const limitError = getProviderAttachmentLimitError([
    ...existing,
    ...batch.files,
    ...batch.images.map((file) => ({
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
