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
  abandonDocumentProduction,
  beginDocumentProduction,
  completeDocumentProduction,
  failDocumentProduction,
  isActiveDocumentProduction,
  type ArtifactProvenance,
  type ArtifactRevisionRef,
  type DocumentBindingChange,
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
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ASSET_TOKEN_TTL_MS } from "../../assets/AssetLifetime.ts";
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

/**
 * Store-level accounting entry for one published revision. The index is the
 * eviction bookkeeping only; the binding files remain the authority on which
 * revision a document currently resolves to.
 */
const RetainedRevisionRecord = Schema.Struct({
  artifactId: ArtifactId,
  revisionId: ArtifactRevisionId,
  logicalDocumentKey: LogicalDocumentKey,
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAtEpochMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Durable protection for a signed reader URL that may outlive this process. */
  assetLeaseExpiresAtEpochMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
type RetainedRevisionRecord = typeof RetainedRevisionRecord.Type;

const RetentionIndex = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  authority: ArtifactAuthority,
  revisions: Schema.Array(RetainedRevisionRecord),
});

/** Access time is diagnostic ordering state only; capability leases are durable. */
interface RetainedRevision extends RetainedRevisionRecord {
  readonly lastAccessEpochMs: number;
}

const BindingJson = Schema.fromJsonString(DocumentArtifactBinding);
const RevisionJson = Schema.fromJsonString(StoredGeneratedDocumentRevision);
const RetentionIndexJson = Schema.fromJsonString(RetentionIndex);
const decodeBinding = Schema.decodeUnknownSync(BindingJson);
const decodeRevision = Schema.decodeUnknownSync(RevisionJson);
const decodeRetentionIndex = Schema.decodeUnknownSync(RetentionIndexJson);
const encodeBinding = Schema.encodeSync(BindingJson);
const encodeRevision = Schema.encodeSync(RevisionJson);
const encodeRetentionIndex = Schema.encodeSync(RetentionIndexJson);

/**
 * Retention budget for the shared immutable revision store, applied across every
 * logical document rather than per document. The defaults are the numbers the
 * shared PDF plan gates continuous-save producers on.
 */
export interface GeneratedDocumentRetentionPolicy {
  /** Total published-revision bytes retained before eviction starts. */
  readonly maxTotalBytes: number;
  /** Total published revisions retained before eviction starts. */
  readonly maxRevisionCount: number;
  /**
   * Upper bound on deletions performed by one opportunistic enforcement pass, so
   * a single publish never pays for an unbounded backlog. Remaining overage is
   * reclaimed by the next publish.
   */
  readonly maxEvictionsPerSweep: number;
}

export const DEFAULT_GENERATED_DOCUMENT_RETENTION: GeneratedDocumentRetentionPolicy = {
  maxTotalBytes: 500 * 1_024 * 1_024,
  maxRevisionCount: 100,
  maxEvictionsPerSweep: 32,
};

/**
 * Recent binding changes replayed to a late subscriber. Delivery is coalescible
 * and the persisted binding stays authoritative, so this only spares a consumer
 * that attaches just after startup from missing the reconciliation report.
 */
const BINDING_CHANGE_REPLAY = 32;

