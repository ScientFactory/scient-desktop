// @effect-diagnostics nodeBuiltinImport:off -- Capture identity and content hashing stay server-owned.
import { LogicalDocumentKey } from "@scientfactory/document-artifacts";
import {
  DOCUMENT_ASSET_URL_PREFIX,
  DocumentWarning,
  EnvironmentFilePath,
  SCIENT_DOCUMENT_CAPTURE_ENTRY_FILE,
  SCIENT_DOCUMENT_CAPTURE_INPUT_FILE,
  SCIENT_DOCUMENT_MAX_ASSETS,
  SCIENT_DOCUMENT_MAX_MARKDOWN_LENGTH,
  SCIENT_DOCUMENT_MAX_WARNINGS,
  SCIENT_DOCUMENT_PAGE_PROTOCOL,
  ScientDocumentCaptureId,
  ScientDocumentPageExpectation,
  ScientDocumentPageInput,
  ScientDocumentPdfExportError,
  Sha256Digest,
  type DocumentBundle,
  type ScientDocumentPageAsset,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { issueAssetUrl } from "../../assets/AssetAccess.ts";
import * as ServerConfig from "../../config.ts";

/**
 * A capture is the export's frozen input: one document bundle and copies of
 * the asset bytes its Markdown refers to, written to a server-owned temporary
 * directory before anything renders. Rendering reads only the capture, so a
 * slow render can neither hold the source open nor observe it changing
 * midway. A capture is removed after publication and expires if the render
 * never returns.
 */

const CAPTURE_DIRECTORY = "document-exports";
/** Server-only record; dot-files are never served through the capture's signed URL. */
const CAPTURE_RECORD_FILE = ".capture.json";
const CAPTURE_TTL_MS = 10 * 60_000;
const CAPTURE_URL_TTL_MS = 5 * 60_000;
/** Asset bytes one capture may copy; larger documents keep labelled placeholders instead. */
export const DOCUMENT_CAPTURE_MAX_ASSET_BYTES = 256 * 1_024 * 1_024;
const CAPTURE_ENTRY_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Scient document capture</title></head><body></body></html>\n';

const ASSET_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

export const sha256Digest = (bytes: Uint8Array): Sha256Digest =>
  Sha256Digest.make(`sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`);

export const documentLogicalKey = (kind: "markdown-pdf" | "conversation-pdf", identity: string) =>
  LogicalDocumentKey.make(
    `${kind}:${NodeCrypto.createHash("sha256").update(identity).digest("hex")}`,
  );

/** What publication re-checks before accepting a render of this capture. */
export const CapturedDocumentSource = Schema.Union([
  /** A project file; publication re-reads it and requires the captured digest. */
  Schema.TaggedStruct("workspace-file", { canonicalPath: Schema.String }),
  /** A conversation snapshot is immutable; its digest already identifies it. */
  Schema.TaggedStruct("conversation", {}),
]);
export type CapturedDocumentSource = typeof CapturedDocumentSource.Type;

export const DocumentCaptureRecord = Schema.Struct({
  version: Schema.Literal(1),
  expected: ScientDocumentPageExpectation,
  title: Schema.String,
  logicalDocumentKey: LogicalDocumentKey,
  source: CapturedDocumentSource,
  warnings: Schema.Array(DocumentWarning),
  createdAtEpochMs: Schema.Number,
  expiresAtEpochMs: Schema.Number,
});
export type DocumentCaptureRecord = typeof DocumentCaptureRecord.Type;

const isCaptureId = Schema.is(ScientDocumentCaptureId);
const isSha256Digest = Schema.is(Sha256Digest);
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(DocumentCaptureRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(DocumentCaptureRecord));
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(ScientDocumentPageInput));

export interface WriteDocumentCaptureInput {
  readonly bundle: DocumentBundle;
  readonly logicalDocumentKey: LogicalDocumentKey;
  readonly source: CapturedDocumentSource;
}

