/**
 * The security pass between Pandoc's read and write passes. Pandoc's
 * `--sandbox` alone is not enough (Pandoc qualification, REPORT §5): citeproc
 * runs outside the sandbox and reads `bibliography` or fetches a `csl` named in
 * document metadata, raw OpenXML (including `INCLUDEPICTURE` field codes) is
 * copied verbatim into `document.xml`, and a `data:` URI of any type becomes an
 * embedded part. So before the write pass Scient:
 *
 * - keeps only presentational metadata and reports the file-reading keys it
 *   deleted (`bibliography`, `csl`, `citation-abbreviations`, `reference-doc`,
 *   `resource-path`);
 * - drops every `RawBlock` and `RawInline` (an HTML `<br>` becomes a line break);
 * - resolves every `Image` itself: bundle assets by id, `data:` URIs only when
 *   the bytes are an image, relative paths only inside the allowlisted roots
 *   (lexically and after `realpath`), regular files under the size cap whose
 *   magic bytes are an image; no URL scheme, absolute, drive, or UNC path is
 *   ever read. Anything else becomes a visible placeholder in the
 *   `Scient Placeholder` style and a warning;
 * - keeps only web, mail, and in-document links; other destinations keep
 *   their text.
 *
 * The walk is generic over the JSON tree, so a node kind Scient does not model
 * cannot carry a raw block or an image past it.
 */
import {
  DOCUMENT_ASSET_URL_PREFIX,
  type DocumentAsset,
  type DocumentWarning,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";

import {
  attr,
  customStyleSpan,
  inlineText,
  isPandocNode,
  textInlines,
  type PandocDocument,
  type PandocNode,
} from "./pandocAst.ts";

/** Metadata keys that make citeproc or the writer open files or URLs. */
const FILE_READING_METADATA_KEYS = [
  "bibliography",
  "csl",
  "citation-abbreviations",
  "reference-doc",
  "resource-path",
] as const;

/** Front-matter keys that survive into the Word file; everything else is dropped. */
const KEPT_METADATA_KEYS = new Set(["title", "subtitle", "author", "date", "abstract"]);

export const PLACEHOLDER_STYLE = "Scient Placeholder";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;
/** Per-image warnings beyond this collapse into one summary line. */
const MAX_IMAGE_WARNINGS = 20;

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/svg+xml";

/** Sniffs only a bounded XML prolog. Each cursor move is forward-only. */
function looksLikeSvg(head: string): boolean {
  let at = 0;
  const skipWhitespace = () => {
    while (at < head.length && /\s/u.test(head[at]!)) at += 1;
  };
  const skipComments = (): boolean => {
    while (head.startsWith("<!--", at)) {
      const end = head.indexOf("-->", at + 4);
      if (end < 0) return false;
      at = end + 3;
      skipWhitespace();
    }
    return true;
  };
  skipWhitespace();
  if (head.slice(at, at + 5).toLowerCase() === "<?xml") {
    const end = head.indexOf(">", at + 5);
    if (end < 0) return false;
    at = end + 1;
    skipWhitespace();
  }
  if (!skipComments()) return false;
  if (head.slice(at, at + 13).toLowerCase() === "<!doctype svg") {
    const end = head.indexOf(">", at + 13);
    if (end < 0) return false;
    at = end + 1;
    skipWhitespace();
  }
  if (!skipComments()) return false;
  return head.slice(at, at + 4).toLowerCase() === "<svg" && /[\s>]/u.test(head[at + 4] ?? "");
}

/** What the leading bytes are, independent of any name or declared type. */
export function sniffMediaType(bytes: Uint8Array): ImageMediaType | "application/pdf" | null {
  const starts = (signature: ReadonlyArray<number>) =>
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
    return "image/gif";
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 4096))
    .replace(/^﻿/u, "");
  if (looksLikeSvg(head)) return "image/svg+xml";
  return null;
}

/**
 * An SVG that points outside itself (an `href` or CSS `url()` to anything but
 * a fragment or an inline image, or an `@import`) could make a viewer fetch or
 * read something when the Word file is opened, so it is not embedded.
 */
