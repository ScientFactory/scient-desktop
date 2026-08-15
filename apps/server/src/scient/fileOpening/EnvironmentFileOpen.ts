import Mime from "@effect/platform-node/Mime";
import {
  EnvironmentFilePath,
  EnvironmentFilePrepareError,
  type EnvironmentFilePrepareInput,
  type EnvironmentFilePrepareResult,
  type EnvironmentFilePresentation,
  type EnvironmentFileTextEncoding,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

const INSPECTION_BYTE_LIMIT = 64 * 1_024;

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);
const BROWSER_IMAGE_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
] as const);
const BROWSER_AUDIO_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
] as const);
const BROWSER_VIDEO_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".ogv", "video/ogg"],
  [".webm", "video/webm"],
] as const);

function startsWithBytes(bytes: Uint8Array, expected: ReadonlyArray<number>, offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let value = "";
  for (let index = start; index < end && index < bytes.length; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}

function imageMediaTypeFromMagic(bytes: Uint8Array): string | null {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (startsWithBytes(bytes, [0x42, 0x4d])) return "image/bmp";
  if (startsWithBytes(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (ascii(bytes, 4, 12) === "ftypavif" || ascii(bytes, 4, 12) === "ftypavis") {
    return "image/avif";
  }
  return null;
}

function isPdf(bytes: Uint8Array): boolean {
  const searchLimit = Math.min(bytes.length, 1_024);
  for (let index = 0; index <= searchLimit - 5; index += 1) {
    if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d], index)) return true;
  }
  return false;
}

function decodeTextSample(
  bytes: Uint8Array,
  sampleTruncated: boolean,
): {
  readonly encoding: EnvironmentFileTextEncoding;
  readonly text: string;
} | null {
  try {
    if (startsWithBytes(bytes, [0xff, 0xfe])) {
      return {
        encoding: "utf-16le",
        text: new TextDecoder("utf-16le" as never, { fatal: true }).decode(bytes.subarray(2), {
          stream: sampleTruncated,
        }),
      };
    }
    if (startsWithBytes(bytes, [0xfe, 0xff])) {
      return {
        encoding: "utf-16be",
        text: new TextDecoder("utf-16be" as never, { fatal: true }).decode(bytes.subarray(2), {
          stream: sampleTruncated,
        }),
      };
    }
    if (bytes.includes(0)) return null;
    return {
      encoding: "utf-8",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: sampleTruncated }),
    };
  } catch {
    return null;
  }
}

function looksLikeSvg(text: string): boolean {
  return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[^]*?-->\s*)*<svg(?:\s|>)/iu.test(text);
}

function looksLikeHtml(text: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>))/iu.test(text);
}

export function classifyEnvironmentFile(input: {
  readonly filePath: string;
  readonly bytes: Uint8Array;
  readonly sampleTruncated?: boolean;
}): EnvironmentFilePresentation {
  const normalizedPath = input.filePath.replaceAll("\\", "/");
  const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  const extensionIndex = fileName.lastIndexOf(".");
  const extension = extensionIndex <= 0 ? "" : fileName.slice(extensionIndex).toLowerCase();
  const detectedImage = imageMediaTypeFromMagic(input.bytes);
  if (detectedImage) return { kind: "image", mediaType: detectedImage };
  if (isPdf(input.bytes)) return { kind: "pdf", mediaType: "application/pdf" };

  const decodedText = decodeTextSample(input.bytes, input.sampleTruncated ?? false);
  if (decodedText && (extension === ".svg" || looksLikeSvg(decodedText.text))) {
    return { kind: "image", mediaType: "image/svg+xml" };
  }
  if (HTML_EXTENSIONS.has(extension) || (decodedText && looksLikeHtml(decodedText.text))) {
    return {
      kind: "html",
      mediaType: Mime.getType(input.filePath) ?? "text/html",
      ...(decodedText ? { textEncoding: decodedText.encoding } : {}),
    };
  }

  const imageMediaType = BROWSER_IMAGE_MEDIA_TYPES.get(extension);
  if (imageMediaType) return { kind: "image", mediaType: imageMediaType };
  const audioMediaType = BROWSER_AUDIO_MEDIA_TYPES.get(extension);
  if (audioMediaType) return { kind: "audio", mediaType: audioMediaType };
  const videoMediaType = BROWSER_VIDEO_MEDIA_TYPES.get(extension);
  if (videoMediaType) return { kind: "video", mediaType: videoMediaType };

  if (decodedText && MARKDOWN_EXTENSIONS.has(extension)) {
    return {
      kind: "markdown",
      mediaType: Mime.getType(input.filePath) ?? "text/markdown",
      textEncoding: decodedText.encoding,
    };
  }
  if (decodedText) {
    return {
      kind: "text",
      mediaType: Mime.getType(input.filePath) ?? "text/plain",
      textEncoding: decodedText.encoding,
    };
  }
  return {
    kind: "binary",
    mediaType: Mime.getType(input.filePath) ?? "application/octet-stream",
  };
}

function filesystemFailure(
  cause: PlatformError.PlatformError,
): "not_found" | "unreadable" | "inspection_failed" {
  switch (cause.reason._tag) {
    case "NotFound":
      return "not_found";
    case "PermissionDenied":
      return "unreadable";
    default:
      return "inspection_failed";
  }
}

export const prepareEnvironmentFileOpen = Effect.fn("EnvironmentFileOpen.prepare")(function* (
  input: EnvironmentFilePrepareInput,
): Effect.fn.Return<
  EnvironmentFilePrepareResult,
  EnvironmentFilePrepareError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(input.path)) {
    return yield* new EnvironmentFilePrepareError({
      path: input.path,
      failure: "path_not_absolute",
    });
  }

  const canonicalPath = yield* fileSystem.realPath(input.path).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentFilePrepareError({
          path: input.path,
          failure: filesystemFailure(cause),
        }),
    ),
  );

  const opened = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(canonicalPath).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentFilePrepareError({
              path: input.path,
              failure: filesystemFailure(cause),
            }),
        ),
      );
      const info = yield* file.stat.pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentFilePrepareError({
              path: input.path,
              failure: filesystemFailure(cause),
            }),
        ),
      );
      if (info.type !== "File") {
        return yield* new EnvironmentFilePrepareError({
          path: input.path,
          failure: "not_a_file",
        });
      }
      const byteLength = Number(info.size);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        return yield* new EnvironmentFilePrepareError({
          path: input.path,
          failure: "inspection_failed",
        });
      }
      const bytes =
        byteLength === 0
          ? new Uint8Array()
          : Option.getOrElse(
              yield* file.readAlloc(Math.min(byteLength, INSPECTION_BYTE_LIMIT)).pipe(
                Effect.mapError(
                  (cause) =>
                    new EnvironmentFilePrepareError({
                      path: input.path,
                      failure: filesystemFailure(cause),
                    }),
                ),
              ),
              () => new Uint8Array(),
            );
      return {
        byteLength,
        mtimeMs: Option.match(info.mtime, {
          onNone: () => null,
          onSome: (mtime) => mtime.getTime(),
        }),
        bytes,
      };
    }),
  );

  return {
    canonicalPath: EnvironmentFilePath.make(canonicalPath),
    fileName: path.basename(canonicalPath),
    byteLength: opened.byteLength,
    mtimeMs: opened.mtimeMs,
    presentation: classifyEnvironmentFile({
      filePath: canonicalPath,
      bytes: opened.bytes,
      sampleTruncated: opened.byteLength > opened.bytes.byteLength,
    }),
  };
});
