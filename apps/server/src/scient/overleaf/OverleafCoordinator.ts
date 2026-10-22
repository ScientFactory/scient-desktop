// @effect-diagnostics nodeBuiltinImport:off -- Folder identities and private scratch folders.
/**
 * The local half of a manual Overleaf sync (coordinator contract sections 3, 4,
 * 6 and 9; step 3b). It prepares reviews, applies a confirmed one to the
 * folder, recovers an interrupted apply and adopts the applier's result into
 * the connection. It never publishes: step 4 continues from an adopted result.
 *
 * Lock order: the connection's operation reservation (in memory, refused rather
 * than queued), then the checkout barrier's application section, then the
 * store's compare-and-set, then the file layer's own locks. Fetching Overleaf
 * happens before the section is taken.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CheckoutBarrier,
  CheckoutRecoveryRequiredError,
  type CheckoutSection,
  type CheckoutSuspendedError,
} from "../workspace/CheckoutBarrier.ts";
import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
import {
  overleafRequiredPins,
  type OverleafConnectionDocument,
  type OverleafOperationReceipt,
} from "./OverleafConnectionState.ts";
import { newOverleafId, type OverleafGitError } from "./OverleafGitExecutor.ts";
import { captureOverleafInventory, type OverleafInventoryRefusal } from "./OverleafInventory.ts";
import { OverleafRepository, type OverleafRepositoryError } from "./OverleafRepository.ts";
import { macVolumeUuid, type OverleafVolumeIdentityResolver } from "./OverleafRetentionVault.ts";
import {
  buildOverleafReview,
  type OverleafReview,
  type OverleafReviewRefusal,
} from "./OverleafReview.ts";
import {
  makeOverleafReviewRegistry,
  overleafReviewStaleness,
  type OverleafReviewRegistry,
  type OverleafReviewStaleReason,
  type OverleafReviewTakeRefusal,
} from "./OverleafReviewRegistry.ts";
import {
  OverleafStateStore,
  type OverleafConnectionStaleError,
  type OverleafConnectionUnavailableError,
  type OverleafRecordInvalidError,
  type OverleafRequestReusedError,
  type OverleafRetentionUnavailableError,
  type OverleafStateIoError,
  type OverleafStateLockedError,
  type OverleafTransitionRejectedError,
} from "./OverleafStateStore.ts";
import type { ConflictChoice } from "./syncRules.ts";
import {
  WorkspaceApplier,
  type WorkspaceApplyError,
  type WorkspaceApplyResult,
} from "./WorkspaceApplier.ts";

/** Another operation holds this connection. Admission never queues. */
export class OverleafOperationActiveError extends Schema.TaggedError<OverleafOperationActiveError>()(
  "OverleafOperationActiveError",
  { connectionId: Schema.String },
) {
  override get message(): string {
    return "Another Overleaf operation is running for this project.";
  }
}