const IDENTIFIER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export class GeneratedDocumentStoreError extends Schema.TaggedErrorClass<GeneratedDocumentStoreError>()(
  "GeneratedDocumentStoreError",
  {
    operation: Schema.Literals([
      "begin",
      "publish",
      "fail",
      "abandon",
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

export interface AbandonGeneratedDocumentProductionInput extends GeneratedDocumentProductionHandle {
  readonly reason: string;
}

export interface ResolvedGeneratedDocumentRevision {
  readonly artifact: GeneratedDocumentArtifact;
  readonly path: string;
  readonly fileName: string;
  readonly title: string;
  readonly revision: { readonly size: number; readonly mtimeMs: number | null };
}

export interface ResolvedGeneratedDocumentAsset {
  readonly document: ResolvedGeneratedDocumentRevision;
  readonly expiresAtEpochMs: number;
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
    /**
     * Records a production whose inputs are discredited. A surviving revision
     * stays visible but is marked stale. Use {@link abandonProduction} for an
     * attempt that merely stopped mattering.
     */
    readonly failProduction: (
      input: FailGeneratedDocumentProductionInput,
    ) => Effect.Effect<DocumentArtifactBinding, GeneratedDocumentStoreError>;
    /**
     * Releases a production that was cancelled or superseded without
     * discrediting its inputs. A published current revision stays current and is
     * never staled. Idempotent: a handle that no longer owns the binding is a
     * no-op that returns the current binding state.
     */
    readonly abandonProduction: (
      input: AbandonGeneratedDocumentProductionInput,
    ) => Effect.Effect<DocumentArtifactBinding, GeneratedDocumentStoreError>;
    readonly getDescriptor: (
      logicalDocumentKey: LogicalDocumentKey,
    ) => Effect.Effect<PdfSourceDescriptor, GeneratedDocumentStoreError>;
    readonly resolveRevision: (input: {
      readonly authority: ArtifactAuthority;
      readonly artifactId: ArtifactId;
      readonly revisionId: ArtifactRevisionId;
    }) => Effect.Effect<ResolvedGeneratedDocumentRevision, GeneratedDocumentStoreError>;
    /**
     * Resolves immutable bytes and durably protects them for exactly as long as
     * the signed asset capability returned to the reader will remain valid.
     */
    readonly resolveRevisionForAsset: (input: {
      readonly authority: ArtifactAuthority;
      readonly artifactId: ArtifactId;
      readonly revisionId: ArtifactRevisionId;
    }) => Effect.Effect<ResolvedGeneratedDocumentAsset, GeneratedDocumentStoreError>;
    /**
     * Protects a revision from retention eviction for the lifetime of the
     * acquiring scope, for work that still references a revision the bindings no
     * longer point at — an in-flight production reading its predecessor, or a
     * reader being served from a superseded revision.
     */
    readonly retainRevision: (
      revision: ArtifactRevisionRef,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Server-internal binding-change seam. Every binding transition is
     * announced, including startup reconciliation and superseded attempts.
     * Delivery may be coalesced, so the persisted binding remains authoritative
     * and a consumer re-reads it through `getDescriptor`.
     */
    readonly changes: Stream.Stream<DocumentBindingChange>;
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

const revisionKey = (artifactId: ArtifactId, revisionId: ArtifactRevisionId) =>
  `${artifactId}/${revisionId}`;

const adjustPinCount = (
  current: ReadonlyMap<string, number>,
  key: string,
  delta: number,
): ReadonlyMap<string, number> => {
  const next = new Map(current);
  const count = (next.get(key) ?? 0) + delta;
  if (count > 0) next.set(key, count);
  else next.delete(key);
  return next;
};

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

export interface GeneratedDocumentStoreOptions {
  readonly retention?: Partial<GeneratedDocumentRetentionPolicy> | undefined;
}

export const make = Effect.fn("GeneratedDocumentStore.make")(function* (
  options: GeneratedDocumentStoreOptions = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const authority = ArtifactAuthority.make(yield* environment.getEnvironmentId);
  const lock = yield* Semaphore.make(1);
  const retention: GeneratedDocumentRetentionPolicy = {
    ...DEFAULT_GENERATED_DOCUMENT_RETENTION,
    ...options.retention,
  };
  const changesPubSub = yield* PubSub.unbounded<DocumentBindingChange>({
    replay: BINDING_CHANGE_REPLAY,
  });
  /** Published revisions retained by the store, oldest publication first. */
  const retainedRevisions = yield* Ref.make<ReadonlyArray<RetainedRevision>>([]);
  /** Revisions each binding currently depends on; the store is their only writer. */
  const bindingRevisions = yield* Ref.make<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  /** Scope-held protection counts for revisions referenced by in-flight work. */
  const pinnedRevisions = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const validator = yield* Effect.acquireRelease(
    Effect.sync(() => createPdfValidationRuntime({ workerUrl: packagedPdfValidationWorkerUrl() })),
    (runtime) => Effect.promise(() => runtime.close()),
  );

  const bindingsDirectory = path.join(config.documentArtifactsDir, "bindings");
  const revisionsDirectory = path.join(config.documentArtifactsDir, "revisions");
  const retentionIndexPath = path.join(config.documentArtifactsDir, "retention-index.json");

  const bindingPath = (logicalDocumentKey: LogicalDocumentKey) =>
    path.join(
      bindingsDirectory,
      `${NodeCrypto.createHash("sha256").update(`${authority}\0${logicalDocumentKey}`).digest("hex")}.json`,
    );

  const artifactRevisionDirectory = (artifactId: ArtifactId) =>
    path.join(revisionsDirectory, artifactId);
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

  const announce = (
    binding: DocumentArtifactBinding,
    changeKind: DocumentBindingChange["changeKind"],
  ) =>
    PubSub.publish(changesPubSub, {
      changeKind,
      authority: binding.authority,
      logicalDocumentKey: binding.logicalDocumentKey,
      artifactId: binding.artifactId,
      generation: binding.generation,
      status: binding.status,
      activeRevision: binding.activeRevision,
      updatedAtEpochMs: binding.updatedAtEpochMs,
    }).pipe(Effect.asVoid);

  const trackBindingProtection = (binding: DocumentArtifactBinding) =>
    Ref.update(bindingRevisions, (current) => {
      const keys = new Set<string>();
      for (const revision of [binding.activeRevision, binding.lastSuccessfulRevision]) {
        if (revision !== null) keys.add(revisionKey(revision.artifactId, revision.revisionId));
      }
      const next = new Map(current);
      if (keys.size === 0) next.delete(binding.logicalDocumentKey);
      else next.set(binding.logicalDocumentKey, keys);
      return next;
    });

  /**
   * Persists a binding, then adopts the revisions it depends on into the
   * protected set and announces the transition. Protection is recorded before
   * any retention pass can run, so a freshly published revision is never a
   * candidate for its own opportunistic eviction.
   */
  const commitBinding = Effect.fn("GeneratedDocumentStore.commitBinding")(function* (
    binding: DocumentArtifactBinding,
    changeKind: DocumentBindingChange["changeKind"],
  ) {
    const filePath = bindingPath(binding.logicalDocumentKey);
    yield* writeFileStringAtomically({ filePath, contents: `${encodeBinding(binding)}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) =>
        makeStoreError("write-binding", "filesystem", "Unable to persist document binding.", cause),
      ),
    );
    yield* trackBindingProtection(binding);
    yield* announce(binding, changeKind);
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
        // Windows rejects fsync on a read-only descriptor with EPERM, so the
        // durability flush opens these freshly written files for writing.
        yield* Effect.scoped(
          Effect.all([
            fileSystem
              .open(path.join(temporaryDirectory, "document.pdf"), { flag: "r+" })
              .pipe(Effect.flatMap((file) => file.sync)),
            fileSystem
              .open(path.join(temporaryDirectory, "metadata.json"), { flag: "r+" })
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

  const retainRevision = (revision: ArtifactRevisionRef) => {
    const key = revisionKey(revision.artifactId, revision.revisionId);
    return Effect.acquireRelease(
      // Acquire under the same lock as eviction: a pin added after a sweep chose
      // its candidates would be too late to protect the directory being removed.
      lock.withPermit(Ref.update(pinnedRevisions, (current) => adjustPinCount(current, key, 1))),
      () => Ref.update(pinnedRevisions, (current) => adjustPinCount(current, key, -1)),
    ).pipe(Effect.asVoid);
  };

  const protectedRevisionKeys = Effect.gen(function* () {
    const bindings = yield* Ref.get(bindingRevisions);
    const pinned = yield* Ref.get(pinnedRevisions);
    const retained = yield* Ref.get(retainedRevisions);
    const nowEpochMs = yield* Clock.currentTimeMillis;
    const keys = new Set<string>();
    for (const revisions of bindings.values()) for (const key of revisions) keys.add(key);
    for (const key of pinned.keys()) keys.add(key);
    for (const revision of retained) {
      if ((revision.assetLeaseExpiresAtEpochMs ?? 0) > nowEpochMs) {
        keys.add(revisionKey(revision.artifactId, revision.revisionId));
      }
    }
    return keys;
  });

  const writeRetentionIndex = (entries: ReadonlyArray<RetainedRevision>) =>
    writeFileStringAtomically({
      filePath: retentionIndexPath,
      contents: `${encodeRetentionIndex({
        schemaVersion: 1,
        authority,
        revisions: entries.map(({ lastAccessEpochMs: _lastAccessEpochMs, ...entry }) => entry),
      })}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  /**
   * Retention accounting is diagnostic state: a store that cannot write it still
   * serves documents, and the next startup sweep rebuilds it from the bindings
   * and the revision directories.
   */
  const persistRetentionIndex = (entries: ReadonlyArray<RetainedRevision>) =>
    writeRetentionIndex(entries).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Unable to persist the document retention index.", { cause }),
      ),
    );

  /** Tolerates an already-missing directory, which a crashed eviction can leave. */
  const removeRevisionDirectory = (artifactId: ArtifactId, revisionId: ArtifactRevisionId) =>
    fileSystem
      .remove(revisionDirectory(artifactId, revisionId), { recursive: true, force: true })
      .pipe(
        Effect.andThen(
          fileSystem
            .readDirectory(artifactRevisionDirectory(artifactId))
            .pipe(
              Effect.flatMap((remaining) =>
                remaining.length === 0
                  ? fileSystem.remove(artifactRevisionDirectory(artifactId), { force: true })
                  : Effect.void,
              ),
            ),
        ),
        Effect.ignore,
      );

  /**
   * Opportunistic, bounded eviction of superseded revisions. Protected work — the
   * revision every binding currently resolves to, and any revision pinned by
   * in-flight work — is never a candidate, so a budget that cannot be restored
   * is reported rather than satisfied by deleting referenced revisions.
   */
  const enforceRetentionBudget = Effect.fn("GeneratedDocumentStore.enforceRetentionBudget")(
    function* () {
      const entries = yield* Ref.get(retainedRevisions);
      const totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
      const withinBudget = (count: number, bytes: number) =>
        count <= retention.maxRevisionCount && bytes <= retention.maxTotalBytes;
      if (withinBudget(entries.length, totalBytes)) return;

      const protectedKeys = yield* protectedRevisionKeys;
      const candidates = entries
        .filter((entry) => !protectedKeys.has(revisionKey(entry.artifactId, entry.revisionId)))
        .toSorted((left, right) => left.lastAccessEpochMs - right.lastAccessEpochMs);

      const evicted: Array<RetainedRevision> = [];
      let remainingCount = entries.length;
      let remainingBytes = totalBytes;
      for (const candidate of candidates) {
        if (withinBudget(remainingCount, remainingBytes)) break;
        if (evicted.length >= retention.maxEvictionsPerSweep) break;
        evicted.push(candidate);
        remainingCount -= 1;
        remainingBytes -= candidate.byteLength;
      }

      if (evicted.length > 0) {
        const evictedKeys = new Set(
          evicted.map((entry) => revisionKey(entry.artifactId, entry.revisionId)),
        );
        const remaining = entries.filter(
          (entry) => !evictedKeys.has(revisionKey(entry.artifactId, entry.revisionId)),
        );
        // State first: a crash after this point strands a directory that nothing
        // references, never a reference to a directory that is already gone.
        yield* Ref.set(retainedRevisions, remaining);
        yield* persistRetentionIndex(remaining);
        yield* Effect.forEach(
          evicted,
          (entry) => removeRevisionDirectory(entry.artifactId, entry.revisionId),
          { discard: true },
        );
        yield* Effect.logInfo("Evicted superseded generated document revisions.", {
          evictedRevisions: evicted.length,
          retainedRevisions: remaining.length,
          retainedBytes: remainingBytes,
        });
      }

      if (!withinBudget(remainingCount, remainingBytes)) {
        yield* Effect.logWarning(
          "Generated document retention budget is exceeded by protected revisions.",
          {
            retainedRevisions: remainingCount,
            retainedBytes: remainingBytes,
            maxRevisionCount: retention.maxRevisionCount,
            maxTotalBytes: retention.maxTotalBytes,
          },
        );
      }
    },
  );

  const recordPublishedRevision = (entry: RetainedRevisionRecord) =>
    Ref.updateAndGet(retainedRevisions, (entries) => [
      ...entries,
      { ...entry, lastAccessEpochMs: entry.createdAtEpochMs },
    ]).pipe(Effect.flatMap(persistRetentionIndex));

  const touchRetainedRevision = (
    artifactId: ArtifactId,
    revisionId: ArtifactRevisionId,
    nowEpochMs: number,
  ) => {
    const key = revisionKey(artifactId, revisionId);
    return Ref.update(retainedRevisions, (entries) =>
      entries.map((entry) =>
        revisionKey(entry.artifactId, entry.revisionId) === key
          ? { ...entry, lastAccessEpochMs: nowEpochMs }
          : entry,
      ),
    );
  };

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
        yield* announce(current, "supersede");
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
          yield* announce(transition.binding, "supersede");
          return yield* makeStoreError(
            "begin",
            "superseded",
            "A newer document production already owns this binding.",
          );
        }
        yield* commitBinding(transition.binding, "begin");
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
        yield* announce(transition.binding, "supersede");
        return yield* makeStoreError(
          "fail",
          "superseded",
          "A newer document production superseded this failure.",
        );
      }
      yield* commitBinding(transition.binding, "fail");
      return transition.binding;
    },
  );

  const failProduction = (input: FailGeneratedDocumentProductionInput) =>
    lock.withPermit(failCurrentProduction(input));

  /**
   * Releases a production whose inputs were never discredited. Unlike
   * `failProduction` this cannot stale a published revision, and a handle that
   * no longer owns the binding settles as a no-op rather than an error so a
   * cancel path can run unconditionally.
   */
  const abandonProduction = (input: AbandonGeneratedDocumentProductionInput) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = yield* readBinding(input.logicalDocumentKey);
        if (current === null) {
          return yield* makeStoreError(
            "abandon",
            "missing-binding",
            "Document production has not been started.",
          );
        }
        const transition = abandonDocumentProduction(current, {
          generation: input.generation,
          operationId: input.operationId,
          producerId: input.producerId,
          reason: input.reason.slice(0, 2_048),
          nowEpochMs: yield* Clock.currentTimeMillis,
        });
        if (transition._tag === "Superseded") {
          yield* announce(transition.binding, "supersede");
          return transition.binding;
        }
        yield* commitBinding(transition.binding, "abandon");
        return transition.binding;
      }),
    );

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
            yield* announce(transition.binding, "supersede");
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
          // The revision directory exists but nothing references it yet, so a
          // crash here strands an orphan the startup sweep reclaims. The
          // retention entry is added only after the binding write commits: an
          // adopted-but-unreferenced revision would otherwise be mistaken for
          // retained history.
          yield* commitBinding(transition.binding, "publish").pipe(
            Effect.catch((cause) =>
              fileSystem
                .remove(publishedRevisionDirectory, {
                  recursive: true,
                  force: true,
                })
                .pipe(Effect.ignore, Effect.andThen(Effect.fail(cause))),
            ),
          );
          yield* recordPublishedRevision({
            artifactId: current.artifactId,
            revisionId,
            logicalDocumentKey: input.logicalDocumentKey,
            byteLength: ownedBytes.byteLength,
            createdAtEpochMs: nowEpochMs,
          });
          yield* enforceRetentionBudget();
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

  const resolveRevisionUnlocked = (input: {
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
      yield* touchRetainedRevision(
        input.artifactId,
        input.revisionId,
        yield* Clock.currentTimeMillis,
      );
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

  const resolveRevision = (input: {
    readonly authority: ArtifactAuthority;
    readonly artifactId: ArtifactId;
    readonly revisionId: ArtifactRevisionId;
  }) => resolveRevisionUnlocked(input);

  const resolveRevisionForAsset = (input: {
    readonly authority: ArtifactAuthority;
    readonly artifactId: ArtifactId;
    readonly revisionId: ArtifactRevisionId;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        // The short scope closes the gap between verification and the durable
        // lease write without holding the global store lock while hashing a PDF.
        yield* retainRevision(input);
        const document = yield* resolveRevisionUnlocked(input);
        return yield* lock.withPermit(
          Effect.gen(function* () {
            const nowEpochMs = yield* Clock.currentTimeMillis;
            const expiresAtEpochMs = nowEpochMs + ASSET_TOKEN_TTL_MS;
            const key = revisionKey(input.artifactId, input.revisionId);
            const entries = yield* Ref.updateAndGet(retainedRevisions, (current) => {
              let found = false;
              const updated = current.map((entry) => {
                if (revisionKey(entry.artifactId, entry.revisionId) !== key) return entry;
                found = true;
                return {
                  ...entry,
                  lastAccessEpochMs: nowEpochMs,
                  assetLeaseExpiresAtEpochMs: Math.max(
                    entry.assetLeaseExpiresAtEpochMs ?? 0,
                    expiresAtEpochMs,
                  ),
                };
              });
              if (found) return updated;
              return [
                ...updated,
                {
                  artifactId: document.artifact.artifactId,
                  revisionId: document.artifact.revisionId,
                  logicalDocumentKey: document.artifact.logicalDocumentKey,
                  byteLength: document.artifact.byteLength,
                  createdAtEpochMs: document.artifact.createdAtEpochMs,
                  lastAccessEpochMs: nowEpochMs,
                  assetLeaseExpiresAtEpochMs: expiresAtEpochMs,
                },
              ];
            });
            // Unlike ordinary retention bookkeeping, this write is part of
            // issuing the capability: without it a restart could forget the
            // lease while the already-signed URL remained valid.
            yield* writeRetentionIndex(entries).pipe(
              Effect.mapError((cause) =>
                makeStoreError(
                  "resolve",
                  "filesystem",
                  "Unable to retain generated PDF bytes for reader access.",
                  cause,
                ),
              ),
            );
            return { document, expiresAtEpochMs };
          }),
        );
      }),
    );

  const listDirectory = (directory: string) =>
    optionalOnNotFound(fileSystem.readDirectory(directory)).pipe(
      Effect.map(Option.getOrElse((): ReadonlyArray<string> => [])),
      Effect.catchCause((cause) =>
        Effect.logWarning("Unable to list a document artifact directory.", {
          directory,
          cause,
        }).pipe(Effect.as([] as ReadonlyArray<string>)),
      ),
    );

  /**
   * Every binding this authority owns, plus how many binding files could not be
   * read or decoded. Unreadable files are reported, not fatal — the store keeps
   * serving every binding that does decode — but the revisions an unreadable
   * binding references are invisible to the protection set, so the count is what
   * lets the startup sweep refuse to mistake them for orphans.
   */
  const listPersistedBindings = Effect.gen(function* () {
    const fileNames = yield* listDirectory(bindingsDirectory);
    const bindings: Array<DocumentArtifactBinding> = [];
    let undecodable = 0;
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) continue;
      const filePath = path.join(bindingsDirectory, fileName);
      const binding = yield* fileSystem.readFileString(filePath).pipe(
        Effect.map((source) => decodeBinding(source)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Skipping an unreadable document binding.", { filePath, cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (binding === null) {
        undecodable += 1;
        continue;
      }
      if (binding.authority === authority) bindings.push(binding);
    }
    return { bindings, undecodable } as const;
  });

  /** Revision directories present on disk, plus stray paths no revision can own. */
  const scanRevisionDirectories = Effect.gen(function* () {
    const found: Array<{
      readonly artifactId: ArtifactId;
      readonly revisionId: ArtifactRevisionId;
    }> = [];
    const strays: Array<string> = [];
    for (const artifactName of yield* listDirectory(revisionsDirectory)) {
      const artifactPath = path.join(revisionsDirectory, artifactName);
      if (!IDENTIFIER_NAME.test(artifactName)) {
        strays.push(artifactPath);
        continue;
      }
      for (const revisionName of yield* listDirectory(artifactPath)) {
        if (!IDENTIFIER_NAME.test(revisionName)) {
          strays.push(path.join(artifactPath, revisionName));
          continue;
        }
        found.push({
          artifactId: ArtifactId.make(artifactName),
          revisionId: ArtifactRevisionId.make(revisionName),
        });
      }
    }
    return { found, strays } as const;
  });

  const readRetentionIndex = optionalOnNotFound(fileSystem.readFileString(retentionIndexPath)).pipe(
    Effect.map(
      Option.match({
        onNone: (): ReadonlyArray<RetainedRevisionRecord> => [],
        onSome: (source) => {
          const index = decodeRetentionIndex(source);
          return index.authority === authority ? index.revisions : [];
        },
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Rebuilding an unreadable document retention index.", { cause }).pipe(
        Effect.as([] as ReadonlyArray<RetainedRevisionRecord>),
      ),
    ),
  );

  /**
   * Rebuilds retention accounting from the durable evidence, then returns every
   * binding whose production was interrupted.
   *
   * A directory the index does not list is either an orphan from a crashed
   * publish or eviction, or — if a binding still references it — an entry lost
   * before its index write. Referenced directories are re-adopted; the rest are
   * reclaimed. Bindings are the only authority on what is protected, so an index
   * that is missing, stale, or corrupt can never cause a referenced revision to
   * be deleted.
   *
   * That guarantee only holds while every binding can be read: a binding this
   * pass could not decode names revisions nothing in the protection set knows
   * about, and with the index also unavailable they would look exactly like
   * orphans. So a pass that skipped any binding reclaims nothing — it keeps
   * serving, reports why, and leaves the real orphans for a later pass that can
   * see the whole picture.
   */
  const rebuildRetentionState = Effect.gen(function* () {
    const { bindings, undecodable } = yield* listPersistedBindings;
    const protectedKeys = new Set<string>();
    const protectionByDocument = new Map<string, ReadonlySet<string>>();
    for (const binding of bindings) {
      const keys = new Set<string>();
      for (const revision of [binding.activeRevision, binding.lastSuccessfulRevision]) {
        if (revision !== null) keys.add(revisionKey(revision.artifactId, revision.revisionId));
      }
      for (const key of keys) protectedKeys.add(key);
      if (keys.size > 0) protectionByDocument.set(binding.logicalDocumentKey, keys);
    }
    yield* Ref.set(bindingRevisions, protectionByDocument);

    const { found, strays } = yield* scanRevisionDirectories;
    const onDisk = new Map(
      found.map((entry) => [revisionKey(entry.artifactId, entry.revisionId), entry]),
    );
    const persisted = yield* readRetentionIndex;

    const retained: Array<RetainedRevision> = [];
    const retainedKeys = new Set<string>();
    for (const record of persisted) {
      const key = revisionKey(record.artifactId, record.revisionId);
      if (!onDisk.has(key) || retainedKeys.has(key)) continue;
      retained.push({ ...record, lastAccessEpochMs: record.createdAtEpochMs });
      retainedKeys.add(key);
    }

    let adopted = 0;
    for (const [key, entry] of onDisk) {
      if (retainedKeys.has(key) || !protectedKeys.has(key)) continue;
      const stored = yield* readRevision(entry.artifactId, entry.revisionId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Unable to account for a referenced document revision.", {
            artifactId: entry.artifactId,
            revisionId: entry.revisionId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      // A referenced revision that cannot be read is left on disk untouched.
      if (stored === null) {
        retainedKeys.add(key);
        continue;
      }
      retained.push({
        artifactId: entry.artifactId,
        revisionId: entry.revisionId,
        logicalDocumentKey: stored.artifact.logicalDocumentKey,
        byteLength: stored.artifact.byteLength,
        createdAtEpochMs: stored.artifact.createdAtEpochMs,
        lastAccessEpochMs: stored.artifact.createdAtEpochMs,
      });
      retainedKeys.add(key);
      adopted += 1;
    }

    const ordered = retained.toSorted(
      (left, right) => left.createdAtEpochMs - right.createdAtEpochMs,
    );
    yield* Ref.set(retainedRevisions, ordered);
    yield* persistRetentionIndex(ordered);

    const unaccounted = [...onDisk.entries()].filter(([key]) => !retainedKeys.has(key));
    // A pass that could not read every binding cannot tell an orphan from a
    // revision an unreadable binding still points at, so it reclaims neither.
    const orphans = undecodable > 0 ? [] : unaccounted;
    if (undecodable > 0 && unaccounted.length > 0) {
      yield* Effect.logWarning(
        "Skipping generated document orphan reclamation: some bindings could not be read.",
        {
          undecodableBindings: undecodable,
          unaccountedRevisions: unaccounted.length,
        },
      );
    }
    yield* Effect.forEach(
      orphans,
      ([, entry]) => removeRevisionDirectory(entry.artifactId, entry.revisionId),
      { discard: true },
    );
    // Strays are outside that caution: no branded identifier decodes to their
    // names, so no binding — readable or not — can be pointing at one.
    yield* Effect.forEach(
      strays,
      (stray) => fileSystem.remove(stray, { recursive: true, force: true }).pipe(Effect.ignore),
      { discard: true },
    );
    if (orphans.length > 0 || strays.length > 0 || adopted > 0) {
      yield* Effect.logInfo("Swept the generated document revision store.", {
        retainedRevisions: ordered.length,
        adoptedRevisions: adopted,
        removedOrphans: orphans.length,
        removedStrays: strays.length,
      });
    }
    return bindings;
  });

  /**
   * A binding still marked as producing survived a crash or restart rather than a
   * failure, so its production is released through the abandon path: a published
   * revision stays current instead of being wrongly staled.
   */
  const reconcileInterruptedProductions = (bindings: ReadonlyArray<DocumentArtifactBinding>) =>
    Effect.gen(function* () {
      const interrupted = bindings.filter((binding) => binding.latestAttempt.state === "running");
      if (interrupted.length === 0) return;
      const nowEpochMs = yield* Clock.currentTimeMillis;
      for (const binding of interrupted) {
        const transition = abandonDocumentProduction(binding, {
          generation: binding.generation,
          operationId: binding.latestAttempt.operationId,
          producerId: binding.latestAttempt.producerId,
          reason: "The server restarted while this document was being produced.",
          nowEpochMs,
        });
        if (transition._tag !== "Accepted") continue;
        yield* commitBinding(transition.binding, "reconcile").pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Unable to reconcile an interrupted document production.", {
              logicalDocumentKey: binding.logicalDocumentKey,
              cause,
            }),
          ),
        );
        yield* Effect.logInfo("Reconciled an interrupted document production.", {
          logicalDocumentKey: binding.logicalDocumentKey,
          generation: transition.binding.generation,
          operationId: binding.latestAttempt.operationId,
          producerId: binding.latestAttempt.producerId,
          status: transition.binding.status,
        });
      }
    });

  // Startup reconciliation runs before the store is published so no caller can
  // observe interrupted state. It is best-effort: a store that cannot sweep still
  // serves documents from its persisted bindings.
  yield* lock
    .withPermit(
      rebuildRetentionState.pipe(
        Effect.tap(reconcileInterruptedProductions),
        Effect.andThen(enforceRetentionBudget()),
      ),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Generated document store startup reconciliation failed.", { cause }),
      ),
    );

  return GeneratedDocumentStore.of({
    beginProduction,
    publishPdf,
    failProduction,
    abandonProduction,
    getDescriptor,
    resolveRevision,
    resolveRevisionForAsset,
    retainRevision,
    changes: Stream.fromPubSub(changesPubSub),
  });
});

export const layer = Layer.effect(GeneratedDocumentStore, make());

/** Constructs the store with a non-default retention budget. */
export const layerWith = (options: GeneratedDocumentStoreOptions) =>
  Layer.effect(GeneratedDocumentStore, make(options));
