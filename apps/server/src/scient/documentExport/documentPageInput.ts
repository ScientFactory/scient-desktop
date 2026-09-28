import {
  DOCUMENT_ASSET_URL_PREFIX,
  SCIENT_DOCUMENT_MAX_ASSETS,
  SCIENT_DOCUMENT_MAX_WARNINGS,
  SCIENT_DOCUMENT_PAGE_PROTOCOL,
  type DocumentBundle,
  type DocumentWarning,
  type ScientDocumentCaptureId,
  type ScientDocumentPageAsset,
  type ScientDocumentPageInput,
  type Sha256Digest,
} from "@t3tools/contracts";

import { hasImageSignature, imageFormatLabel } from "./imageSignature.ts";

/**
 * The pure half of a capture: which asset bytes a document bundle needs on
 * its page, and the page input that refers to them. Kept free of services so
 * the capture writer and the real-Chromium qualification build identical
 * page inputs.
 */

/** Asset bytes one capture may copy; larger documents keep labelled placeholders instead. */
export const DOCUMENT_CAPTURE_MAX_ASSET_BYTES = 256 * 1_024 * 1_024;

const ASSET_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/**
 * At most `limit` entries: `mandatory` always, as many of `ordinary` as fit,
 * and, when some do not, one closing entry from `omitted` with their exact
 * number.
 */
export function boundWarnings<A>(input: {
  readonly ordinary: ReadonlyArray<A>;
  readonly mandatory: ReadonlyArray<A>;
  readonly limit: number;
  readonly omitted: (count: number) => A;
}): ReadonlyArray<A> {
  const room = input.limit - input.mandatory.length;
  if (input.ordinary.length <= room) return [...input.ordinary, ...input.mandatory];
  const shown = input.ordinary.slice(0, Math.max(0, room - 1));
  return [...shown, ...input.mandatory, input.omitted(input.ordinary.length - shown.length)];
}

/** The asset ids a bundle's Markdown actually refers to. */
export function referencedDocumentAssetIds(markdown: string): ReadonlySet<string> {
  const ids = new Set<string>();
  const prefix = DOCUMENT_ASSET_URL_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  for (const match of markdown.matchAll(new RegExp(`${prefix}([a-z0-9][a-z0-9-]*)`, "gu"))) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
}

/**
 * The digest the page must echo back: a project file's saved revision or a
 * conversation snapshot's content digest.
 */
export function bundleSourceDigest(bundle: DocumentBundle): Sha256Digest | null {
  const source = bundle.metadata.source;
  const digest = source._tag === "workspace-file" ? source.revision : source.contentDigest;
  return SHA256_DIGEST.test(digest) ? (digest as Sha256Digest) : null;
}

/** Capture warnings within the contract's limit, ending with a count of those left out. */
export function boundCaptureWarnings(
  warnings: ReadonlyArray<DocumentWarning>,
): ReadonlyArray<DocumentWarning> {
  return boundWarnings({
    ordinary: warnings,
    mandatory: [],
    limit: SCIENT_DOCUMENT_MAX_WARNINGS,
    omitted: (count) => ({
      code: warnings[0]?.code ?? "resource-unresolved",
      message: `…and ${count} more notes, not listed here.`,
    }),
  });
}

export interface DocumentPageCapture {
  readonly pageInput: ScientDocumentPageInput;
  /** Files to write next to the page input, keyed by their capture-relative path. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>;
  /** Every capture warning, without the page input's limit. */
  readonly warnings: ReadonlyArray<DocumentWarning>;
}

/**
 * Builds the page input for one bundle. Only images the Markdown refers to are
 * copied, and only when their bytes carry their format's signature;
 * attachments and other referenced assets print as labelled names.
 */
export function buildDocumentPageCapture(input: {
  readonly bundle: DocumentBundle;
  readonly captureId: ScientDocumentCaptureId;
  readonly sourceDigest: Sha256Digest;
}): DocumentPageCapture {
  const { bundle } = input;
  const referenced = referencedDocumentAssetIds(bundle.markdown);
  const warnings = [...bundle.warnings];
  const assets: ScientDocumentPageAsset[] = [];
  const files: Array<{ readonly path: string; readonly bytes: Uint8Array }> = [];
  let capturedBytes = 0;
  for (const asset of bundle.assets) {
    if (!referenced.has(asset.id) || assets.length >= SCIENT_DOCUMENT_MAX_ASSETS) continue;
    const base = {
      id: asset.id,
      role: asset.role,
      fileName: asset.fileName,
      mediaType: asset.mediaType,
    };
    if (asset.content._tag === "unavailable") {
      assets.push({ ...base, content: { _tag: "unavailable", reason: asset.content.reason } });
      continue;
    }
    const extension = ASSET_EXTENSIONS[asset.mediaType.toLowerCase()];
    if (asset.role === "attachment" || extension === undefined) {
      assets.push({ ...base, content: { _tag: "unavailable", reason: "unsupported" } });
      continue;
    }
    if (!hasImageSignature(asset.content.bytes, asset.mediaType)) {
      assets.push({ ...base, content: { _tag: "unavailable", reason: "unsupported" } });
      warnings.push({
        code: "resource-unresolved",
        message: `Image "${asset.fileName}" is not a valid ${imageFormatLabel(asset.mediaType)} file and was left out.`,
      });
      continue;
    }
    if (capturedBytes + asset.content.bytes.byteLength > DOCUMENT_CAPTURE_MAX_ASSET_BYTES) {
      assets.push({ ...base, content: { _tag: "unavailable", reason: "too-large" } });
      warnings.push({
        code: "resource-unresolved",
        message: `Image "${asset.fileName}" was left out because the document's images exceed the export size limit.`,
      });
      continue;
    }
    capturedBytes += asset.content.bytes.byteLength;
    const path = `assets/${String(files.length + 1).padStart(4, "0")}.${extension}`;
    files.push({ path, bytes: asset.content.bytes });
    assets.push({ ...base, content: { _tag: "captured", path, sha256: asset.content.sha256 } });
  }
  return {
    pageInput: {
      protocol: SCIENT_DOCUMENT_PAGE_PROTOCOL,
      captureId: input.captureId,
      documentKind: bundle.metadata.source._tag,
      sourceDigest: input.sourceDigest,
      profile: bundle.profile,
      title: bundle.metadata.title.slice(0, 512) || "Document",
      language: bundle.metadata.language?.slice(0, 35) ?? null,
      direction: bundle.metadata.direction,
      createdAt: bundle.metadata.createdAt,
      markdown: bundle.markdown,
      assets,
      // The page prints these; the capture record keeps every warning.
      warnings: boundCaptureWarnings(warnings),
    },
    files,
    warnings,
  };
}
