import {
  inspectMarkdownDocument,
  resolveMarkdownDocumentRelativePath,
  rewriteMarkdownImageDestinations,
} from "@scientfactory/scient-markdown";
import {
  DOCUMENT_ASSET_URL_PREFIX,
  SCIENT_DOCUMENT_MAX_MARKDOWN_LENGTH,
  ScientDocumentPdfExportError,
  type DocumentAsset,
  type DocumentBundle,
  type DocumentWarning,
  type Sha256Digest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { sha256Digest } from "./DocumentCapture.ts";

/**
 * Turns a saved project Markdown file into a document bundle: the file's
 * bytes at a verified revision, with every workspace image it shows copied in
 * as an asset and its destination rewritten to `scient-asset:<id>`. The file
 * and its images are read once; nothing later reads the workspace again
 * except the currentness check before publication.
 */

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};
const MAX_IMAGE_BYTES = 64 * 1_024 * 1_024;
const MAX_IMAGES = 1_024;

const sourceError = (
  reason: "invalid-source" | "source-unavailable" | "source-changed" | "too-large",
  detail: string,
) => new ScientDocumentPdfExportError({ reason, detail });

export const isMarkdownDocumentPath = (path: Path.Path, relativePath: string) =>
  MARKDOWN_EXTENSIONS.has(path.extname(relativePath).toLowerCase());