export function svgHasExternalReferences(bytes: Uint8Array): boolean {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return (
    /\bhref\s*=\s*["']\s*(?!#|data:image\/)/iu.test(text) ||
    /url\(\s*["']?\s*(?!#|data:image\/)/iu.test(text) ||
    /@import\b/iu.test(text) ||
    /<!ENTITY/iu.test(text)
  );
}

type ImageRefusal =
  | "missing"
  | "unavailable"
  | "outside-allowlist"
  | "symlink-outside-allowlist"
  | "absolute-path"
  | "remote-or-scheme"
  | "not-a-file"
  | "not-an-image"
  | "data-uri-not-image"
  | "pdf-figure"
  | "svg-external-reference"
  | "too-large"
  | "budget-exceeded";

const REFUSAL_TEXT: Record<ImageRefusal, string> = {
  missing: "file not found",
  unavailable: "not available in this export",
  "outside-allowlist": "outside the document's folder",
  "symlink-outside-allowlist": "links outside the document's folder",
  "absolute-path": "absolute paths are not embedded",
  "remote-or-scheme": "remote and non-file images are not embedded",
  "not-a-file": "not a regular file",
  "not-an-image": "not an image",
  "data-uri-not-image": "inline data is not an image",
  "pdf-figure": "PDF figures cannot be embedded in Word",
  "svg-external-reference": "the SVG refers to outside resources",
  "too-large": "larger than 25 MB",
  "budget-exceeded": "the export's image size limit was reached",
};

/** Loads the PNG rendering that stands in for an SVG, when there is one. */
type PngLoader = () => Effect.Effect<Uint8Array | null>;

type ImageResolution =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly mediaType: ImageMediaType;
      readonly png: PngLoader | null;
    }
  | { readonly ok: false; readonly refusal: ImageRefusal };

export interface ImageResourceOptions {
  readonly assets: ReadonlyArray<DocumentAsset>;
  /** Relative image paths resolve against `baseDirectory`, only inside `allowRoots`. */
  readonly files: {
    readonly baseDirectory: string;
    readonly allowRoots: ReadonlyArray<string>;
  } | null;
  readonly maxImageBytes?: number;
  readonly maxTotalImageBytes?: number;
}

export interface SecurityReport {
  readonly warnings: ReadonlyArray<DocumentWarning>;
  readonly embeddedImages: number;
  readonly placeholders: number;
}

function placeholderSpan(label: string, reason: string): PandocNode {
  return customStyleSpan(
    PLACEHOLDER_STYLE,
    textInlines(`[Image unavailable: ${label} — ${reason}]`),
  );
}

const BREAK_TAG = /^<br\s*\/?>$/iu;
const COMMENT = /^<!--[\s\S]*-->\s*$/u;

interface RawCounts {
  html: number;
  other: Map<string, number>;
}

function stripRawNodes(value: unknown, counts: RawCounts): void {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item: unknown = value[index];
      if (isPandocNode(item) && (item.t === "RawBlock" || item.t === "RawInline")) {
        const [format, text] = Array.isArray(item.c) ? item.c : ["", ""];
        const raw = Predicate.isString(text) ? text.trim() : "";
        if (item.t === "RawInline" && format === "html" && BREAK_TAG.test(raw)) {
          value[index] = { t: "LineBreak" };
          continue;
        }
        value.splice(index, 1);
        if (format === "html") {
          if (!COMMENT.test(raw)) counts.html += 1;
        } else {
          const key = Predicate.isString(format) ? format : "unknown";
          counts.other.set(key, (counts.other.get(key) ?? 0) + 1);
        }
        continue;
      }
      stripRawNodes(item, counts);
    }
    return;
  }
  if (Predicate.isObject(value)) {
    for (const child of Object.values(value)) stripRawNodes(child, counts);
  }
}

function collectNodes(value: unknown, kind: string, found: Array<PandocNode>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, kind, found);
    return;
  }
  if (!Predicate.isObject(value)) return;
  if (isPandocNode(value) && value.t === kind) found.push(value);
  for (const child of Object.values(value)) collectNodes(child, kind, found);
}

function isKeptLinkTarget(url: string): boolean {
  return /^(?:https?:|mailto:)/iu.test(url) || url.startsWith("#");
}

