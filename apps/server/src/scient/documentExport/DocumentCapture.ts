// @effect-diagnostics nodeBuiltinImport:off -- Capture identity and content hashing stay server-owned.
import { LogicalDocumentKey } from "@scientfactory/document-artifacts";
import {
  DocumentWarning,
  EnvironmentFilePath,
  SCIENT_DOCUMENT_CAPTURE_ENTRY_FILE,
  SCIENT_DOCUMENT_CAPTURE_INPUT_FILE,
  SCIENT_DOCUMENT_MAX_MARKDOWN_LENGTH,
  ScientDocumentCaptureId,
  ScientDocumentPageExpectation,
  ScientDocumentPageInput,
  ScientDocumentPdfExportError,
  Sha256Digest,
  type DocumentBundle,
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
import { buildDocumentPageCapture, bundleSourceDigest } from "./documentPageInput.ts";

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
const CAPTURE_ENTRY_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Scient document capture</title></head><body></body></html>\n';

export const sha256Digest = (bytes: Uint8Array): Sha256Digest =>
  Sha256Digest.make(`sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`);

export const documentLogicalKey = (kind: "markdown-pdf" | "conversation-pdf", identity: string) =>
  LogicalDocumentKey.make(
    `${kind}:${NodeCrypto.createHash("sha256").update(identity).digest("hex")}`,
  );

/** What publication re-checks before accepting a render of this capture. */
export const CapturedDocumentSource = Schema.Union([
  /**
   * A project file. Publication resolves the requested path again and requires
   * the same canonical file with the captured digest.
   */
  Schema.TaggedStruct("workspace-file", {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    canonicalPath: Schema.String,
  }),
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
  const {
    pageInput,
    files: pending,
    warnings,
  } = buildDocumentPageCapture({
    bundle,
    captureId,
    sourceDigest,
  });
  const record: DocumentCaptureRecord = {
    version: 1,
    expected: {
      captureId,
      documentKind: pageInput.documentKind,
      sourceDigest,
    },
    title: pageInput.title,
    logicalDocumentKey: input.logicalDocumentKey,
    source: input.source,
    warnings,
    createdAtEpochMs,
    expiresAtEpochMs: createdAtEpochMs + CAPTURE_TTL_MS,
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
