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
import { DOCUMENT_CAPTURE_MAX_ASSET_BYTES } from "./documentPageInput.ts";

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
  /**
   * The workspace-relative path as requested, `/`-separated. For a symlinked
   * file this is the link, as the editor opened it, not its target.
   */
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
      // The path as opened, not the symlink target: relative images resolve from
      // here, as the editor resolves them. Containment uses the canonical path.
      relativePath: portable
        .split("/")
        .filter((segment) => segment.length > 0 && segment !== ".")
        .join("/"),
      bytes,
      revision: sha256Digest(bytes),
    } satisfies ResolvedMarkdownFile;
  },
);

type LocatedImage =
  | {
      readonly _tag: "located";
      readonly canonicalPath: string;
      readonly fileName: string;
      readonly mediaType: string;
      readonly size: number;
    }
  | {
      readonly _tag: "unavailable";
      readonly fileName: string;
      readonly reason: "missing" | "unreadable" | "unsupported" | "too-large";
      readonly message: string;
    };

/** Finds and checks one image without reading it, so budgets apply before any bytes are held. */
const locateWorkspaceImage = Effect.fn("MarkdownFileBundle.locateWorkspaceImage")(function* (
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
    } satisfies LocatedImage;
  }
  const mediaType = IMAGE_MEDIA_TYPES[path.extname(relative).toLowerCase()];
  if (mediaType === undefined) {
    return {
      _tag: "unavailable",
      fileName,
      reason: "unsupported",
      message: `"${destination}" is not a supported image type and was not included.`,
    } satisfies LocatedImage;
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
    } satisfies LocatedImage;
  }
  return {
    _tag: "located",
    canonicalPath: canonical.value,
    fileName,
    mediaType,
    size: Number(info.value.size),
  } satisfies LocatedImage;
});

/** How much image data one Markdown export may hold; fixed in production, smaller in tests. */
export interface MarkdownImageBudget {
  readonly maxImageBytes: number;
  readonly maxTotalBytes: number;
  readonly maxImages: number;
}

export const MARKDOWN_IMAGE_BUDGET: MarkdownImageBudget = {
  maxImageBytes: MAX_IMAGE_BYTES,
  maxTotalBytes: DOCUMENT_CAPTURE_MAX_ASSET_BYTES,
  maxImages: MAX_IMAGES,
};

const isDirectImageDestination = (destination: string) =>
  /^(?:https?:)?\/\//iu.test(destination) ||
  destination.toLowerCase().startsWith("data:image/") ||
  destination.startsWith(DOCUMENT_ASSET_URL_PREFIX);

/** Builds the bundle for one already-read project Markdown file. */
export const buildMarkdownFileBundle = Effect.fn("MarkdownFileBundle.build")(function* (input: {
  readonly workspaceRoot: string;
  readonly file: ResolvedMarkdownFile;
  readonly budget?: MarkdownImageBudget;
}) {
  const path = yield* Path.Path;
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const markdown = yield* Effect.try({
    try: () => source.decode(input.file.bytes),
    catch: () => sourceError("invalid-source", "The Markdown file is not valid UTF-8 text."),
  });
  const inspection = inspectMarkdownDocument(markdown);
  const fileSystem = yield* FileSystem.FileSystem;
  const budget = input.budget ?? MARKDOWN_IMAGE_BUDGET;
  const warnings: DocumentWarning[] = [];
  const assets: DocumentAsset[] = [];
  const assetIds = new Map<string, string>();
  // Destinations that differ only by query, fragment, or a symlink share one asset.
  const assetIdsByFile = new Map<string, string>();
  let heldBytes = 0;
  let heldImages = 0;
  const addAsset = (
    destination: string,
    fileName: string,
    content:
      | { readonly _tag: "bytes"; readonly bytes: Uint8Array; readonly mediaType: string }
      | {
          readonly _tag: "unavailable";
          readonly reason: "missing" | "unreadable" | "unsupported" | "too-large";
          readonly message: string;
        },
  ) => {
    const id = `image-${String(assets.length + 1).padStart(4, "0")}`;
    assetIds.set(destination, id);
    const base = {
      id,
      role: "image" as const,
      fileName: fileName.slice(0, 255),
      packagePath: `assets/${id}-${fileName}`.slice(0, 512),
    };
    if (content._tag === "bytes") {
      assets.push({
        ...base,
        mediaType: content.mediaType,
        byteLength: content.bytes.byteLength,
        content: { _tag: "bytes", bytes: content.bytes, sha256: sha256Digest(content.bytes) },
      });
    } else {
      assets.push({
        ...base,
        mediaType: "application/octet-stream",
        byteLength: 0,
        content: { _tag: "unavailable", reason: content.reason },
      });
      warnings.push({ code: "resource-unresolved", message: content.message });
    }
    return id;
  };
  for (const destination of inspection.imageReferences) {
    if (isDirectImageDestination(destination)) continue;
    const located = yield* locateWorkspaceImage(input.file, destination);
    if (located._tag === "unavailable") {
      addAsset(destination, located.fileName, located);
      continue;
    }
    const shared = assetIdsByFile.get(located.canonicalPath);
    if (shared !== undefined) {
      assetIds.set(destination, shared);
      continue;
    }
    const overBudget =
      located.size > budget.maxImageBytes
        ? `Image "${destination}" is larger than the per-image export limit and was not included.`
        : heldImages >= budget.maxImages
          ? `Image "${destination}" was not included because the document has more than ${budget.maxImages} images.`
          : heldBytes + located.size > budget.maxTotalBytes
            ? `Image "${destination}" was not included because the document's images exceed the export size limit.`
            : null;
    if (overBudget !== null) {
      assetIdsByFile.set(
        located.canonicalPath,
        addAsset(destination, located.fileName, {
          _tag: "unavailable",
          reason: "too-large",
          message: overBudget,
        }),
      );
      continue;
    }
    const bytes = yield* fileSystem.readFile(located.canonicalPath).pipe(Effect.option);
    // A file that grew after it was measured is held to the same budget.
    if (Option.isSome(bytes) && heldBytes + bytes.value.byteLength > budget.maxTotalBytes) {
      assetIdsByFile.set(
        located.canonicalPath,
        addAsset(destination, located.fileName, {
          _tag: "unavailable",
          reason: "too-large",
          message: `Image "${destination}" was not included because the document's images exceed the export size limit.`,
        }),
      );
      continue;
    }
    if (Option.isNone(bytes)) {
      assetIdsByFile.set(
        located.canonicalPath,
        addAsset(destination, located.fileName, {
          _tag: "unavailable",
          reason: "unreadable",
          message: `Image "${destination}" could not be read.`,
        }),
      );
      continue;
    }
    heldBytes += bytes.value.byteLength;
    heldImages += 1;
    assetIdsByFile.set(
      located.canonicalPath,
      addAsset(destination, located.fileName, {
        _tag: "bytes",
        bytes: bytes.value,
        mediaType: located.mediaType,
      }),
    );
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
