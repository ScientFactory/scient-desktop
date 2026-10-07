import * as Schema from "effect/Schema";
import type { ExtractedDraftIntent } from "./extractedDraftIntent";

const ComposerImageSelection = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    mimeType: Schema.String,
    sizeBytes: Schema.Number,
  }),
);
type ComposerImageSelection = typeof ComposerImageSelection.Type;
const isComposerImageSelection = Schema.is(ComposerImageSelection);

export const extractedImagePersistenceFields = {
  imageSelection: Schema.optionalKey(Schema.NullOr(ComposerImageSelection)),
};

export interface ExtractedImageRecoveryState {
  /** Hydrated extracted selection awaiting journal bytes; null means legacy/invalid membership. */
  pendingImageSelection?: ComposerImageSelection | null | undefined;
}

type ExtractedImageDraft = ExtractedImageRecoveryState & {
  extractedIntent?: ExtractedDraftIntent;
  images: ReadonlyArray<ComposerImageSelection[number]>;
};

export function normalizeExtractedImageSelection(draft: object) {
  return "imageSelection" in draft
    ? isComposerImageSelection(draft.imageSelection)
      ? draft.imageSelection.map((image) => ({ ...image }))
      : null
    : undefined;
}

export function persistedExtractedImageSelection(draft: ExtractedImageDraft) {
  return draft.extractedIntent
    ? {
        // Membership is synchronous; image encoding may still be in flight at unload.
        imageSelection:
          draft.pendingImageSelection === null
            ? null
            : Array.from(
                new Map([
                  ...(draft.pendingImageSelection ?? []).map((image) => [image.id, image] as const),
                  ...draft.images.map(
                    ({ id, name, mimeType, sizeBytes }) =>
                      [id, { id, name, mimeType, sizeBytes }] as const,
                  ),
                ]).values(),
              ),
      }
    : {};
}

export function selectedExtractedImageAttachments<A extends ComposerImageSelection[number]>(
  attachments: ReadonlyArray<A>,
  extractedIntent: ExtractedDraftIntent | undefined,
  imageSelection: ComposerImageSelection | null | undefined,
) {
  return attachments.filter(
    (attachment) =>
      !extractedIntent ||
      imageSelection == null ||
      imageSelection.some(
        (selection) =>
          selection.id === attachment.id &&
          selection.name === attachment.name &&
          selection.mimeType === attachment.mimeType &&
          selection.sizeBytes === attachment.sizeBytes,
      ),
  );
}

export function hydratedExtractedImageSelection(
  extractedIntent: ExtractedDraftIntent | undefined,
  imageSelection: ComposerImageSelection | null | undefined,
) {
  return extractedIntent ? { pendingImageSelection: imageSelection ?? null } : {};
}

export function removedExtractedImageSelection(
  pendingImageSelection: ComposerImageSelection | null | undefined,
  imageId: string,
) {
  return Array.isArray(pendingImageSelection)
    ? { pendingImageSelection: pendingImageSelection.filter((image) => image.id !== imageId) }
    : {};
}

export function assertExtractedImagesRecovered(
  drafts: ReadonlyArray<Pick<ExtractedImageDraft, "extractedIntent" | "pendingImageSelection">>,
) {
  if (
    drafts.some(
      (draft) =>
        draft.extractedIntent &&
        (draft.pendingImageSelection === null || (draft.pendingImageSelection?.length ?? 0) > 0),
    )
  )
    throw new Error("Recover the extracted images before moving this draft.");
}
