// @effect-diagnostics nodeBuiltinImport:off -- This is the server-owned immutable artifact filesystem boundary.
import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactProducerId,
  ArtifactRevisionId,
  BindingGeneration,
  ContentSha256,
  DocumentArtifactBinding,
  GeneratedDocumentArtifact,
  LogicalDocumentKey,
  PdfSourceDescriptor,
  ProducingOperationId,
  beginDocumentProduction,
  completeDocumentProduction,
  failDocumentProduction,
  isActiveDocumentProduction,
  type ArtifactProvenance,
} from "@scientfactory/document-artifacts";
import {
  PDF_VALIDATION_MAX_BYTES,
  createPdfValidationRuntime,
  type PdfValidationResult,
} from "@scientfactory/pdf-validation";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";

const StoredGeneratedDocumentRevision = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  artifact: GeneratedDocumentArtifact,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  fileName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(255),
    // eslint-disable-next-line no-control-regex -- Persisted filenames must reject NUL explicitly.
    Schema.isPattern(/^[^/\\\0]+\.pdf$/iu),
  ),
  pageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
type StoredGeneratedDocumentRevision = typeof StoredGeneratedDocumentRevision.Type;

const BindingJson = Schema.fromJsonString(DocumentArtifactBinding);
const RevisionJson = Schema.fromJsonString(StoredGeneratedDocumentRevision);
const decodeBinding = Schema.decodeUnknownSync(BindingJson);
const decodeRevision = Schema.decodeUnknownSync(RevisionJson);
const encodeBinding = Schema.encodeSync(BindingJson);
const encodeRevision = Schema.encodeSync(RevisionJson);

