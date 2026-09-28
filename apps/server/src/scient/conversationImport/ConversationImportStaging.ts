// @effect-diagnostics nodeBuiltinImport:off -- uploads and attachment copies stream through Node files with hashing.
/**
 * The import staging area: receives `.scic` uploads, validates them, serves
 * previews, runs confirm and cancel, and removes what it staged. It
 * implements the staging side of `ConversationImporter.ts`, whose header is
 * the contract (areas, lease, attempts and receipts, completions).
 *
 * Staging writes only under `<stateDir>/conversation-imports/`: it creates no
 * thread, copies nothing into a thread's attachments, and starts no provider.
 * Only a confirmed import reaches the importer.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import { waitForWritableDrain } from "../conversationFile/waitForWritableDrain.ts";

import {
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  ConversationImportId,
  SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES,
  SCIENT_CONVERSATION_IMPORT_UPLOAD_PATH,
  ScientConversationImportError,
  type ConversationImportRejection,
  type EnvironmentSessionPrincipalShape,
  type ScientConversationImportCancelResult,
  type ScientConversationImportConfirmRequest,
  type ScientConversationImportCreateUploadRequest,
  type ScientConversationImportPreview,
  type ScientConversationImportResult,
  type ScientConversationImportUpload,
  type Sha256Digest,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../../auth/utils.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  inspectScicExpandedBytes,
  readScicPackage,
  stagedAttachmentFile,
} from "../conversationFile/ScicReader.ts";
import {
  MARKDOWN_IMPORT_MAX_BYTES,
  readMarkdownConversation,
  type MarkdownReadResult,
} from "./MarkdownConversationReader.ts";
import {
  CONVERSATION_IMPORT_COMPLETION_RETENTION_MS,
  CONVERSATION_IMPORT_MAX_LIVE,
  CONVERSATION_IMPORT_STAGING_DIRECTORY,
  CONVERSATION_IMPORT_STAGING_QUOTA_BYTES,
  CONVERSATION_IMPORT_STAGING_TTL_MS,
  ConversationImportCompletion,
  ConversationImporter,
  ConversationImporterError,
  ConversationImportStagingError,
  sameConversationImportDestination,
  type AbandonedConversationImportAttempt,
  type ConversationImportAttemptBinding,
  type ConversationImportLease,
  type ValidatedConversationImport,
} from "./ConversationImporter.ts";

export const CONVERSATION_IMPORT_UPLOAD_ROUTE_PREFIX = SCIENT_CONVERSATION_IMPORT_UPLOAD_PATH;
const SIGNING_SECRET_NAME = "asset-access-signing-key";
const COMPLETIONS_DIRECTORY = "completions";
const PACKAGE_FILE = "package.scic";
const ATTEMPT_DIRECTORY = "attempt";
const ATTACHMENTS_DIRECTORY = "attachments";
const SWEEP_INTERVAL_MS = 60_000;

/** Failures the client cannot act on; the HTTP layer reports them as internal errors. */
export class ConversationImportStagingFailure extends Schema.TaggedError<ConversationImportStagingFailure>()(
  "ConversationImportStagingFailure",
  { detail: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return this.detail;
  }
}

export type ConversationImportStagingServiceError =
  | ScientConversationImportError
  | ConversationImportStagingFailure;

const UploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("conversation-import-upload"),
  importId: ConversationImportId,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
export type ConversationImportUploadClaims = typeof UploadClaims.Type;
const uploadClaimsJson = Schema.fromJsonString(UploadClaims);
const decodeUploadClaims = Schema.decodeUnknownOption(uploadClaimsJson);
const encodeUploadClaims = Schema.encodeSync(uploadClaimsJson);

const completionJson = Schema.fromJsonString(ConversationImportCompletion);
const decodeCompletion = Schema.decodeUnknownOption(completionJson);
const encodeCompletion = Schema.encodeSync(completionJson);
const isImportId = Schema.is(ConversationImportId);

export type ConversationImportUploadResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly detail: string };

type ImportOutcome =
  | { readonly _tag: "committed"; readonly completion: ConversationImportCompletion }
  | { readonly _tag: "cancelled" }
  | {
      readonly _tag: "failed";
      readonly reason: ScientConversationImportError["reason"];
      readonly detail: string;
    }
  | { readonly _tag: "unsettled" };

type Phase =
  | { readonly _tag: "awaiting-upload"; readonly uploadExpiresAt: number }
  | { readonly _tag: "uploading" }
  | {
      readonly _tag: "uploaded";
      readonly packageSha256: Sha256Digest;
      readonly packageBytes: number;
    }
  | {
      readonly _tag: "validating";
      readonly fiber: Fiber.Fiber<void>;
      readonly result: Deferred.Deferred<
        ValidatedConversationImport,
        ConversationImportStagingServiceError
      >;
    }
  | { readonly _tag: "ready"; readonly validated: ValidatedConversationImport }
  | {
      readonly _tag: "importing";
      readonly validated: ValidatedConversationImport;
      readonly binding: ConversationImportAttemptBinding;
      readonly attempt: Fiber.Fiber<ConversationImportCompletion, ConversationImporterError>;
      readonly outcome: Deferred.Deferred<ImportOutcome>;
    }
  /** The import committed, but its completion is not yet recorded. */
  | { readonly _tag: "committed"; readonly completion: ConversationImportCompletion }
  /** An attempt that must be settled before the area can go. */
  | { readonly _tag: "abandoned" }
  | { readonly _tag: "removing" };