/** The connection cannot run local work now; `reason` says why. */
export class OverleafConnectionNotReadyError extends Schema.TaggedError<OverleafConnectionNotReadyError>()(
  "OverleafConnectionNotReadyError",
  {
    connectionId: Schema.String,
    reason: Schema.Literals([
      "missing",
      "corrupt",
      "unsupported",
      "archived",
      "folder-changed",
      "recovery-required",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "missing":
        return "This Overleaf connection does not exist.";
      case "corrupt":
      case "unsupported":
        return "This Overleaf connection's record cannot be read.";
      case "archived":
        return "This Overleaf connection was disconnected.";
      case "folder-changed":
        return "The project folder is not the one this connection recorded.";
      case "recovery-required":
        return "An earlier Overleaf sync in this project did not finish. Recover it first.";
    }
  }
}

/** Adoption would keep more replaced files than a connection can record. */
export class OverleafRetainedLimitError extends Schema.TaggedError<OverleafRetainedLimitError>()(
  "OverleafRetainedLimitError",
  { connectionId: Schema.String },
) {
  override get message(): string {
    return "This sync would keep more replaced files than Scient can track. Release kept copies first.";
  }
}

/** The connection's selections: what a review was built from, and is rebuilt from. */
export interface OverleafSelections {
  readonly selectedAdditions: ReadonlyArray<string>;
  /** Local paths read in full because Overleaf has content at their place. */
  readonly collisionPaths: ReadonlyArray<string>;
  readonly choices: ReadonlyMap<string, ConflictChoice>;
}

export type OverleafPrepareResult =
  | { readonly _tag: "review"; readonly review: OverleafReview }
  | {
      readonly _tag: "refused";
      readonly refusal: OverleafReviewRefusal | OverleafInventoryRefusal;
    }
  /** A pending apply was recovered but needs review before anything else. */
  | { readonly _tag: "recovered"; readonly recovery: OverleafAdopted };

/** What one apply did to the folder and the connection. */
export interface OverleafAdopted {
  readonly applyId: string;
  readonly outcome: WorkspaceApplyResult["outcome"];
  readonly interrupted: ReadonlyArray<ReadonlyArray<string>>;
  readonly markerPaths: ReadonlyArray<string>;
  readonly baseGeneration: number;
}

export type OverleafConfirmResult =
  | { readonly _tag: "applied"; readonly adopted: OverleafAdopted }
  /** The review no longer describes the folder or Overleaf; `review` replaces it. */
  | {
      readonly _tag: "stale";
      readonly reason: OverleafReviewStaleReason;
      readonly review: OverleafReview;
    }
  | { readonly _tag: "review-refused"; readonly reason: OverleafReviewTakeRefusal }
  | {
      readonly _tag: "refused";
      readonly refusal: OverleafReviewRefusal | OverleafInventoryRefusal;
    }
  /** The same request was confirmed before; its receipt, never a second apply. */
  | { readonly _tag: "duplicate"; readonly receipt: OverleafOperationReceipt };

export type OverleafRecoverResult =
  | { readonly _tag: "none" }
  | { readonly _tag: "recovered"; readonly adopted: OverleafAdopted };

type FetchError = OverleafRepositoryError | OverleafGitError;
/** Everything a coordinator operation can fail with; business outcomes are results instead. */
export type OverleafCoordinatorError =
  | OverleafOperationActiveError
  | OverleafConnectionNotReadyError
  | OverleafRetainedLimitError
  | CheckoutSuspendedError
  | FetchError
  | WorkspaceApplyError
  | OverleafStateIoError
  | OverleafStateLockedError
  | OverleafConnectionStaleError
  | OverleafConnectionUnavailableError
  | OverleafTransitionRejectedError
  | OverleafRecordInvalidError
  | OverleafRequestReusedError
  | OverleafRetentionUnavailableError;

export interface OverleafCoordinatorOptions {
  /** `stateDir/overleaf`: repositories and scratch folders live here. */
  readonly stateRoot: string;
  /** The host's exchange helper; null only for the declared development fallback. */
  readonly exchangeHelper: string | null;
  /** Fetches Overleaf's branch into `repo`. Step 4 supplies the authenticated fetch. */
  readonly fetchRemote: (input: {
    readonly repo: string;
    readonly connection: OverleafConnectionDocument;
  }) => Effect.Effect<{ readonly commit: string; readonly tree: string }, FetchError>;
  /** The host credential epoch; renewing the token advances it. */
  readonly credentialEpoch?: () => number;
  /** Test seam: the disk's volume UUID for a path. Defaults to `diskutil`. */
  readonly volumeUuid?: OverleafVolumeIdentityResolver;
  readonly registry?: OverleafReviewRegistry;
  /** Fault points for tests: a throw stops the operation there, as a crash would. */
  readonly hooks?: {
    readonly at?: (point: "linked" | "applied" | "adopted") => Promise<void>;
  };
}

const RETAINED_COPY_LIMIT = 4_096;
const PRIOR_BASE_LIMIT = 20;
const LOCAL_SNAPSHOT_LIMIT = 10;

const byPath = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const unique = (paths: Iterable<string>) => [...new Set(paths)].sort(byPath);
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const hook = (
  options: OverleafCoordinatorOptions,
  point: "linked" | "applied" | "adopted",
): Effect.Effect<void> => Effect.promise(() => options.hooks?.at?.(point) ?? Promise.resolve());

/** @public Context tag; step 5 mounts it behind authenticated routes. */
export class OverleafCoordinator extends Context.Service<
  OverleafCoordinator,
  {
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly selections?: OverleafSelections;
    }) => Effect.Effect<OverleafPrepareResult, OverleafCoordinatorError>;
    readonly confirm: (input: {
      readonly connectionId: string;
      readonly requestId: string;
      readonly reviewId: string;
      readonly digest: string;
      readonly acknowledgements: ReadonlyArray<string>;
    }) => Effect.Effect<OverleafConfirmResult, OverleafCoordinatorError>;
    readonly recover: (input: {
      readonly connectionId: string;
    }) => Effect.Effect<OverleafRecoverResult, OverleafCoordinatorError>;
  }