export class GeneratedDocumentStoreError extends Schema.TaggedErrorClass<GeneratedDocumentStoreError>()(
  "GeneratedDocumentStoreError",
  {
    operation: Schema.Literals([
      "begin",
      "publish",
      "fail",
      "read-binding",
      "read-revision",
      "write-binding",
      "write-revision",
      "resolve",
    ]),
    reason: Schema.Literals([
      "authority-mismatch",
      "corrupt-state",
      "missing-binding",
      "missing-revision",
      "superseded",
      "validation-rejected",
      "filesystem",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface BeginGeneratedDocumentProductionInput {
  readonly logicalDocumentKey: LogicalDocumentKey;
  readonly operationId: ProducingOperationId;
  readonly producerId: ArtifactProducerId;
}

export interface GeneratedDocumentProductionHandle extends BeginGeneratedDocumentProductionInput {
  readonly generation: BindingGeneration;
}

export interface PublishGeneratedPdfInput extends GeneratedDocumentProductionHandle {
  readonly bytes: Uint8Array;
  readonly title: string;
  readonly provenanceKind: ArtifactProvenance["kind"];
}

export interface FailGeneratedDocumentProductionInput extends GeneratedDocumentProductionHandle {
  readonly reason: string;
}

export interface ResolvedGeneratedDocumentRevision {
  readonly artifact: GeneratedDocumentArtifact;
  readonly path: string;
  readonly fileName: string;
  readonly title: string;
  readonly revision: { readonly size: number; readonly mtimeMs: number | null };
}

export class GeneratedDocumentStore extends Context.Service<
  GeneratedDocumentStore,
  {
    readonly beginProduction: (
      input: BeginGeneratedDocumentProductionInput,
    ) => Effect.Effect<GeneratedDocumentProductionHandle, GeneratedDocumentStoreError>;
    readonly publishPdf: (
      input: PublishGeneratedPdfInput,
    ) => Effect.Effect<PdfSourceDescriptor, GeneratedDocumentStoreError>;
    readonly failProduction: (
      input: FailGeneratedDocumentProductionInput,
    ) => Effect.Effect<DocumentArtifactBinding, GeneratedDocumentStoreError>;
    readonly getDescriptor: (
      logicalDocumentKey: LogicalDocumentKey,
    ) => Effect.Effect<PdfSourceDescriptor, GeneratedDocumentStoreError>;
    readonly resolveRevision: (input: {
      readonly authority: ArtifactAuthority;
      readonly artifactId: ArtifactId;
      readonly revisionId: ArtifactRevisionId;
    }) => Effect.Effect<ResolvedGeneratedDocumentRevision, GeneratedDocumentStoreError>;
  }
>()("t3/scient/documentArtifacts/GeneratedDocumentStore") {}

function packagedPdfValidationWorkerUrl(): URL {
  const moduleUrl = new URL(import.meta.url);
  return moduleUrl.pathname.endsWith("/dist/bin.mjs")
    ? new URL("./pdf-validation-worker.mjs", moduleUrl)
    : new URL("../../pdf-validation-worker.ts", moduleUrl);
}

const makeStoreError = (
  operation: GeneratedDocumentStoreError["operation"],
  reason: GeneratedDocumentStoreError["reason"],
  detail: string,
  cause?: unknown,
) => new GeneratedDocumentStoreError({ operation, reason, detail, ...(cause ? { cause } : {}) });

const optionalOnNotFound = <A>(effect: Effect.Effect<A, PlatformError.PlatformError>) =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

function pdfFileName(title: string): string {
  const normalized = title
    .trim()
    .replace(/\.pdf$/iu, "")
    // eslint-disable-next-line no-control-regex -- Filesystem-safe output names replace NUL explicitly.
    .replace(/[\\/:*?"<>|\0]/gu, "-")
    .replace(/\s+/gu, " ")
    .slice(0, 240)
    .trim();
  return `${normalized || "document"}.pdf`;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const authority = ArtifactAuthority.make(yield* environment.getEnvironmentId);
  const lock = yield* Semaphore.make(1);
  const validator = yield* Effect.acquireRelease(
    Effect.sync(() => createPdfValidationRuntime({ workerUrl: packagedPdfValidationWorkerUrl() })),
    (runtime) => Effect.promise(() => runtime.close()),
  );

  const bindingPath = (logicalDocumentKey: LogicalDocumentKey) =>
    path.join(
      config.documentArtifactsDir,
      "bindings",
      `${NodeCrypto.createHash("sha256").update(`${authority}\0${logicalDocumentKey}`).digest("hex")}.json`,
    );

  const artifactRevisionDirectory = (artifactId: ArtifactId) =>
    path.join(config.documentArtifactsDir, "revisions", artifactId);
  const revisionDirectory = (artifactId: ArtifactId, revisionId: ArtifactRevisionId) =>
    path.join(artifactRevisionDirectory(artifactId), revisionId);
  const revisionMetadataPath = (artifactId: ArtifactId, revisionId: ArtifactRevisionId) =>
    path.join(revisionDirectory(artifactId, revisionId), "metadata.json");
  const revisionPdfPath = (artifactId: ArtifactId, revisionId: ArtifactRevisionId) =>
    path.join(revisionDirectory(artifactId, revisionId), "document.pdf");

  const readBinding = Effect.fn("GeneratedDocumentStore.readBinding")(function* (
    logicalDocumentKey: LogicalDocumentKey,
  ) {
    const filePath = bindingPath(logicalDocumentKey);
    const source = yield* optionalOnNotFound(fileSystem.readFileString(filePath)).pipe(
      Effect.mapError((cause) =>
        makeStoreError("read-binding", "filesystem", "Unable to read document binding.", cause),
      ),
    );
    if (Option.isNone(source)) return null;
    const binding = yield* Effect.try({
      try: () => decodeBinding(source.value),
      catch: (cause) =>
        makeStoreError("read-binding", "corrupt-state", "Document binding is corrupt.", cause),
    });
    if (binding.authority !== authority || binding.logicalDocumentKey !== logicalDocumentKey) {
      return yield* makeStoreError(
        "read-binding",
        "authority-mismatch",
        "Document binding belongs to another authority.",
      );
    }
    return binding;
  });

  const writeBinding = Effect.fn("GeneratedDocumentStore.writeBinding")(function* (
    binding: DocumentArtifactBinding,
  ) {
    const filePath = bindingPath(binding.logicalDocumentKey);
    yield* writeFileStringAtomically({ filePath, contents: `${encodeBinding(binding)}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) =>
        makeStoreError("write-binding", "filesystem", "Unable to persist document binding.", cause),
      ),
    );
  });

  const readRevision = Effect.fn("GeneratedDocumentStore.readRevision")(function* (
    artifactId: ArtifactId,
    revisionId: ArtifactRevisionId,
  ) {
    const metadataPath = revisionMetadataPath(artifactId, revisionId);
    const source = yield* optionalOnNotFound(fileSystem.readFileString(metadataPath)).pipe(
      Effect.mapError((cause) =>
        makeStoreError("read-revision", "filesystem", "Unable to read PDF revision.", cause),
      ),
    );
    if (Option.isNone(source)) {
      return yield* makeStoreError(
        "read-revision",
        "missing-revision",
        "Generated PDF revision was not found.",
      );
    }
    const stored = yield* Effect.try({
      try: () => decodeRevision(source.value),
      catch: (cause) =>
        makeStoreError(
          "read-revision",
          "corrupt-state",
          "PDF revision metadata is corrupt.",
          cause,
        ),
    });
    if (
      stored.artifact.authority !== authority ||
      stored.artifact.artifactId !== artifactId ||
      stored.artifact.revisionId !== revisionId
    ) {
      return yield* makeStoreError(
        "read-revision",
        "authority-mismatch",
        "Generated PDF revision belongs to another authority.",
      );
    }
    return stored;
  });

  const writeRevisionAtomically = Effect.fn("GeneratedDocumentStore.writeRevisionAtomically")(
    function* (stored: StoredGeneratedDocumentRevision, bytes: Uint8Array) {
      const artifactId = stored.artifact.artifactId;
      const revisionId = stored.artifact.revisionId;
      const artifactDirectory = artifactRevisionDirectory(artifactId);
      const finalDirectory = revisionDirectory(artifactId, revisionId);
      yield* fileSystem.makeDirectory(artifactDirectory, { recursive: true });
      const temporaryDirectory = yield* fileSystem.makeTempDirectory({
        directory: artifactDirectory,
        prefix: ".revision-",
      });
      yield* Effect.gen(function* () {
        yield* fileSystem.writeFile(path.join(temporaryDirectory, "document.pdf"), bytes);
        yield* fileSystem.writeFileString(
          path.join(temporaryDirectory, "metadata.json"),
          `${encodeRevision(stored)}\n`,
        );
        yield* Effect.scoped(
          Effect.all([
            fileSystem
              .open(path.join(temporaryDirectory, "document.pdf"), { flag: "r" })
              .pipe(Effect.flatMap((file) => file.sync)),
            fileSystem
              .open(path.join(temporaryDirectory, "metadata.json"), { flag: "r" })
              .pipe(Effect.flatMap((file) => file.sync)),
          ]),
        );
        yield* fileSystem.rename(temporaryDirectory, finalDirectory);
      }).pipe(
        Effect.ensuring(
          fileSystem
            .remove(temporaryDirectory, { recursive: true, force: true })
            .pipe(Effect.ignore),
        ),
      );
    },
  );

  const ensureActiveProduction = Effect.fn("GeneratedDocumentStore.ensureActiveProduction")(
    function* (input: GeneratedDocumentProductionHandle) {
      const current = yield* readBinding(input.logicalDocumentKey);
      if (current === null) {
        return yield* makeStoreError(
          "publish",
          "missing-binding",
          "Document production has not been started.",
        );
      }
      if (!isActiveDocumentProduction(current, input)) {
        return yield* makeStoreError(
          "publish",
          "superseded",
          "A newer document production superseded this PDF.",
        );
      }
    },
  );

  const beginProduction = (input: BeginGeneratedDocumentProductionInput) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = yield* readBinding(input.logicalDocumentKey);
        const artifactId = current?.artifactId ?? ArtifactId.make(NodeCrypto.randomUUID());
        const generation = BindingGeneration.make((current?.generation ?? 0) + 1);
        const nowEpochMs = yield* Clock.currentTimeMillis;
        const transition = beginDocumentProduction(current, {
          authority,
          artifactId,
          logicalDocumentKey: input.logicalDocumentKey,
          generation,
          operationId: input.operationId,
          producerId: input.producerId,
          nowEpochMs,
        });
        if (transition._tag === "Superseded") {
          return yield* makeStoreError(
            "begin",
            "superseded",
            "A newer document production already owns this binding.",
          );
        }
        yield* writeBinding(transition.binding);
        return { ...input, generation };
      }),
    );

  const failCurrentProduction = Effect.fn("GeneratedDocumentStore.failCurrentProduction")(
    function* (input: FailGeneratedDocumentProductionInput) {
      const current = yield* readBinding(input.logicalDocumentKey);
      if (current === null) {
        return yield* makeStoreError(
          "fail",
          "missing-binding",
          "Document production has not been started.",
        );
      }
      const transition = failDocumentProduction(current, {
        generation: input.generation,
        operationId: input.operationId,
        producerId: input.producerId,
        reason: input.reason.slice(0, 2_048),
        nowEpochMs: yield* Clock.currentTimeMillis,
      });
      if (transition._tag === "Superseded") {
        return yield* makeStoreError(
          "fail",
          "superseded",
          "A newer document production superseded this failure.",
        );
      }
      yield* writeBinding(transition.binding);
      return transition.binding;
    },
  );

  const failProduction = (input: FailGeneratedDocumentProductionInput) =>
    lock.withPermit(failCurrentProduction(input));

  const descriptorFromBinding = Effect.fn("GeneratedDocumentStore.descriptorFromBinding")(
    function* (binding: DocumentArtifactBinding) {
      if (binding.activeRevision === null) {
        return yield* makeStoreError(
          "resolve",
          "missing-revision",
          "The document does not have a successful PDF revision yet.",
        );
      }
      const stored = yield* readRevision(
        binding.activeRevision.artifactId,
        binding.activeRevision.revisionId,
      );
      return PdfSourceDescriptor.make({
        _tag: "generated-pdf",
        authority,
        logicalDocumentKey: binding.logicalDocumentKey,
        artifactId: stored.artifact.artifactId,
        revisionId: stored.artifact.revisionId,
        bindingGeneration: binding.generation,
        bindingStatus: binding.status === "stale" ? "stale" : "current",
        staleReason: binding.status === "stale" ? binding.staleReason : null,
        title: stored.title,
        fileName: stored.fileName,
        capabilities: { canSaveCopy: true, canRevealSource: false },
      });
    },
  );

  const recordRejectedValidation = (
    input: PublishGeneratedPdfInput,
    validation: Extract<PdfValidationResult, { readonly accepted: false }>,
  ) =>
    Effect.gen(function* () {
      yield* failCurrentProduction({
        ...input,
        reason: validation.detail,
      });
      return yield* makeStoreError("publish", "validation-rejected", validation.detail);
    });

  const publishPdf = (input: PublishGeneratedPdfInput) =>
    Effect.gen(function* () {
      yield* lock.withPermit(ensureActiveProduction(input));
      const ownedBytes =
        input.bytes.byteLength > PDF_VALIDATION_MAX_BYTES ? input.bytes : input.bytes.slice();
      const validation = yield* Effect.promise(() =>
        validator.validate(ownedBytes, "producer-registration"),
      );
      if (!validation.accepted) {
        return yield* lock.withPermit(recordRejectedValidation(input, validation));
      }
      const contentHash = ContentSha256.make(
        NodeCrypto.createHash("sha256").update(ownedBytes).digest("hex"),
      );

      return yield* lock.withPermit(
        Effect.gen(function* () {
          const current = yield* readBinding(input.logicalDocumentKey);
          if (current === null) {
            return yield* makeStoreError(
              "publish",
              "missing-binding",
              "Document production has not been started.",
            );
          }
          const revisionId = ArtifactRevisionId.make(NodeCrypto.randomUUID());
          const revision = { artifactId: current.artifactId, revisionId };
          const nowEpochMs = yield* Clock.currentTimeMillis;
          const transition = completeDocumentProduction(current, {
            generation: input.generation,
            operationId: input.operationId,
            producerId: input.producerId,
            revision,
            nowEpochMs,
          });
          if (transition._tag === "Superseded") {
            return yield* makeStoreError(
              "publish",
              "superseded",
              "A newer document production superseded this PDF.",
            );
          }

          const stored: StoredGeneratedDocumentRevision = {
            schemaVersion: 1,
            artifact: {
              schemaVersion: 1,
              authority,
              logicalDocumentKey: input.logicalDocumentKey,
              artifactId: current.artifactId,
              revisionId,
              contentHash,
              mediaType: "application/pdf",
              byteLength: ownedBytes.byteLength,
              createdAtEpochMs: nowEpochMs,
              provenance: {
                kind: input.provenanceKind,
                producerId: input.producerId,
                operationId: input.operationId,
              },
            },
            title: input.title.trim().slice(0, 512) || "Document",
            fileName: pdfFileName(input.title),
            pageCount: validation.pageCount,
          };
          const publishedRevisionDirectory = revisionDirectory(current.artifactId, revisionId);
          yield* writeRevisionAtomically(stored, ownedBytes).pipe(
            Effect.mapError((cause) =>
              makeStoreError(
                "write-revision",
                "filesystem",
                "Unable to publish the complete PDF revision.",
                cause,
              ),
            ),
          );
          yield* writeBinding(transition.binding).pipe(
            Effect.catch((cause) =>
              fileSystem
                .remove(publishedRevisionDirectory, {
                  recursive: true,
                  force: true,
                })
                .pipe(Effect.ignore, Effect.andThen(Effect.fail(cause))),
            ),
          );
          return yield* descriptorFromBinding(transition.binding);
        }),
      );
    });

  const getDescriptor = (logicalDocumentKey: LogicalDocumentKey) =>
    lock.withPermit(
      Effect.gen(function* () {
        const binding = yield* readBinding(logicalDocumentKey);
        if (binding === null) {
          return yield* makeStoreError(
            "resolve",
            "missing-binding",
            "Document binding was not found.",
          );
        }
        return yield* descriptorFromBinding(binding);
      }),
    );

  const resolveRevision = (input: {
    readonly authority: ArtifactAuthority;
    readonly artifactId: ArtifactId;
    readonly revisionId: ArtifactRevisionId;
  }) =>
    Effect.gen(function* () {
      if (input.authority !== authority) {
        return yield* makeStoreError(
          "resolve",
          "authority-mismatch",
          "Generated PDF belongs to another environment.",
        );
      }
      const stored = yield* readRevision(input.artifactId, input.revisionId);
      const filePath = revisionPdfPath(input.artifactId, input.revisionId);
      const info = yield* optionalOnNotFound(fileSystem.stat(filePath)).pipe(
        Effect.mapError((cause) =>
          makeStoreError("resolve", "filesystem", "Unable to inspect generated PDF.", cause),
        ),
      );
      if (Option.isNone(info) || info.value.type !== "File") {
        return yield* makeStoreError(
          "resolve",
          "missing-revision",
          "Generated PDF bytes were not found.",
        );
      }
      if (Number(info.value.size) !== stored.artifact.byteLength) {
        return yield* makeStoreError(
          "resolve",
          "corrupt-state",
          "Generated PDF bytes no longer match their immutable revision.",
        );
      }
      const currentBytes = yield* fileSystem
        .readFile(filePath)
        .pipe(
          Effect.mapError((cause) =>
            makeStoreError("resolve", "filesystem", "Unable to verify generated PDF.", cause),
          ),
        );
      const currentHash = NodeCrypto.createHash("sha256").update(currentBytes).digest("hex");
      if (currentHash !== stored.artifact.contentHash) {
        return yield* makeStoreError(
          "resolve",
          "corrupt-state",
          "Generated PDF bytes no longer match their immutable content hash.",
        );
      }
      return {
        artifact: stored.artifact,
        path: filePath,
        fileName: stored.fileName,
        title: stored.title,
        revision: {
          size: Number(info.value.size),
          mtimeMs: Option.match(info.value.mtime, {
            onNone: () => null,
            onSome: (mtime) => mtime.getTime(),
          }),
        },
      };
    });

  return GeneratedDocumentStore.of({
    beginProduction,
    publishPdf,
    failProduction,
    getDescriptor,
    resolveRevision,
  });
});

export const layer = Layer.effect(GeneratedDocumentStore, make);