interface ImportRecord {
  readonly importId: ConversationImportId;
  readonly directory: string;
  readonly fileName: string;
  readonly markdownMode: "messages" | "document";
  markdownPreview: Pick<MarkdownReadResult, "kind" | "issues"> | null;
  reservedBytes: number;
  touchedAt: number;
  cancelRequested: boolean;
  phase: Phase;
}

export interface ConversationImportStagingOptions {
  readonly ttlMs?: number;
  readonly quotaBytes?: number;
  readonly maxLive?: number;
  /** Run the expiry sweep on a timer. Tests call `sweep` directly. */
  readonly sweepOnTimer?: boolean;
}

export class ConversationImportStaging extends Context.Service<
  ConversationImportStaging,
  {
    readonly createUpload: (
      request: ScientConversationImportCreateUploadRequest,
    ) => Effect.Effect<ScientConversationImportUpload, ConversationImportStagingServiceError>;
    /** Claims from a valid signed upload token, or null. */
    readonly validateUploadToken: (
      token: string,
    ) => Effect.Effect<ConversationImportUploadClaims | null>;
    readonly receiveUpload: <E>(
      claims: ConversationImportUploadClaims,
      body: Stream.Stream<Uint8Array, E>,
    ) => Effect.Effect<ConversationImportUploadResult>;
    readonly preview: (
      importId: ConversationImportId,
    ) => Effect.Effect<ScientConversationImportPreview, ConversationImportStagingServiceError>;
    readonly confirm: (
      request: ScientConversationImportConfirmRequest,
      principal: EnvironmentSessionPrincipalShape,
    ) => Effect.Effect<ScientConversationImportResult, ConversationImportStagingServiceError>;
    readonly cancel: (
      importId: ConversationImportId,
    ) => Effect.Effect<ScientConversationImportCancelResult, ConversationImportStagingServiceError>;
    /** Removes expired areas and completions, and retries unfinished settlements. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/scient/conversationImport/ConversationImportStaging") {}

const importError = (
  reason: ScientConversationImportError["reason"],
  message: string,
  rejection: ConversationImportRejection | null = null,
) => new ScientConversationImportError({ reason, rejection, message });

/** What the user reads for each rejection: plain, short, and free of codes or paths. */
const REJECTION_MESSAGES: Record<ConversationImportRejection["reason"], string> = {
  "corrupt-archive": "This file is damaged and cannot be opened.",
  "mimetype-invalid": "This is not a Scient conversation file.",
  "unsafe-path": "This file contains a file name Scient does not accept.",
  "special-entry": "This file contains a link or folder Scient does not accept.",
  "duplicate-path": "This file contains the same item twice.",
  "encrypted-entry": "This file is encrypted. Scient cannot import encrypted files.",
  "too-many-entries": "This file contains too many items to import.",
  "entry-too-large": "Part of this file is too large to import.",
  "package-too-large": "This file is too large to import.",
  "compression-ratio": "This file is compressed in a way Scient does not accept.",
  "manifest-invalid": "This file's list of contents is damaged.",
  "unsupported-version": "This file was made by a newer Scient. Update Scient to import it.",
  "manifest-mismatch": "This file was changed or damaged after it was exported.",
  "undeclared-entry": "This file contains content Scient did not expect.",
  "snapshot-invalid": "The conversation in this file is damaged or was edited.",
  "attachment-type-mismatch": "An attachment in this file is not the type it claims to be.",
  "attachment-policy": "An attachment in this file is a type or size Scient does not accept.",
};

function directoryIsEmpty(directory: string): boolean {
  try {
    return NodeFS.readdirSync(directory).length === 0;
  } catch {
    return true;
  }
}

async function sha256File(
  path: string,
  signal?: AbortSignal,
): Promise<{ sha256: string; byteLength: number }> {
  const hash = NodeCrypto.createHash("sha256");
  let byteLength = 0;
  for await (const chunk of NodeFS.createReadStream(path, { signal }) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    byteLength += chunk.byteLength;
  }
  return { sha256: `sha256:${hash.digest("hex")}`, byteLength };
}

/** Copies `source` to `destination` through a temporary file, verifying it on the way. */
async function copyVerified(
  input: {
    readonly source: string;
    readonly destination: string;
    readonly sha256: Sha256Digest;
    readonly byteLength: number;
  },
  signal: AbortSignal,
): Promise<"copied" | "present" | "corrupt" | "conflict"> {
  if (signal.aborted) throw new Error("Attachment copy was interrupted.");
  const existing = await NodeFS.promises.stat(input.destination).catch(() => null);
  if (existing !== null) {
    const present = await sha256File(input.destination, signal);
    return present.sha256 === input.sha256 && present.byteLength === input.byteLength
      ? "present"
      : "conflict";
  }
  await NodeFS.promises.mkdir(NodePath.dirname(input.destination), { recursive: true });
  const temporary = `${input.destination}.${NodeCrypto.randomUUID()}.part`;
  const hash = NodeCrypto.createHash("sha256");
  let byteLength = 0;
  const sink = NodeFS.createWriteStream(temporary, { flags: "wx" });
  const source = NodeFS.createReadStream(input.source, { signal });
  source.on("error", () => {});
  let sinkError: Error | null = null;
  sink.on("error", (error: Error) => {
    sinkError = error;
    source.destroy(error);
  });
  const sinkFinished = NodeStreamPromises.finished(sink);
  void sinkFinished.catch(() => {});
  const sinkClosed = new Promise<void>((resolve) => sink.once("close", resolve));
  const abort = () => {
    const error = new Error("Attachment copy was interrupted.");
    source.destroy(error);
    sink.destroy(error);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      hash.update(chunk);
      byteLength += chunk.byteLength;
      if (!sink.write(chunk)) {
        if (sinkError !== null) throw sinkError;
        await waitForWritableDrain(sink);
      }
    }
    if (signal.aborted) throw new Error("Attachment copy was interrupted.");
    if (sinkError !== null) throw sinkError;
    sink.end();
    await sinkFinished;
    if (`sha256:${hash.digest("hex")}` !== input.sha256 || byteLength !== input.byteLength) {
      return "corrupt";
    }
    if (signal.aborted) throw new Error("Attachment copy was interrupted.");
    await NodeFS.promises.rename(temporary, input.destination);
    return "copied";
  } finally {
    signal.removeEventListener("abort", abort);
    source.destroy();
    if (!sink.closed) sink.destroy();
    await sinkClosed;
    await NodeFS.promises.rm(temporary, { force: true });
  }
}

