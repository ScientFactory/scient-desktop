import { SCIENT_SOURCES_DIRECTORY } from "@scientfactory/scient-sources/store";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { issueAssetUrl } from "../../assets/AssetAccess.ts";
import { libraryAttachmentMaterial } from "./LibrarySourcesRoutes.ts";
import { getScientSourceAttachmentPreviewMaterial } from "./ScientSourcesCoordinator.ts";
import type { ScientSourcesLibraryStore } from "./SourcesBackend.ts";

export class SourceAttachmentPreviewError extends Schema.TaggedError<SourceAttachmentPreviewError>()(
  "SourceAttachmentPreviewError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The source attachment could not be previewed.";
  }
}

/**
 * A signed URL for a Source attachment, plus the path the reader names it by. The URL is rooted
 * where the bytes live (the Library after the move); the path is always the project's
 * `.scient/sources/…` locator, which annotation lookups resolve to the Library's bytes.
 */
export const sourceAttachmentPreview = Effect.fn("ScientSources.attachmentPreview")(function* (
  library: ScientSourcesLibraryStore | null,
  payload: { readonly root: string; readonly sourceId: string; readonly attachmentId: string },
) {
  const material = yield* Effect.tryPromise({
    try: () =>
      library
        ? libraryAttachmentMaterial(library, payload)
        : getScientSourceAttachmentPreviewMaterial(payload).then((found) => ({
            ...found,
            folder: payload.root,
          })),
    catch: (cause) => new SourceAttachmentPreviewError({ cause }),
  });
  const path = yield* Path.Path;
  const { folder, attachment } = material;
  const asset = yield* issueAssetUrl({
    resource: {
      _tag: "workspace-file",
      cwd: folder,
      relativePath: path.relative(folder, material.absolutePath),
    },
  });
  const { sha256, byteLength } = attachment;
  return {
    ...asset,
    sourcePath: `${SCIENT_SOURCES_DIRECTORY}/${attachment.relativePath}`,
    ...(/^[0-9a-f]{64}$/u.test(sha256) && byteLength >= 1
      ? { material: { sha256, byteLength } }
      : {}),
  };
});
