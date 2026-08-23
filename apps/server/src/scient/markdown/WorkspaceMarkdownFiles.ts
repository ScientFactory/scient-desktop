// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  SCIENT_MARKDOWN_IMAGE_MAX_BYTES,
  ScientMarkdownImageConflictError,
  ScientMarkdownImageInvalidError,
  ScientMarkdownImageTooLargeError,
  type ScientMarkdownImageUploadResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";

import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";

interface SupportedImage {
  readonly extension: "avif" | "gif" | "jpeg" | "png" | "webp";
  readonly mediaType: "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  readonly acceptedExtensions: ReadonlySet<string>;
}

export class WorkspaceMarkdownImageOperationError extends Data.TaggedError(
  "WorkspaceMarkdownImageOperationError",
)<{ readonly cause: unknown }> {}

const PNG: SupportedImage = {
  extension: "png",
  mediaType: "image/png",
  acceptedExtensions: new Set(["png"]),
};
const JPEG: SupportedImage = {
  extension: "jpeg",
  mediaType: "image/jpeg",
  acceptedExtensions: new Set(["jpg", "jpeg"]),
};
const GIF: SupportedImage = {
  extension: "gif",
  mediaType: "image/gif",
  acceptedExtensions: new Set(["gif"]),
};
const WEBP: SupportedImage = {
  extension: "webp",
  mediaType: "image/webp",
  acceptedExtensions: new Set(["webp"]),
};
const AVIF: SupportedImage = {
  extension: "avif",
  mediaType: "image/avif",
  acceptedExtensions: new Set(["avif"]),
};

function bytesEqual(bytes: Uint8Array, offset: number, expected: ReadonlyArray<number>): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function inspectMarkdownImage(bytes: Uint8Array): SupportedImage | null {
  if (bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  if (bytesEqual(bytes, 0, [0xff, 0xd8, 0xff])) return JPEG;
  if (asciiAt(bytes, 0, 6) === "GIF87a" || asciiAt(bytes, 0, 6) === "GIF89a") return GIF;
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") return WEBP;
  if (asciiAt(bytes, 4, 4) === "ftyp") {
    const brands = asciiAt(bytes, 8, Math.min(bytes.length - 8, 32));
    if (brands.includes("avif") || brands.includes("avis")) return AVIF;
  }
  return null;
}

export function portableImageStem(fileName: string): string {
  const basename = NodePath.posix.basename(fileName.replaceAll("\\", "/"));
  const extension = NodePath.posix.extname(basename);
  const normalized = basename
    .slice(0, basename.length - extension.length)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return normalized || "image";
}

function validRelativeDocumentPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..") &&
    /\.(?:md|markdown)$/iu.test(normalized)
  );
}

function validAssetDirectory(directory: string): boolean {
  return directory !== "." && directory !== ".." && /^[\p{L}\p{N}_.-]{1,128}$/u.test(directory);
}

function uploadedExtension(fileName: string): string {
  return NodePath.posix.extname(fileName.replaceAll("\\", "/")).slice(1).toLowerCase();
}

export const uploadWorkspaceMarkdownImage = Effect.fn(
  "WorkspaceMarkdownFiles.uploadWorkspaceMarkdownImage",
)(function* (input: {
  readonly cwd: string;
  readonly documentRelativePath: string;
  readonly assetDirectory?: string | undefined;
  readonly temporaryPath: string;
  readonly fileName: string;
}) {
  if (!validRelativeDocumentPath(input.documentRelativePath)) {
    return yield* new ScientMarkdownImageInvalidError({
      reason: "invalid_document_path",
      message: "Images can only be inserted into a workspace-relative Markdown document.",
    });
  }
  const assetDirectory = input.assetDirectory?.trim() || "assets";
  if (!validAssetDirectory(assetDirectory)) {
    return yield* new ScientMarkdownImageInvalidError({
      reason: "invalid_asset_directory",
      message: "The image directory must be one portable folder name.",
    });
  }

  const stat = yield* Effect.tryPromise({
    try: () => NodeFSP.stat(input.temporaryPath),
    catch: (cause) => new WorkspaceMarkdownImageOperationError({ cause }),
  });
  if (stat.size === 0) {
    return yield* new ScientMarkdownImageInvalidError({
      reason: "empty_file",
      message: "The selected image is empty.",
    });
  }
  if (stat.size > SCIENT_MARKDOWN_IMAGE_MAX_BYTES) {
    return yield* new ScientMarkdownImageTooLargeError({
      byteLength: stat.size,
      maxBytes: SCIENT_MARKDOWN_IMAGE_MAX_BYTES,
      message: "The selected image is larger than the 20 MB Markdown asset limit.",
    });
  }
  const bytes = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(input.temporaryPath),
    catch: (cause) => new WorkspaceMarkdownImageOperationError({ cause }),
  });
  const image = inspectMarkdownImage(bytes);
  if (!image) {
    return yield* new ScientMarkdownImageInvalidError({
      reason: "unsupported_media",
      message: "Use a PNG, JPEG, GIF, WebP, or AVIF image.",
    });
  }
  const extension = uploadedExtension(input.fileName);
  if (extension.length > 0 && !image.acceptedExtensions.has(extension)) {
    return yield* new ScientMarkdownImageInvalidError({
      reason: "media_extension_mismatch",
      message: `The .${extension} filename does not match the detected ${image.mediaType} bytes.`,
    });
  }

  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const documentPath = input.documentRelativePath.replaceAll("\\", "/");
  const documentDirectory = NodePath.posix.dirname(documentPath);
  const assetParent =
    documentDirectory === "."
      ? assetDirectory
      : NodePath.posix.join(documentDirectory, assetDirectory);
  const stem = portableImageStem(input.fileName);

  for (let collision = 1; collision <= 100; collision += 1) {
    const suffix = collision === 1 ? "" : `-${collision}`;
    const relativePath = NodePath.posix.join(assetParent, `${stem}${suffix}.${image.extension}`);
    const created = yield* workspaceFileSystem
      .createBinaryFile({ cwd: input.cwd, relativePath, bytes })
      .pipe(Effect.result);
    if (created._tag === "Success") {
      const markdownSource = NodePath.posix.relative(documentDirectory, relativePath);
      return {
        relativePath: created.success.relativePath,
        markdownSource,
        mediaType: image.mediaType,
        byteLength: bytes.byteLength,
        revision: created.success.revision,
      } satisfies ScientMarkdownImageUploadResult;
    }
    if (created.failure._tag !== "WorkspaceFileExistsError") {
      return yield* new WorkspaceMarkdownImageOperationError({ cause: created.failure });
    }
  }

  return yield* new ScientMarkdownImageConflictError({
    message: "No collision-free image filename was available in the asset directory.",
  });
});