export interface WrittenDocumentCapture {
  readonly record: DocumentCaptureRecord;
  readonly inputRelativeUrl: string;
}

const storageError = (detail: string) =>
  new ScientDocumentPdfExportError({ reason: "storage", detail });

const capturesRoot = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, CAPTURE_DIRECTORY);
});

const captureDirectory = Effect.fn("DocumentCapture.directory")(function* (
  captureId: ScientDocumentCaptureId,
) {
  const path = yield* Path.Path;
  return path.join(yield* capturesRoot, captureId);
});

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
  return isSha256Digest(digest) ? digest : null;
}

/** Removes captures whose render never returned. Runs before each new capture. */
export const sweepExpiredDocumentCaptures = Effect.fn("DocumentCapture.sweepExpired")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* capturesRoot;
  const now = yield* Clock.currentTimeMillis;
  const entries = yield* fileSystem.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(
    entries.filter((entry) => isCaptureId(entry)),
    (entry) =>
      Effect.gen(function* () {
        const directory = path.join(root, entry);
        const record = yield* fileSystem
          .readFileString(path.join(directory, CAPTURE_RECORD_FILE))
          .pipe(Effect.flatMap(decodeRecord), Effect.option);
        if (Option.isSome(record) && record.value.expiresAtEpochMs > now) return;
        // A capture without a readable record is only removed once it is old
        // enough that it cannot be one still being written.
        if (Option.isNone(record)) {
          const info = yield* fileSystem.stat(directory).pipe(Effect.option);
          const modified = Option.flatMap(info, (value) => value.mtime);
          if (Option.isSome(modified) && modified.value.getTime() > now - CAPTURE_TTL_MS) return;
        }
        yield* fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore);
      }),
    { discard: true },
  );
});

/**
 * Writes one bundle as a complete capture and issues the short-lived URL the
 * document page reads it from. Only assets the Markdown refers to are copied.
 */