export const make = (options: ConversationImportStagingOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const importer = yield* ConversationImporter;
    const scope = yield* Effect.scope;
    const ttlMs = options.ttlMs ?? CONVERSATION_IMPORT_STAGING_TTL_MS;
    const quotaBytes = options.quotaBytes ?? CONVERSATION_IMPORT_STAGING_QUOTA_BYTES;
    const maxLive = options.maxLive ?? CONVERSATION_IMPORT_MAX_LIVE;
    const root = NodePath.join(config.stateDir, "scient", CONVERSATION_IMPORT_STAGING_DIRECTORY);
    const completionsRoot = NodePath.join(root, COMPLETIONS_DIRECTORY);
    const records = new Map<ConversationImportId, ImportRecord>();
    const completions = new Map<ConversationImportId, ConversationImportCompletion>();
    const lock = yield* Semaphore.make(1);
    const locked = lock.withPermits(1);

    const failure = (detail: string) => (cause: unknown) =>
      new ConversationImportStagingFailure({ detail, cause });
    const now = Clock.currentTimeMillis;
    const attemptDirectory = (record: ImportRecord) =>
      NodePath.join(record.directory, ATTEMPT_DIRECTORY);
    const attachmentsDirectory = (record: ImportRecord) =>
      NodePath.join(record.directory, ATTACHMENTS_DIRECTORY);
    const completionPath = (importId: ConversationImportId) =>
      NodePath.join(completionsRoot, `${importId}.json`);

    const removeDirectory = (directory: string) =>
      fileSystem
        .remove(directory, { recursive: true, force: true })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not remove a conversation import staging area.", { cause }),
          ),
        );

    const removeArea = (record: ImportRecord) =>
      Effect.gen(function* () {
        record.phase = { _tag: "removing" };
        yield* removeDirectory(record.directory);
        yield* locked(Effect.sync(() => records.delete(record.importId)));
      });

    // ---------------------------------------------------------------------
    // Completions
    // ---------------------------------------------------------------------

    const isCurrent = (completion: ConversationImportCompletion, at: number) =>
      DateTime.toEpochMillis(DateTime.makeUnsafe(completion.completedAt)) +
        CONVERSATION_IMPORT_COMPLETION_RETENTION_MS >
      at;

    const persistCompletion = (completion: ConversationImportCompletion) =>
      writeFileStringAtomically({
        filePath: completionPath(completion.result.importId),
        contents: encodeCompletion(completion),
        durable: true,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => completions.set(completion.result.importId, completion)),
        ),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

    const lookupCompletion = (importId: ConversationImportId) =>
      Effect.gen(function* () {
        const at = yield* now;
        const cached = completions.get(importId);
        if (cached) return isCurrent(cached, at) ? Option.some(cached) : Option.none();
        const text = yield* fileSystem.readFileString(completionPath(importId)).pipe(Effect.option);
        if (Option.isNone(text)) return Option.none();
        const completion = decodeCompletion(text.value);
        if (Option.isSome(completion) && isCurrent(completion.value, at)) {
          completions.set(importId, completion.value);
          return completion;
        }
        return Option.none();
      });

    /** Records the commit durably, then removes the area; on failure keeps both for the sweep. */
    const commit = (record: ImportRecord, completion: ConversationImportCompletion) =>
      persistCompletion(completion).pipe(
        Effect.flatMap(() => removeArea(record)),
        Effect.catch((cause) =>
          Effect.logWarning("Could not record a committed conversation import yet.", {
            cause,
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                record.phase = { _tag: "committed", completion };
              }),
            ),
          ),
        ),
      );

    // ---------------------------------------------------------------------
    // Settling abandoned attempts
    // ---------------------------------------------------------------------

    /** Settles the attempt (if any) and removes the area; an unsettled attempt keeps it. */
    const settleAndRemove = (
      record: ImportRecord,
      reason: AbandonedConversationImportAttempt["reason"],
    ): Effect.Effect<"committed" | "removed" | "unsettled"> =>
      Effect.gen(function* () {
        const directory = attemptDirectory(record);
        if (!directoryIsEmpty(directory)) {
          const settled = yield* Effect.result(
            importer.settleAttempt({
              importId: record.importId,
              attemptDirectory: directory,
              reason,
            }),
          );
          if (settled._tag === "Failure") {
            yield* Effect.logWarning("Could not settle a conversation import attempt.", {
              importId: record.importId,
              cause: settled.failure,
            });
            record.phase = { _tag: "abandoned" };
            return "unsettled" as const;
          }
          if (settled.success._tag === "committed") {
            yield* commit(record, settled.success.completion);
            return "committed" as const;
          }
        }
        yield* removeArea(record);
        return "removed" as const;
      });

    // ---------------------------------------------------------------------
    // Startup: every area left from an earlier run is abandoned.
    // ---------------------------------------------------------------------

    yield* fileSystem.makeDirectory(completionsRoot, { recursive: true }).pipe(Effect.orDie);
    const startedAt = yield* now;
    for (const name of yield* fileSystem.readDirectory(root).pipe(Effect.orDie)) {
      if (name === COMPLETIONS_DIRECTORY) continue;
      const directory = NodePath.join(root, name);
      if (!isImportId(name)) {
        yield* removeDirectory(directory);
        continue;
      }
      const record: ImportRecord = {
        importId: name,
        directory,
        fileName: PACKAGE_FILE,
        markdownMode: "messages",
        markdownPreview: null,
        reservedBytes: 0,
        touchedAt: startedAt,
        cancelRequested: true,
        phase: { _tag: "abandoned" },
      };
      records.set(name, record);
      yield* settleAndRemove(record, "startup");
    }
    for (const name of yield* fileSystem.readDirectory(completionsRoot).pipe(Effect.orDie)) {
      const importId = name.replace(/\.json$/u, "");
      if (!isImportId(importId)) {
        yield* removeDirectory(NodePath.join(completionsRoot, name));
        continue;
      }
      completions.delete(importId);
      if (Option.isNone(yield* lookupCompletion(importId))) {
        yield* removeDirectory(NodePath.join(completionsRoot, name));
      }
    }

    // ---------------------------------------------------------------------
    // Upload
    // ---------------------------------------------------------------------

    const signingSecret = secrets.getOrCreateRandom(SIGNING_SECRET_NAME, 32);

    const createUpload: ConversationImportStaging["Service"]["createUpload"] = Effect.fn(
      "ConversationImportStaging.createUpload",
    )(function* (request) {
      if (/[/\\]/u.test(request.fileName)) {
        return yield* importError("package-rejected", "Choose a file with a valid name.");
      }
      const isMarkdown = /\.md$/iu.test(request.fileName);
      if (!isMarkdown && !/\.scic$/iu.test(request.fileName)) {
        return yield* importError("package-rejected", "Choose a .scic or .md file.");
      }
      if (!isMarkdown && request.markdownMode !== undefined) {
        return yield* importError("package-rejected", "Markdown mode only applies to .md files.");
      }
      if (isMarkdown && request.sizeBytes > MARKDOWN_IMPORT_MAX_BYTES) {
        return yield* importError("package-too-large", "This Markdown file is too large.");
      }
      if (request.sizeBytes > SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES) {
        return yield* importError("package-too-large", "This file is larger than Scient imports.");
      }
      const secret = yield* signingSecret.pipe(
        Effect.mapError(failure("Could not load the upload signing key.")),
      );
      const importId = `cimp_${NodeCrypto.randomUUID()}` as ConversationImportId;
      const at = yield* now;
      const expiresAt = at + ATTACHMENT_UPLOAD_URL_TTL_MS;
      const directory = NodePath.join(root, importId);
      yield* locked(
        Effect.gen(function* () {
          if (records.size >= maxLive) {
            return yield* importError(
              "staging-full",
              "Too many imports are waiting. Finish or cancel one, then try again.",
            );
          }
          const reserved = [...records.values()].reduce(
            (total, record) => total + record.reservedBytes,
            0,
          );
          if (reserved + request.sizeBytes > quotaBytes) {
            return yield* importError(
              "staging-full",
              "There is not enough room for this import right now. Try again later.",
            );
          }
          yield* fileSystem
            .makeDirectory(NodePath.join(directory, ATTEMPT_DIRECTORY), { recursive: true })
            .pipe(Effect.mapError(failure("Could not create the import staging area.")));
          yield* fileSystem
            .makeDirectory(NodePath.join(directory, ATTACHMENTS_DIRECTORY), { recursive: true })
            .pipe(Effect.mapError(failure("Could not create the import staging area.")));
          records.set(importId, {
            importId,
            directory,
            fileName: request.fileName,
            markdownMode: request.markdownMode ?? "messages",
            markdownPreview: null,
            reservedBytes: request.sizeBytes,
            touchedAt: at,
            cancelRequested: false,
            phase: { _tag: "awaiting-upload", uploadExpiresAt: expiresAt },
          });
        }),
      );
      const payload = base64UrlEncode(
        encodeUploadClaims({
          version: 1,
          kind: "conversation-import-upload",
          importId,
          sizeBytes: request.sizeBytes,
          expiresAt,
        }),
      );
      return {
        importId,
        relativeUrl: `${CONVERSATION_IMPORT_UPLOAD_ROUTE_PREFIX}/${payload}.${signPayload(payload, secret)}`,
        expiresAt,
      };
    });

    const validateUploadToken: ConversationImportStaging["Service"]["validateUploadToken"] = (
      token,
    ) =>
      Effect.gen(function* () {
        const [payload, signature, unexpected] = token.split(".");
        if (!payload || !signature || unexpected !== undefined) return null;
        const secret = yield* signingSecret.pipe(Effect.orElseSucceed(() => null));
        if (!secret || !timingSafeEqualBase64Url(signature, signPayload(payload, secret))) {
          return null;
        }
        let decoded: Option.Option<ConversationImportUploadClaims>;
        try {
          decoded = decodeUploadClaims(base64UrlDecodeUtf8(payload));
        } catch {
          return null;
        }
        if (Option.isNone(decoded) || decoded.value.expiresAt <= (yield* now)) return null;
        return decoded.value;
      });

    const receiveUpload: ConversationImportStaging["Service"]["receiveUpload"] = Effect.fn(
      "ConversationImportStaging.receiveUpload",
    )(function* (claims, body) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const uploading = { _tag: "uploading" } as const;
          const record = yield* locked(
            Effect.sync(() => {
              const found = records.get(claims.importId);
              // Single use: only an import still waiting for its bytes accepts them.
              if (
                !found ||
                found.cancelRequested ||
                found.phase._tag !== "awaiting-upload" ||
                found.reservedBytes !== claims.sizeBytes
              ) {
                return null;
              }
              found.phase = uploading;
              return found;
            }),
          );
          if (record === null) {
            return {
              ok: false,
              status: 409,
              detail: "This upload is no longer accepted.",
            } as const;
          }
          return yield* restore(
            Effect.gen(function* () {
              const target = NodePath.join(record.directory, PACKAGE_FILE);
              const part = `${target}.${NodeCrypto.randomUUID()}.part`;
              const hash = NodeCrypto.createHash("sha256");
              let received = 0;
              const stored = yield* Stream.run(
                body.pipe(
                  Stream.takeWhile((chunk) => {
                    received += chunk.byteLength;
                    return received <= claims.sizeBytes;
                  }),
                  Stream.tap((chunk) => Effect.sync(() => hash.update(chunk))),
                ),
                fileSystem.sink(part),
              ).pipe(
                Effect.flatMap(() =>
                  received === claims.sizeBytes
                    ? fileSystem.rename(part, target).pipe(Effect.as(true))
                    : Effect.succeed(false),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("A conversation import upload failed.", { cause }).pipe(
                    Effect.as(false),
                  ),
                ),
                Effect.timeoutOption(ATTACHMENT_UPLOAD_URL_TTL_MS),
                Effect.map(Option.getOrElse(() => false)),
                Effect.ensuring(fileSystem.remove(part, { force: true }).pipe(Effect.ignore)),
              );
              const at = yield* now;
              const accepted = yield* locked(
                Effect.sync(() => {
                  if (
                    !stored ||
                    record.cancelRequested ||
                    records.get(record.importId) !== record
                  ) {
                    return false;
                  }
                  record.phase = {
                    _tag: "uploaded",
                    packageSha256: `sha256:${hash.digest("hex")}`,
                    packageBytes: received,
                  };
                  record.touchedAt = at;
                  return true;
                }),
              );
              if (accepted) return { ok: true } as const;
              // A failed or cancelled upload ends the import; the client starts again.
              return stored
                ? ({ ok: false, status: 409, detail: "This import was cancelled." } as const)
                : ({
                    ok: false,
                    status: 400,
                    detail: `The upload must be exactly ${claims.sizeBytes} bytes.`,
                  } as const);
            }),
          ).pipe(
            Effect.ensuring(
              locked(
                Effect.sync(() => {
                  if (records.get(record.importId) !== record || record.phase !== uploading) {
                    return false;
                  }
                  record.phase = { _tag: "removing" };
                  return true;
                }),
              ).pipe(Effect.flatMap((owned) => (owned ? removeArea(record) : Effect.void))),
            ),
          );
        }),
      );
    });

    // ---------------------------------------------------------------------
    // Validation and preview
    // ---------------------------------------------------------------------

    const validate = (
      record: ImportRecord,
      uploaded: Extract<Phase, { _tag: "uploaded" }>,
      result: Deferred.Deferred<ValidatedConversationImport, ConversationImportStagingServiceError>,
    ) =>
      Effect.gen(function* () {
        const packagePath = NodePath.join(record.directory, PACKAGE_FILE);
        const read = yield* Effect.exit(
          Effect.gen(function* () {
            if (/\.md$/iu.test(record.fileName))
              return yield* Effect.try({
                try: () =>
                  readMarkdownConversation({
                    importId: record.importId,
                    path: packagePath,
                    fileName: record.fileName,
                    packageSha256: uploaded.packageSha256,
                    packageBytes: uploaded.packageBytes,
                    attachmentsDirectory: attachmentsDirectory(record),
                    mode: record.markdownMode,
                    receivedAt: DateTime.formatIso(DateTime.makeUnsafe(record.touchedAt)),
                  }),
                catch: (cause) =>
                  new ConversationImportStagingFailure({
                    detail: "The Markdown file could not be read.",
                    cause,
                  }),
              });
            // Reserve the central directory's declared expansion before any
            // member is extracted. Keep the compressed package reservation
            // until the package is removed after successful validation.
            const expandedBytes = yield* inspectScicExpandedBytes(packagePath);
            yield* locked(
              Effect.gen(function* () {
                if (record.cancelRequested || records.get(record.importId) !== record) {
                  return yield* importError("import-not-found", "This import was cancelled.");
                }
                const others = [...records.values()]
                  .filter((other) => other !== record)
                  .reduce((total, other) => total + other.reservedBytes, 0);
                const reservedBytes = uploaded.packageBytes + expandedBytes;
                if (others + reservedBytes > quotaBytes) {
                  return yield* importError(
                    "staging-full",
                    "There is not enough room for this import right now. Try again later.",
                  );
                }
                record.reservedBytes = reservedBytes;
              }),
            );
            const validated = yield* readScicPackage({
              importId: record.importId,
              packagePath,
              packageSha256: uploaded.packageSha256,
              packageBytes: uploaded.packageBytes,
              attachmentsDirectory: attachmentsDirectory(record),
              maxExpandedBytes: expandedBytes,
            });
            return { validated, kind: "scic" as const, issues: [] };
          }),
        );
        if (Exit.isSuccess(read)) {
          // The package is no longer needed; staged attachments are what remain.
          yield* fileSystem
            .remove(NodePath.join(record.directory, PACKAGE_FILE), { force: true })
            .pipe(Effect.ignore);
        }
        const at = yield* now;
        const failed = yield* locked(
          Effect.gen(function* () {
            if (record.cancelRequested || records.get(record.importId) !== record) return null;
            if (Exit.isSuccess(read)) {
              const staged = new Map(
                read.value.validated.attachments.map((attachment) => [
                  attachment.sha256,
                  attachment.byteLength,
                ]),
              );
              const stagedBytes = [...staged.values()].reduce((total, bytes) => total + bytes, 0);
              const others = [...records.values()]
                .filter((other) => other !== record)
                .reduce((total, other) => total + other.reservedBytes, 0);
              if (others + stagedBytes > quotaBytes) {
                return importError(
                  "staging-full",
                  "There is not enough room for this import right now. Try again later.",
                );
              }
              record.reservedBytes = stagedBytes;
              record.touchedAt = at;
              record.markdownPreview =
                read.value.kind === "scic"
                  ? null
                  : {
                      kind: read.value.kind,
                      issues: read.value.issues,
                    };
              record.phase = { _tag: "ready", validated: read.value.validated };
              yield* Deferred.succeed(result, read.value.validated);
              return null;
            }
            const cause = read.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
            if (cause?._tag === "ScicRejection") {
              const rejection = { reason: cause.reason, entry: cause.entry };
              return importError("package-rejected", REJECTION_MESSAGES[cause.reason], rejection);
            }
            if (cause?._tag === "ScientConversationImportError") return cause;
            return new ConversationImportStagingFailure({
              detail: "The file could not be read.",
              cause: read.cause,
            });
          }),
        );
        if (failed !== null) {
          yield* removeArea(record);
          yield* Deferred.fail(result, failed);
        }
      });

    const buildPreview = (
      record: ImportRecord,
      validated: ValidatedConversationImport,
    ): ScientConversationImportPreview => {
      const { snapshot } = validated;
      return {
        importId: record.importId,
        kind: record.markdownPreview?.kind ?? "scic",
        fileName: record.fileName,
        package: validated.package,
        conversation: snapshot.thread,
        counts: {
          messages: snapshot.messages.length,
          attachments: validated.attachments.length,
          reasoning: snapshot.reasoning.length,
          workLogEntries: snapshot.workLog.length,
          proposedPlans: snapshot.proposedPlans.length,
          questionAnswers: snapshot.questionAnswers.length,
        },
        omissions: validated.omissions,
        warnings: validated.warnings,
        markdownIssues: record.markdownPreview?.issues ?? [],
        expiresAt: record.touchedAt + ttlMs,
      };
    };

    /** Waits for (or starts) validation; the validated import once it is ready. */
    const validated = (
      importId: ConversationImportId,
    ): Effect.Effect<
      { readonly record: ImportRecord; readonly validated: ValidatedConversationImport },
      ConversationImportStagingServiceError
    > =>
      Effect.gen(function* () {
        const at = yield* now;
        const next = yield* locked(
          Effect.gen(function* () {
            const record = records.get(importId);
            if (!record || record.cancelRequested) {
              return yield* importError("import-not-found", "This import is no longer available.");
            }
            const phase = record.phase;
            switch (phase._tag) {
              case "awaiting-upload":
              case "uploading":
                return yield* importError(
                  "upload-incomplete",
                  "The file has not finished uploading.",
                );
              case "uploaded": {
                const result = yield* Deferred.make<
                  ValidatedConversationImport,
                  ConversationImportStagingServiceError
                >();
                const fiber = yield* Effect.forkIn(validate(record, phase, result), scope);
                record.phase = { _tag: "validating", fiber, result };
                return { _tag: "wait", result } as const;
              }
              case "validating":
                return { _tag: "wait", result: phase.result } as const;
              case "ready":
              case "importing":
                record.touchedAt = at;
                return { _tag: "ready", record, validated: phase.validated } as const;
              default:
                return yield* importError(
                  "import-not-found",
                  "This import is no longer available.",
                );
            }
          }),
        );
        if (next._tag === "ready") return { record: next.record, validated: next.validated };
        yield* Deferred.await(next.result);
        return yield* validated(importId);
      });

    const preview: ConversationImportStaging["Service"]["preview"] = Effect.fn(
      "ConversationImportStaging.preview",
    )(function* (importId) {
      const ready = yield* validated(importId);
      return buildPreview(ready.record, ready.validated);
    });

    // ---------------------------------------------------------------------
    // Confirm
    // ---------------------------------------------------------------------

    const makeLease = (
      record: ImportRecord,
      input: ValidatedConversationImport,
    ): ConversationImportLease => ({
      importId: record.importId,
      input,
      attemptDirectory: attemptDirectory(record),
      copyAttachment: ({ resourceId, destinationPath }) =>
        Effect.gen(function* () {
          const staged = input.attachments.find((item) => item.resourceId === resourceId);
          if (!staged) {
            return yield* new ConversationImportStagingError({
              reason: "attachment-not-staged",
              detail: `Attachment ${resourceId} is not staged for this import.`,
            });
          }
          let active: ReturnType<typeof copyVerified> | null = null;
          const copied = yield* Effect.acquireUseRelease(
            Effect.void,
            () =>
              Effect.tryPromise({
                try: (signal) => {
                  active = copyVerified(
                    {
                      source: stagedAttachmentFile(attachmentsDirectory(record), staged.sha256),
                      destination: destinationPath,
                      sha256: staged.sha256,
                      byteLength: staged.byteLength,
                    },
                    signal,
                  );
                  return active;
                },
                catch: () =>
                  new ConversationImportStagingError({
                    reason: "io-failed",
                    detail: `Attachment ${resourceId} could not be copied.`,
                  }),
              }),
            () =>
              Effect.promise(
                () =>
                  active?.then(
                    () => {},
                    () => {},
                  ) ?? Promise.resolve(),
              ),
          );
          if (copied === "corrupt") {
            return yield* new ConversationImportStagingError({
              reason: "attachment-corrupt",
              detail: `Staged attachment ${resourceId} no longer matches its digest.`,
            });
          }
          if (copied === "conflict") {
            return yield* new ConversationImportStagingError({
              reason: "destination-conflict",
              detail: `The destination for attachment ${resourceId} holds different bytes.`,
            });
          }
        }),
    });

    /** Decides a finished attempt by its exit and, if it was cancelled, its receipt. */
    const finishImport = (
      record: ImportRecord,
      exit: Exit.Exit<ConversationImportCompletion, ConversationImporterError>,
    ): Effect.Effect<ImportOutcome> =>
      Effect.gen(function* () {
        if (Exit.isSuccess(exit)) {
          yield* commit(record, exit.value);
          return { _tag: "committed", completion: exit.value } as const;
        }
        const reasons = exit.cause.reasons;
        const interrupted = reasons.some((reason) => reason._tag === "Interrupt");
        if (!record.cancelRequested && !interrupted) {
          const error = reasons.find((reason) => reason._tag === "Fail")?.error;
          const known = error?._tag === "ConversationImporterError" ? error : null;
          const at = yield* now;
          yield* locked(
            Effect.sync(() => {
              if (record.phase._tag === "importing") {
                record.phase = { _tag: "ready", validated: record.phase.validated };
                record.touchedAt = at;
              }
            }),
          );
          return {
            _tag: "failed",
            reason: known?.reason ?? "import-failed",
            detail: known?.detail ?? "The conversation could not be imported. Try again.",
          } as const;
        }
        const settled = yield* settleAndRemove(record, "cancelled");
        if (settled === "unsettled") return { _tag: "unsettled" } as const;
        const completion =
          record.phase._tag === "committed"
            ? record.phase.completion
            : completions.get(record.importId);
        return settled === "committed" && completion
          ? ({ _tag: "committed", completion } as const)
          : ({ _tag: "cancelled" } as const);
      });

    const answerFromCompletion = (
      completion: ConversationImportCompletion,
      request: ScientConversationImportConfirmRequest,
    ) =>
      completion.packageSha256 !== request.packageSha256
        ? Effect.fail(importError("package-changed", "This import was made from a different file."))
        : !sameConversationImportDestination(completion.result.destination, request.destination)
          ? Effect.fail(
              importError(
                "already-imported",
                "This conversation was already imported to another project or model.",
              ),
            )
          : Effect.succeed(completion.result);

    const confirm: ConversationImportStaging["Service"]["confirm"] = Effect.fn(
      "ConversationImportStaging.confirm",
    )(function* (request, principal) {
      const known = yield* locked(Effect.sync(() => records.get(request.importId)));
      if (!known) {
        const completion = yield* lookupCompletion(request.importId);
        if (Option.isSome(completion)) {
          return yield* answerFromCompletion(completion.value, request);
        }
        return yield* importError("import-not-found", "This import is no longer available.");
      }
      if (known.phase._tag === "committed") {
        return yield* answerFromCompletion(known.phase.completion, request);
      }
      // Validation must have finished; a confirm joins it if it is still running.
      yield* validated(request.importId);
      const at = yield* now;
      const outcome = yield* locked(
        Effect.gen(function* () {
          const record = records.get(request.importId);
          if (!record || record.cancelRequested) {
            return yield* importError("cancelled", "This import was cancelled.");
          }
          const phase = record.phase;
          if (phase._tag === "importing") {
            if (
              phase.binding.packageSha256 === request.packageSha256 &&
              sameConversationImportDestination(phase.binding.destination, request.destination)
            ) {
              return phase.outcome;
            }
            return yield* importError("import-busy", "This import is already running.");
          }
          if (phase._tag !== "ready") {
            return yield* importError(
              "import-busy",
              "This import is finishing. Try again shortly.",
            );
          }
          if (phase.validated.package.packageSha256 !== request.packageSha256) {
            return yield* importError(
              "package-changed",
              "The staged file is not the one that was previewed.",
            );
          }
          if (
            record.markdownPreview?.kind === "markdown" &&
            (phase.validated.snapshot.messages.length === 0 ||
              (record.markdownPreview.issues.length > 0 &&
                request.acknowledgeMarkdownIssues !== true))
          ) {
            return yield* importError(
              "package-rejected",
              phase.validated.snapshot.messages.length === 0
                ? "No valid messages were found. Import this file as a document instead."
                : "Review the damaged marker ranges and explicitly choose to import the clean messages.",
            );
          }
          const outcomeDeferred = yield* Deferred.make<ImportOutcome>();
          const attempt = yield* Effect.forkIn(
            importer.importConversation(makeLease(record, phase.validated), {
              destination: request.destination,
              principal,
            }),
            scope,
          );
          record.phase = {
            _tag: "importing",
            validated: phase.validated,
            binding: { packageSha256: request.packageSha256, destination: request.destination },
            attempt,
            outcome: outcomeDeferred,
          };
          record.touchedAt = at;
          yield* Effect.forkIn(
            Fiber.await(attempt).pipe(
              Effect.flatMap((exit) => finishImport(record, exit)),
              Effect.flatMap((result) => Deferred.succeed(outcomeDeferred, result)),
            ),
            scope,
          );
          return outcomeDeferred;
        }),
      );
      const result = yield* Deferred.await(outcome);
      switch (result._tag) {
        case "committed":
          return yield* answerFromCompletion(result.completion, request);
        case "cancelled":
          return yield* importError("cancelled", "The import was cancelled before it finished.");
        case "unsettled":
          return yield* importError(
            "import-failed",
            "The import was interrupted. Scient will finish cleaning up; try again later.",
          );
        case "failed":
          return yield* importError(result.reason, result.detail);
      }
    });

    // ---------------------------------------------------------------------
    // Cancel
    // ---------------------------------------------------------------------

    const cancel: ConversationImportStaging["Service"]["cancel"] = Effect.fn(
      "ConversationImportStaging.cancel",
    )(function* (importId) {
      const action = yield* locked(
        Effect.sync(() => {
          const record = records.get(importId);
          if (!record) return { _tag: "absent" } as const;
          if (record.phase._tag === "committed") {
            return { _tag: "committed", completion: record.phase.completion } as const;
          }
          if (record.phase._tag === "removing") return { _tag: "gone" } as const;
          record.cancelRequested = true;
          return { _tag: "cancel", record, phase: record.phase } as const;
        }),
      );
      if (action._tag === "absent") {
        const completion = yield* lookupCompletion(importId);
        return Option.isSome(completion)
          ? ({ _tag: "already-imported", result: completion.value.result } as const)
          : ({ _tag: "cancelled" } as const);
      }
      if (action._tag === "committed") {
        return { _tag: "already-imported", result: action.completion.result } as const;
      }
      if (action._tag === "gone") return { _tag: "cancelled" } as const;
      const { record, phase } = action;
      switch (phase._tag) {
        case "importing": {
          yield* Fiber.interrupt(phase.attempt);
          const outcome = yield* Deferred.await(phase.outcome);
          if (outcome._tag === "committed") {
            return { _tag: "already-imported", result: outcome.completion.result } as const;
          }
          if (outcome._tag === "unsettled") {
            return yield* importError(
              "import-failed",
              "The import could not be cancelled cleanly. Scient will finish cleaning up.",
            );
          }
          return { _tag: "cancelled" } as const;
        }
        case "validating": {
          yield* Fiber.interrupt(phase.fiber);
          yield* Deferred.fail(
            phase.result,
            importError("cancelled", "This import was cancelled."),
          );
          yield* removeArea(record);
          return { _tag: "cancelled" } as const;
        }
        default: {
          const settled = yield* settleAndRemove(record, "cancelled");
          if (settled === "unsettled") {
            return yield* importError(
              "import-failed",
              "The import could not be cancelled cleanly. Scient will finish cleaning up.",
            );
          }
          const completion = completions.get(importId);
          return settled === "committed" && completion
            ? ({ _tag: "already-imported", result: completion.result } as const)
            : ({ _tag: "cancelled" } as const);
        }
      }
    });

    // ---------------------------------------------------------------------
    // Expiry
    // ---------------------------------------------------------------------

    const sweep: ConversationImportStaging["Service"]["sweep"] = Effect.gen(function* () {
      const at = yield* now;
      const due = yield* locked(
        Effect.sync(() =>
          [...records.values()].flatMap((record) => {
            const phase = record.phase;
            const expired =
              (phase._tag === "awaiting-upload" && phase.uploadExpiresAt <= at) ||
              ((phase._tag === "uploaded" || phase._tag === "ready") &&
                record.touchedAt + ttlMs <= at) ||
              phase._tag === "abandoned" ||
              phase._tag === "committed";
            if (!expired) return [];
            const previous = phase;
            record.phase = { _tag: "removing" };
            return [{ record, previous }];
          }),
        ),
      );
      for (const { record, previous } of due) {
        if (previous._tag === "committed") {
          yield* commit(record, previous.completion);
          continue;
        }
        yield* settleAndRemove(record, "expired");
      }
      for (const name of yield* fileSystem
        .readDirectory(completionsRoot)
        .pipe(Effect.orElseSucceed(() => []))) {
        const importId = name.replace(/\.json$/u, "");
        if (!isImportId(importId)) continue;
        if (Option.isNone(yield* lookupCompletion(importId))) {
          completions.delete(importId);
          yield* removeDirectory(NodePath.join(completionsRoot, name));
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The conversation import sweep failed.", { cause }),
      ),
    );

    if (options.sweepOnTimer !== false) {
      yield* Effect.forkIn(Effect.repeat(sweep, Schedule.spaced(SWEEP_INTERVAL_MS)), scope);
    }

    return ConversationImportStaging.of({
      createUpload,
      validateUploadToken,
      receiveUpload,
      preview,
      confirm,
      cancel,
      sweep,
    });
  });

export const layer = (options?: ConversationImportStagingOptions) =>
  Layer.effect(ConversationImportStaging, make(options));