const within = (path: Path.Path, root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** A URL-encoded relative path, or the text as written when it is not valid encoding. */
function decodePathUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function decodeDataUri(url: string): Uint8Array | null {
  const match = /^data:([^,]*),(.*)$/isu.exec(url);
  if (!match) return null;
  const meta = match[1] ?? "";
  const payload = match[2] ?? "";
  try {
    return /;base64$/iu.test(meta.trim())
      ? new Uint8Array(Buffer.from(payload, "base64"))
      : new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

/**
 * Secures the tree in place. Needs the file system only for bundles that name
 * workspace files by relative path; asset and `data:` images are in memory.
 */
export const securePandocDocument = Effect.fn("scient.pandoc.securePandocDocument")(function* (
  document: PandocDocument,
  options: ImageResourceOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const warnings: Array<DocumentWarning> = [];
  const maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
  const maxTotalImageBytes = options.maxTotalImageBytes ?? MAX_TOTAL_IMAGE_BYTES;

  // 1. Metadata.
  for (const key of Object.keys(document.meta)) {
    if (KEPT_METADATA_KEYS.has(key)) continue;
    delete document.meta[key];
    if ((FILE_READING_METADATA_KEYS as ReadonlyArray<string>).includes(key)) {
      warnings.push({
        code: "unsupported-construct",
        message: `The document's front matter named a ${key}; Scient ignored it and read no file for it.`,
      });
    }
  }

  // 2. Raw content, in metadata as well as in the body.
  const counts: RawCounts = { html: 0, other: new Map() };
  stripRawNodes(document.meta, counts);
  stripRawNodes(document.blocks, counts);
  if (counts.html > 0) {
    warnings.push({
      code: "unsupported-construct",
      message: `Raw HTML was left out of the Word file (${counts.html} ${counts.html === 1 ? "place" : "places"}).`,
    });
  }
  for (const [format, count] of counts.other) {
    warnings.push({
      code: "unsupported-construct",
      message: `Raw ${format} content was left out of the Word file (${count} ${count === 1 ? "place" : "places"}).`,
    });
  }

  // 3. Links keep their text; only web, mail, and in-document targets stay links.
  const links: Array<PandocNode> = [];
  collectNodes(document, "Link", links);
  for (const link of links) {
    const [, inlines, target] = Array.isArray(link.c) ? link.c : [];
    const url = Array.isArray(target) && Predicate.isString(target[0]) ? target[0] : "";
    if (isKeptLinkTarget(url)) continue;
    link.t = "Span";
    link.c = [attr(), Array.isArray(inlines) ? inlines : []];
  }

  // 4. Images.
  const assetsById = new Map(options.assets.map((asset) => [asset.id, asset]));
  const roots = options.files
    ? yield* Effect.forEach(options.files.allowRoots, (root) =>
        fileSystem.realPath(root).pipe(
          Effect.map((real) => ({ lexical: path.resolve(root), real })),
          Effect.orElseSucceed(() => null),
        ),
      ).pipe(Effect.map((list) => list.filter(Predicate.isNotNull)))
    : [];

  const readAllowedFile = (candidate: string) =>
    Effect.gen(function* () {
      const lexical = path.resolve(candidate);
      if (!roots.some((root) => within(path, root.lexical, lexical))) {
        return { ok: false, refusal: "outside-allowlist" } as const;
      }
      const real = yield* fileSystem.realPath(lexical).pipe(Effect.orElseSucceed(() => null));
      if (real === null) return { ok: false, refusal: "missing" } as const;
      if (!roots.some((root) => within(path, root.real, real))) {
        return { ok: false, refusal: "symlink-outside-allowlist" } as const;
      }
      const info = yield* fileSystem.stat(real).pipe(Effect.orElseSucceed(() => null));
      if (info === null) return { ok: false, refusal: "missing" } as const;
      if (info.type !== "File") return { ok: false, refusal: "not-a-file" } as const;
      if (Number(info.size) > maxImageBytes) return { ok: false, refusal: "too-large" } as const;
      const bytes = yield* fileSystem.readFile(real).pipe(Effect.orElseSucceed(() => null));
      if (bytes === null) return { ok: false, refusal: "missing" } as const;
      return { ok: true, bytes } as const;
    });

  const asImage = (
    bytes: Uint8Array,
    notImage: ImageRefusal,
    png: PngLoader | null,
  ): ImageResolution => {
    if (bytes.byteLength > maxImageBytes) return { ok: false, refusal: "too-large" };
    const mediaType = sniffMediaType(bytes);
    if (mediaType === "application/pdf") return { ok: false, refusal: "pdf-figure" };
    if (mediaType === null) return { ok: false, refusal: notImage };
    if (mediaType === "image/svg+xml" && svgHasExternalReferences(bytes)) {
      return { ok: false, refusal: "svg-external-reference" };
    }
    return { ok: true, bytes, mediaType, png };
  };

  const resolveImage = (url: string): Effect.Effect<ImageResolution> =>
    Effect.gen(function* () {
      if (url.startsWith(DOCUMENT_ASSET_URL_PREFIX)) {
        const asset = assetsById.get(url.slice(DOCUMENT_ASSET_URL_PREFIX.length));
        if (asset === undefined) return { ok: false, refusal: "missing" };
        if (asset.content._tag !== "bytes") return { ok: false, refusal: "unavailable" };
        const pngPath = asset.packagePath.replace(/\.svg$/iu, ".png");
        const sibling = options.assets.find(
          (candidate) =>
            candidate.id !== asset.id &&
            candidate.content._tag === "bytes" &&
            pngPath !== asset.packagePath &&
            candidate.packagePath === pngPath,
        );
        return asImage(
          asset.content.bytes,
          "not-an-image",
          sibling !== undefined && sibling.content._tag === "bytes"
            ? () => Effect.succeed(sibling.content._tag === "bytes" ? sibling.content.bytes : null)
            : null,
        );
      }
      if (/^data:/iu.test(url)) {
        const bytes = decodeDataUri(url);
        return bytes === null
          ? { ok: false, refusal: "data-uri-not-image" }
          : asImage(bytes, "data-uri-not-image", null);
      }
      // Any scheme at all (a drive letter is not one) is refused.
      if (/^[a-z][a-z0-9+.-]*:/iu.test(url) && !/^[a-z]:[\\/]/iu.test(url)) {
        return { ok: false, refusal: "remote-or-scheme" };
      }
      const relative = decodePathUrl(url).replaceAll("\\", "/");
      if (
        relative.includes("\0") ||
        relative.startsWith("/") ||
        /^[a-z]:\//iu.test(relative) ||
        path.isAbsolute(relative)
      ) {
        return { ok: false, refusal: "absolute-path" };
      }
      const files = options.files;
      if (files === null || relative.length === 0) return { ok: false, refusal: "missing" };
      const candidate = path.join(files.baseDirectory, relative);
      const read = yield* readAllowedFile(candidate);
      if (!read.ok) return { ok: false, refusal: read.refusal };
      // The rendering sits beside the SVG as written, and passes the same checks.
      const siblingPath = candidate.replace(/\.svg$/iu, ".png");
      return asImage(
        read.bytes,
        "not-an-image",
        siblingPath === candidate
          ? null
          : () =>
              readAllowedFile(siblingPath).pipe(
                Effect.map((sibling) => (sibling.ok ? sibling.bytes : null)),
              ),
      );
    });

  const images: Array<PandocNode> = [];
  collectNodes(document, "Image", images);
  let embeddedBytes = 0;
  let embeddedImages = 0;
  let placeholders = 0;
  const imageWarnings: Array<string> = [];
  for (const image of images) {
    const [, alt, target] = Array.isArray(image.c) ? image.c : [];
    const url = Array.isArray(target) && Predicate.isString(target[0]) ? target[0] : "";
    const label =
      inlineText(alt).trim().slice(0, 120) ||
      (url.startsWith(DOCUMENT_ASSET_URL_PREFIX)
        ? (assetsById.get(url.slice(DOCUMENT_ASSET_URL_PREFIX.length))?.fileName ?? "image")
        : (url.split(/[\\/]/u).pop()?.slice(0, 80) ?? "image")) ||
      "image";
    let resolved = yield* resolveImage(url);
    if (resolved.ok && resolved.mediaType === "image/svg+xml") {
      const png = resolved.png === null ? null : yield* resolved.png();
      if (png !== null && sniffMediaType(png) === "image/png" && png.byteLength <= maxImageBytes) {
        resolved = { ok: true, bytes: png, mediaType: "image/png", png: null };
      } else {
        imageWarnings.push(
          `Image “${label}” is an SVG without a PNG rendering; Word 2016 and later show it, older viewers may not.`,
        );
      }
    }
    if (resolved.ok && embeddedBytes + resolved.bytes.byteLength > maxTotalImageBytes) {
      resolved = { ok: false, refusal: "budget-exceeded" };
    }
    if (!resolved.ok) {
      placeholders += 1;
      imageWarnings.push(`Image “${label}” was not embedded: ${REFUSAL_TEXT[resolved.refusal]}.`);
      const replacement = placeholderSpan(label, REFUSAL_TEXT[resolved.refusal]);
      image.t = replacement.t;
      image.c = replacement.c;
      continue;
    }
    embeddedBytes += resolved.bytes.byteLength;
    embeddedImages += 1;
    const title = Array.isArray(target) && Predicate.isString(target[1]) ? target[1] : "";
    image.c = [
      attr(),
      Array.isArray(alt) ? alt : [],
      [
        `data:${resolved.mediaType};base64,${Buffer.from(resolved.bytes).toString("base64")}`,
        title,
      ],
    ];
  }
  for (const message of imageWarnings.slice(0, MAX_IMAGE_WARNINGS)) {
    warnings.push({ code: "resource-unresolved", message });
  }
  if (imageWarnings.length > MAX_IMAGE_WARNINGS) {
    warnings.push({
      code: "resource-unresolved",
      message: `${imageWarnings.length - MAX_IMAGE_WARNINGS} more image problems are not listed.`,
    });
  }

  return { warnings, embeddedImages, placeholders } satisfies SecurityReport;
});