export const writeDocumentCapture = Effect.fn("DocumentCapture.write")(function* (
  input: WriteDocumentCaptureInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { bundle } = input;
  const sourceDigest = bundleSourceDigest(bundle);
  if (sourceDigest === null) {
    return yield* new ScientDocumentPdfExportError({
      reason: "invalid-source",
      detail: "The document has no verifiable content digest.",
    });
  }
  if (bundle.markdown.length > SCIENT_DOCUMENT_MAX_MARKDOWN_LENGTH) {
    return yield* new ScientDocumentPdfExportError({
      reason: "too-large",
      detail: "The document is too large to export as one PDF. Export a shorter range.",
    });
  }
  yield* sweepExpiredDocumentCaptures();
  const captureId = ScientDocumentCaptureId.make(NodeCrypto.randomUUID());
  const directory = path.join(yield* capturesRoot, captureId);
  const createdAtEpochMs = yield* Clock.currentTimeMillis;
  const expected = {
    captureId,
    documentKind: bundle.metadata.source._tag,
    sourceDigest,
  } satisfies ScientDocumentPageExpectation;
  const referenced = referencedDocumentAssetIds(bundle.markdown);
  const warnings = [...bundle.warnings];
  const assets: ScientDocumentPageAsset[] = [];
  const pending: Array<{ readonly path: string; readonly bytes: Uint8Array }> = [];
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
    // Only images are displayed; other attachments print as labelled names.
    if (asset.role === "attachment" || extension === undefined) {
      assets.push({ ...base, content: { _tag: "unavailable", reason: "unsupported" } });
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
    const relativePath = `assets/${String(pending.length + 1).padStart(4, "0")}.${extension}`;
    pending.push({ path: relativePath, bytes: asset.content.bytes });
    assets.push({ ...base, content: { _tag: "captured", path: relativePath } });
  }
  const record: DocumentCaptureRecord = {
    version: 1,
    expected,
    title: bundle.metadata.title.slice(0, 512),
    logicalDocumentKey: input.logicalDocumentKey,
    source: input.source,
    warnings: warnings.slice(0, SCIENT_DOCUMENT_MAX_WARNINGS),
    createdAtEpochMs,
    expiresAtEpochMs: createdAtEpochMs + CAPTURE_TTL_MS,
  };
  const pageInput: ScientDocumentPageInput = {
    protocol: SCIENT_DOCUMENT_PAGE_PROTOCOL,
    captureId,
    documentKind: expected.documentKind,
    sourceDigest,
    profile: bundle.profile,
    title: record.title,
    language: bundle.metadata.language?.slice(0, 35) ?? null,
    direction: bundle.metadata.direction,
    createdAt: bundle.metadata.createdAt,
    markdown: bundle.markdown,
    assets,
    warnings: record.warnings,
  };

  yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(path.join(directory, "assets"), { recursive: true });
    for (const file of pending) {
      yield* fileSystem.writeFile(path.join(directory, file.path), file.bytes);
    }
    yield* fileSystem.writeFileString(
      path.join(directory, SCIENT_DOCUMENT_CAPTURE_INPUT_FILE),
      yield* encodeInput(pageInput),
    );
    yield* fileSystem.writeFileString(
      path.join(directory, SCIENT_DOCUMENT_CAPTURE_ENTRY_FILE),
      CAPTURE_ENTRY_HTML,
    );
    // The record is written last: a capture without one is incomplete.
    yield* fileSystem.writeFileString(
      path.join(directory, CAPTURE_RECORD_FILE),
      yield* encodeRecord(record),
    );
  }).pipe(
    Effect.tapError(() => fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore)),
    Effect.mapError(() => storageError("Scient could not prepare the document for export.")),
  );

  const issued = yield* issueAssetUrl({
    resource: {
      _tag: "environment-file",
      path: EnvironmentFilePath.make(path.join(directory, SCIENT_DOCUMENT_CAPTURE_ENTRY_FILE)),
      access: "html-document",
    },
    expiresInMs: CAPTURE_URL_TTL_MS,
  }).pipe(
    Effect.tapError(() => fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore)),
    Effect.mapError(() => storageError("Scient could not authorize the captured document.")),
  );
  const entrySuffix = `/${SCIENT_DOCUMENT_CAPTURE_ENTRY_FILE}`;
  if (!issued.relativeUrl.endsWith(entrySuffix)) {
    yield* fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore);
    return yield* storageError("Scient could not authorize the captured document.");
  }
  const inputRelativeUrl = `${issued.relativeUrl.slice(0, -entrySuffix.length)}/${SCIENT_DOCUMENT_CAPTURE_INPUT_FILE}`;
  return { record, inputRelativeUrl } satisfies WrittenDocumentCapture;
});

/** Reads a live capture's record. An unknown or expired capture cannot be published. */
export const readDocumentCapture = Effect.fn("DocumentCapture.read")(function* (
  captureId: ScientDocumentCaptureId,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* captureDirectory(captureId);
  const expired = new ScientDocumentPdfExportError({
    reason: "capture-expired",
    detail: "This export is no longer available. Export the document again.",
  });
  const record = yield* fileSystem.readFileString(path.join(directory, CAPTURE_RECORD_FILE)).pipe(
    Effect.flatMap(decodeRecord),
    Effect.mapError(() => expired),
  );
  if (record.expected.captureId !== captureId) return yield* expired;
  if (record.expiresAtEpochMs <= (yield* Clock.currentTimeMillis)) {
    yield* fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore);
    return yield* expired;
  }
  return record;
});

export const removeDocumentCapture = Effect.fn("DocumentCapture.remove")(function* (
  captureId: ScientDocumentCaptureId,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem
    .remove(yield* captureDirectory(captureId), { recursive: true })
    .pipe(Effect.ignore);
});
