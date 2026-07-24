// FILE: localPreviewFiles.ts
// Purpose: Single source of truth for local preview route shapes consumed by the
//          server and web client, plus the file-extension allowlists that guard them.
// Layer: Shared utility (no runtime dependencies)
// Exports: route path, preview-file extension allowlists, and helper predicates
//          derived from them.

export const LOCAL_IMAGE_ROUTE_PATH = "/api/local-image" as const;
export const LOCAL_HTML_PREVIEW_ROUTE_PATH = "/api/local-html-preview" as const;

// Lower-case extensions (with leading dot) that the server is willing to serve and
// the web client is willing to treat as local-image markdown sources. Keep these in
// sync with the MIME allowlist used elsewhere; this list is the canonical answer.
export const SUPPORTED_LOCAL_IMAGE_EXTENSIONS = [
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
] as const;

const SUPPORTED_LOCAL_IMAGE_EXTENSIONS_SET: ReadonlySet<string> = new Set(
  SUPPORTED_LOCAL_IMAGE_EXTENSIONS,
);

/** Lower-cased extension (with leading dot) of a path, or null when there is none. */
export function lowerCaseExtensionOf(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  return filePath.slice(dot).toLowerCase();
}

export function isSupportedLocalImagePath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && SUPPORTED_LOCAL_IMAGE_EXTENSIONS_SET.has(extension);
}

export const SUPPORTED_LOCAL_PDF_EXTENSION = ".pdf" as const;

export function isSupportedLocalPdfPath(filePath: string): boolean {
  return lowerCaseExtensionOf(filePath) === SUPPORTED_LOCAL_PDF_EXTENSION;
}

export const SUPPORTED_LOCAL_AUDIO_EXTENSIONS = [
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
] as const;

export const SUPPORTED_LOCAL_VIDEO_EXTENSIONS = [".m4v", ".mov", ".mp4", ".ogv", ".webm"] as const;

const SUPPORTED_LOCAL_AUDIO_EXTENSIONS_SET: ReadonlySet<string> = new Set(
  SUPPORTED_LOCAL_AUDIO_EXTENSIONS,
);
const SUPPORTED_LOCAL_VIDEO_EXTENSIONS_SET: ReadonlySet<string> = new Set(
  SUPPORTED_LOCAL_VIDEO_EXTENSIONS,
);

export function isSupportedLocalAudioPath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && SUPPORTED_LOCAL_AUDIO_EXTENSIONS_SET.has(extension);
}

export function isSupportedLocalVideoPath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && SUPPORTED_LOCAL_VIDEO_EXTENSIONS_SET.has(extension);
}

export function isSupportedLocalMediaPath(filePath: string): boolean {
  return isSupportedLocalAudioPath(filePath) || isSupportedLocalVideoPath(filePath);
}

const SUPPORTED_LOCAL_HTML_EXTENSIONS: ReadonlySet<string> = new Set([".htm", ".html"]);

export function isSupportedLocalHtmlPath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && SUPPORTED_LOCAL_HTML_EXTENSIONS.has(extension);
}

export type LocalFileViewerKind =
  | "markdown"
  | "source"
  | "image"
  | "svg"
  | "pdf"
  | "html"
  | "audio"
  | "video";

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([".markdown", ".md", ".mdx"]);

/**
 * The single routing decision used by click-to-open surfaces and the file
 * preview itself. `source` is deliberately the fallback: the reader will show
 * ordinary text and replace binary-read failures with a useful file-info view.
 */
export function localFileViewerKindForPath(filePath: string): LocalFileViewerKind {
  const extension = lowerCaseExtensionOf(filePath);
  if (extension !== null && MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (isSupportedLocalHtmlPath(filePath)) return "html";
  if (extension === ".svg") return "svg";
  if (isSupportedLocalImagePath(filePath)) return "image";
  if (isSupportedLocalPdfPath(filePath)) return "pdf";
  if (isSupportedLocalAudioPath(filePath)) return "audio";
  if (isSupportedLocalVideoPath(filePath)) return "video";
  return "source";
}

// Full allowlist for the /api/local-image serving route. Markdown image source
// detection (below) intentionally stays image-only: a `.pdf` link in chat
// markdown must never be inlined as an <img>.
export function isSupportedLocalPreviewFilePath(filePath: string): boolean {
  return (
    isSupportedLocalImagePath(filePath) ||
    isSupportedLocalPdfPath(filePath) ||
    isSupportedLocalMediaPath(filePath)
  );
}

// Built from the canonical extensions list so the web regex never drifts from the
// server allowlist. Anchored at end-of-string to match `.png`-style suffixes only.
export const SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX: RegExp = (() => {
  const escaped = SUPPORTED_LOCAL_IMAGE_EXTENSIONS.map((extension) =>
    extension.slice(1).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`\\.(?:${escaped.join("|")})$`, "i");
})();