const isInside = (path: Path.Path, root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

export interface ResolvedMarkdownFile {
  readonly canonicalRoot: string;
  readonly canonicalPath: string;
  /** Workspace-relative, `/`-separated. */
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly revision: Sha256Digest;
}

/**
 * Reads a project Markdown file that must stay inside `workspaceRoot`,
 * symlinks included. The revision matches the editor's saved-file revision.
 */
export const readProjectMarkdownFile = Effect.fn("MarkdownFileBundle.readProjectMarkdownFile")(
  function* (workspaceRoot: string, requestedPath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const portable = requestedPath.replaceAll("\\", "/");
    if (
      portable.includes("\0") ||
      path.isAbsolute(requestedPath) ||
      /^[A-Za-z]:\//u.test(portable) ||
      portable.startsWith("//") ||
      portable.split("/").some((segment) => segment === "..") ||
      !isMarkdownDocumentPath(path, portable)
    ) {
      return yield* sourceError(
        "invalid-source",
        "The source must be a project-relative .md or .markdown file.",
      );
    }
    const canonicalRoot = yield* fileSystem
      .realPath(workspaceRoot)
      .pipe(
        Effect.mapError(() =>
          sourceError("source-unavailable", "The project workspace is unavailable."),
        ),
      );
    const canonicalPath = yield* fileSystem
      .realPath(path.resolve(canonicalRoot, portable))
      .pipe(
        Effect.mapError(() =>
          sourceError("source-unavailable", "The Markdown file was not found in this project."),
        ),
      );
    if (!isInside(path, canonicalRoot, canonicalPath)) {
      return yield* sourceError(
        "invalid-source",
        "The Markdown file must remain inside the project workspace.",
      );
    }
    const info = yield* fileSystem
      .stat(canonicalPath)
      .pipe(
        Effect.mapError(() =>
          sourceError("source-unavailable", "The Markdown file could not be inspected."),
        ),
      );
    if (info.type !== "File") {
      return yield* sourceError("invalid-source", "The Markdown path does not identify a file.");
    }
    if (Number(info.size) > SCIENT_DOCUMENT_MAX_MARKDOWN_LENGTH) {
      return yield* sourceError("too-large", "The Markdown file is too large to export as PDF.");
    }
    const bytes = yield* fileSystem
      .readFile(canonicalPath)
      .pipe(
        Effect.mapError(() =>
          sourceError("source-unavailable", "The Markdown file could not be read."),
        ),
      );
    return {
      canonicalRoot,
      canonicalPath,
      relativePath: path.relative(canonicalRoot, canonicalPath).split(path.sep).join("/"),
      bytes,
      revision: sha256Digest(bytes),
    } satisfies ResolvedMarkdownFile;
  },
);

type ImageResolution =
  | {
      readonly _tag: "available";
      readonly fileName: string;
      readonly mediaType: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly _tag: "unavailable";
      readonly fileName: string;
      readonly reason: "missing" | "unreadable" | "unsupported" | "too-large";
      readonly message: string;
    };

const resolveWorkspaceImage = Effect.fn("MarkdownFileBundle.resolveWorkspaceImage")(function* (
  file: ResolvedMarkdownFile,
  destination: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const relative = resolveMarkdownDocumentRelativePath(file.relativePath, destination);
  const fileName = (relative ?? destination).split("/").at(-1) || "image";
  if (relative === null) {
    return {
      _tag: "unavailable",
      fileName,
      reason: "missing",
      message: `Image "${destination}" is outside the project and was not included.`,
    } satisfies ImageResolution;
  }
  const mediaType = IMAGE_MEDIA_TYPES[path.extname(relative).toLowerCase()];
  if (mediaType === undefined) {
    return {
      _tag: "unavailable",
      fileName,
      reason: "unsupported",
      message: `"${destination}" is not a supported image type and was not included.`,
    } satisfies ImageResolution;
  }
  const canonical = yield* fileSystem
    .realPath(path.resolve(file.canonicalRoot, relative))
    .pipe(Effect.option);
  const info = Option.isSome(canonical)
    ? yield* fileSystem.stat(canonical.value).pipe(Effect.option)
    : Option.none();
  if (
    Option.isNone(canonical) ||
    !isInside(path, file.canonicalRoot, canonical.value) ||
    Option.isNone(info) ||
    info.value.type !== "File"
  ) {
    return {
      _tag: "unavailable",
      fileName,
      reason: "missing",
      message: `Image "${destination}" was not found in the project.`,
    } satisfies ImageResolution;
  }
  if (Number(info.value.size) > MAX_IMAGE_BYTES) {
    return {
      _tag: "unavailable",
      fileName,
      reason: "too-large",
      message: `Image "${destination}" is larger than 64 MiB and was not included.`,
    } satisfies ImageResolution;
  }
  const bytes = yield* fileSystem.readFile(canonical.value).pipe(Effect.option);
  if (Option.isNone(bytes)) {
    return {
      _tag: "unavailable",
      fileName,
      reason: "unreadable",
      message: `Image "${destination}" could not be read.`,
    } satisfies ImageResolution;
  }
  return {
    _tag: "available",
    fileName,
    mediaType,
    bytes: bytes.value,
  } satisfies ImageResolution;
});

const isDirectImageDestination = (destination: string) =>
  /^(?:https?:)?\/\//iu.test(destination) ||
  destination.toLowerCase().startsWith("data:image/") ||
  destination.startsWith(DOCUMENT_ASSET_URL_PREFIX);

/** Builds the bundle for one already-read project Markdown file. */
export const buildMarkdownFileBundle = Effect.fn("MarkdownFileBundle.build")(function* (input: {
  readonly workspaceRoot: string;
  readonly file: ResolvedMarkdownFile;
}) {
  const path = yield* Path.Path;
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const markdown = yield* Effect.try({
    try: () => source.decode(input.file.bytes),
    catch: () => sourceError("invalid-source", "The Markdown file is not valid UTF-8 text."),
  });
  const inspection = inspectMarkdownDocument(markdown);
  const warnings: DocumentWarning[] = [];
  const assets: DocumentAsset[] = [];
  const assetIds = new Map<string, string>();
  for (const destination of inspection.imageReferences) {
    if (isDirectImageDestination(destination) || assets.length >= MAX_IMAGES) continue;
    const resolved = yield* resolveWorkspaceImage(input.file, destination);
    const id = `image-${String(assets.length + 1).padStart(4, "0")}`;
    assetIds.set(destination, id);
    const packagePath = `assets/${id}-${resolved.fileName}`.slice(0, 512);
    if (resolved._tag === "available") {
      assets.push({
        id,
        role: "image",
        fileName: resolved.fileName.slice(0, 255),
        mediaType: resolved.mediaType,
        byteLength: resolved.bytes.byteLength,
        packagePath,
        content: { _tag: "bytes", bytes: resolved.bytes, sha256: sha256Digest(resolved.bytes) },
      });
    } else {
      assets.push({
        id,
        role: "image",
        fileName: resolved.fileName.slice(0, 255),
        mediaType: "application/octet-stream",
        byteLength: 0,
        packagePath,
        content: { _tag: "unavailable", reason: resolved.reason },
      });
      warnings.push({ code: "resource-unresolved", message: resolved.message });
    }
  }
  const rewritten = rewriteMarkdownImageDestinations(markdown, (destination) => {
    const id = assetIds.get(destination);
    return id === undefined ? null : `${DOCUMENT_ASSET_URL_PREFIX}${id}`;
  });
  for (const destination of new Set(rewritten.unlocated)) {
    warnings.push({
      code: "resource-unresolved",
      message: `Image "${destination}" is written in a form Scient could not resolve and was not included.`,
    });
  }
  const fileTitle = path.basename(input.file.relativePath).replace(/\.[^.]+$/u, "");
  const bundle: DocumentBundle = {
    markdown: rewritten.markdown,
    profile: "document",
    metadata: {
      title: inspection.title ?? (fileTitle || "Document"),
      language: null,
      direction: "auto",
      createdAt: null,
      source: {
        _tag: "workspace-file",
        cwd: input.workspaceRoot,
        relativePath: input.file.relativePath,
        revision: input.file.revision,
      },
    },
    assets,
    citations: [],
    warnings,
  };
  return bundle;
});