>()("t3/scient/overleaf/OverleafCoordinator") {}

export const make = (options: OverleafCoordinatorOptions) =>
  Effect.gen(function* () {
    const store = yield* OverleafStateStore;
    const repos = yield* OverleafRepository;
    const applier = yield* WorkspaceApplier;
    const barrier = yield* CheckoutBarrier;
    const registry = options.registry ?? makeOverleafReviewRegistry();
    const volumeUuid = options.volumeUuid ?? macVolumeUuid;
    const credentialEpoch = options.credentialEpoch ?? (() => 0);
    /** Connection → the operation holding it. */
    const reservations = new Map<string, string>();

    const now = Clock.currentTimeMillis;

    const reserve = <A, E, R>(
      connectionId: string,
      body: (operationId: string) => Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          if (reservations.has(connectionId))
            return Effect.fail(new OverleafOperationActiveError({ connectionId }));
          const operationId = newOverleafId();
          reservations.set(connectionId, operationId);
          return Effect.succeed(operationId);
        }),
        body,
        () => Effect.sync(() => reservations.delete(connectionId)),
      );

    const readActive = Effect.fn("OverleafCoordinator.readActive")(function* (
      connectionId: string,
    ) {
      const read = yield* store.readConnection(connectionId);
      if (read._tag !== "ready")
        return yield* new OverleafConnectionNotReadyError({ connectionId, reason: read._tag });
      if (read.document.state !== "active")
        return yield* new OverleafConnectionNotReadyError({ connectionId, reason: "archived" });
      return read.document;
    });

    const folderOf = (connection: OverleafConnectionDocument) =>
      connection.folder.relativePath === ""
        ? connection.checkout.canonicalRoot
        : NodePath.join(connection.checkout.canonicalRoot, connection.folder.relativePath);

    /** The checkout and folder are still the physical folders the connection recorded. */
    const verifyFolders = Effect.fn("OverleafCoordinator.verifyFolders")(function* (
      connection: OverleafConnectionDocument,
    ) {
      const matches = yield* Effect.promise(async () => {
        for (const [path, recorded] of [
          [connection.checkout.canonicalRoot, connection.checkout.identity],
          [folderOf(connection), connection.folder.identity],
        ] as const) {
          const stat = await NodeFSP.lstat(path, { bigint: true }).catch(() => null);
          if (stat === null || !stat.isDirectory() || String(stat.ino) !== recorded.fileId)
            return false;
          if ((await volumeUuid(path)) !== recorded.volume) return false;
        }
        return true;
      });
      if (!matches)
        return yield* new OverleafConnectionNotReadyError({
          connectionId: connection.connectionId,
          reason: "folder-changed",
        });
    });

    const repositoryFor = Effect.fn("OverleafCoordinator.repositoryFor")(function* (
      connection: OverleafConnectionDocument,
    ) {
      const repo = NodePath.join(
        options.stateRoot,
        "repositories",
        `${connection.connectionId}.git`,
      );
      yield* repos.initialize({
        repo,
        gitUrl: `https://git.overleaf.com/${connection.remote.projectId}`,
      });
      return repo;
    });

    /** Captures the folder and builds the review, reading requested collisions in full. */
    const buildReview = Effect.fn("OverleafCoordinator.buildReview")(function* (input: {
      readonly connection: OverleafConnectionDocument;
      readonly repo: string;
      readonly selections: OverleafSelections;
      readonly remote: { readonly commit: string; readonly tree: string };
      readonly checkoutEpoch: number;
    }) {
      const { connection, repo } = input;
      const baseTree =
        connection.base.tree === null
          ? []
          : yield* repos.readTree({ repo, tree: connection.base.tree });
      const managedPaths = unique([
        ...baseTree.map((entry) => entry.path),
        ...connection.managedPaths,
      ]);
      const scratch = NodePath.join(options.stateRoot, "scratch", newOverleafId());
      let requested = input.selections.collisionPaths;
      // A review may ask once for the local files Overleaf has content at; a second
      // request means the folder changed meanwhile, which the next prepare sees.
      for (let round = 0; ; round++) {
        const captured = yield* Effect.promise(() =>
          captureOverleafInventory({
            folder: folderOf(connection),
            managedPaths,
            localOnlyPaths: connection.localOnlyPaths,
            selectedAdditions: input.selections.selectedAdditions,
            requestedPaths: requested,
            stagingPaths: connection.stagingPaths,
          }),
        );
        if (captured._tag === "refused")
          return { _tag: "refused" as const, refusal: captured.refusal };
        yield* Effect.promise(() => NodeFSP.mkdir(scratch, { recursive: true, mode: 0o700 }));
        const result = yield* buildOverleafReview({
          repo,
          connection,
          inventory: captured.inventory,
          remote: input.remote,
          selectedAdditions: input.selections.selectedAdditions,
          collisionPaths: requested,
          choices: input.selections.choices,
          interrupted: connection.forcedConflicts,
          markerPaths: connection.markerPaths,
          epochs: { checkout: input.checkoutEpoch, credential: credentialEpoch() },
          scratch,
        }).pipe(
          Effect.provideService(OverleafRepository, repos),
          Effect.ensuring(
            Effect.promise(() => NodeFSP.rm(scratch, { recursive: true, force: true })),
          ),
        );
        if (result._tag !== "needs-capture" || round > 0) {
          if (result._tag === "needs-capture")
            return {
              _tag: "refused" as const,
              refusal: { reason: "unstable" as const, path: result.paths[0] ?? "" },
            };
          return result;
        }
        requested = result.paths;
      }
    });

    /** Writes the refs `next` needs, then replaces the document; refs it no longer needs go after. */
    const replaceWithPins = Effect.fn("OverleafCoordinator.replaceWithPins")(function* (
      repo: string,
      previous: OverleafConnectionDocument,
      next: OverleafConnectionDocument,
    ) {
      const before = new Map(overleafRequiredPins(previous).map((pin) => [pin.name, pin.oid]));
      const after = overleafRequiredPins(next);
      for (const pin of after)
        if (before.get(pin.name) !== pin.oid) yield* repos.setRef({ repo, ...pin });
      yield* store.replaceConnection({ expectedRevision: previous.revision, next });
      const kept = new Set(after.map((pin) => pin.name));
      for (const name of before.keys())
        if (!kept.has(name)) yield* repos.deleteRef({ repo, name }).pipe(Effect.ignore);
    });

    /** The connection after the applier's result: one replacement, so it is adopted once. */
    const adoption = Effect.fn("OverleafCoordinator.adoption")(function* (
      repo: string,
      connection: OverleafConnectionDocument,
      result: WorkspaceApplyResult,
    ) {
      const link = connection.activeApply!;
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      if (result.outcome === "replan")
        return {
          ...connection,
          revision: connection.revision + 1,
          activeApply: null,
          updatedAt,
        } satisfies OverleafConnectionDocument;
      const baseTree = yield* repos.writeTree({
        repo,
        entries: [...result.base]
          .sort(([left], [right]) => byPath(left, right))
          .map(([path, oid]) => ({ path, oid })),
      });
      const candidate = yield* repos.readTree({ repo, tree: link.intentTree });
      const completedSyncCount =
        connection.completedSyncCount + (result.outcome === "complete" ? 1 : 0);
      const copies = new Map(
        connection.retention.copies.map((copy) => [`${copy.applyId}\0${copy.relativePath}`, copy]),
      );
      for (const kept of result.retained) {
        if (kept.retainedRevision === null) continue;
        const key = `${link.applyId}\0${kept.relativePath}`;
        const state = kept.changed
          ? ("changed" as const)
          : result.interrupted.some((group) => group.includes(kept.relativePath))
            ? ("interrupted" as const)
            : ("releasable" as const);
        const earlier = copies.get(key);
        // One record per file; a changed or interrupted leaf outranks a releasable one.
        if (earlier !== undefined && (earlier.state !== "releasable" || state === "releasable"))
          continue;
        copies.set(key, {
          applyId: link.applyId,
          relativePath: kept.relativePath,
          revision: kept.retainedRevision,
          state,
          retainedAt: updatedAt,
          retainedAtSyncCount: completedSyncCount,
        });
      }
      return {
        ...connection,
        revision: connection.revision + 1,
        base: {
          commit: link.remoteCommit,
          tree: baseTree,
          generation: connection.base.generation + 1,
        },
        priorBases:
          connection.base.tree === null
            ? connection.priorBases
            : [
                {
                  commit: connection.base.commit,
                  tree: connection.base.tree,
                  generation: connection.base.generation,
                },
                ...connection.priorBases,
              ].slice(0, PRIOR_BASE_LIMIT),
        completedSyncCount,
        managedPaths: unique([
          ...candidate.map((entry) => entry.path),
          ...result.interrupted.flat(),
        ]),
        localOnlyPaths: unique([...connection.localOnlyPaths, ...link.newLocalOnly]),
        forcedConflicts: result.interrupted.map((group) => unique(group)),
        markerPaths: unique([...result.markerPaths, ...link.priorMarkers]),
        stagingPaths: unique([...connection.stagingPaths, ...result.stagingPaths]),
        retention: { ...connection.retention, copies: [...copies.values()] },
        // The base moved, so a publication still unknown is overtaken (contract section 6).
        attempts: connection.attempts.map((attempt) =>
          attempt.outcome === "unknown"
            ? {
                ...attempt,
                outcome: "superseded-unresolved" as const,
                evidence: "superseded" as const,
              }
            : attempt,
        ),
        activeApply: null,
        updatedAt,
      } satisfies OverleafConnectionDocument;
    });

    /**
     * Runs or resumes the linked apply inside an application section and adopts
     * its result. Without `plan` the applier resumes from its own durable intent.
     */
    const runLinked = Effect.fn("OverleafCoordinator.runLinked")(function* (
      repo: string,
      connection: OverleafConnectionDocument,
      plan?: OverleafReview["applyPlan"],
    ) {
      const link = connection.activeApply!;
      const retention = yield* store.prepareRetention({
        environmentId: connection.environmentId,
        connectionId: connection.connectionId,
        checkoutRoot: connection.checkout.canonicalRoot,
        exchangeHelper: options.exchangeHelper,
        expected: connection.retention.vaultIdentity,
      });
      const result = yield* applier.apply({
        cwd: folderOf(connection),
        applicationDirectory: retention.directory,
        id: link.applyId,
        ...(plan ? { plan } : {}),
      });
      yield* hook(options, "applied");
      yield* replaceWithPins(repo, connection, yield* adoption(repo, connection, result));
      yield* hook(options, "adopted");
      return {
        applyId: link.applyId,
        outcome: result.outcome,
        interrupted: result.interrupted,
        markerPaths: result.markerPaths,
        baseGeneration: connection.base.generation + (result.outcome === "replan" ? 0 : 1),
      } satisfies OverleafAdopted;
    });

    /** Recovers a linked apply, under a section of its own or one a bulk change holds. */
    const recoverHeld = Effect.fn("OverleafCoordinator.recoverHeld")(function* (
      connectionId: string,
      within?: CheckoutSection,
    ) {
      const pending = yield* readActive(connectionId);
      if (pending.activeApply === null) return { _tag: "none" as const };
      const repo = yield* repositoryFor(pending);
      return yield* barrier.application(
        folderOf(pending),
        () =>
          Effect.gen(function* () {
            const connection = yield* readActive(connectionId);
            if (connection.activeApply === null) return { _tag: "none" as const };
            yield* verifyFolders(connection);
            return {
              _tag: "recovered" as const,
              adopted: yield* runLinked(repo, connection),
            };
          }),
        within ? { within } : undefined,
      );
    });

    const prepare: OverleafCoordinator["Service"]["prepare"] = (input) =>
      reserve(input.connectionId, () =>
        Effect.gen(function* () {
          let connection = yield* readActive(input.connectionId);
          if (connection.activeApply !== null) {
            const recovered = yield* recoverHeld(input.connectionId);
            if (recovered._tag === "recovered" && recovered.adopted.outcome !== "complete")
              return { _tag: "recovered" as const, recovery: recovered.adopted };
            connection = yield* readActive(input.connectionId);
          }
          const repo = yield* repositoryFor(connection);
          const remote = yield* options.fetchRemote({ repo, connection });
          const section = yield* barrier.current(folderOf(connection));
          const built = yield* buildReview({
            connection,
            repo,
            selections: input.selections ?? {
              selectedAdditions: [],
              collisionPaths: [],
              choices: new Map(),
            },
            remote,
            checkoutEpoch: section.epoch,
          });
          if (built._tag === "review") registry.offer(built.review, yield* now);
          return built;
        }),
      );

    const confirm: OverleafCoordinator["Service"]["confirm"] = (input) =>
      reserve(input.connectionId, (operationId) =>
        Effect.gen(function* () {
          const started = DateTime.formatIso(yield* DateTime.now);
          const begun = yield* store.beginReceipt({
            schemaVersion: 1,
            connectionId: input.connectionId,
            requestId: input.requestId,
            kind: "confirm",
            payloadDigest: sha256(
              [input.reviewId, input.digest, ...[...input.acknowledgements].sort(byPath)].join(" "),
            ),
            operationId,
            status: "running",
            resultCategory: null,
            createdAt: started,
            updatedAt: started,
          });
          if (begun._tag === "existing")
            return { _tag: "duplicate" as const, receipt: begun.receipt };
          let linked = false;
          const finish = (status: "completed" | "failed" | "unknown", resultCategory: string) =>
            store
              .finishReceipt({
                connectionId: input.connectionId,
                requestId: input.requestId,
                status,
                resultCategory,
              })
              .pipe(Effect.ignore);
          const result = yield* Effect.gen(function* () {
            const taken = registry.take({
              connectionId: input.connectionId,
              id: input.reviewId,
              digest: input.digest,
              acknowledgements: input.acknowledgements,
              now: yield* now,
            });
            if (taken._tag === "refused")
              return { _tag: "review-refused" as const, reason: taken.reason };
            const review = taken.review;
            const first = yield* readActive(input.connectionId);
            if (first.activeApply !== null)
              return yield* new OverleafConnectionNotReadyError({
                connectionId: input.connectionId,
                reason: "recovery-required",
              });
            const repo = yield* repositoryFor(first);
            const remote = yield* options.fetchRemote({ repo, connection: first });
            return yield* barrier.application(folderOf(first), (section) =>
              Effect.gen(function* () {
                const connection = yield* readActive(input.connectionId);
                if (connection.activeApply !== null)
                  return yield* new OverleafConnectionNotReadyError({
                    connectionId: input.connectionId,
                    reason: "recovery-required",
                  });
                yield* verifyFolders(connection);
                // The same review, built again from what stands now (contract section 5).
                const fresh = yield* buildReview({
                  connection,
                  repo,
                  selections: {
                    selectedAdditions: review.binding.selectedAdditions,
                    collisionPaths: review.binding.collisionPaths,
                    choices: new Map(review.binding.choices),
                  },
                  remote,
                  checkoutEpoch: section.epoch,
                });
                if (fresh._tag === "refused") return fresh;
                const stale = overleafReviewStaleness(review.binding, fresh.review.binding);
                if (stale !== null) {
                  registry.offer(fresh.review, yield* now);
                  return { _tag: "stale" as const, reason: stale, review: fresh.review };
                }
                // Every captured file the plan replaces or deletes may leave a kept copy.
                const replaced = [...review.applyPlan.captured].filter(([path, revision]) => {
                  const target = review.applyPlan.target.get(path);
                  return target === undefined || bytesRevision(target.bytes) !== revision;
                }).length;
                if (connection.retention.copies.length + replaced > RETAINED_COPY_LIMIT)
                  return yield* new OverleafRetainedLimitError({
                    connectionId: input.connectionId,
                  });
                const sequence =
                  Math.max(0, ...connection.localSnapshots.map((snapshot) => snapshot.sequence)) +
                  1;
                const withLink: OverleafConnectionDocument = {
                  ...connection,
                  revision: connection.revision + 1,
                  localSnapshots: [
                    ...connection.localSnapshots,
                    { sequence, commit: null, tree: review.binding.localTree },
                  ].slice(-LOCAL_SNAPSHOT_LIMIT),
                  activeApply: {
                    applyId: newOverleafId(),
                    kind: "sync-apply",
                    operationId,
                    planDigest: review.digest,
                    baseGeneration: connection.base.generation,
                    intentTree: review.binding.candidateTree,
                    remoteCommit: review.binding.remoteCommit,
                    newLocalOnly: review.binding.newLocalOnly,
                    priorMarkers: review.binding.unresolvedMarkers,
                  },
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                };
                yield* replaceWithPins(repo, connection, withLink);
                linked = true;
                yield* hook(options, "linked");
                return {
                  _tag: "applied" as const,
                  adopted: yield* runLinked(repo, withLink, review.applyPlan),
                };
              }),
            );
          }).pipe(
            Effect.tapError(() => finish(linked ? "unknown" : "failed", "error")),
            Effect.tap((done) =>
              finish(
                done._tag === "applied" ? "completed" : "failed",
                done._tag === "applied" ? `applied-${done.adopted.outcome}` : done._tag,
              ),
            ),
          );
          return result;
        }),
      );

    const recover: OverleafCoordinator["Service"]["recover"] = (input) =>
      reserve(input.connectionId, () => recoverHeld(input.connectionId));

    // A bulk change of a checkout first settles an apply left pending in it, when
    // nothing else holds that connection (owner decision 3); otherwise it refuses.
    yield* barrier.settleBeforeBulk((section) =>
      Effect.gen(function* () {
        const connectionIds = yield* store.listConnections.pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
        for (const connectionId of connectionIds) {
          const read = yield* store
            .readConnection(connectionId)
            .pipe(Effect.orElseSucceed(() => ({ _tag: "missing" as const })));
          if (read._tag !== "ready" || read.document.state !== "active") continue;
          const connection = read.document;
          if ((yield* barrier.current(connection.checkout.canonicalRoot)).key !== section.key)
            continue;
          const refuse = new CheckoutRecoveryRequiredError({ checkout: section.root });
          // Structural source copies sit in the folder; a bulk change could erase them.
          if (connection.stagingPaths.length > 0) return yield* refuse;
          if (connection.activeApply === null) continue;
          yield* reserve(connectionId, () => recoverHeld(connectionId, section)).pipe(
            Effect.mapError(() => refuse),
          );
        }
      }),
    );

    return OverleafCoordinator.of({ prepare, confirm, recover });
  });
